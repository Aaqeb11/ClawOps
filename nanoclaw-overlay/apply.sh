#!/usr/bin/env bash
# Assemble a working NanoClaw tree from pinned upstream + this overlay.
#
# DESTRUCTIVE BY DESIGN: resets the target to the pinned commit and re-applies.
# Never hand-edit the target tree; this script discards such edits.
# Gitignored state (.env, groups/, data/, logs/, node_modules/) is preserved --
# `git clean -fd` without -x leaves ignored files alone.
#
# Usage: bash apply.sh [target-dir]     (default: ~/nanoclaw)
set -euo pipefail

OVERLAY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$OVERLAY/.." && pwd)"
TARGET="${1:-$HOME/nanoclaw}"
UPSTREAM="https://github.com/nanocoai/nanoclaw.git"
PIN="$(tr -d '[:space:]' < "$OVERLAY/UPSTREAM_PIN")"
PATCH="$OVERLAY/patches/0001-register-opencode-and-slack.patch"

[ -d "$TARGET/.git" ] || git clone "$UPSTREAM" "$TARGET"

# Only hit the network if the pinned commit isn't already local.
git -C "$TARGET" cat-file -e "${PIN}^{commit}" 2>/dev/null || git -C "$TARGET" fetch origin

git -C "$TARGET" checkout --force --quiet "$PIN"
git -C "$TARGET" clean -fdq

# Fail loudly rather than silently producing a half-patched tree.
if ! git -C "$TARGET" apply --check "$PATCH"; then
  echo "ERROR: patch does not apply at pin ${PIN:0:8}." >&2
  echo "Upstream moved under the overlay. Refresh it before deploying." >&2
  exit 1
fi
git -C "$TARGET" apply "$PATCH"

cp -R "$OVERLAY/files/." "$TARGET/"

# One source of truth for the skill: the repo's agent/SKILL.md.
mkdir -p "$TARGET/container/skills/clawops"
cp "$REPO_ROOT/agent/SKILL.md" "$TARGET/container/skills/clawops/SKILL.md"

# NanoClaw refuses to boot unless the install records how it got to this
# commit. This script IS that sanctioned path -- it force-checks-out the pin
# and cleans the tree, so what is on disk is exactly the pin by construction.
# Without this stamp a freshly assembled host dies on the upgrade tripwire.
if [ -d "$TARGET/node_modules" ]; then
  # pnpm is not always on PATH (corepack-managed installs, fresh EC2 hosts), so
  # fall back to the exact version the target pins rather than whatever npx picks.
  if command -v pnpm >/dev/null 2>&1; then
    PNPM="pnpm"
  else
    PNPM_VERSION="$(node -pe 'require("'"$TARGET"'/package.json").packageManager.split("@")[1]')"
    PNPM="npx -y pnpm@${PNPM_VERSION}"
  fi
  ( cd "$TARGET" && $PNPM exec tsx scripts/upgrade-state.ts set >/dev/null )
  echo "Install state stamped at ${PIN:0:8}"
else
  echo "NOTE: run 'pnpm install' in $TARGET, then 'pnpm exec tsx scripts/upgrade-state.ts set'" >&2
  echo "      before starting NanoClaw, or it will stop on the upgrade tripwire." >&2
fi

echo "Overlay applied to $TARGET at pin ${PIN:0:8}"
