// Agent-side view of the broker. This is the entire privileged surface the
// agent has: it can ask for a write action and, if a human approves it on
// their phone, it receives credentials for that one action. It cannot approve
// anything, and it never learns the role arn or the external id.

import type { Action } from "../types";

const BROKER = process.env.CLAWOPS_BROKER_URL ?? "http://127.0.0.1:3001";

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
