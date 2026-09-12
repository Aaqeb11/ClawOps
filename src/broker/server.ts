#!/usr/bin/env node
//
// The approval broker. Runs as its own process, bound to loopback, holding the
// two secrets the agent must never have: the elevated role arn and its external
// id. The agent can ask for permission and can spend permission a human has
// granted — it can never grant permission to itself.
//
//   POST /request   agent   propose an action, get a request id
//   POST /approve   human   grant or deny it            <- Auth0 guards this
//   POST /mint      agent   trade an approval for 15-minute credentials
//   GET  /requests  either  inspect the queue
//
// Start with: node dist/broker/server.js

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { mintScopedCredentials } from "../aws/sts";
import { ApprovalStore, type Action } from "./store";

const PORT = Number(process.env.CLAWOPS_BROKER_PORT ?? 7171);
const ACTIONS: Action[] = ["reboot", "start", "stop"];
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

const store = new ApprovalStore();

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A broker that can be OOM'd by a POST body is a broker that can be
    // switched off by anything that reaches it.
    if (size > 64 * 1024) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Validate the (action, instanceId) pair shared by /request and /mint. Both
 * endpoints check it: /mint re-validates rather than trusting the stored
 * request, so a malformed id can never reach the policy builder.
 */
function readTarget(
  body: Record<string, unknown>,
): { ok: true; action: Action; instanceId: string } | { ok: false; error: string } {
  const action = str(body, "action");
  const instanceId = str(body, "instanceId");
  if (!action || !ACTIONS.includes(action as Action))
    return { ok: false, error: `action must be one of ${ACTIONS.join(", ")}.` };
  if (!instanceId || !INSTANCE_ID.test(instanceId))
    return { ok: false, error: "instanceId must look like i-0a3f9c21b7e4d500." };
  return { ok: true, action: action as Action, instanceId };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/requests") {
    send(res, 200, { ok: true, requests: store.list() });
    return;
  }

  if (req.method !== "POST") {
    send(res, 405, { ok: false, error: `Cannot ${req.method} ${url}.` });
    return;
  }

  const body = await readJson(req);

  switch (url) {
    case "/request": {
      const target = readTarget(body);
      if (!target.ok) return send(res, 400, { ok: false, error: target.error });

      const reason = str(body, "reason");
      // No silent default. An approver reading a Slack card needs to know why,
      // and a request with no stated reason is not reviewable.
      if (!reason)
        return send(res, 400, { ok: false, error: "reason is required — say why this is needed." });

      const request = store.create(target.action, target.instanceId, reason);
      return send(res, 201, { ok: true, request });
    }

    case "/approve": {
      // AUTH0: this endpoint is the whole trust boundary. Wire the Auth0
      // access-token check here and take `approver` from the verified `sub`
      // claim instead of the request body — until then any caller that can
      // reach loopback can approve.
      const requestId = str(body, "requestId");
      const decision = str(body, "decision") ?? "approve";
      const approver = str(body, "approver");
      if (!requestId) return send(res, 400, { ok: false, error: "requestId is required." });
      if (!approver) return send(res, 400, { ok: false, error: "approver is required." });
      if (decision !== "approve" && decision !== "deny")
        return send(res, 400, { ok: false, error: "decision must be approve or deny." });

      const result = store.decide(requestId, decision, approver);
      if (!result.ok) return send(res, 409, { ok: false, error: result.error });
      return send(res, 200, { ok: true, request: result.request });
    }

    case "/mint": {
      const target = readTarget(body);
      if (!target.ok) return send(res, 400, { ok: false, error: target.error });
      const requestId = str(body, "requestId");
      if (!requestId) return send(res, 400, { ok: false, error: "requestId is required." });

      const claim = store.consume(requestId, target.action, target.instanceId);
      if (!claim.ok) return send(res, 403, { ok: false, error: claim.error });

      const credentials = await mintScopedCredentials(
        target.action,
        target.instanceId,
        requestId,
        claim.request.approver ?? "unknown",
      );
      return send(res, 200, { ok: true, credentials, approvedBy: claim.request.approver });
    }

    default:
      send(res, 404, { ok: false, error: `No such endpoint: ${url}` });
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // Never echo the failure verbatim to the caller — an STS error can quote
    // the role arn back. Log locally, return the shape only.
    console.error(`[broker] ${req.method} ${req.url} failed: ${message}`);
    if (!res.headersSent) send(res, 500, { ok: false, error: "Broker could not complete the request." });
  });
});

// Loopback only. The broker holds the keys to every state change in the
// account; it must not be reachable from the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[broker] listening on 127.0.0.1:${PORT}`);
});
