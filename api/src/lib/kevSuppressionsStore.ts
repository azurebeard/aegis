// ADR-0033 §2 — KevSuppressions table accessor.
//
// Per-(tenantId, stackItemId, cveID) status workflow row.
//   PartitionKey = tenantId
//   RowKey       = `<stackItemId>_<cveID>` (UUID + CVE-ID; both upstream-validated)
//   Columns      = Status, Notes, ExpiresAt, UpdatedAt, UpdatedBy
//
// Default-when-absent: missing row → effective status `"open"`. Reads
// resolve `expiresAt` at query time (Phase 2.5 will add a Timer sweeper
// for physical deletion of expired rows; ADR-0033 §5).

import { odata, RestError, type TableClient, type TableEntity } from "@azure/data-tables";

export const KEV_SUPPRESSION_STATUSES = [
  "open",
  "acknowledged",
  "risk_accepted",
  "remediated",
  "not_applicable",
] as const;
export type KevSuppressionStatus = (typeof KEV_SUPPRESSION_STATUSES)[number];
const STATUS_SET = new Set<string>(KEV_SUPPRESSION_STATUSES);

export const KEV_SUPPRESSION_BOUNDS = Object.freeze({
  notes: { maxChars: 256 } as const,
});

export function isKevSuppressionStatus(v: unknown): v is KevSuppressionStatus {
  return typeof v === "string" && STATUS_SET.has(v);
}

export interface KevSuppressionRow {
  readonly stackItemId: string;
  readonly cveID: string;
  readonly status: KevSuppressionStatus;
  readonly notes: string;       // "" when absent
  readonly expiresAt: string;   // "" when no expiry
  readonly updatedAt: string;
  readonly updatedBy: string;
}

interface KevSuppressionEntity extends TableEntity {
  readonly Status: string;
  readonly Notes: string;
  readonly ExpiresAt: string;
  readonly UpdatedAt: string;
  readonly UpdatedBy: string;
}

/** Compose the RowKey from `(stackItemId, cveID)`. Both inputs are
 *  validated upstream (UUID v4 + `^CVE-\d{4}-\d{4,7}$` regex) so the
 *  underscore separator is unambiguous. */
export function suppressionRowKey(stackItemId: string, cveID: string): string {
  return `${stackItemId}_${cveID}`;
}

function entityToRow(e: KevSuppressionEntity): KevSuppressionRow {
  // RowKey shape `<uuid>_<cveID>`. CVE-ID itself contains hyphens but
  // never an underscore, so the first underscore is the canonical
  // separator.
  const sepIdx = e.rowKey.indexOf("_");
  const stackItemId = sepIdx > 0 ? e.rowKey.slice(0, sepIdx) : "";
  const cveID = sepIdx > 0 ? e.rowKey.slice(sepIdx + 1) : "";
  const status: KevSuppressionStatus = isKevSuppressionStatus(e.Status)
    ? e.Status
    : "open";
  return {
    stackItemId,
    cveID,
    status,
    notes: typeof e.Notes === "string" ? e.Notes : "",
    expiresAt: typeof e.ExpiresAt === "string" ? e.ExpiresAt : "",
    updatedAt: typeof e.UpdatedAt === "string" ? e.UpdatedAt : "",
    updatedBy: typeof e.UpdatedBy === "string" ? e.UpdatedBy : "",
  };
}

/** List all suppressions for a tenant. Used by the read-time join in
 *  GET /api/stack/items + getKevSummary. At v1 row volume the partition
 *  scan is trivial. */
export async function listSuppressions(
  table: TableClient,
  tenantId: string,
): Promise<readonly KevSuppressionRow[]> {
  const out: KevSuppressionRow[] = [];
  for await (const e of table.listEntities<KevSuppressionEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  })) {
    out.push(entityToRow(e));
  }
  return out;
}

/** Read a single suppression by `(stackItemId, cveID)`. `null` on 404. */
export async function readSuppression(
  table: TableClient,
  tenantId: string,
  stackItemId: string,
  cveID: string,
): Promise<KevSuppressionRow | null> {
  try {
    const e = await table.getEntity<KevSuppressionEntity>(
      tenantId,
      suppressionRowKey(stackItemId, cveID),
    );
    return entityToRow(e);
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return null;
    throw err;
  }
}

export interface UpsertSuppressionArgs {
  readonly tenantId: string;
  readonly stackItemId: string;
  readonly cveID: string;
  readonly status: KevSuppressionStatus;
  readonly notes: string;
  readonly expiresAt: string; // "" when no expiry
  readonly updatedBy: string;
  readonly now: string;
}

export async function upsertSuppression(
  table: TableClient,
  args: UpsertSuppressionArgs,
): Promise<KevSuppressionRow> {
  const entity: KevSuppressionEntity = {
    partitionKey: args.tenantId,
    rowKey: suppressionRowKey(args.stackItemId, args.cveID),
    Status: args.status,
    Notes: args.notes,
    ExpiresAt: args.expiresAt,
    UpdatedAt: args.now,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    stackItemId: args.stackItemId,
    cveID: args.cveID,
    status: args.status,
    notes: args.notes,
    expiresAt: args.expiresAt,
    updatedAt: args.now,
    updatedBy: args.updatedBy,
  };
}

/** Hard delete. Idempotent: 404 → "already absent" → caller returns 204. */
export async function deleteSuppression(
  table: TableClient,
  tenantId: string,
  stackItemId: string,
  cveID: string,
): Promise<boolean> {
  try {
    await table.deleteEntity(tenantId, suppressionRowKey(stackItemId, cveID));
    return true;
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return false;
    throw err;
  }
}

// --- Effective-status resolver --------------------------------------------

export interface EffectiveSuppression {
  readonly status: KevSuppressionStatus;
  readonly notes: string | null;
  readonly expiresAt: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

const DEFAULT_EFFECTIVE: EffectiveSuppression = Object.freeze({
  status: "open",
  notes: null,
  expiresAt: null,
  updatedAt: null,
  updatedBy: null,
});

/**
 * Resolve effective status for a (stackItemId, cveID) pair given the
 * current map of suppressions. Honours expiry — a row with an
 * `expiresAt` in the past resolves to `"open"` regardless of stored
 * status. Missing row → default `"open"`.
 *
 * `now` is injectable for deterministic tests.
 */
export function resolveEffective(
  suppressionsByKey: ReadonlyMap<string, KevSuppressionRow>,
  stackItemId: string,
  cveID: string,
  now: Date = new Date(),
): EffectiveSuppression {
  const row = suppressionsByKey.get(suppressionRowKey(stackItemId, cveID));
  if (!row) return DEFAULT_EFFECTIVE;
  if (row.expiresAt) {
    const expiresMs = Date.parse(row.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= now.getTime()) {
      return { ...DEFAULT_EFFECTIVE };
    }
  }
  return {
    status: row.status,
    notes: row.notes || null,
    expiresAt: row.expiresAt || null,
    updatedAt: row.updatedAt || null,
    updatedBy: row.updatedBy || null,
  };
}

/** Index a flat list into the map keyed `<stackItemId>_<cveID>`. */
export function indexSuppressions(
  rows: readonly KevSuppressionRow[],
): ReadonlyMap<string, KevSuppressionRow> {
  const m = new Map<string, KevSuppressionRow>();
  for (const r of rows) {
    m.set(suppressionRowKey(r.stackItemId, r.cveID), r);
  }
  return m;
}

// --- ADR-0033 §5 Phase 2.5 — expiry sweeper ---------------------------------

export interface SweepExpiredResult {
  readonly scanned: number;
  readonly deleted: number;
}

/**
 * Walk the partition, physically delete rows whose `ExpiresAt` is set
 * AND parses to a timestamp ≤ `now`. Rows with empty `ExpiresAt` are
 * skipped (no expiry → never sweep). Rows with malformed `ExpiresAt`
 * are also skipped — the read-time resolver already treats them as
 * no-expiry, so deleting them would silently change effective state.
 *
 * In-memory filter rather than OData `lt` because:
 *   1. `ExpiresAt` is the empty string when no expiry was set —
 *      empty strings would lexicographically sort BEFORE any ISO
 *      timestamp and would be false-positive deleted by an OData
 *      `lt` predicate.
 *   2. Defence-in-depth on malformed-date rows (operator manual
 *      Storage Explorer edits, schema drift) — `Date.parse` is the
 *      single source of truth for "is this an actual past instant".
 *
 * At v1 scale (≤ a few hundred rows per tenant) the partition scan
 * is trivial. `now` is injectable for deterministic tests.
 */
export async function sweepExpiredSuppressions(
  table: TableClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<SweepExpiredResult> {
  let scanned = 0;
  let deleted = 0;
  const cutoffMs = now.getTime();
  for await (const e of table.listEntities<KevSuppressionEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  })) {
    scanned++;
    const raw = typeof e.ExpiresAt === "string" ? e.ExpiresAt : "";
    if (!raw) continue;
    const expiresMs = Date.parse(raw);
    if (!Number.isFinite(expiresMs)) continue;
    if (expiresMs > cutoffMs) continue;
    try {
      await table.deleteEntity(e.partitionKey, e.rowKey);
      deleted++;
    } catch (err) {
      // 404 is a race-loss against a concurrent admin DELETE — treat
      // as already-swept rather than fail the whole pass. Re-raise on
      // anything else so the timer surfaces real backend failures.
      if (err instanceof RestError && err.statusCode === 404) continue;
      throw err;
    }
  }
  return { scanned, deleted };
}
