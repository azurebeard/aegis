#!/usr/bin/env node
// Phantom-intent detector for the report-email audit chain (ADR-0030 §C.7).
//
// A `report.email.intent` line is emitted BEFORE the Graph send attempt;
// a paired `report.email.sent` OR `report.email.failed` line is emitted
// after. If the FA crashes mid-send (or the outcome write fails after the
// intent has landed), the intent stays on the chain forever with no paired
// outcome — a "phantom intent". This is a real-but-rare anomaly worth
// surfacing as a chain-integrity finding so the operator can manually
// reconcile (Exchange message trace + audit-chain replay).
//
// Pairing rule: outcome.intentLineSeq === intent.seq (see
// `api/src/lib/reportEmailAuditHooks.ts:155` — outcome lines carry an
// `intentLineSeq` back-reference to the intent's `seq` within the same
// `(tenantId, periodKey)` pair).
//
// Grace-period rule: an intent without a paired outcome whose
// `startedAt` is more recent than `grace_period_minutes` is NOT flagged —
// the outcome may still be in-flight from a long-running Graph call or
// queued for the next ingest sweep. Default grace is 10 minutes (Graph
// sendMail p99 ≈ 8s; 10 min absorbs cold-starts, replication lag, and
// the orchestrator's retry-on-ambiguous fallback).
//
// Usage:
//   node scripts/verify-phantom-intents.mjs \
//     --tenant <guid> \
//     --from 2026-04-18 \
//     --to   2026-05-18 \
//     [--grace-minutes 10] \
//     --audit-mi-client-id <guid> \
//     --audit-blob-endpoint https://<acct>.blob.core.windows.net \
//     [--audit-container audit]
//
// Exit code 0 on clean (no phantoms); 1 on phantoms found.

import { DefaultAzureCredential } from "@azure/identity";
import { BlockBlobClient, RestError } from "@azure/storage-blob";

const INTENT_SOURCE = "report.email.intent";
const OUTCOME_SOURCE = "report.email.sent"; // includes failed event types per ADR-0030 §C.7
const INTENT_FILENAME = "report-email-intent.ndjson";
const OUTCOME_FILENAME = "report-email-sent.ndjson";
const DEFAULT_GRACE_MINUTES = 10;

/** Pure phantom detection — given two arrays of audit lines (intents +
 *  outcomes) and a now-epoch + grace window, return the set of phantom
 *  intents. Exported so the co-located node:test file can exercise it
 *  without spinning up a real audit blob. */
export function detectPhantomIntents({
  intents,
  outcomes,
  graceMinutes,
  nowEpochMs,
}) {
  const graceWindowMs = graceMinutes * 60_000;
  const cutoffMs = nowEpochMs - graceWindowMs;
  // Index outcomes by (tenantId, intentLineSeq). Skip outcomes lacking a
  // back-reference — they're malformed but shouldn't break the join.
  const outcomeSeenByKey = new Set();
  for (const o of outcomes) {
    if (typeof o.intentLineSeq !== "number") continue;
    outcomeSeenByKey.add(`${o.tenantId}|${o.intentLineSeq}`);
  }
  const phantoms = [];
  for (const intent of intents) {
    if (typeof intent.seq !== "number") continue;
    if (typeof intent.tenantId !== "string") continue;
    const key = `${intent.tenantId}|${intent.seq}`;
    if (outcomeSeenByKey.has(key)) continue;
    // Grace-window guard: intents emitted in the recent window may still
    // have an outcome inflight. Only flag intents older than the cutoff.
    const startedMs = Date.parse(intent.startedAt ?? "");
    if (!Number.isFinite(startedMs)) {
      // Malformed timestamp — flag, since we can't reason about freshness.
      phantoms.push({
        tenantId: intent.tenantId,
        intentSeq: intent.seq,
        startedAt: intent.startedAt ?? "(missing)",
        ageMinutes: null,
        reason: "missing-or-invalid-startedAt",
      });
      continue;
    }
    if (startedMs > cutoffMs) continue; // still inside the grace window
    phantoms.push({
      tenantId: intent.tenantId,
      intentSeq: intent.seq,
      startedAt: intent.startedAt,
      ageMinutes: Math.floor((nowEpochMs - startedMs) / 60_000),
      reason: "no-paired-outcome",
    });
  }
  // Stable ordering: oldest first so the operator's first finding is the
  // most concerning.
  phantoms.sort((a, b) => {
    const aMs = Date.parse(a.startedAt ?? "");
    const bMs = Date.parse(b.startedAt ?? "");
    const aFinite = Number.isFinite(aMs);
    const bFinite = Number.isFinite(bMs);
    if (aFinite && bFinite) return aMs - bMs;
    if (aFinite) return -1;
    if (bFinite) return 1;
    return 0;
  });
  return phantoms;
}

// ---------------------------------------------------------------------------
// CLI driver — only runs when invoked as a script, not when imported as a
// module from the test file (node:test imports this file with import.meta.url
// set to the absolute path; argv[1] would still be the test file).
// ---------------------------------------------------------------------------

const invokedAsCli =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("verify-phantom-intents.mjs");

if (invokedAsCli) {
  await runCli();
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant) usage("--tenant is required");
  if (!args.from || !args.to) usage("--from and --to are required");
  if (!args["audit-mi-client-id"]) usage("--audit-mi-client-id is required");
  if (!args["audit-blob-endpoint"]) usage("--audit-blob-endpoint is required");

  const container = args["audit-container"] ?? "audit";
  const tenantId = args.tenant;
  const graceMinutes =
    args["grace-minutes"] !== undefined
      ? Number.parseInt(args["grace-minutes"], 10)
      : DEFAULT_GRACE_MINUTES;
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
    usage(`--grace-minutes must be a non-negative integer`);
  }

  const from = new Date(`${args.from}T00:00:00.000Z`);
  const to = new Date(`${args.to}T23:59:59.999Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    usage(`--from / --to must be yyyy-mm-dd UTC dates`);
  }

  const credential = new DefaultAzureCredential({
    managedIdentityClientId: args["audit-mi-client-id"],
  });

  const intents = await loadLines({
    credential,
    blobEndpoint: args["audit-blob-endpoint"],
    container,
    source: INTENT_SOURCE,
    filename: INTENT_FILENAME,
    tenantId,
    from,
    to,
  });
  const outcomes = await loadLines({
    credential,
    blobEndpoint: args["audit-blob-endpoint"],
    container,
    source: OUTCOME_SOURCE,
    filename: OUTCOME_FILENAME,
    tenantId,
    from,
    to,
  });

  const phantoms = detectPhantomIntents({
    intents,
    outcomes,
    graceMinutes,
    nowEpochMs: Date.now(),
  });

  if (phantoms.length === 0) {
    console.log(
      `[verify-phantom-intents] CLEAN — ${intents.length} intent(s) paired across ${outcomes.length} outcome(s) for tenant=${tenantId} in window ${args.from}..${args.to} (grace=${graceMinutes}m).`,
    );
    process.exit(0);
  }

  console.error(
    `[verify-phantom-intents] FAILED — ${phantoms.length} phantom intent(s) detected for tenant=${tenantId} in window ${args.from}..${args.to} (grace=${graceMinutes}m):`,
  );
  for (const p of phantoms) {
    const age = p.ageMinutes === null ? "?" : `${p.ageMinutes}m`;
    console.error(
      `  - intentSeq=${p.intentSeq} startedAt=${p.startedAt} age=${age} reason=${p.reason}`,
    );
  }
  console.error(
    `\nNext steps: cross-reference Exchange message trace + the report-email-sent.ndjson blob for each intentSeq above. A genuine phantom (no Graph message + no outcome line) is a FA crash mid-send; replay the audit chain after operator-initiated reconciliation.`,
  );
  process.exit(1);
}

async function loadLines({
  credential,
  blobEndpoint,
  container,
  source,
  filename,
  tenantId,
  from,
  to,
}) {
  const safeSource = source.replace(/[^A-Za-z0-9._-]/g, "_");
  const out = [];
  let parseSkipCount = 0;
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) {
    const y = String(d.getUTCFullYear()).padStart(4, "0");
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const path = `${safeSource}/${y}/${m}/${day}/${filename}`;
    const blob = new BlockBlobClient(`${blobEndpoint}/${container}/${path}`, credential);
    try {
      const buffer = await blob.downloadToBuffer();
      const text = buffer.toString("utf-8");
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line === "") continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.tenantId !== tenantId) continue;
          out.push(parsed);
        } catch {
          // Skip malformed lines and surface a counter at the end. WS10
          // SEC-M-PHANTOM-01 — silent parse failures could hide a phantom
          // (intent corrupted to JSON-invalid, outcome present), so the
          // operator must see the skip total. The canonical chain-integrity
          // tool (verify-audit-chain.mjs) still flags each individual line.
          parseSkipCount += 1;
        }
      }
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 404) continue;
      throw err;
    }
  }
  if (parseSkipCount > 0) {
    console.warn(
      `[verify-phantom-intents] WARN — skipped ${parseSkipCount} malformed line(s) in source=${source}. Run verify-audit-chain.mjs --source ${source} for per-line diagnosis. Phantom detection may be incomplete.`,
    );
  }
  return out;
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

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    [
      "usage: node scripts/verify-phantom-intents.mjs [options]",
      "  --tenant <guid>                   tenant ID to verify",
      "  --from <yyyy-mm-dd>               window start (inclusive, UTC)",
      "  --to   <yyyy-mm-dd>               window end   (inclusive, UTC)",
      `  --grace-minutes <n>               default ${DEFAULT_GRACE_MINUTES}`,
      "  --audit-mi-client-id <guid>       reader MI (audit read)",
      "  --audit-blob-endpoint <url>       https://<acct>.blob.core.windows.net",
      "  --audit-container <name>          default 'audit'",
    ].join("\n"),
  );
  process.exit(msg ? 2 : 0);
}
