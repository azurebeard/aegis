// Unit tests for the pure phantom-intent detector. Run with:
//   node --test scripts/verify-phantom-intents.test.mjs
//
// The Azure-blob IO of the CLI driver is intentionally out of scope here;
// it shares the same patterns as verify-audit-chain.mjs which is exercised
// via the live-tenant operator workflow.

import test from "node:test";
import assert from "node:assert/strict";

import { detectPhantomIntents } from "./verify-phantom-intents.mjs";

const TENANT = "00000000-0000-0000-0000-000000000001";
const NOW_MS = Date.parse("2026-05-21T12:00:00.000Z");

function mkIntent(seq, startedAt) {
  return {
    source: "report.email.intent",
    eventType: "report.email.intent",
    tenantId: TENANT,
    seq,
    startedAt,
  };
}

function mkOutcome(intentLineSeq, startedAt, eventType = "report.email.sent") {
  return {
    source: "report.email.sent",
    eventType,
    tenantId: TENANT,
    intentLineSeq,
    startedAt,
  };
}

test("clean chain — every intent has a paired outcome → no phantoms", () => {
  const phantoms = detectPhantomIntents({
    intents: [
      mkIntent(10, "2026-05-21T10:00:00.000Z"),
      mkIntent(12, "2026-05-21T10:30:00.000Z"),
    ],
    outcomes: [
      mkOutcome(10, "2026-05-21T10:00:05.000Z"),
      mkOutcome(12, "2026-05-21T10:30:08.000Z"),
    ],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.deepEqual(phantoms, []);
});

test("intent without paired outcome older than grace → phantom", () => {
  const startedAt = "2026-05-21T11:00:00.000Z"; // 60 minutes before NOW
  const phantoms = detectPhantomIntents({
    intents: [mkIntent(42, startedAt)],
    outcomes: [],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.equal(phantoms.length, 1);
  assert.equal(phantoms[0].intentSeq, 42);
  assert.equal(phantoms[0].tenantId, TENANT);
  assert.equal(phantoms[0].startedAt, startedAt);
  assert.equal(phantoms[0].ageMinutes, 60);
  assert.equal(phantoms[0].reason, "no-paired-outcome");
});

test("intent within grace window is NOT flagged (outcome may still be inflight)", () => {
  // 5 minutes ago; grace is 10 min.
  const startedAt = new Date(NOW_MS - 5 * 60_000).toISOString();
  const phantoms = detectPhantomIntents({
    intents: [mkIntent(99, startedAt)],
    outcomes: [],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.deepEqual(phantoms, []);
});

test("report.email.failed outcomes pair with intents same as report.email.sent", () => {
  const phantoms = detectPhantomIntents({
    intents: [mkIntent(5, "2026-05-21T10:00:00.000Z")],
    outcomes: [mkOutcome(5, "2026-05-21T10:00:02.000Z", "report.email.failed")],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.deepEqual(phantoms, []);
});

test("malformed intent startedAt is flagged (can't reason about freshness)", () => {
  const phantoms = detectPhantomIntents({
    intents: [mkIntent(7, "not-a-real-iso-timestamp")],
    outcomes: [],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.equal(phantoms.length, 1);
  assert.equal(phantoms[0].reason, "missing-or-invalid-startedAt");
  assert.equal(phantoms[0].ageMinutes, null);
});

test("multi-tenant — intent for tenant A does not pair with outcome for tenant B", () => {
  const intentA = { ...mkIntent(11, "2026-05-21T10:00:00.000Z"), tenantId: "tenant-A" };
  // Outcome with the same intentLineSeq but DIFFERENT tenantId — must NOT pair.
  const outcomeB = { ...mkOutcome(11, "2026-05-21T10:00:05.000Z"), tenantId: "tenant-B" };
  const phantoms = detectPhantomIntents({
    intents: [intentA],
    outcomes: [outcomeB],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.equal(phantoms.length, 1);
  assert.equal(phantoms[0].tenantId, "tenant-A");
  assert.equal(phantoms[0].intentSeq, 11);
});

test("outcome without intentLineSeq back-reference is ignored for pairing", () => {
  const phantoms = detectPhantomIntents({
    intents: [mkIntent(3, "2026-05-21T10:00:00.000Z")],
    outcomes: [
      // Malformed outcome — no intentLineSeq. Should not pair with intent.seq=3.
      { source: "report.email.sent", tenantId: TENANT, startedAt: "2026-05-21T10:00:05.000Z" },
    ],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.equal(phantoms.length, 1);
  assert.equal(phantoms[0].intentSeq, 3);
});

test("phantom order is oldest-first (operator sees the most concerning finding first)", () => {
  const phantoms = detectPhantomIntents({
    intents: [
      mkIntent(100, "2026-05-21T08:00:00.000Z"), // 4h old
      mkIntent(101, "2026-05-21T11:00:00.000Z"), // 1h old
      mkIntent(102, "2026-05-21T06:00:00.000Z"), // 6h old — oldest
    ],
    outcomes: [],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.equal(phantoms.length, 3);
  assert.equal(phantoms[0].intentSeq, 102);
  assert.equal(phantoms[1].intentSeq, 100);
  assert.equal(phantoms[2].intentSeq, 101);
});

test("orphan outcome (no matching intent) does not mask a real phantom", () => {
  // Real-world developer bug: outcome line lands with intentLineSeq=999 but
  // no intent.seq=999 exists. The intent line that DID land (seq=5) has no
  // matching outcome. Both anomalies are surfaced together:
  //   - intent.seq=5 is reported as a phantom (no paired outcome).
  //   - the orphan outcome with intentLineSeq=999 is silently ignored
  //     here (out-of-scope; verify-audit-chain.mjs surfaces shape mismatches).
  // This test pins the "phantom is NOT masked by an unrelated outcome".
  const phantoms = detectPhantomIntents({
    intents: [mkIntent(5, "2026-05-21T08:00:00.000Z")],
    outcomes: [
      mkOutcome(999, "2026-05-21T10:00:05.000Z"), // dangling — no intent.seq=999
    ],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.equal(phantoms.length, 1);
  assert.equal(phantoms[0].intentSeq, 5);
});

test("non-numeric intent.seq is skipped (defensive — should never happen)", () => {
  const phantoms = detectPhantomIntents({
    intents: [
      { source: "report.email.intent", tenantId: TENANT, startedAt: "2026-05-21T08:00:00.000Z" }, // no seq
      mkIntent(50, "2026-05-21T08:00:00.000Z"),
    ],
    outcomes: [],
    graceMinutes: 10,
    nowEpochMs: NOW_MS,
  });
  assert.equal(phantoms.length, 1);
  assert.equal(phantoms[0].intentSeq, 50);
});
