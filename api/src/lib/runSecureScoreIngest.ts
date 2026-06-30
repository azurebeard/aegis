// Core Secure Score ingest logic — shared between the Timer trigger and the
// admin HTTP trigger. Implements the flow specified in ADRs 0010/0011:
//
//   1. Read IngestHealth row (create if absent) — captures ETag used as the
//      optimistic lease.
//   2. Fetch the latest snapshot from Microsoft Graph, retrying per ADR-0011 §5.
//   3. Parse and upsert into the SecureScore table (idempotent per snapshot
//      date).
//   4. Trim retention (400 snapshots, oldest dropped).
//   5. Commit the IngestHealth row with IfMatch — this allocates the next
//      audit `seq` and rotates status. A 412 here means another instance won
//      the race; exit quietly without writing audit.
//   6. Append one NDJSON audit line using the allocated seq.
//
// Error paths commit the IngestHealth row with status=error (same IfMatch
// optimistic lease, same seq-allocation semantics) and append an error audit
// line. Graph token / permission errors (401/403) are terminal-no-retry per
// ADR-0011 §5 — the expected first-fire state on a fresh deploy if the
// Function App restart in bootstrap-entra.ps1 failed.

import type { InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { appendAuditLine, type AuditLineFields } from "./audit.js";
import { computeLineSha256, resolvePrevLineSha256 } from "./auditChain.js";
import type { IngestConfig } from "./config.js";
import {
  fetchLatestSecureScore,
  GraphFetchError,
  type GraphFetchResult,
} from "./graphClient.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import { parseSecureScore } from "./secureScoreParser.js";
import {
  getTableClient,
  OPS_TABLES,
  trimSnapshotRetention,
  upsertSecureScoreSnapshot,
} from "./tables.js";
import type { IngestOutcome, SecureScoreSnapshot } from "./types.js";
import type { SecureScore } from "@microsoft/microsoft-graph-types";

export async function runSecureScoreIngestOnce(
  config: IngestConfig,
  context: InvocationContext,
): Promise<IngestOutcome> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();

  const ingestTables = { endpoint: config.opsTableEndpoint, managedIdentityClientId: config.ingestMiClientId };
  const healthTable = getTableClient(ingestTables, OPS_TABLES.IngestHealth);
  const secureScoreTable = getTableClient(ingestTables, OPS_TABLES.SecureScore);

  const prevHealth = await getOrInitHealthRow(healthTable, config.tenantId, config.source);
  const nextSeq = prevHealth.lastAuditSeq + 1;

  let graphResult: GraphFetchResult<SecureScore | null> | null = null;
  let parsed: SecureScoreSnapshot | null = null;
  let rowsWritten = 0;
  let retentionDeleted = 0;
  type IngestErrorKind = NonNullable<IngestOutcome["error"]>["kind"];
  let status: IngestOutcome["status"] = "error";
  let httpStatusFinal: number | null = null;
  let errorKind: IngestErrorKind | null = null;
  let errorMessage: string | null = null;
  // Surfaces the actual retry-attempt count when Graph fetch fails. Without
  // this, `graphResult` stays null on error and `graphAttempts` defaults to
  // 0 in telemetry — masking how hard we were trying when the call failed.
  let graphAttemptsOnError = 0;

  try {
    graphResult = await fetchLatestSecureScore(
      {
        managedIdentityClientId: config.ingestMiClientId,
        graphBaseUrl: config.graphBaseUrl,
        leaseWindowMs: config.leaseWindowMs,
        timeoutMs: config.graphApiTimeoutMs,
      },
      context,
    );
    httpStatusFinal = graphResult.finalHttpStatus;
    for (const ev of graphResult.retryEvents) {
      context.log(
        `secureScore.ingest.retry attempt=${ev.attempt} status=${ev.statusCode} retryAfterHeader=${ev.retryAfterHeader ?? "none"} clamped=${ev.retryAfterClamped} appliedMs=${ev.retryAfterAppliedMs} backoffMs=${ev.backoffMs}`,
      );
    }

    if (graphResult.data === null) {
      status = "no_data";
    } else {
      parsed = parseSecureScore(graphResult.data, { ingestedAt: new Date().toISOString(), ingestRunId: runId });
      await upsertSecureScoreSnapshot(secureScoreTable, parsed);
      rowsWritten = 1;
      retentionDeleted = await trimSnapshotRetention(secureScoreTable, config.retentionCap);
      status = "success";
    }
  } catch (err) {
    if (err instanceof GraphFetchError) {
      errorKind = err.kind;
      errorMessage = err.message;
      httpStatusFinal = err.status;
      graphAttemptsOnError = err.attempts;
    } else {
      errorKind = "internal";
      errorMessage = String((err as Error).message ?? err);
    }
    context.error(`secureScore.ingest.error kind=${errorKind} message=${errorMessage}`);
    status = "error";
  }
  const graphAttempts = graphResult?.attempts ?? graphAttemptsOnError;

  // ADR-0015 chain: resolve prev-hash and compute this line's hash BEFORE
  // committing IngestHealth, so the same (seq, lineSha256) pair can be
  // persisted atomically on the health row under the same ETag lease.
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
    rowsWritten,
    retentionRowsDeleted: retentionDeleted,
    graphAttempts: graphAttempts,
    ...(parsed
      ? {
          snapshotDate: parsed.snapshotDate,
          currentScore: parsed.currentScore,
          maxScore: parsed.maxScore,
        }
      : {}),
    callerPrincipalMiClientId: config.ingestMiClientId,
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage.slice(0, 2000) } }
      : {}),
    prevLineSha256,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);

  // Commit IngestHealth under IfMatch — this is the lease; only one instance wins.
  try {
    await commitHealthRow(healthTable, prevHealth, {
      outcome: status === "error" ? "error" : "success", // no_data counts as success for the health badge
      runId,
      now: endedAtCandidate,
      auditSeq: nextSeq,
      lineSha256,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      context.warn(
        `secureScore.ingest.lease_contended runId=${runId} — another instance committed first; aborting without audit write.`,
      );
      const endedAt = new Date().toISOString();
      return {
        runId,
        status: "error",
        startedAt,
        endedAt,
        durationMs: hrDurationMs(startHr),
        rowsWritten,
        retentionRowsDeleted: retentionDeleted,
        graphAttempts: graphAttempts,
        httpStatusFinal,
        error: { kind: "lease_contended", message: err.message },
      };
    }
    throw err;
  }

  // Audit append — at this point we own the seq. A failure here leaves a gap
  // that will be visible when a verifier walks the audit blob; log loudly.
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
      `secureScore.ingest.audit_write_failed runId=${runId} seq=${nextSeq} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }

  const endedAt = new Date().toISOString();
  const outcome: IngestOutcome = {
    runId,
    status,
    startedAt,
    endedAt,
    durationMs: hrDurationMs(startHr),
    rowsWritten,
    retentionRowsDeleted: retentionDeleted,
    graphAttempts: graphAttempts,
    httpStatusFinal,
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage } }
      : {}),
    ...(parsed
      ? {
          snapshot: {
            snapshotDate: parsed.snapshotDate,
            currentScore: parsed.currentScore,
            maxScore: parsed.maxScore,
          },
        }
      : {}),
  };

  context.log(
    `secureScore.ingest.run runId=${runId} status=${status} durationMs=${outcome.durationMs} rowsWritten=${rowsWritten} retentionRowsDeleted=${retentionDeleted} graphAttempts=${graphAttempts} httpStatusFinal=${httpStatusFinal ?? "n/a"}`,
  );

  return outcome;
}

function hrDurationMs(start: bigint): number {
  const diffNs = process.hrtime.bigint() - start;
  return Number(diffNs / 1_000_000n);
}
