#!/usr/bin/env bash
# One-time ClawOps install on a fresh Ubuntu 24.04 EC2 instance.
# Run as the ubuntu user:  sudo su - ubuntu
#
# Stops before the interactive NanoClaw installer rather than wrapping it --
# nanoclaw.sh asks questions and needs a real terminal.
set -euo pipefail

CLAWOPS_REPO="${CLAWOPS_REPO:-https://github.com/Aaqeb11/ClawOps.git}"
CLAWOPS_REF="${CLAWOPS_REF:-feat/agent-runtime}"

sudo apt-get update -qq
sudo apt-get install -y git curl ca-certificates

if [ -d "$HOME/ClawOps/.git" ]; then
  git -C "$HOME/ClawOps" pull --ff-only
else
  git clone -b "$CLAWOPS_REF" "$CLAWOPS_REPO" "$HOME/ClawOps"
fi

bash "$HOME/ClawOps/nanoclaw-overlay/apply.sh" "$HOME/nanoclaw"

# Without this file EVERY container mount is rejected -- silently, no warning.
mkdir -p "$HOME/.config/nanoclaw"
cat > "$HOME/.config/nanoclaw/mount-allowlist.json" <<'JSON'
{
  "allowedRoots": [
    {
      "path": "~/ClawOps",
      "allowReadWrite": false,
      "description": "ClawOps CLI - agent may run it, never modify it"
    }
  ],
  "blockedPatterns": ["password", "secret", "token"]
}
JSON

cat <<'NEXT'

Bootstrap complete. Remaining steps, in order:

  1. cd ~/nanoclaw && bash nanoclaw.sh
     Interactive, ~10 min. Installs Node 22, pnpm, Docker; builds the agent
     container; pairs Slack; writes and enables the systemd unit.

  2. cd ~/ClawOps && corepack enable && yarn install && yarn build
     Only works after step 1 -- that is what installs Node.

  3. Secrets (type them here, never paste into chat):
       nano ~/nanoclaw/.env            Slack tokens, OpenCode/OpenRouter config
       nano ~/ClawOps/.aws-credentials read-only agent key
       chmod 600 ~/ClawOps/.aws-credentials
     The OpenRouter key lives in the OneCLI vault, not .env.

  4. Register ~/ClawOps as a read-only mount, container path: clawops
     (relative -- resolves to /workspace/extra/clawops)

  5. sudo systemctl start nanoclaw && journalctl -u nanoclaw -f

NEXT
