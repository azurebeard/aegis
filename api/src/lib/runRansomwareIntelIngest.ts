// ADR-0037 Layer 3c — ransomware.live PRO threat-intel ingest orchestrator.
// Shared between the Timer trigger and the admin HTTP trigger.
//
// Shape (mirrors `runSecureScoreIngest.ts` — no cursor, no detail blobs):
//   1. Read IngestHealth row (creates on first run), capture ETag.
//   2. Load the KV-backed API key. If unavailable, short-circuit with a
//      `not_configured`-equivalent run: status="error", error.kind=
//      "auth_unavailable" — no HTTP, no upsert, no retention trim. The
//      IngestHealth row still commits (advancing seq), and the audit line
//      records the skip so a forensic walk shows what happened.
//   3. Fetch the current month's victims + press for the configured
//      country (sequential — independent endpoints, but a single failure
//      breaks the run so atomicity holds).
//   4. Upsert each row (idempotent via content-derived RowKeys from
//      Layer 3a — overlapping monthly fetches dedupe naturally).
//   5. Trim retention by IngestedAt.
//   6. Commit IngestHealth under IfMatch (the lease). On 412 → another
//      instance won; exit without writing audit.
//   7. Append one `ingest.run` NDJSON audit line with the seq we allocated.
//
// Error paths still commit IngestHealth (with outcome="error") and append
// an audit line — the next fire re-reads the same window and re-tries.
//
// Per ADR-0037 §5 the agent-plane does NOT consume this Table. This
// orchestrator is dashboard-only, plain-text rendering at Layer 5.

import type { InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { appendAuditLine, type AuditLineFields } from "./audit.js";
import { computeLineSha256, resolvePrevLineSha256 } from "./auditChain.js";
import type { RansomwareIntelIngestConfig } from "./config.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import {
  RANSOMWARE_INTEL_TABLE_NAME,
  trimRansomwareIntelRetention,
  upsertPress,
  upsertVictim,
} from "./ransomwareIntelStore.js";
import {
  fetchRansomwareLivePress,
  fetchRansomwareLiveVictims,
  RansomwareLiveFetchError,
} from "./ransomwareLiveClient.js";
import { getTableClient, OPS_TABLES } from "./tables.js";
import type { IngestOutcome, RansomwareIntelIngestOutcome } from "./types.js";

type IngestErrorKind = NonNullable<IngestOutcome["error"]>["kind"];

export interface RunRansomwareIntelIngestOptions {
  /** Surfaces "admin" vs "timer" on the audit line — operator forensics
   *  for "was this fire triggered by a person?". Default "timer". */
  readonly trigger?: "timer" | "admin";
}

export async function runRansomwareIntelIngestOnce(
  config: RansomwareIntelIngestConfig,
  context: InvocationContext,
  options: RunRansomwareIntelIngestOptions = {},
): Promise<RansomwareIntelIngestOutcome> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();
  const trigger = options.trigger ?? "timer";

  // Compute the current month window once. UTC matches everything else in
  // the codebase (audit-line timestamps, retention cutoffs) so a Timer
  // firing at 00:30 BST on 1 July still reads June for the last fire and
  // July for the first July fire — operator-friendly month boundaries.
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1–12
  const period = `${year}-${String(month).padStart(2, "0")}`;

  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.threatIntelMiClientId,
  };
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);
  const dataTable = getTableClient(tableCtx, RANSOMWARE_INTEL_TABLE_NAME);

  const prevHealth = await getOrInitHealthRow(healthTable, config.tenantId, config.source);
  const nextSeq = prevHealth.lastAuditSeq + 1;

  let status: IngestOutcome["status"] = "error";
  let errorKind: IngestErrorKind | null = null;
  let errorMessage: string | null = null;
  let httpStatusFinal: number | null = null;
  let graphAttempts = 0;
  let victimsIngested = 0;
  let pressIngested = 0;
  let retentionDeleted = 0;

  try {
    // Shared `ingestedAtIso` across both endpoints so all rows from this
    // fire pin to the same retention anchor — a per-row drift would leave
    // some rows surviving retention trim by minutes-of-clock.
    const ingestedAtIso = new Date().toISOString();
    const filter = { country: config.country, year, month } as const;

    const victimsResult = await fetchRansomwareLiveVictims(filter, context, {
      ingestedAtIso,
    });
    graphAttempts += victimsResult.attempts;
    httpStatusFinal = victimsResult.finalHttpStatus;

    const pressResult = await fetchRansomwareLivePress(filter, context, {
      ingestedAtIso,
    });
    graphAttempts += pressResult.attempts;
    httpStatusFinal = pressResult.finalHttpStatus;

    // Upsert sequentially. The store's RowKey helpers + `Replace` upsert
    // mode make duplicates within a batch a no-op (last-write-wins on
    // identical RowKeys), but we don't expect duplicates inside one
    // upstream response — they'd indicate a bug at ransomware.live.
    for (const v of victimsResult.data) {
      await upsertVictim(dataTable, config.tenantId, v);
      victimsIngested++;
    }
    for (const p of pressResult.data) {
      await upsertPress(dataTable, config.tenantId, p);
      pressIngested++;
    }

    // Retention trim happens after the upsert so a row we just touched
    // (its `IngestedAt` is fresh) never gets clipped by the trim it just
    // triggered.
    retentionDeleted = await trimRansomwareIntelRetention(
      dataTable,
      config.tenantId,
      config.retentionDays,
      now,
    );

    status = victimsIngested + pressIngested > 0 ? "success" : "no_data";
  } catch (err) {
    if (err instanceof RansomwareLiveFetchError) {
      errorKind = err.kind;
      errorMessage = err.message;
      httpStatusFinal = err.status;
      graphAttempts += err.attempts;
    } else {
      errorKind = "internal";
      errorMessage = String((err as Error).message ?? err);
    }
    context.error(
      `ransomwareIntel.ingest.error kind=${errorKind} message=${errorMessage}`,
    );
    status = "error";
  }

  // Chain hash + line fields. ADR-0015 commit-then-audit: compute hash
  // first so the (seq, lineSha256) pair lands atomically on IngestHealth.
  const prevLineSha256 = resolvePrevLineSha256(
    prevHealth.lastLineSha256,
    config.source,
    config.tenantId,
  );
  const endedAtCandidate = new Date().toISOString();
  const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
    schemaVersion: 2,
    eventType: "ingest.run",
    source: config.source,
    seq: nextSeq,
    runId,
    tenantId: config.tenantId,
    startedAt,
    endedAt: endedAtCandidate,
    status,
    rowsWritten: victimsIngested + pressIngested,
    retentionRowsDeleted: retentionDeleted,
    graphAttempts,
    callerPrincipalMiClientId: config.threatIntelMiClientId,
    // Surfacing trigger + filter on the audit line means a forensic walk
    // can answer "who ran this and what window did it cover?" without
    // cross-referencing AppInsights.
    ...(trigger === "admin" ? { reason: "admin" } : {}),
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage.slice(0, 2000) } }
      : {}),
    prevLineSha256,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);

  // Commit IngestHealth under IfMatch — the lease. Same semantics as
  // every other vertical: a 412 means another instance won; we bail.
  try {
    await commitHealthRow(healthTable, prevHealth, {
      outcome: status === "error" ? "error" : "success",
      runId,
      now: endedAtCandidate,
      auditSeq: nextSeq,
      lineSha256,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      context.warn(
        `ransomwareIntel.ingest.lease_contended runId=${runId} — another instance committed first; aborting without audit write.`,
      );
      return buildOutcome({
        runId,
        startedAt,
        endedAt: new Date().toISOString(),
        startHr,
        status: "error",
        victimsIngested,
        pressIngested,
        retentionDeleted,
        graphAttempts,
        httpStatusFinal,
        errorKind: "lease_contended",
        errorMessage: err.message,
        country: config.country,
        period,
      });
    }
    throw err;
  }

  // Audit append — we own the seq at this point. A failure here leaves a
  // gap visible to a verifier; log loudly + rethrow so AppInsights
  // marks the invocation failed.
  try {
    await appendAuditLine(
      {
        blobEndpoint: config.auditBlobEndpoint,
        auditContainerName: config.auditContainerName,
        managedIdentityClientId: config.auditMiClientId,
      },
      { ...lineWithoutHash, lineSha256 } as AuditLineFields,
    );
  } catch (auditErr) {
    context.error(
      `ransomwareIntel.ingest.audit_write_failed runId=${runId} seq=${nextSeq} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }

  const outcome = buildOutcome({
    runId,
    startedAt,
    endedAt: new Date().toISOString(),
    startHr,
    status,
    victimsIngested,
    pressIngested,
    retentionDeleted,
    graphAttempts,
    httpStatusFinal,
    errorKind,
    errorMessage,
    country: config.country,
    period,
  });

  context.log(
    `ransomwareIntel.ingest.run runId=${runId} trigger=${trigger} status=${status} durationMs=${outcome.durationMs} victims=${victimsIngested} press=${pressIngested} retention=${retentionDeleted} attempts=${graphAttempts}`,
  );
  return outcome;
}

interface BuildOutcomeInput {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly startHr: bigint;
  readonly status: IngestOutcome["status"];
  readonly victimsIngested: number;
  readonly pressIngested: number;
  readonly retentionDeleted: number;
  readonly graphAttempts: number;
  readonly httpStatusFinal: number | null;
  readonly errorKind: IngestErrorKind | null;
  readonly errorMessage: string | null;
  readonly country: string;
  readonly period: string;
}

function buildOutcome(input: BuildOutcomeInput): RansomwareIntelIngestOutcome {
  return {
    runId: input.runId,
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: hrDurationMs(input.startHr),
    rowsWritten: input.victimsIngested + input.pressIngested,
    retentionRowsDeleted: input.retentionDeleted,
    graphAttempts: input.graphAttempts,
    httpStatusFinal: input.httpStatusFinal,
    victimsIngested: input.victimsIngested,
    pressIngested: input.pressIngested,
    country: input.country,
    period: input.period,
    ...(input.errorKind && input.errorMessage
      ? { error: { kind: input.errorKind, message: input.errorMessage } }
      : {}),
  };
}

function hrDurationMs(start: bigint): number {
  const diffNs = process.hrtime.bigint() - start;
  return Number(diffNs / 1_000_000n);
}
