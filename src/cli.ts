#!/usr/bin/env node
//
// The agent's only way in. Every capability is a subcommand with validated
// arguments — nothing here builds a shell string or evaluates input, so a
// model that has been fed a hostile log line still cannot reach anything
// beyond these verbs.
//
// State changes are deliberately two calls, never one:
//
//   clawops stop i-0abc --reason "idle 72h"   -> proposes, returns a requestId
//   (a human approves it)
//   clawops stop i-0abc --request <requestId> -> mints credentials, executes
//
// The agent cannot collapse those into one step, because the approval the
// second call spends is created by someone else.

import {
  monitorInstances,
  rebootInstance,
  startInstance,
  stopInstance,
} from "./aws/ec2";
import type { ScopedCredentials } from "./aws/sts";
import { mintCredentials, requestApproval } from "./broker/client";
import type { Action } from "./broker/store";

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

  monitor                              Health report for every instance in the region

  reboot <id> --reason "<why>"         Propose a restart      -> returns a requestId
  start  <id> --reason "<why>"         Propose a start        -> returns a requestId
  stop   <id> --reason "<why>"         Propose a stop         -> returns a requestId

  reboot <id> --request <requestId>    Execute, once a human has approved it
  start  <id> --request <requestId>
  stop   <id> --request <requestId>

Instance ids look like i-0a3f9c21b7e4d500.`;

/**
 * One state-changing verb. Propose when given --reason, execute when given
 * --request. Asking for both is rejected rather than guessed at: the two
 * halves of this flow are supposed to be separated by a human.
 */
async function changeState(action: Action, argv: string[]): Promise<void> {
  const instanceId = instanceIdOrDie(argv[0]);
  const options = flags(argv.slice(1), ["reason", "request"]);

  if (options.reason && options.request)
    fail("Pass --reason to propose an action or --request to execute an approved one, not both.");

  if (options.reason) {
    const request = await requestApproval(action, instanceId, options.reason);
    emit({
      stage: "awaiting-approval",
      requestId: request.requestId,
      action,
      instanceId,
      reason: request.reason,
      message: `Approval required. Post this to the channel and wait for a human to approve request ${request.requestId}.`,
    });
    return;
  }

  if (options.request) {
    const { credentials, approvedBy } = await mintCredentials(options.request, action, instanceId);
    const message = await RUNNERS[action](instanceId, credentials);
    emit({
      stage: "executed",
      requestId: options.request,
      instanceId,
      approvedBy,
      credentialsExpireAt: credentials.expiration,
      message,
    });
    return;
  }

  fail(`${action} needs --reason "<why>" to propose it, or --request <requestId> to execute an approved one.`);
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
