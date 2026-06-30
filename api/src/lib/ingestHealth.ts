// IngestHealth table accessors (ADR-0011 §5a).
//
// The IngestHealth row per (tenantId, source) carries the health signal for
// the dashboard badge, the monotonic audit `seq` counter, and — critically —
// the ETag used as an optimistic **lease** for the ingest handler (WS10
// recommendation on SEC-L-STEP3-INFRA-02). Rather than a separate `locks`
// blob container, we reuse the IngestHealth row: the ingest handler reads
// the row, does its work, and writes the row back with `If-Match = <etag>`.
// If another instance won the race, the conditional update returns 412 and
// the handler aborts without duplicating the Graph → Table write.
//
// Why optimistic instead of a pessimistic lock:
//   - Two ingest instances racing the same day produce the same snapshot
//     (Graph is the source of truth); the second's work is wasted but not
//     incorrect.
//   - `InsertOrReplace` on SecureScore is idempotent per snapshotDate.
//   - The only cross-instance race we must avoid is double-incrementing `seq`
//     and double-writing the audit line. IfMatch on the IngestHealth row
//     closes both: only the winner bumps `seq`, and the loser's audit-write
//     is gated on the successful increment.

import { odata, RestError, type TableClient } from "@azure/data-tables";
import {
  getTableClient,
  ingestHealthTableNameForSource,
  OPS_TABLES,
  type TableContext,
} from "./tables.js";
import type { IngestHealthRow, IngestStatus } from "./types.js";

export interface IngestHealthEntity {
  readonly partitionKey: string; // tenantId
  readonly rowKey: string; // source, e.g. "graph.security.secureScores"
  readonly Status: IngestStatus;
  readonly LastSuccessAt: string | null;
  readonly LastFailureAt: string | null;
  readonly ConsecutiveFailureCount: number;
  readonly LastRunId: string | null;
  readonly LastAuditSeq: number;
  // ADR-0015 §5 — "" on first ingest after ADR-0015 lands; populated by the
  // one-off migration helper for pre-existing sources, by first-run for new.
  readonly LastLineSha256: string;
  // ADR-0014 §2 — Incidents cursor (ISO8601 UTC string). "" on first run.
  readonly LastCursor: string;
  readonly UpdatedAt: string;
  // ADR-0024 §1.3 — EntraRisk admin-endpoint run counter. Additive per
  // ADR-0011 §5a. Optional so existing non-EntraRisk rows are unaffected;
  // the EntraRisk admin handler treats `undefined` as 0.
  readonly EntraRiskManualRunsAttempted?: number;
  readonly EntraRiskManualRunsWindowStart?: string | null;
  readonly etag: string;
}

/**
 * Read every IngestHealth row for the given tenant from a single table.
 * Read-only — no auto-create. Returns rows in the order Azure Tables
 * enumerates them (no sort). Callers that need ordering apply it
 * client-side.
 *
 * For cross-source observability that spans the freshness-table split
 * (ADR-0036 v1.3 — ARM-data-plane rows live in `ArmIngestHealth`), use
 * `listHealthRowsFederated` instead.
 */
export async function listHealthRows(
  table: TableClient,
  tenantId: string,
): Promise<readonly IngestHealthRow[]> {
  const out: IngestHealthRow[] = [];
  for await (const e of table.listEntities<IngestHealthEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  })) {
    out.push(entityToRow(e));
  }
  return out;
}

/**
 * ADR-0036 v1.3 — federated list across `IngestHealth` (Graph-plane sources)
 * AND `ArmIngestHealth` (ARM-plane sources). Powers cross-source views
 * (notifications panel, report envelope, settings response) that pre-v1.3
 * read a single `IngestHealth` table.
 *
 * §10.71 F3 — both reads run via `Promise.allSettled` so a transient
 * table-side 5xx on either plane degrades THAT plane's freshness rows to
 * empty rather than 503-ing the whole notifications panel. Mirrors the
 * `caChangesPromise` degrade-on-failure pattern in `getNotifications`.
 * Per-plane failures are logged to the caller-supplied logger (if any)
 * but do NOT throw — the caller's existing try/catch around this
 * function continues to handle the rare both-planes-down case.
 *
 * **Defensive read-side filter.** Any row whose
 * RowKey starts with `azure.` is dropped from the legacy `IngestHealth`
 * half of the federation. Pre-v1.3 deploys persisted `azure.security.*`
 * rows directly into `IngestHealth`; those rows are now stale (the
 * canonical home is `ArmIngestHealth`) but cannot be cheaply deleted
 * because the legacy ingest MI no longer has access to write the table
 * and operator-side row deletes require an ad-hoc RBAC grant. Filtering
 * read-side ensures the notifications panel doesn't fire a spurious
 * "ingest-degrading" alert against the stale row once its
 * `lastSuccessAt` ages out.
 */
export async function listHealthRowsFederated(
  ctx: TableContext,
  tenantId: string,
  logger?: { readonly warn?: (msg: string) => void },
): Promise<readonly IngestHealthRow[]> {
  const [legacyResult, armResult] = await Promise.allSettled([
    listHealthRows(getTableClient(ctx, OPS_TABLES.IngestHealth), tenantId),
    listHealthRows(getTableClient(ctx, OPS_TABLES.ArmIngestHealth), tenantId),
  ]);
  const legacy =
    legacyResult.status === "fulfilled"
      ? legacyResult.value
      : (logger?.warn?.(
          `ingestHealth.federated.legacy.degraded ${String((legacyResult.reason as Error)?.message ?? legacyResult.reason)}`,
        ),
        [] as readonly IngestHealthRow[]);
  const arm =
    armResult.status === "fulfilled"
      ? armResult.value
      : (logger?.warn?.(
          `ingestHealth.federated.arm.degraded ${String((armResult.reason as Error)?.message ?? armResult.reason)}`,
        ),
        [] as readonly IngestHealthRow[]);
  const legacyFiltered = legacy.filter((r) => !r.source.startsWith("azure."));
  return [...legacyFiltered, ...arm];
}

/**
 * ADR-0036 v1.3 — return the `TableClient` that owns the freshness row
 * for `source`. ARM-plane sources (`azure.*`) → `ArmIngestHealth`;
 * everything else → `IngestHealth`. Used by point readers that already
 * know the source they're querying.
 */
export function getIngestHealthTableForSource(
  ctx: TableContext,
  source: string,
): TableClient {
  return getTableClient(ctx, ingestHealthTableNameForSource(source));
}

/**
 * Read the IngestHealth row, creating it with healthy defaults if absent.
 * Returns the current row (including ETag) for subsequent IfMatch updates.
 */
export async function getOrInitHealthRow(
  table: TableClient,
  tenantId: string,
  source: string,
): Promise<IngestHealthRow> {
  try {
    const got = await table.getEntity<IngestHealthEntity>(tenantId, source);
    return entityToRow(got);
  } catch (err) {
    if (isNotFound(err)) {
      const init: IngestHealthEntity = {
        partitionKey: tenantId,
        rowKey: source,
        Status: "healthy",
        LastSuccessAt: null,
        LastFailureAt: null,
        ConsecutiveFailureCount: 0,
        LastRunId: null,
        LastAuditSeq: 0,
        LastLineSha256: "", // resolvePrevLineSha256 translates "" → genesis
        LastCursor: "", // incidents seeds from now-24h on first run
        UpdatedAt: new Date().toISOString(),
        etag: "",
      };
      const created = await table.createEntity(init);
      // Round-trip to capture the assigned ETag.
      const got = await table.getEntity<IngestHealthEntity>(tenantId, source);
      return entityToRow({ ...got, etag: created.etag ?? got.etag });
    }
    throw err;
  }
}

export interface HealthUpdate {
  readonly outcome: "success" | "error";
  readonly runId: string;
  readonly now: string; // ISO8601 UTC
  readonly auditSeq: number; // the new `seq` value (previous + 1)
  readonly lineSha256?: string; // ADR-0015 — new LastLineSha256, optional to
  // preserve backward-compat call sites that haven't yet been converted.
  readonly cursor?: string; // ADR-0014 — new LastCursor, incidents-only.
}

/**
 * Commit the IngestHealth row using the ETag from the read at the start of the
 * handler. Throws `LeaseContendedError` when the ETag has moved (another
 * instance won the race).
 *
 * Status transitions:
 *   success ⇒ healthy, failureCount reset to 0
 *   error ⇒ failing if count+1 ≥ 3, else degrading
 */
export async function commitHealthRow(
  table: TableClient,
  previous: IngestHealthRow,
  update: HealthUpdate,
): Promise<IngestStatus> {
  const nextCount = update.outcome === "success" ? 0 : previous.consecutiveFailureCount + 1;
  const nextStatus: IngestStatus =
    update.outcome === "success" ? "healthy" : nextCount >= 3 ? "failing" : "degrading";

  const entity: IngestHealthEntity = {
    partitionKey: previous.tenantId,
    rowKey: previous.source,
    Status: nextStatus,
    LastSuccessAt: update.outcome === "success" ? update.now : previous.lastSuccessAt,
    LastFailureAt: update.outcome === "error" ? update.now : previous.lastFailureAt,
    ConsecutiveFailureCount: nextCount,
    LastRunId: update.runId,
    LastAuditSeq: update.auditSeq,
    // ADR-0015 commit-then-audit order: the chain-head hash moves forward here,
    // atomically with seq, under the same ETag lease. Default to preserving
    // the prior value when an errored run doesn't want to advance it.
    LastLineSha256: update.lineSha256 ?? previous.lastLineSha256,
    // ADR-0014 §2 cursor persistence: advance on success-only. Error runs
    // preserve the prior cursor so the next fire re-reads from the same point.
    LastCursor: update.cursor ?? previous.lastCursor,
    UpdatedAt: update.now,
    etag: previous.etag,
  };

  try {
    await table.updateEntity(entity, "Replace", { etag: previous.etag });
  } catch (err) {
    if (isPreconditionFailed(err)) {
      throw new LeaseContendedError(
        `IngestHealth row ETag drifted — another instance owns the run; etag=${previous.etag}`,
      );
    }
    throw err;
  }
  return nextStatus;
}

/**
 * Commit the IngestHealth row with `Status = 'licence_required'` using the
 * sticky-state rule (ADR-0023 §7). Bypasses `commitHealthRow`'s
 * success-or-error derivation: the licence absence is not a failure, so
 * `ConsecutiveFailureCount` resets to 0 and `LastFailureAt` is preserved
 * verbatim from `previous`. ETag-leased same as `commitHealthRow` —
 * throws `LeaseContendedError` on 412.
 *
 * SEC-INFO-PHASE8C-01 — extracted from three duplicate definitions in
 * `runUserDormancyIngest.ts`, `runSignInsIngest.ts`, and
 * `runEntraRiskIngest.ts`. The three callers shared byte-identical
 * implementations; the only divergence was the file each lived in.
 */
export async function commitStickyLicenceRequired(
  table: TableClient,
  previous: IngestHealthRow,
  runId: string,
  now: string,
  auditSeq: number,
  lineSha256: string,
): Promise<void> {
  const entity: IngestHealthEntity = {
    partitionKey: previous.tenantId,
    rowKey: previous.source,
    Status: "licence_required",
    LastSuccessAt: previous.lastSuccessAt,
    LastFailureAt: previous.lastFailureAt,
    ConsecutiveFailureCount: 0,
    LastRunId: runId,
    LastAuditSeq: auditSeq,
    LastLineSha256: lineSha256,
    LastCursor: previous.lastCursor,
    UpdatedAt: now,
    etag: previous.etag,
  };
  try {
    await table.updateEntity(entity, "Replace", { etag: previous.etag });
  } catch (err) {
    if (isPreconditionFailed(err)) {
      throw new LeaseContendedError(
        `IngestHealth row ETag drifted during licence-required commit; etag=${previous.etag}`,
      );
    }
    throw err;
  }
}

/**
 * Read the health row for the dashboard. Does NOT create if missing — the API
 * caller interprets a null result as "awaiting first run".
 */
export async function readHealthRow(
  table: TableClient,
  tenantId: string,
  source: string,
): Promise<IngestHealthRow | null> {
  try {
    const got = await table.getEntity<IngestHealthEntity>(tenantId, source);
    return entityToRow(got);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export class LeaseContendedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseContendedError";
  }
}

function entityToRow(e: IngestHealthEntity): IngestHealthRow {
  return {
    tenantId: e.partitionKey,
    source: e.rowKey,
    status: e.Status,
    lastSuccessAt: e.LastSuccessAt,
    lastFailureAt: e.LastFailureAt,
    consecutiveFailureCount: e.ConsecutiveFailureCount,
    lastRunId: e.LastRunId,
    lastAuditSeq: e.LastAuditSeq,
    // Absent on pre-ADR-0015 rows — default to empty string so
    // resolvePrevLineSha256 picks up genesis on the first chained write.
    lastLineSha256: e.LastLineSha256 ?? "",
    lastCursor: e.LastCursor ?? "",
    updatedAt: e.UpdatedAt,
    etag: e.etag,
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 404;
}

function isPreconditionFailed(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 412;
}

// Small re-export so callers don't all need to import `odata` directly when
// extending query patterns later.
export { odata };
