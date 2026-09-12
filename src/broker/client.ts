// Agent-side view of the broker. This is the entire privileged surface the
// agent has: it can propose an action and it can spend an approval someone
// else granted. Nothing here can approve anything.

import type { ScopedCredentials } from "../aws/sts";
import type { Action, ApprovalRequest } from "./store";

const BROKER = process.env.CLAWOPS_BROKER_URL ?? "http://127.0.0.1:7171";

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BROKER}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // A broker that is not running is the safe state, but it is also a
    // confusing one to debug from a Slack message, so name it precisely.
    throw new Error(
      `Approval broker is not reachable at ${BROKER}. No state change can be approved until it is running.`,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!response.ok || payload.ok !== true)
    throw new Error(payload.error ?? `Broker returned ${response.status}.`);
  return payload as T;
}

/** Propose an action. Returns the request a human now has to decide on. */
export async function requestApproval(
  action: Action,
  instanceId: string,
  reason: string,
): Promise<ApprovalRequest> {
  const { request } = await post<{ request: ApprovalRequest }>("/request", {
    action,
    instanceId,
    reason,
  });
  return request;
}

/**
 * Trade an approved request for credentials. Fails — by design — when the
 * request is unapproved, already spent, expired, or was approved for a
 * different instance.
 */
export async function mintCredentials(
  requestId: string,
  action: Action,
  instanceId: string,
): Promise<{ credentials: ScopedCredentials; approvedBy: string }> {
  return post<{ credentials: ScopedCredentials; approvedBy: string }>("/mint", {
    requestId,
    action,
    instanceId,
  });
}
