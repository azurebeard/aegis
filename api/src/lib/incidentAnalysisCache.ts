// Per-incident analysis cache (ADR-0028 §Decision.5).
//
// Two halves:
//   1. `IncidentAnalysisCache` table — index row per (tenantId, incidentId).
//      Carries the content-addressable freshness hash, redaction-lock state,
//      and OutputSha256 for read-path defence-in-depth.
//      PK = tenantId, RK = `incidents.analysis.<incidentId>`.
//   2. `incident-narratives` blob container — markdown body at
//      `<incidentId>.md` (flat path — RowKey is the lookup primitive).
//
// Freshness predicate (§Decision.3): content hash is primary, incident
// lastUpdateDateTime is the fast-path fallback. Content-addressable means
// operator-mutable metadata (tag churn, comment churn, assignee changes)
// does NOT invalidate the cache unless the underlying narrative-relevant
// fields change — blocking a budget-grind attack through adversary-
// triggered timestamp bumps.
//
// Redaction-lock (§Decision.7d): `RedactionLockRunCount` + `RedactionLockUntil`
// fields engage a 24h lock after 2 consecutive ≥3-of-4 redaction runs on
// the same incident. Lock returns a cached "analysis withheld" envelope
// without spending a run. Admin clears via
// `DELETE /api/ingest/incidents/{id}/redaction-lock`.

import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  type BlockBlobClient,
  RestError,
} from "@azure/storage-blob";
import { odata, type TableClient } from "@azure/data-tables";
import { canonicalize } from "json-canonicalize";
import { createHash } from "node:crypto";

export const INCIDENT_ANALYSIS_CACHE_TABLE_NAME = "IncidentAnalysisCache";
const ROW_KEY_PREFIX = "incidents.analysis.";

export interface IncidentAnalysisCacheRow {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly rowKey: string;
  readonly runId: string;
  readonly blobPath: string;
  readonly outputSha256: string;
  /** Two-axis freshness §Decision.3 — content-addressable primary. */
  readonly analysedContentSha256: string;
  /** Two-axis freshness §Decision.3 — timestamp fast-path fallback. */
  readonly analysedIncidentLastUpdateDateTime: string;
  /** Redaction-lock expiry ISO-8601 UTC; null when no lock is active. */
  readonly redactionLockUntil: string | null;
  readonly redactionLockRunCount: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly generatedAt: string;
  readonly modelDeployment: string;
  readonly etag: string;
}

interface IncidentAnalysisCacheEntity {
  readonly partitionKey: string;
  readonly rowKey: string;
  readonly RunId: string;
  readonly BlobPath: string;
  readonly OutputSha256: string;
  readonly AnalysedContentSha256: string;
  readonly AnalysedIncidentLastUpdateDateTime: string;
  readonly RedactionLockUntil: string;
  readonly RedactionLockRunCount: number;
  readonly TokensIn: number;
  readonly TokensOut: number;
  readonly GeneratedAt: string;
  readonly ModelDeployment: string;
  readonly etag: string;
}

export function analysisRowKey(incidentId: string): string {
  return `${ROW_KEY_PREFIX}${incidentId}`;
}

export function analysisBlobPath(incidentId: string): string {
  const safe = incidentId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}.md`;
}

/**
 * Find the most-recently-generated analysis row across all incidents for a
 * tenant. Used by the agent observability endpoint to surface "latest
 * incidents-agent run" without requiring the caller to know which incident
 * id to look up.
 *
 * Partition-scoped query (PK = tenantId), then in-memory max by
 * `GeneratedAt`. The cache is bounded by the operator's incident-analysis
 * volume — typical tenant has 0–50 rows at steady state, so a full scan
 * is cheap. Returns `null` when no analysis exists for the tenant.
 */
export async function findLatestAnalysisRow(
  table: TableClient,
  tenantId: string,
): Promise<IncidentAnalysisCacheRow | null> {
  const filter = `PartitionKey eq '${tenantId.replace(/'/g, "''")}'`;
  let best: IncidentAnalysisCacheRow | null = null;
  for await (const e of table.listEntities<IncidentAnalysisCacheEntity>({
    queryOptions: { filter },
  })) {
    if (!e.rowKey.startsWith(ROW_KEY_PREFIX)) continue;
    const incidentId = e.rowKey.slice(ROW_KEY_PREFIX.length);
    const row = entityToRow(e, incidentId);
    if (best === null || row.generatedAt > best.generatedAt) best = row;
  }
  return best;
}

export async function readCache(
  table: TableClient,
  tenantId: string,
  incidentId: string,
): Promise<IncidentAnalysisCacheRow | null> {
  try {
    const got = await table.getEntity<IncidentAnalysisCacheEntity>(
      tenantId,
      analysisRowKey(incidentId),
    );
    return entityToRow(got, incidentId);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Returns the set of incident IDs that currently have a committed analysis
 * row in this tenant's partition. Used by the incidents-list handler to
 * stamp `hasAnalysis` on each row (drives the "AI" column on the SPA).
 *
 * Implementation: a single partition-scoped `listEntities` projecting only
 * RowKey. The cache table holds one row per analysed incident — small even
 * at customer scale (~hundreds of rows) — so reading the whole partition
 * per list call is cheaper than per-row `getEntity` round-trips.
 *
 * Failures fall through as an empty Set (caller decides whether to swallow
 * the throw or surface it — the list handler treats this lookup as
 * best-effort observability rather than a hard dependency).
 */
export async function listAnalysedIncidentIds(
  table: TableClient,
  tenantId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const iter = table.listEntities<{ rowKey: string }>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId}`,
      select: ["RowKey"],
    },
  });
  for await (const entity of iter) {
    const rk = entity.rowKey ?? "";
    if (rk.startsWith(ROW_KEY_PREFIX)) {
      ids.add(rk.slice(ROW_KEY_PREFIX.length));
    }
  }
  return ids;
}

export interface ReadCacheBodyResult {
  readonly body: string;
  readonly sha256: string;
}

export async function readCacheBody(
  blobServiceEndpoint: string,
  miClientId: string,
  container: string,
  path: string,
): Promise<ReadCacheBodyResult> {
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: miClientId,
  });
  const service = new BlobServiceClient(blobServiceEndpoint, credential);
  const containerClient = service.getContainerClient(container);
  const blob = containerClient.getBlockBlobClient(path);
  const buffer = await blob.downloadToBuffer();
  const body = buffer.toString("utf-8");
  return { body, sha256: sha256Hex(buffer) };
}

export interface WriteCacheArgs {
  readonly table: TableClient;
  readonly blobServiceEndpoint: string;
  readonly miClientId: string;
  readonly container: string;
  readonly tenantId: string;
  readonly incidentId: string;
  readonly body: string;
  readonly runId: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly modelDeployment: string;
  readonly analysedContentSha256: string;
  readonly analysedIncidentLastUpdateDateTime: string;
  readonly redactionLockUntil: string | null;
  readonly redactionLockRunCount: number;
  readonly priorEtag?: string;
  readonly now?: Date;
}

export interface WriteCacheResult {
  readonly status: "committed" | "superseded";
  readonly supersedingRunId?: string;
  readonly outputSha256?: string;
  readonly blobPath?: string;
}

/**
 * Write body + index row. Re-analysis overwrites — the RowKey is stable
 * per-incident and the blob path is flat. ETag-lease serialisation on
 * the table row protects against two concurrent admin triggers on the
 * same incident. First-write uses `createEntity`; refresh uses
 * `updateEntity` with an If-Match ETag.
 */
export async function writeCache(args: WriteCacheArgs): Promise<WriteCacheResult> {
  const now = args.now ?? new Date();
  const path = analysisBlobPath(args.incidentId);
  const bodyBytes = Buffer.from(args.body, "utf-8");
  const sha256 = sha256Hex(bodyBytes);

  const credential = new DefaultAzureCredential({
    managedIdentityClientId: args.miClientId,
  });
  const service = new BlobServiceClient(args.blobServiceEndpoint, credential);
  const containerClient = service.getContainerClient(args.container);
  const blob: BlockBlobClient = containerClient.getBlockBlobClient(path);

  // Blob write — use ifNoneMatch:* on first-write; overwrite on refresh.
  try {
    if (args.priorEtag) {
      await blob.uploadData(bodyBytes, {
        blobHTTPHeaders: {
          blobContentType: "text/markdown; charset=utf-8",
          blobCacheControl: "no-store",
        },
      });
    } else {
      await blob.uploadData(bodyBytes, {
        blobHTTPHeaders: {
          blobContentType: "text/markdown; charset=utf-8",
          blobCacheControl: "no-store",
        },
        conditions: { ifNoneMatch: "*" },
      });
    }
  } catch (err) {
    if (isBlobConflict(err)) {
      const current = await readCache(args.table, args.tenantId, args.incidentId);
      const result: WriteCacheResult = { status: "superseded" };
      if (current) return { ...result, supersedingRunId: current.runId };
      return result;
    }
    throw err;
  }

  const entity: IncidentAnalysisCacheEntity = {
    partitionKey: args.tenantId,
    rowKey: analysisRowKey(args.incidentId),
    RunId: args.runId,
    BlobPath: path,
    OutputSha256: sha256,
    AnalysedContentSha256: args.analysedContentSha256,
    AnalysedIncidentLastUpdateDateTime: args.analysedIncidentLastUpdateDateTime,
    RedactionLockUntil: args.redactionLockUntil ?? "",
    RedactionLockRunCount: args.redactionLockRunCount,
    TokensIn: args.tokensIn,
    TokensOut: args.tokensOut,
    GeneratedAt: now.toISOString(),
    ModelDeployment: args.modelDeployment,
    etag: "",
  };

  try {
    if (args.priorEtag) {
      await args.table.updateEntity(entity, "Replace", { etag: args.priorEtag });
    } else {
      await args.table.createEntity(entity);
    }
  } catch (err) {
    if (isRowConflict(err)) {
      const current = await readCache(args.table, args.tenantId, args.incidentId);
      const result: WriteCacheResult = { status: "superseded" };
      if (current) return { ...result, supersedingRunId: current.runId };
      return result;
    }
    throw err;
  }

  return { status: "committed", outputSha256: sha256, blobPath: path };
}

/**
 * Two-axis freshness predicate (ADR-0028 §Decision.3). Content hash is
 * the primary check; timestamp is a fast-path fallback when the hash
 * field was written by a pre-upgrade row (first-write forward-compat).
 *
 * Returns `true` if the cached row is considered fresh for the current
 * incident state — in which case the adapter short-circuits without
 * spending a run.
 */
export function isCacheFresh(
  row: IncidentAnalysisCacheRow | null,
  currentContentSha256: string,
  currentLastUpdateDateTime: string,
): boolean {
  if (!row) return false;
  if (row.analysedContentSha256 && row.analysedContentSha256 === currentContentSha256) {
    return true;
  }
  // Fast-path: the primary hash field is absent on rows predating this
  // ADR (empty string stored when legacy). If the timestamp matches AND
  // the content-hash field exists (non-empty), accept; otherwise treat
  // as stale.
  if (
    row.analysedContentSha256 &&
    row.analysedIncidentLastUpdateDateTime === currentLastUpdateDateTime
  ) {
    return true;
  }
  return false;
}

/** Check whether the lock is currently engaged. */
export function isRedactionLockActive(
  row: IncidentAnalysisCacheRow | null,
  now: Date = new Date(),
): boolean {
  if (!row || row.redactionLockUntil === null) return false;
  const expiry = Date.parse(row.redactionLockUntil);
  if (!Number.isFinite(expiry)) return false;
  return now.getTime() < expiry;
}

/**
 * Compute the next redaction-lock state from the prior row + current
 * run's redacted-field count. ADR-0028 §Decision.7d: 2 consecutive
 * ≥3-of-4 redaction runs engages a 24h lock. <3 redactions resets the
 * counter to 0.
 */
export interface NextLockState {
  readonly redactionLockRunCount: number;
  readonly redactionLockUntil: string | null;
  readonly lockNewlyEngaged: boolean;
}

export function computeNextRedactionLockState(
  priorRow: IncidentAnalysisCacheRow | null,
  redactedFieldCount: number,
  now: Date,
  lockDurationHours: number,
): NextLockState {
  const priorCount = priorRow?.redactionLockRunCount ?? 0;
  const heavyRun = redactedFieldCount >= 3;
  const priorLockActive = isRedactionLockActive(priorRow, now);
  // If a lock is already active we don't increment — engagement persists
  // until it expires or admin clears it. Adapter should short-circuit
  // before getting here when the lock is active, but defensively keep
  // the state stable.
  if (priorLockActive) {
    return {
      redactionLockRunCount: priorCount,
      redactionLockUntil: priorRow?.redactionLockUntil ?? null,
      lockNewlyEngaged: false,
    };
  }
  if (!heavyRun) {
    return {
      redactionLockRunCount: 0,
      redactionLockUntil: null,
      lockNewlyEngaged: false,
    };
  }
  const nextCount = priorCount + 1;
  if (nextCount >= 2) {
    const until = new Date(now.getTime() + lockDurationHours * 3_600_000);
    return {
      redactionLockRunCount: nextCount,
      redactionLockUntil: until.toISOString(),
      lockNewlyEngaged: true,
    };
  }
  return {
    redactionLockRunCount: nextCount,
    redactionLockUntil: null,
    lockNewlyEngaged: false,
  };
}

/** Admin-clear the lock (DELETE /api/ingest/incidents/{id}/redaction-lock). */
export async function clearRedactionLock(
  table: TableClient,
  tenantId: string,
  incidentId: string,
): Promise<IncidentAnalysisCacheRow | null> {
  const row = await readCache(table, tenantId, incidentId);
  if (!row) return null;
  const entity: IncidentAnalysisCacheEntity = {
    partitionKey: tenantId,
    rowKey: row.rowKey,
    RunId: row.runId,
    BlobPath: row.blobPath,
    OutputSha256: row.outputSha256,
    AnalysedContentSha256: row.analysedContentSha256,
    AnalysedIncidentLastUpdateDateTime: row.analysedIncidentLastUpdateDateTime,
    RedactionLockUntil: "",
    RedactionLockRunCount: 0,
    TokensIn: row.tokensIn,
    TokensOut: row.tokensOut,
    GeneratedAt: row.generatedAt,
    ModelDeployment: row.modelDeployment,
    etag: "",
  };
  try {
    await table.updateEntity(entity, "Replace", { etag: row.etag });
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 412) {
      // Concurrent writer won; re-read and treat as best-effort.
      return await readCache(table, tenantId, incidentId);
    }
    throw err;
  }
  return await readCache(table, tenantId, incidentId);
}

/**
 * Compute the canonical content-sha256 over the freshness-hash input
 * shape (ADR-0028 §Decision.3). Identical inputs → identical hash.
 */
export function computeContentSha256(input: Record<string, unknown>): string {
  const canonical = canonicalize(input);
  return sha256Hex(Buffer.from(canonical, "utf-8"));
}

function entityToRow(
  e: IncidentAnalysisCacheEntity,
  incidentId: string,
): IncidentAnalysisCacheRow {
  return {
    tenantId: e.partitionKey,
    incidentId,
    rowKey: e.rowKey,
    runId: e.RunId,
    blobPath: e.BlobPath,
    outputSha256: e.OutputSha256,
    analysedContentSha256: e.AnalysedContentSha256 ?? "",
    analysedIncidentLastUpdateDateTime: e.AnalysedIncidentLastUpdateDateTime ?? "",
    redactionLockUntil:
      typeof e.RedactionLockUntil === "string" && e.RedactionLockUntil !== ""
        ? e.RedactionLockUntil
        : null,
    redactionLockRunCount: e.RedactionLockRunCount ?? 0,
    tokensIn: e.TokensIn ?? 0,
    tokensOut: e.TokensOut ?? 0,
    generatedAt: e.GeneratedAt,
    modelDeployment: e.ModelDeployment,
    etag: e.etag,
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 404;
}

function isBlobConflict(err: unknown): boolean {
  return (
    err instanceof RestError && (err.statusCode === 409 || err.statusCode === 412)
  );
}

function isRowConflict(err: unknown): boolean {
  return (
    err instanceof RestError && (err.statusCode === 409 || err.statusCode === 412)
  );
}

export function sha256Hex(bytes: Buffer | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf-8") : bytes;
  return createHash("sha256").update(buf).digest("hex");
}
