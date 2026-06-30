// Co-located node:test cases for the pure helpers exported by
// scripts/verify-audit-chain.mjs. The full CLI driver is gated behind the
// `invokedAsCli` check so importing this module from a test does not
// trigger a real audit-blob walk.
//
// Run with:  node --test scripts/verify-audit-chain.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkRecipientHashFieldXor,
  filenameForSource,
} from "./verify-audit-chain.mjs";

// SEC-I-L12-03 — XOR rule on report.email.intent only.

test("returns null for non-intent sources regardless of fields", () => {
  // Other sources (ingest.*, report.snapshot, agent.*) do not carry the
  // recipient-hash fields. The XOR check must not flag absent fields there.
  assert.equal(checkRecipientHashFieldXor({}, "ingest.intuneDeviceCompliance"), null);
  assert.equal(checkRecipientHashFieldXor({}, "report.snapshot"), null);
  assert.equal(checkRecipientHashFieldXor({}, "report.email.sent"), null);
  assert.equal(checkRecipientHashFieldXor({}, "agent.posture.run"), null);
});

test("returns null when only recipientHashSalted is present (legacy field path)", () => {
  const issue = checkRecipientHashFieldXor(
    { recipientHashSalted: "abc123" },
    "report.email.intent",
  );
  assert.equal(issue, null);
});

test("returns null when only recipientHashSaltedV2 is present (peppered path)", () => {
  const issue = checkRecipientHashFieldXor(
    { recipientHashSaltedV2: "def456" },
    "report.email.intent",
  );
  assert.equal(issue, null);
});

test("flags both-present as XOR violation (orchestrator double-write bug)", () => {
  const issue = checkRecipientHashFieldXor(
    { recipientHashSalted: "abc123", recipientHashSaltedV2: "def456" },
    "report.email.intent",
  );
  assert.notEqual(issue, null);
  assert.match(issue, /both recipientHashSalted and recipientHashSaltedV2 present/);
  assert.match(issue, /ADR-0030 §C.21/);
});

test("flags neither-present as XOR violation (missing recipient fingerprint)", () => {
  const issue = checkRecipientHashFieldXor({}, "report.email.intent");
  assert.notEqual(issue, null);
  assert.match(issue, /neither recipientHashSalted nor recipientHashSaltedV2 present/);
  assert.match(issue, /ADR-0030 §C.21/);
});

test("non-string field types are treated as absent (type guard, not value guard)", () => {
  // The check is `typeof === "string"` — null/undefined/numbers don't count
  // as "present". A line with `recipientHashSalted: null` is therefore
  // treated as missing, which (with no V2) is a violation.
  assert.notEqual(
    checkRecipientHashFieldXor({ recipientHashSalted: null }, "report.email.intent"),
    null,
  );
  assert.notEqual(
    checkRecipientHashFieldXor({ recipientHashSaltedV2: 42 }, "report.email.intent"),
    null,
  );
  // Mixed: legacy string + V2 null is fine (V1-only).
  assert.equal(
    checkRecipientHashFieldXor(
      { recipientHashSalted: "abc", recipientHashSaltedV2: null },
      "report.email.intent",
    ),
    null,
  );
});

test("rule scoped strictly to literal source string 'report.email.intent'", () => {
  // Defence against future schema where someone might emit a near-alias
  // (e.g. 'report.email.intent.v2') — the check must NOT apply, since the
  // dispatch + rule live together and a new source would carry its own
  // contract.
  assert.equal(
    checkRecipientHashFieldXor({}, "report.email.intent.v2"),
    null,
  );
  assert.equal(
    checkRecipientHashFieldXor({}, "report.email.intents"),
    null,
  );
});

// SEC-OBS-AUDIT-CHAIN-01 — pin the filename dispatch table. Drift between
// this and `api/src/lib/audit.ts:auditFilenameForSource` results in the
// verifier reading zero lines and exiting 0, masking a real chain-walk
// failure. The TS side is unit-tested separately; these cases pin the JS
// twin so the two stay byte-for-byte aligned.

test("filenameForSource: agent.* sources land at agent-run.ndjson", () => {
  assert.equal(filenameForSource("agent.aegis.brief"), "agent-run.ndjson");
  assert.equal(filenameForSource("agent.aegis.posture"), "agent-run.ndjson");
  assert.equal(filenameForSource("agent.aegis.incidents"), "agent-run.ndjson");
});

test("filenameForSource: report.snapshot lands at report.ndjson", () => {
  assert.equal(filenameForSource("report.snapshot"), "report.ndjson");
});

test("filenameForSource: report-email partitions split intent vs sent+failed", () => {
  assert.equal(filenameForSource("report.email.intent"), "report-email-intent.ndjson");
  assert.equal(filenameForSource("report.email.sent"), "report-email-sent.ndjson");
});

test("filenameForSource: report.html.share lands at report-html-share.ndjson (ADR-0030 §C.22)", () => {
  assert.equal(filenameForSource("report.html.share"), "report-html-share.ndjson");
});

test("filenameForSource: every other source falls through to ingest.ndjson", () => {
  assert.equal(filenameForSource("graph.security.incidents"), "ingest.ndjson");
  assert.equal(filenameForSource("azure.security.defenderForCloud.secureScores"), "ingest.ndjson");
  assert.equal(filenameForSource("cisa.kev"), "ingest.ndjson");
  assert.equal(filenameForSource("operator.stack"), "ingest.ndjson");
});

test("filenameForSource: near-aliases do NOT collapse to the per-source filename", () => {
  // A future near-alias source (e.g. a `.v2` variant) must NOT silently
  // claim the same filename — it belongs to a new chain entirely.
  assert.equal(filenameForSource("report.html.share.v2"), "ingest.ndjson");
  assert.equal(filenameForSource("report.snapshot.v2"), "ingest.ndjson");
});
