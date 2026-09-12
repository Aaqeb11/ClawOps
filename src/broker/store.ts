// The approval state machine. Deliberately pure — no AWS, no HTTP — so the
// rules that decide whether a state change may happen can be tested directly.
//
// A request moves pending -> approved -> consumed, and nowhere else. Every
// other transition is a rejection with a reason the agent can report verbatim.

import { randomUUID } from "node:crypto";

export type Action = "reboot" | "start" | "stop";

export type RequestState = "pending" | "approved" | "denied" | "consumed";

export interface ApprovalRequest {
  requestId: string;
  action: Action;
  instanceId: string;
  reason: string;
  state: RequestState;
  createdAt: number;
  /** Set when a human approves. The mint window is measured from here. */
  approvedAt: number | null;
  /** Who approved. Populated by the Auth0 subject once auth is wired. */
  approver: string | null;
}

/** Unapproved requests die young — a stale proposal must not be approvable. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Gap between a human approving and the agent minting. Short on purpose: an
 * approval is consent to act *now*, not a credential the agent can bank.
 */
export const MINT_WINDOW_MS = 2 * 60 * 1000;

export class ApprovalStore {
  // ponytail: in-memory, so a broker restart voids pending approvals. That is
  // the safe direction to fail. Swap for Redis/DynamoDB if the broker ever
  // needs more than one instance.
  private requests = new Map<string, ApprovalRequest>();

  constructor(private now: () => number = Date.now) {}

  create(action: Action, instanceId: string, reason: string): ApprovalRequest {
    const request: ApprovalRequest = {
      requestId: randomUUID(),
      action,
      instanceId,
      reason,
      state: "pending",
      createdAt: this.now(),
      approvedAt: null,
      approver: null,
    };
    this.requests.set(request.requestId, request);
    return request;
  }

  get(requestId: string): ApprovalRequest | null {
    return this.requests.get(requestId) ?? null;
  }

  list(): ApprovalRequest[] {
    return [...this.requests.values()];
  }

  /**
   * Record a human decision. Only a live pending request can be decided, so a
   * second approval of an already-consumed request cannot resurrect it.
   */
  decide(
    requestId: string,
    decision: "approve" | "deny",
    approver: string,
  ): { ok: true; request: ApprovalRequest } | { ok: false; error: string } {
    const request = this.requests.get(requestId);
    if (!request) return { ok: false, error: "No such approval request." };
    if (request.state !== "pending")
      return { ok: false, error: `Request is already ${request.state}.` };
    if (this.now() - request.createdAt > PENDING_TTL_MS)
      return { ok: false, error: "Request expired before it was approved." };

    request.state = decision === "approve" ? "approved" : "denied";
    request.approvedAt = this.now();
    request.approver = approver;
    return { ok: true, request };
  }

  /**
   * Claim an approved request for exactly one credential mint. Consumption
   * happens here rather than after the AWS call so a failed call cannot be
   * retried into a second privileged session.
   */
  consume(
    requestId: string,
    action: Action,
    instanceId: string,
  ): { ok: true; request: ApprovalRequest } | { ok: false; error: string } {
    const request = this.requests.get(requestId);
    if (!request) return { ok: false, error: "No such approval request." };
    if (request.state !== "approved")
      return { ok: false, error: `Request is ${request.state}, not approved.` };

    // An approval authorises one action on one instance. Re-pointing it at a
    // different target is the whole attack this broker exists to stop.
    if (request.action !== action || request.instanceId !== instanceId)
      return {
        ok: false,
        error: `Approval was for ${request.action} on ${request.instanceId}, not ${action} on ${instanceId}.`,
      };

    if (this.now() - (request.approvedAt ?? 0) > MINT_WINDOW_MS)
      return { ok: false, error: "Approval expired. Ask for a fresh one." };

    request.state = "consumed";
    return { ok: true, request };
  }
}
