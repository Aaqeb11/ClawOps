// Self-check for the approval state machine — the one piece of logic here that
// decides whether infrastructure may change. Run it with:
//
//   yarn ts-node src/broker/store.check.ts
//
// A controllable clock is passed in, so expiry is tested without sleeping.

import assert from "node:assert/strict";

import { ApprovalStore, MINT_WINDOW_MS, PENDING_TTL_MS } from "./store";

let now = 1_000_000;
const clock = () => now;

function fresh() {
  now = 1_000_000;
  return new ApprovalStore(clock);
}

// The happy path, and the only path that ends in credentials.
{
  const store = fresh();
  const request = store.create("stop", "i-0a3f9c21b7e4d500", "idle for 72h");
  assert.equal(request.state, "pending");

  assert.ok(store.decide(request.requestId, "approve", "auth0|mo").ok);
  const claim = store.consume(request.requestId, "stop", "i-0a3f9c21b7e4d500");
  assert.ok(claim.ok);
  assert.equal(claim.request.approver, "auth0|mo");
  assert.equal(store.get(request.requestId)?.state, "consumed");
}

// An unapproved request is worth nothing.
{
  const store = fresh();
  const request = store.create("stop", "i-0a3f9c21b7e4d500", "idle");
  const claim = store.consume(request.requestId, "stop", "i-0a3f9c21b7e4d500");
  assert.equal(claim.ok, false);
}

// A denied request is worth nothing either.
{
  const store = fresh();
  const request = store.create("stop", "i-0a3f9c21b7e4d500", "idle");
  store.decide(request.requestId, "deny", "auth0|mo");
  assert.equal(store.consume(request.requestId, "stop", "i-0a3f9c21b7e4d500").ok, false);
}

// One approval, one action. A replayed approval cannot mint twice.
{
  const store = fresh();
  const request = store.create("stop", "i-0a3f9c21b7e4d500", "idle");
  store.decide(request.requestId, "approve", "auth0|mo");
  assert.ok(store.consume(request.requestId, "stop", "i-0a3f9c21b7e4d500").ok);
  assert.equal(store.consume(request.requestId, "stop", "i-0a3f9c21b7e4d500").ok, false);
}

// The attack this broker exists to stop: approval for one instance, spent on
// another. Same for swapping the verb.
{
  const store = fresh();
  const request = store.create("reboot", "i-0a3f9c21b7e4d500", "wedged");
  store.decide(request.requestId, "approve", "auth0|mo");

  assert.equal(store.consume(request.requestId, "reboot", "i-0ffffffffffffffff").ok, false);
  assert.equal(store.consume(request.requestId, "stop", "i-0a3f9c21b7e4d500").ok, false);
  // Still spendable for what it was actually approved for.
  assert.ok(store.consume(request.requestId, "reboot", "i-0a3f9c21b7e4d500").ok);
}

// A stale proposal cannot be approved.
{
  const store = fresh();
  const request = store.create("stop", "i-0a3f9c21b7e4d500", "idle");
  now += PENDING_TTL_MS + 1;
  assert.equal(store.decide(request.requestId, "approve", "auth0|mo").ok, false);
}

// An approval is consent to act now, not a credential to bank.
{
  const store = fresh();
  const request = store.create("stop", "i-0a3f9c21b7e4d500", "idle");
  store.decide(request.requestId, "approve", "auth0|mo");
  now += MINT_WINDOW_MS + 1;
  assert.equal(store.consume(request.requestId, "stop", "i-0a3f9c21b7e4d500").ok, false);
}

// Unknown ids are rejected, not treated as absent-and-therefore-fine.
{
  const store = fresh();
  assert.equal(store.consume("not-a-request", "stop", "i-0a3f9c21b7e4d500").ok, false);
  assert.equal(store.decide("not-a-request", "approve", "auth0|mo").ok, false);
}

console.log("approval store: all checks passed");
