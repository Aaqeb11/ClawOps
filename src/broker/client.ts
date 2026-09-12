import { existsSync } from "node:fs";

// Agent-side view of the broker. This is the entire privileged surface the
// agent has: it can ask for a write action and, if a human approves it on
// their phone, it receives credentials for that one action. It cannot approve
// anything, and it never learns the role arn or the external id.

import type { Action } from "../types";

/**
 * Where the broker listens.
 *
 * Inside a container `127.0.0.1` is the container itself, so the default has
 * to differ by where this runs — the agent reported the broker unreachable
 * for exactly this reason. Detect the container rather than depend on the
 * caller remembering an env prefix; an explicit CLAWOPS_BROKER_URL still wins.
 */
const BROKER =
  process.env.CLAWOPS_BROKER_URL ??
  (existsSync("/.dockerenv") ? "http://host.docker.internal:3001" : "http://127.0.0.1:3001");

/**
 * The agent's container routes every request through NanoClaw's egress proxy
 * and sets no NO_PROXY, so a plain fetch to the broker goes to the proxy
 * instead of the broker and comes back as "not reachable". The broker is on
 * the host, not the internet, so exempt exactly its hostname — everything
 * else still goes through the proxy, which is the point of having one.
 *
 * Set before the first fetch: undici builds its proxy agent from the
 * environment lazily, on first use.
 */
function bypassProxyForBroker(): void {
  const host = new URL(BROKER).hostname;
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const current = process.env[key] ?? "";
    const entries = current.split(",").map((s) => s.trim()).filter(Boolean);
    if (!entries.includes(host)) entries.push(host);
    process.env[key] = entries.join(",");
  }
}

bypassProxyForBroker();

/** The verbs the CLI speaks, mapped to the IAM actions the broker allows. */
export const IAM_ACTION: Record<Action, string> = {
  stop: "ec2:StopInstances",
  start: "ec2:StartInstances",
  reboot: "ec2:RebootInstances",
};

export interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

interface ActionResponse {
  status: "approved" | "denied" | "expired" | "rejected" | "error";
  planId?: string;
  approvedBy?: string;
  credentials?: ScopedCredentials;
  error?: string;
}

/**
 * Ask for one write action and wait for a human to decide.
 *
 * This call blocks while the approver's phone is prompted, so it can sit open
 * for as long as the approval window lasts — that pause is the point, not a
 * stall. Anything other than `approved` comes back as a refusal the agent
 * should report verbatim rather than retry.
 */
export async function requestAction(
  action: Action,
  instanceId: string,
  reason: string,
  requestedBy: string,
): Promise<{ credentials: ScopedCredentials; approvedBy: string; planId: string }> {
  let response: Response;
  try {
    response = await fetch(`${BROKER}/request-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: IAM_ACTION[action],
        instanceId,
        reason,
        requestedBy,
      }),
    });
  } catch {
    // A broker that is not running is the safe state, but a confusing one to
    // debug from a chat message, so name it precisely.
    throw new Error(
      `Approval broker is not reachable at ${BROKER}. No state change can be approved until it is running.`,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as ActionResponse;

  if (payload.status !== "approved" || !payload.credentials) {
    throw new Error(
      payload.error ??
        (payload.status === "denied"
          ? "A human denied this action."
          : payload.status === "expired"
            ? "The approval request expired with no answer."
            : `Broker returned ${payload.status ?? response.status}.`),
    );
  }

  return {
    credentials: payload.credentials,
    approvedBy: payload.approvedBy ?? "unknown",
    planId: payload.planId ?? "unknown",
  };
}
