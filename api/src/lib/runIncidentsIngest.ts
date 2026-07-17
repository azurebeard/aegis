// Incidents ingest orchestrator (ADR-0014 / ADR-0015 / ADR-0016).
//
// Shape:
//   1.  Read IngestHealth row (creates on first run), capture ETag.
//   2.  Read-clamp cursor if > now + 1h (ADR-0014 §2 cursor sanity bounds).
//   3.  Optional repair-detection (ADR-0015 §Negative audit-write-gap):
//       if prevHealth.lastLineSha256 disagrees with on-disk last line for this
//       (source, tenantId), emit an `ingest.audit.repair` line first and
//       consume an extra `seq`.
//   4.  Fetch Graph `/security/incidents` paged on `lastUpdateDateTime > cursor`.
//   5.  Emit `IncidentsCursorSkewDetected` if a first-page incident is older
//       than the cursor's safety window AND unseen in the Table.
//   6.  For each incident: validate ID (reject-not-truncate), write detail
//       blob, upsert Table row. Count skipped vs ingested vs alerts.
//   7.  Compute `cursorAfter` = max(lastUpdateDateTime) - overlapMs.
//       Reject-if-future (write-reject `> now + 5m`).
//   8.  Trim Table-row retention (`LastUpdateDateTime < now - retentionDays`).
//   9.  Commit IngestHealth under IfMatch with new seq + lineSha256 + cursor.
//   10. Append `ingest.run` audit line with chain fields.
//
// Backfill mode (`mode = "backfill"`, ADR-0014 §2):
//   - `cursorBefore` is the request's `from`; `cursorAfter` is NOT persisted.
//   - Distinct `eventType = "ingest.backfill.run"` on the audit line so a
//     verifier differentiates historical backfill from forward ingest.

import type { InvocationContext } from "@azure/functions";
import type { TableClient } from "@azure/data-tables";
import { randomUUID } from "node:crypto";
import { emitAievent } from "./aievent.js";
import {
  appendAuditLine,
  readLastOnDiskAuditLine,
  type AuditLineFields,
} from "./audit.js";
import {
  buildChainRepairLine,
  computeLineSha256,
  resolvePrevLineSha256,
} from "./auditChain.js";
import type { IncidentsIngestConfig } from "./config.js";
import {
  fetchIncidentsPaged,
  GraphFetchError,
  type RawGraphIncident,
} from "./graphClient.js";
import {
  buildDetailBlobPath,
  IncidentIdRejectedError,
  parseIncident,
} from "./incidentsParser.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import {
  getIncidentById,
  INCIDENTS_TABLE_NAME,
  trimIncidentsRetention,
  upsertIncidentSummary,
  writeIncidentDetailBlob,
} from "./incidentsStore.js";
import { getTableClient, OPS_TABLES } from "./tables.js";
import type { IncidentsIngestOutcome, IngestOutcome } from "./types.js";
import { sanitiseLog } from "./sanitiseLog.js";

export interface RunIncidentsIngestOptions {
  readonly mode?: "forward" | "backfill";
  readonly backfillFrom?: string; // ISO8601 UTC — required if mode === "backfill"
  readonly backfillTo?: string; // ISO8601 UTC — required if mode === "backfill"
}

const MAX_BACKFILL_WINDOW_DAYS = 30;

export async function runIncidentsIngestOnce(
  config: IncidentsIngestConfig,
  context: InvocationContext,
  options: RunIncidentsIngestOptions = {},
): Promise<IncidentsIngestOutcome> {
  const mode = options.mode ?? "forward";
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();

  if (mode === "backfill") {
    validateBackfillWindow(options.backfillFrom, options.backfillTo);
  }

  const tableCtx = { endpoint: config.opsTableEndpoint, managedIdentityClientId: config.ingestMiClientId };
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);
  const incidentsTable = getTableClient(tableCtx, INCIDENTS_TABLE_NAME);

  const prevHealth = await getOrInitHealthRow(healthTable, config.tenantId, config.source);
  let seqCursor = prevHealth.lastAuditSeq;

  // --- Step 2: cursor read-clamp (forward mode only) ---
  const now = Date.now();
  let effectiveCursor: string;
  let cursorReadClamped = false;
  if (mode === "backfill") {
    // Backfill ignores the live cursor; uses the request window.
    effectiveCursor = must(options.backfillFrom, "backfillFrom");
  } else {
    const resolved = resolveForwardCursor(prevHealth.lastCursor, config, now);
    effectiveCursor = resolved.effectiveCursor;
    cursorReadClamped = resolved.clamped;
    if (resolved.clamped) {
      emitCustomEvent(context, "IncidentsCursorCorrupt", {
        cursorRead: prevHealth.lastCursor,
        clampedTo: effectiveCursor,
        source: config.source,
        tenantId: config.tenantId,
      });
    }
  }

  // --- Step 3: audit-chain repair detection ---
  let chainPrev = resolvePrevLineSha256(
    prevHealth.lastLineSha256,
    config.source,
    config.tenantId,
  );
  try {
    const onDisk = await readLastOnDiskAuditLine(
      {
        blobEndpoint: config.auditBlobEndpoint,
        auditContainerName: config.auditContainerName,
        managedIdentityClientId: config.auditMiClientId,
      },
      config.source,
      config.tenantId,
      startedAt,
    );
    if (
      prevHealth.lastLineSha256 &&
      onDisk !== null &&
      onDisk.lineSha256 !== prevHealth.lastLineSha256
    ) {
      // Mismatch → emit repair line. seq N+1 is consumed by the repair; the
      // normal ingest.run line that follows uses seq N+2.
      seqCursor += 1;
      const repairBase = buildChainRepairLine({
        source: config.source,
        tenantId: config.tenantId,
        seq: seqCursor,
        startedAt,
        priorOnDiskLineSha256: onDisk.lineSha256,
        expectedLineSha256: prevHealth.lastLineSha256,
        callerPrincipalMiClientId: config.ingestMiClientId,
      });
      const repairHash = computeLineSha256(repairBase);
      await appendAuditLine(
        {
          blobEndpoint: config.auditBlobEndpoint,
          auditContainerName: config.auditContainerName,
          managedIdentityClientId: config.auditMiClientId,
        },
        { ...repairBase, lineSha256: repairHash } as AuditLineFields,
      );
      chainPrev = repairHash;
      emitCustomEvent(context, "AuditChainRepairWritten", {
        source: config.source,
        tenantId: config.tenantId,
        priorOnDiskLineSha256: onDisk.lineSha256,
        expectedLineSha256: prevHealth.lastLineSha256,
        repairSeq: seqCursor,
      });
    }
  } catch (err) {
    // The repair scan is best-effort — an audit-blob outage is surfaced by
    // the subsequent appendAuditLine; we don't want to mask a primary error.
    context.warn(
      `incidents.ingest.repair_probe_failed source=${config.source} ${String((err as Error).message ?? err)}`,
    );
  }

  let graphAttempts = 0;
  let pagesFetched = 0;
  let httpStatusFinal: number | null = null;
  let status: IngestOutcome["status"] = "error";
  type IngestErrorKind = NonNullable<IngestOutcome["error"]>["kind"];
  let errorKind: IngestErrorKind | null = null;
  let errorMessage: string | null = null;

  let incidentsIngested = 0;
  let incidentsSkipped = 0;
  let detailBlobsWritten = 0;
  let alertsIngested = 0;
  let maxLastUpdateDateTime: string | null = null;
  let retentionDeleted = 0;

  try {
    const pageResult = await fetchIncidentsPaged(
      {
        managedIdentityClientId: config.ingestMiClientId,
        graphBaseUrl: config.graphBaseUrl,
        leaseWindowMs: config.leaseWindowMs,
        timeoutMs: config.graphApiTimeoutMs,
      },
      mode === "backfill"
        ? {
            greaterThan: effectiveCursor,
            lessThan: must(options.backfillTo, "backfillTo"),
            pageSize: config.pageSize,
          }
        : {
            greaterThan: effectiveCursor,
            pageSize: config.pageSize,
          },
      context,
    );
    graphAttempts = pageResult.attempts;
    pagesFetched = pageResult.pagesFetched;
    httpStatusFinal = 200;

    // --- Step 5: skew detection ---
    if (mode === "forward" && !cursorReadClamped && pageResult.incidents.length > 0) {
      await detectAndEmitSkew(
        incidentsTable,
        config,
        context,
        effectiveCursor,
        pageResult.incidents,
      );
    }

    for (const raw of pageResult.incidents) {
      try {
        const ingestedAt = new Date().toISOString();
        const parsed = parseIncident(raw, { ingestedAt, ingestRunId: runId });
        const detailPath = buildDetailBlobPath(parsed.id, ingestedAt);
        await writeIncidentDetailBlob(
          {
            blobEndpoint: config.opsBlobEndpoint,
            containerName: config.incidentsDetailContainerName,
            managedIdentityClientId: config.ingestMiClientId,
          },
          parsed.id,
          ingestedAt,
          raw,
        );
        detailBlobsWritten += 1;
        await upsertIncidentSummary(
          incidentsTable,
          config.tenantId,
          parsed,
          `${config.incidentsDetailContainerName}/${detailPath}`,
        );
        incidentsIngested += 1;
        alertsIngested += parsed.alertCount;
        if (
          maxLastUpdateDateTime === null ||
          parsed.lastUpdateDateTime > maxLastUpdateDateTime
        ) {
          maxLastUpdateDateTime = parsed.lastUpdateDateTime;
        }
      } catch (err) {
        if (err instanceof IncidentIdRejectedError) {
          incidentsSkipped += 1;
          emitCustomEvent(context, "IncidentsIdRejected", {
            source: config.source,
            reason: err.reason,
            length: err.length,
            idFirst32: err.id.slice(0, 32),
          });
          continue;
        }
        // Non-ID-rejection failure on a single incident breaks the run —
        // the cursor is not advanced and the next fire re-reads the same
        // page. Surfacing loudly is the right signal.
        throw err;
      }
    }

    // --- Step 7: cursorAfter + write-reject if > now + 5min ---
    if (mode === "forward") {
      if (maxLastUpdateDateTime !== null) {
        const maxMs = Date.parse(maxLastUpdateDateTime);
        if (!Number.isFinite(maxMs)) {
          throw new Error(
            `incidents.ingest.cursor_max_invalid value=${maxLastUpdateDateTime}`,
          );
        }
        const newCursorMs = maxMs - config.cursorOverlapMs;
        const cursorAfter = new Date(newCursorMs).toISOString();
        const writeSkewCutoff = Date.now() + config.cursorWriteSkewAllowanceMs;
        if (newCursorMs > writeSkewCutoff) {
          emitCustomEvent(context, "IncidentsCursorRejected", {
            source: config.source,
            tenantId: config.tenantId,
            rejectedValue: cursorAfter,
            nowPlusAllowance: new Date(writeSkewCutoff).toISOString(),
          });
          errorKind = "cursor_rejected";
          errorMessage = `cursorAfter ${cursorAfter} exceeds now + ${config.cursorWriteSkewAllowanceMs}ms`;
          status = "error";
        } else {
          status = "success";
        }
      } else {
        // No incidents returned — idle run. Status success; cursor unchanged.
        status = "success";
      }
    } else {
      // Backfill: success if we got here without error.
      status = "success";
    }

    // --- Step 8: retention trim (forward, success only) ---
    if (mode === "forward" && status === "success") {
      const cutoffMs = Date.now() - config.retentionDays * 86_400_000;
      const cutoffIso = new Date(cutoffMs).toISOString();
      retentionDeleted = await trimIncidentsRetention(
        incidentsTable,
        config.tenantId,
        cutoffIso,
      );
    }
  } catch (err) {
    if (err instanceof GraphFetchError) {
      errorKind = err.kind;
      errorMessage = err.message;
      httpStatusFinal = err.status;
    } else {
      errorKind = "internal";
      errorMessage = String((err as Error).message ?? err);
    }
    context.error(`incidents.ingest.error kind=${errorKind} message=${errorMessage}`);
    status = "error";
  }

  // --- Chain + commit ---
  seqCursor += 1;
  const endedAtCandidate = new Date().toISOString();
  const cursorAfterForAudit =
    mode === "forward" && status === "success" && maxLastUpdateDateTime !== null
      ? new Date(Date.parse(maxLastUpdateDateTime) - config.cursorOverlapMs).toISOString()
      : null;

  const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
    schemaVersion: 2,
    eventType: "ingest.run",
    source: config.source,
    seq: seqCursor,
    runId,
    tenantId: config.tenantId,
    startedAt,
    endedAt: endedAtCandidate,
    status,
    rowsWritten: incidentsIngested,
    retentionRowsDeleted: retentionDeleted,
    graphAttempts,
    cursorBefore: effectiveCursor,
    cursorAfter: cursorAfterForAudit,
    pagesFetched,
    incidentsIngested,
    incidentsSkipped,
    detailBlobsWritten,
    alertsIngested,
    ...(mode === "backfill" ? { reason: "backfill" } : {}),
    callerPrincipalMiClientId: config.ingestMiClientId,
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage.slice(0, 2000) } }
      : {}),
    prevLineSha256: chainPrev,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);

  try {
    await commitHealthRow(healthTable, prevHealth, {
      outcome: status === "error" ? "error" : "success",
      runId,
      now: endedAtCandidate,
      auditSeq: seqCursor,
      lineSha256,
      // Forward-mode success advances cursor; backfill never persists cursor.
      ...(mode === "forward" && status === "success" && cursorAfterForAudit
        ? { cursor: cursorAfterForAudit }
        : {}),
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      context.warn(
        `incidents.ingest.lease_contended runId=${runId} — another instance committed first; aborting without audit write.`,
      );
      const endedAt = new Date().toISOString();
      return {
        runId,
        status: "error",
        startedAt,
        endedAt,
        durationMs: hrDurationMs(startHr),
        rowsWritten: incidentsIngested,
        retentionRowsDeleted: retentionDeleted,
        graphAttempts,
        httpStatusFinal,
        error: { kind: "lease_contended", message: err.message },
        cursorBefore: effectiveCursor,
        cursorAfter: null,
        pagesFetched,
        incidentsIngested,
        incidentsSkipped,
        detailBlobsWritten,
        alertsIngested,
      };
    }
    throw err;
  }

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
      `incidents.ingest.audit_write_failed runId=${runId} seq=${seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    emitCustomEvent(context, "AuditWriteFailed", {
      source: config.source,
      tenantId: config.tenantId,
      seq: seqCursor,
      runId,
    });
    throw auditErr;
  }

  const endedAt = new Date().toISOString();
  const outcome: IncidentsIngestOutcome = {
    runId,
    status,
    startedAt,
    endedAt,
    durationMs: hrDurationMs(startHr),
    rowsWritten: incidentsIngested,
    retentionRowsDeleted: retentionDeleted,
    graphAttempts,
    httpStatusFinal,
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage } }
      : {}),
    cursorBefore: effectiveCursor,
    cursorAfter: cursorAfterForAudit,
    pagesFetched,
    incidentsIngested,
    incidentsSkipped,
    detailBlobsWritten,
    alertsIngested,
  };

  context.log(
    `incidents.ingest.run runId=${sanitiseLog(runId)} mode=${sanitiseLog(mode)} status=${sanitiseLog(status)} durationMs=${outcome.durationMs} incidentsIngested=${incidentsIngested} incidentsSkipped=${incidentsSkipped} alertsIngested=${alertsIngested} detailBlobsWritten=${detailBlobsWritten} graphAttempts=${graphAttempts} pagesFetched=${pagesFetched}`,
  );

  return outcome;
}

// --- Helpers ----------------------------------------------------------------

function resolveForwardCursor(
  stored: string,
  config: IncidentsIngestConfig,
  now: number,
): { effectiveCursor: string; clamped: boolean } {
  if (!stored) {
    // First-ever run: seed at now - 24h (or bounded by retentionDays; ADR-0014
    // §5 the handler bounds back-seek at min(24h, retentionDays * 1d)).
    const retentionMs = config.retentionDays * 86_400_000;
    const seek = Math.min(config.firstRunSeedBackSeekMs, retentionMs);
    return { effectiveCursor: new Date(now - seek).toISOString(), clamped: false };
  }
  const storedMs = Date.parse(stored);
  if (!Number.isFinite(storedMs)) {
    // Malformed cursor — clamp to now - 24h.
    return {
      effectiveCursor: new Date(now - config.firstRunSeedBackSeekMs).toISOString(),
      clamped: true,
    };
  }
  if (storedMs > now + config.cursorReadCorruptThresholdMs) {
    // ADR-0014 §2: read-clamp for this run only.
    return {
      effectiveCursor: new Date(now - config.firstRunSeedBackSeekMs).toISOString(),
      clamped: true,
    };
  }
  return { effectiveCursor: stored, clamped: false };
}

async function detectAndEmitSkew(
  table: TableClient,
  config: IncidentsIngestConfig,
  context: InvocationContext,
  cursorBefore: string,
  firstPage: readonly RawGraphIncident[],
): Promise<void> {
  const cursorMs = Date.parse(cursorBefore);
  if (!Number.isFinite(cursorMs)) return;
  for (const inc of firstPage) {
    const last = inc.lastUpdateDateTime;
    if (typeof last !== "string") continue;
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) continue;
    if (lastMs >= cursorMs - config.cursorOverlapMs) continue; // inside overlap
    // Check if we've seen this ID before.
    const id = typeof inc.id === "string" ? inc.id : null;
    if (!id) continue;
    try {
      const existing = await getIncidentById(table, config.tenantId, id);
      if (existing !== null) continue; // known; not skew
      emitCustomEvent(context, "IncidentsCursorSkewDetected", {
        source: config.source,
        incidentId: id,
        incidentLastUpdateDateTime: last,
        cursorBefore,
        overlapMs: config.cursorOverlapMs,
        severity: inc.severity ?? "unknown",
      });
      // Emit once per run; breaking after the first detection limits log spam.
      break;
    } catch {
      // Graceful: skew detection is advisory.
      continue;
    }
  }
}

function validateBackfillWindow(
  from: string | undefined,
  to: string | undefined,
): void {
  if (!from || !to) {
    throw new Error("backfill requires both `from` and `to` ISO8601 timestamps");
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error(`backfill window has invalid ISO8601: from=${from} to=${to}`);
  }
  if (toMs <= fromMs) {
    throw new Error(`backfill window: to (${to}) must be > from (${from})`);
  }
  const windowMs = toMs - fromMs;
  if (windowMs > MAX_BACKFILL_WINDOW_DAYS * 86_400_000) {
    throw new Error(
      `backfill window exceeds ${MAX_BACKFILL_WINDOW_DAYS}-day max: ${Math.round(windowMs / 86_400_000)}d`,
    );
  }
}

function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing required option: ${name}`);
  return value;
}

function emitCustomEvent(
  context: InvocationContext,
  name: string,
  properties: Record<string, unknown>,
): void {
  // Thin wrapper kept at the original call-site signature so the inline
  // callers don't need to change. Routes through the centralised
  // AIEVENT helper which both logs the structured line (FunctionAppLogs
  // grep) AND tracks it as an App Insights customEvent.
  emitAievent(context, name, properties);
}

function hrDurationMs(start: bigint): number {
  const diffNs = process.hrtime.bigint() - start;
  return Number(diffNs / 1_000_000n);
}
