#!/usr/bin/env node
//
// The agent's only way in. Every capability is a subcommand with validated
// arguments — nothing here builds a shell string or evaluates input, so a
// model that has been fed a hostile log line still cannot reach anything
// beyond these verbs.

import {
  monitorInstances,
  rebootInstance,
  startInstance,
  stopInstance,
} from "./aws/ec2";

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

function fail(message: string): never {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}

function instanceIdOrDie(raw: string | undefined): string {
  if (!raw) fail("An instance id is required, e.g. i-0a3f9c21b7e4d500");
  if (!INSTANCE_ID.test(raw))
    fail(`Not a valid instance id: ${JSON.stringify(raw)}. Expected i- followed by 8-17 hex characters.`);
  return raw;
}

function emit(payload: unknown): void {
  console.log(JSON.stringify({ ok: true, ...(payload as object) }, null, 2));
}

const USAGE = `clawops <command>

  monitor              Health report for every instance in the region
  reboot  <id>         Restart an instance          (needs approval)
  start   <id>         Start a stopped instance     (needs approval)
  stop    <id>         Stop an instance             (needs approval)

Instance ids look like i-0a3f9c21b7e4d500.`;

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  switch (command) {
    case "monitor": {
      emit(await monitorInstances());
      return;
    }

    case "reboot": {
      const id = instanceIdOrDie(arg);
      emit({ message: await rebootInstance(id), instanceId: id });
      return;
    }

    case "start": {
      const id = instanceIdOrDie(arg);
      emit({ message: await startInstance(id), instanceId: id });
      return;
    }

    case "stop": {
      // The agent's own credentials are read-only, so AWS refuses this today.
      // It succeeds only with a session credential minted after a human
      // approval — iam/elevated-perms.json bounds what such a session may touch.
      const id = instanceIdOrDie(arg);
      emit({ message: await stopInstance(id), instanceId: id });
      return;
    }

    case "help":
    case "--help":
    case undefined: {
      console.log(USAGE);
      return;
    }

    default:
      fail(`Unknown command: ${JSON.stringify(command)}\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  const e = err as { name?: string; message?: string };
  // AWS refusals are expected and meaningful — surface them as data, not a crash.
  if (e.name === "UnauthorizedOperation" || e.name === "AccessDenied" || e.name === "AccessDeniedException") {
    console.error(
      JSON.stringify(
        { ok: false, error: "AccessDenied", detail: e.message, hint: "This action needs credentials minted after a human approval." },
        null,
        2,
      ),
    );
    process.exit(2);
  }
  fail(e.message ?? String(err));
});
