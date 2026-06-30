#!/usr/bin/env node
// Standalone audit-chain verifier (ADR-0015 §7).
//
// Walks the audit blob for a given (source, tenantId, from..to) window and
// verifies:
//   1. Each line's `lineSha256` matches the recomputed hash over its
//      canonical form (lineSha256 field excluded).
//   2. `prevLineSha256` on each line matches the previous line's `lineSha256`.
//   3. `seq` is strictly `prev.seq + 1` within the chain.
//   4. The first line in the window (chain head) is either the salted
//      genesis sentinel or a known boundary marker; sixty-four zeros is
//      rejected as malformed (ADR-0015 §3).
//
// Usage:
//   node scripts/verify-audit-chain.mjs \
//     --source graph.security.incidents \
//     --tenant <guid> \
//     --from 2026-04-18 \
//     --to   2026-05-18 \
//     --audit-mi-client-id <guid> \
//     --audit-blob-endpoint https://<acct>.blob.core.windows.net \
//     [--audit-container audit]
//
// Exit code 0 on clean chain; 1 on any verification failure (prints a
// human-readable report).
//
// ADR-0034 §3.3 + WS10 Phase 8D verdict M-1 — known-recoverable gap class:
// the `graph.identity.conditionalAccess.policies` source emits a multi-line
// commit per run (1 ingest.run + N ca.policy.changed). The orchestrator
// commits IngestHealth pointing at the FINAL sha BEFORE writing all lines;
// a FA crash mid-loop leaves IngestHealth ahead of the audit blob. If this
// verifier reports a gap on that source, the recovery procedure is:
//   1. Inspect FunctionAppLogs for the partially-written run (search for
//      the runId emitted in the ingest.run line that DID land).
//   2. Manually trigger the next ingest run via `POST /api/ingest/
//      conditional-access/run` (admin-only). The orchestrator re-diffs
//      against the table snapshot, so missed change-lines from the prior
//      run are re-emitted on the next change OR replaced by the next
//      successful diff (whichever happens first).
//   3. The verifier's gap report should then close on the next sweep.
// No manual blob editing required. The chain forward-only invariant is
// preserved because the seq counter never goes backwards — the recovery
// re-issues lines at higher seq numbers.

import { canonicalize } from "json-canonicalize";
import { createHash } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { BlockBlobClient, RestError } from "@azure/storage-blob";

const BUFFER_ZERO_SHA256_HEX = "0".repeat(64);
const CHAIN_SALT_VERSION = "v2";

// FD-B1-03 (ADR-0021 §Decision.5 + ADR-0027 §Decision.7 + ADR-0028 §Decision.9):
// the strict-enum check on the audit-line `status` field. Any value outside
// this set is a verification failure (exit 1). Extended with `degraded` when
// posture-agent first emits that status; extend again if a future specialist
// adds a new terminal state.
const ALLOWED_STATUS_VALUES = new Set([
  "success",
  "no_data",
  "error",
  "budget_exhausted",
  "circuit_open",
  "cache_hit",
  "degraded",
]);

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      "Usage: verify-audit-chain.mjs [flags]",
      "  --source <string>                 e.g. graph.security.incidents",
      "  --tenant <guid>                   tenantId",
      "  --from <yyyy-mm-dd>               window start (inclusive, UTC)",
      "  --to   <yyyy-mm-dd>               window end   (inclusive, UTC)",
      "  --audit-mi-client-id <guid>       reader MI (audit read)",
      "  --audit-blob-endpoint <url>       https://<acct>.blob.core.windows.net",
      "  --audit-container <name>          default 'audit'",
    ].join("\n"),
  );
  process.exit(msg ? 2 : 0);
}

// CLI driver — only runs when invoked as a script, not when imported as a
// module from the test file. Matches the gating used by
// `verify-phantom-intents.mjs` so the pure helpers below stay importable.
const invokedAsCli =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("verify-audit-chain.mjs");

if (invokedAsCli) {
  await runCli();
}

async function runCli() {
const args = parseArgs(process.argv.slice(2));
if (!args.source) usage("--source is required");
if (!args.tenant) usage("--tenant is required");
if (!args.from || !args.to) usage("--from and --to are required");
if (!args["audit-mi-client-id"]) usage("--audit-mi-client-id is required");
if (!args["audit-blob-endpoint"]) usage("--audit-blob-endpoint is required");

const container = args["audit-container"] ?? "audit";
const source = args.source;
const tenantId = args.tenant;
const expectedGenesis = sha256Hex(
  Buffer.from(
    `aegis:audit-chain:${CHAIN_SALT_VERSION}:${source}:${tenantId}:genesis`,
    "utf-8",
  ),
);

const from = new Date(`${args.from}T00:00:00.000Z`);
const to = new Date(`${args.to}T23:59:59.999Z`);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
  usage(`--from / --to must be yyyy-mm-dd UTC dates`);
}

const credential = new DefaultAzureCredential({
  managedIdentityClientId: args["audit-mi-client-id"],
});

const issues = [];
const lines = [];
const safeSource = source.replace(/[^A-Za-z0-9._-]/g, "_");
// Filename dispatch must mirror `api/src/lib/audit.ts:auditFilenameForSource`
// exactly. Keep this in sync with the
// TS path builder — drift results in the verifier silently reading zero
// lines and exiting 0 ("no lines for..."), masking a real chain-walk
// failure. The pure helper is exported below for unit-test coverage of
// the dispatch table without a live audit blob.
const filename = filenameForSource(source);

for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) {
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const path = `${safeSource}/${y}/${m}/${day}/${filename}`;
  const blob = new BlockBlobClient(
    `${args["audit-blob-endpoint"]}/${container}/${path}`,
    credential,
  );
  try {
    const buffer = await blob.downloadToBuffer();
    const text = buffer.toString("utf-8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        issues.push(`[parse] ${path}: ${(err && err.message) || err}`);
        continue;
      }
      if (parsed.tenantId !== tenantId) continue; // other tenant
      lines.push({ blob: path, parsed });
    }
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) continue;
    throw err;
  }
}

if (lines.length === 0) {
  console.log(`[verify] no lines for (${source}, ${tenantId}) in window ${args.from}..${args.to}`);
  process.exit(0);
}

// Sort by seq ascending (stable for ties, which shouldn't occur).
lines.sort((a, b) => a.parsed.seq - b.parsed.seq);

let prevLineSha = null;
let prevSeq = null;
for (let i = 0; i < lines.length; i++) {
  const { blob, parsed } = lines[i];
  const { lineSha256, ...rest } = parsed;
  if (typeof lineSha256 !== "string") {
    issues.push(`[${blob} seq=${parsed.seq}] missing lineSha256`);
    continue;
  }
  // Skip pre-chain v1 lines that legitimately lack chain fields.
  if (parsed.schemaVersion === 1) {
    prevSeq = parsed.seq;
    continue;
  }
  if (typeof rest.prevLineSha256 !== "string") {
    issues.push(`[${blob} seq=${parsed.seq}] missing prevLineSha256`);
    continue;
  }
  if (rest.prevLineSha256 === BUFFER_ZERO_SHA256_HEX) {
    issues.push(`[${blob} seq=${parsed.seq}] prevLineSha256 is sixty-four zeros (malformed)`);
  }
  // FD-B1-03: strict-enum check on `status`. A line with a status value
  // outside `ALLOWED_STATUS_VALUES` is a verification failure. `status` is
  // optional on some line shapes (e.g. `audit.chain.start`) — a missing
  // value is fine, but a present-and-unknown value is not.
  if (rest.status !== undefined && !ALLOWED_STATUS_VALUES.has(rest.status)) {
    issues.push(
      `[${blob} seq=${parsed.seq}] status=${JSON.stringify(rest.status)} is not in the allowed set: ${[...ALLOWED_STATUS_VALUES].join(", ")}`,
    );
  }
  // SEC-I-L12-03: report.email.intent lines must carry exactly one of
  // `recipientHashSalted` (legacy, pre-pepper) or `recipientHashSaltedV2`
  // (peppered). Pure predicate `checkRecipientHashFieldXor` so the rule is
  // unit-testable without live blobs; see `verify-audit-chain.test.mjs`.
  const xorViolation = checkRecipientHashFieldXor(rest, source);
  if (xorViolation !== null) {
    issues.push(`[${blob} seq=${parsed.seq}] ${xorViolation}`);
  }
  const recomputed = sha256Hex(Buffer.from(canonicalize(rest), "utf-8"));
  if (recomputed !== lineSha256) {
    issues.push(
      `[${blob} seq=${parsed.seq}] lineSha256 mismatch: stored=${lineSha256} recomputed=${recomputed}`,
    );
  }
  if (prevLineSha === null) {
    // First chained line — must chain to genesis or a valid boundary.
    if (rest.prevLineSha256 !== expectedGenesis && parsed.eventType !== "audit.chain.start") {
      issues.push(
        `[${blob} seq=${parsed.seq}] chain-head prevLineSha256=${rest.prevLineSha256} is not the genesis sentinel ${expectedGenesis}; eventType=${parsed.eventType}`,
      );
    }
  } else if (rest.prevLineSha256 !== prevLineSha) {
    issues.push(
      `[${blob} seq=${parsed.seq}] prevLineSha256 mismatch: stored=${rest.prevLineSha256} expected=${prevLineSha}`,
    );
  }
  if (prevSeq !== null && parsed.seq !== prevSeq + 1) {
    issues.push(
      `[${blob} seq=${parsed.seq}] seq gap: prev=${prevSeq} current=${parsed.seq}`,
    );
  }
  prevLineSha = lineSha256;
  prevSeq = parsed.seq;
}

if (issues.length === 0) {
  console.log(`[verify] CLEAN — ${lines.length} lines verified for (${source}, ${tenantId}).`);
  process.exit(0);
}

console.error(`[verify] FAILED — ${issues.length} issue(s):`);
for (const i of issues) console.error(`  - ${i}`);
process.exit(1);
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** SEC-OBS-AUDIT-CHAIN-01 — pure dispatch function mapping an audit-chain
 *  source string to its per-source NDJSON filename. Mirrors
 *  `api/src/lib/audit.ts:auditFilenameForSource` byte-for-byte. Exported
 *  so the co-located node:test file can pin the dispatch table without
 *  spinning up a real audit blob walk. Any new TS-side dispatch entry
 *  MUST land here in the same commit, asserted via the test below. */
export function filenameForSource(s) {
  if (s.startsWith("agent.")) return "agent-run.ndjson";
  if (s === "report.snapshot") return "report.ndjson";
  if (s === "report.email.intent") return "report-email-intent.ndjson";
  if (s === "report.email.sent") return "report-email-sent.ndjson"; // includes report.email.failed event types
  if (s === "report.html.share") return "report-html-share.ndjson"; // ADR-0030 §C.22
  return "ingest.ndjson";
}

/** SEC-I-L12-03 — pure XOR predicate for the recipient-hash field on
 *  `report.email.intent` lines. Returns a human-readable issue string when
 *  the invariant is broken (both fields present OR neither present), or
 *  `null` when the line is fine (or not subject to the check). Exported so
 *  the co-located node:test file can exercise the rule without spinning up
 *  a real audit blob. */
export function checkRecipientHashFieldXor(rest, lineSource) {
  if (lineSource !== "report.email.intent") return null;
  const hasV1 = typeof rest.recipientHashSalted === "string";
  const hasV2 = typeof rest.recipientHashSaltedV2 === "string";
  if (hasV1 && hasV2) {
    return "recipient-hash XOR violation: both recipientHashSalted and recipientHashSaltedV2 present (ADR-0030 §C.21 — must be exactly one)";
  }
  if (!hasV1 && !hasV2) {
    return "recipient-hash XOR violation: neither recipientHashSalted nor recipientHashSaltedV2 present (ADR-0030 §C.21 — must be exactly one)";
  }
  return null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}
