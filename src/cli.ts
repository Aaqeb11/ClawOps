#!/usr/bin/env node
//
// The agent's only way in. Every capability is a subcommand with validated
// arguments — nothing here builds a shell string or evaluates input, so a
// model that has been fed a hostile log line still cannot reach anything
// beyond these verbs.
//
// Reads need nothing. Every write goes through the approval broker, which
// prompts a human on their phone and returns credentials good for that one
// action on that one instance. The agent's own credentials are read-only, so
// there is no path around it.

import {
  monitorInstances,
  rebootInstance,
  startInstance,
  stopInstance,
} from "./aws/ec2";
import { requestAction, type ScopedCredentials } from "./broker/client";
import type { Action } from "./types";

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

const RUNNERS: Record<
  Action,
  (instanceId: string, credentials: ScopedCredentials) => Promise<string>
> = {
  reboot: rebootInstance,
  start: startInstance,
  stop: stopInstance,
};

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

/** Read `--name value` pairs. Unknown flags are an error, never ignored. */
function flags(argv: string[], allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`Expected a --flag, got ${JSON.stringify(key)}.`);
    const name = key.slice(2);
    if (!allowed.includes(name))
      fail(`Unknown flag --${name}. Allowed here: ${allowed.map((a) => `--${a}`).join(", ")}.`);
    const value = argv[i + 1];
    if (!value) fail(`--${name} needs a value.`);
    out[name] = value;
  }
  return out;
}

const USAGE = `clawops <command>

  monitor                          Health report for every instance in the region

  stop   <id> --reason "<why>" --by <user>    Stop an instance      (needs approval)
  start  <id> --reason "<why>" --by <user>    Start an instance     (needs approval)
  reboot <id> --reason "<why>" --by <user>    Restart an instance   (needs approval)

--by is the requester's id as the broker knows them (its approver map decides
whose phone is prompted). Each write waits for that human to approve.

Instance ids look like i-0a3f9c21b7e4d500.`;

/**
 * One state-changing verb. Asks the broker, which blocks until a human answers
 * on their phone, then runs the action with the credentials that come back.
 */
async function changeState(action: Action, argv: string[]): Promise<void> {
  const instanceId = instanceIdOrDie(argv[0]);
  const options = flags(argv.slice(1), ["reason", "by"]);

  // No silent default for either. An approver reading a push notification
  // needs to know why, and the broker needs to know whose phone to ring.
  if (!options.reason)
    fail(`${action} needs --reason "<why>" — the approver sees this and nothing else.`);
  if (!options.by) fail(`${action} needs --by <user> so the broker knows who to ask.`);

  const { credentials, approvedBy, planId } = await requestAction(
    action,
    instanceId,
    options.reason,
    options.by,
  );

  const message = await RUNNERS[action](instanceId, credentials);
  emit({
    stage: "executed",
    planId,
    instanceId,
    approvedBy,
    credentialsExpireAt: credentials.expiration,
    message,
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "monitor": {
      emit(await monitorInstances());
      return;
    }

    case "reboot":
    case "start":
    case "stop": {
      await changeState(command, rest);
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
