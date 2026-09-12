#!/usr/bin/env node
//
// The agent's only way in. Every capability is a subcommand with validated
// arguments — nothing here builds a shell string or evaluates input, so a
// model that has been fed a hostile log line still cannot reach anything
// beyond these verbs.
//
// Write actions hold no credentials of their own. They ask the broker, which
// pushes an approval to a human's phone and returns a credential scoped to
// that one action on that one instance for fifteen minutes.

import {
  EC2Client,
  RebootInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";

import { monitorInstances } from "./aws/ec2";

const REGION = process.env.AWS_REGION || "ap-south-1";
const BROKER_URL = process.env.CLAWOPS_BROKER_URL || "http://172.17.0.1:3001";
const REQUESTED_BY = process.env.CLAWOPS_REQUESTED_BY || "U0C10BFCB52";

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
  reboot  <id> [why]   Restart an instance          (needs approval)
  start   <id> [why]   Start a stopped instance     (needs approval)
  stop    <id> [why]   Stop an instance             (needs approval)

Instance ids look like i-0a3f9c21b7e4d500.
Write actions push an approval to a human's phone and wait for the tap.`;

/**
 * Ask the broker for a credential. The broker validates the request against
 * its own allowlist, stores a plan row, pushes to the approver's phone via
 * Auth0, and — only if a human taps approve — mints a credential whose session
 * policy it builds from that stored row. Nothing here can widen the scope.
 */
async function elevated(
  action: string,
  verb: "stop" | "start" | "reboot",
  instanceId: string,
  reason: string,
): Promise<void> {
  const res = await fetch(`${BROKER_URL}/request-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, instanceId, reason, requestedBy: REQUESTED_BY }),
  });
  const outcome: any = await res.json();

  if (outcome.status !== "approved") {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: outcome.status ?? "error",
          detail: outcome.error ?? `Not approved (${outcome.status}).`,
          hint: "A human must approve this on their phone before it can run.",
        },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  const c = outcome.credentials;
  const ec2 = new EC2Client({
    region: REGION,
    credentials: {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
    },
  });

  if (verb === "stop") await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  else if (verb === "start") await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  else await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));

  emit({
    message: `${verb} initiated for ${instanceId}`,
    instanceId,
    approvedBy: outcome.approvedBy,
    planId: outcome.planId,
    credentialExpiresAt: outcome.expiresAt,
  });
}

async function main(): Promise<void> {
  const [command, arg, ...rest] = process.argv.slice(2);
  const reason = rest.join(" ") || "requested through ClawOps";

  switch (command) {
    case "monitor":
      emit(await monitorInstances());
      return;
    case "reboot":
      await elevated("ec2:RebootInstances", "reboot", instanceIdOrDie(arg), reason);
      return;
    case "start":
      await elevated("ec2:StartInstances", "start", instanceIdOrDie(arg), reason);
      return;
    case "stop":
      await elevated("ec2:StopInstances", "stop", instanceIdOrDie(arg), reason);
      return;
    case "help":
    case "--help":
    case undefined:
      console.log(USAGE);
      return;
    default:
      fail(`Unknown command: ${JSON.stringify(command)}\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  const e = err as { name?: string; message?: string };
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
ubuntu@ip-172-31-15-229:~/ClawOps$
