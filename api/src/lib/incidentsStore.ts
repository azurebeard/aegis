// Store layer for the Incidents vertical (ADR-0014 §3).
//
// Writes: upsert Table row (summary), write detail blob (full JSON).
// Reads : list-with-filter for /api/incidents, get-one merge for detail.
// Retention: trim-at-write on rows (lifecycle policy owns blob deletion).
// Lifecycle-only-deletes invariant (ADR-0014 §3.3): this module does not
// delete detail blobs. The ingest MI has Blob Data Contributor on the
// container, but the only caller of that role's delete capability is the
// storage lifecycle policy configured in `infra/modules/storage-ops.bicep`.

import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  type BlockBlobClient,
  type ContainerClient,
  RestError,
} from "@azure/storage-blob";
import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import { getTableClient, type TableContext } from "./tables.js";
import { buildDetailBlobPath, validateIncidentId } from "./incidentsParser.js";
import type {
  IncidentClassification,
  IncidentSeverity,
  IncidentStatus,
  IncidentSummary,
} from "./types.js";

export const INCIDENTS_TABLE_NAME = "Incidents";
const PRIORITY_SCORE_NULL_SENTINEL = -1;

// Re-export for callers that bundle imports via this module.
export { getTableClient, type TableContext };

// --- Table row <-> entity ---------------------------------------------------

interface IncidentEntity extends TableEntity {
  readonly Status: IncidentStatus;
  readonly Severity: IncidentSeverity;
  readonly Classification: IncidentClassification;
  readonly Determination: string;
  readonly PriorityScore: number; // -1 sentinel for null
  readonly DisplayName: string;
  readonly AssignedTo: string | null;
  readonly CreatedDateTime: string;
  readonly LastUpdateDateTime: string;
  readonly AlertCount: number;
  readonly HasRedirect: boolean;
  readonly RedirectIncidentId: string | null;
  readonly IncidentWebUrl: string;
  readonly CustomTagsJson: string;
  readonly SystemTagsJson: string;
  readonly DetailBlobPath: string;
  readonly IngestedAt: string;
  readonly IngestRunId: string;
}

function summaryToEntity(
  tenantId: string,
  inc: IncidentSummary,
  detailBlobPath: string,
): IncidentEntity {
  return {
    partitionKey: tenantId,
    rowKey: inc.id,
    Status: inc.status,
    Severity: inc.severity,
    Classification: inc.classification,
    Determination: inc.determination,
    PriorityScore: inc.priorityScore ?? PRIORITY_SCORE_NULL_SENTINEL,
    DisplayName: inc.displayName,
    AssignedTo: inc.assignedTo,
    CreatedDateTime: inc.createdDateTime,
    LastUpdateDateTime: inc.lastUpdateDateTime,
    AlertCount: inc.alertCount,
    HasRedirect: inc.hasRedirect,
    RedirectIncidentId: inc.redirectIncidentId,
    IncidentWebUrl: inc.incidentWebUrl,
    CustomTagsJson: JSON.stringify(inc.customTags),
    SystemTagsJson: JSON.stringify(inc.systemTags),
    DetailBlobPath: detailBlobPath,
    IngestedAt: inc.ingestedAt,
    IngestRunId: inc.ingestRunId,
  };
}

function entityToSummary(e: IncidentEntity): IncidentSummary {
  return {
    id: e.rowKey,
    displayName: e.DisplayName,
    severity: e.Severity,
    status: e.Status,
    classification: e.Classification,
    determination: e.Determination,
    priorityScore:
      e.PriorityScore === PRIORITY_SCORE_NULL_SENTINEL ? null : e.PriorityScore,
    assignedTo: e.AssignedTo,
    createdDateTime: e.CreatedDateTime,
    lastUpdateDateTime: e.LastUpdateDateTime,
    alertCount: e.AlertCount,
    customTags: safeJson<readonly string[]>(e.CustomTagsJson, []),
    systemTags: safeJson<readonly string[]>(e.SystemTagsJson, []),
    incidentWebUrl: e.IncidentWebUrl,
    hasRedirect: e.HasRedirect,
    redirectIncidentId: e.RedirectIncidentId,
    ingestedAt: e.IngestedAt,
    ingestRunId: e.IngestRunId,
  };
}

/**
 * Upsert one incident's summary row. `InsertOrReplace` per ADR-0014 §4.
 */
export async function upsertIncidentSummary(
  table: TableClient,
  tenantId: string,
  inc: IncidentSummary,
  detailBlobPath: string,
): Promise<void> {
  await table.upsertEntity(summaryToEntity(tenantId, inc, detailBlobPath), "Replace");
}

/**
 * Read one incident by ID. Returns `null` on 404.
 */
export async function getIncidentById(
  table: TableClient,
  tenantId: string,
  incidentId: string,
): Promise<IncidentSummary | null> {
  validateIncidentId(incidentId);
  try {
    const got = await table.getEntity<IncidentEntity>(tenantId, incidentId);
    return entityToSummary(got);
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return null;
    throw err;
  }
}

// --- Filter + pagination ----------------------------------------------------

export interface ListIncidentsFilter {
  readonly severity?: readonly IncidentSeverity[];
  readonly status?: readonly IncidentStatus[];
  readonly classification?: readonly IncidentClassification[];
  readonly since?: string | null;
  readonly includeRedirected?: boolean;
  readonly limit: number;
  /** Base64url-decoded cursor payload, if any. */
  readonly cursor?: { readonly k: string; readonly t: string } | undefined;
}

export interface ListIncidentsResult {
  readonly incidents: readonly IncidentSummary[];
  readonly nextCursor: { readonly k: string; readonly t: string } | null;
  readonly hasMore: boolean;
}

/**
 * List incidents with filters + keyset pagination on (LastUpdateDateTime desc,
 * RowKey desc). Table Storage doesn't support server-side sort beyond the
 * natural PartitionKey+RowKey order, so we pull the partition, filter + sort
 * in memory. At v1 scale (hundreds → low thousands of incidents) this is
 * negligible; at >>10K rows we'd add an aggregation row (ADR-0016 §Negative).
 */
export async function listIncidents(
  table: TableClient,
  tenantId: string,
  filter: ListIncidentsFilter,
): Promise<ListIncidentsResult> {
  // Server-side filter on the partition — only the cheap narrowing conditions
  // that Azure Table supports well. The rest we apply in memory. The `odata`
  // tag must wrap the WHOLE template (it quotes interpolated strings); embedding
  // `${odata\`${v}\`}` inside another template returns the value unquoted and
  // produces `InvalidInput` at query time.
  let filterStr: string;
  if (filter.since && !filter.includeRedirected) {
    filterStr = odata`PartitionKey eq ${tenantId} and HasRedirect eq false and LastUpdateDateTime ge ${filter.since}`;
  } else if (filter.since) {
    filterStr = odata`PartitionKey eq ${tenantId} and LastUpdateDateTime ge ${filter.since}`;
  } else if (!filter.includeRedirected) {
    filterStr = odata`PartitionKey eq ${tenantId} and HasRedirect eq false`;
  } else {
    filterStr = odata`PartitionKey eq ${tenantId}`;
  }
  const iter = table.listEntities<IncidentEntity>({
    queryOptions: { filter: filterStr },
  });

  const all: IncidentEntity[] = [];
  for await (const e of iter) all.push(e);

  // In-memory sort: LastUpdateDateTime desc, then rowKey desc as tiebreaker.
  all.sort((a, b) => {
    if (a.LastUpdateDateTime < b.LastUpdateDateTime) return 1;
    if (a.LastUpdateDateTime > b.LastUpdateDateTime) return -1;
    if (a.rowKey < b.rowKey) return 1;
    if (a.rowKey > b.rowKey) return -1;
    return 0;
  });

  let filtered = all;
  if (filter.severity && filter.severity.length > 0) {
    const allow = new Set<string>(filter.severity);
    filtered = filtered.filter((e) => allow.has(e.Severity));
  }
  if (filter.status && filter.status.length > 0) {
    const allow = new Set<string>(filter.status);
    filtered = filtered.filter((e) => allow.has(e.Status));
  }
  if (filter.classification && filter.classification.length > 0) {
    const allow = new Set<string>(filter.classification);
    filtered = filtered.filter((e) => allow.has(e.Classification));
  }

  // Keyset pagination: drop rows >= cursor (cursor is the LAST row returned,
  // so we want strictly-less-than it in the same desc order).
  if (filter.cursor) {
    const { k: cursorK, t: cursorT } = filter.cursor;
    filtered = filtered.filter((e) => {
      if (e.LastUpdateDateTime < cursorT) return true;
      if (e.LastUpdateDateTime > cursorT) return false;
      return e.rowKey < cursorK;
    });
  }

  const page = filtered.slice(0, filter.limit);
  const hasMore = filtered.length > page.length;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? { k: last.rowKey, t: last.LastUpdateDateTime } : null;

  return { incidents: page.map(entityToSummary), nextCursor, hasMore };
}

// --- Retention trim (rows only) ---------------------------------------------

/**
 * Delete rows whose `LastUpdateDateTime < cutoff`. Called at end of each
 * successful run (ADR-0014 §5). Blob retention is governed by the storage
 * lifecycle policy — not touched here.
 */
export async function trimIncidentsRetention(
  table: TableClient,
  tenantId: string,
  cutoffIso: string,
): Promise<number> {
  const iter = table.listEntities<IncidentEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId} and LastUpdateDateTime lt ${cutoffIso}`,
    },
  });
  let deleted = 0;
  for await (const e of iter) {
    await table.deleteEntity(e.partitionKey, e.rowKey);
    deleted++;
  }
  return deleted;
}

// --- Counts (summary endpoint) ----------------------------------------------

export interface IncidentsCounts {
  readonly total: number;
  readonly bySeverity: Record<IncidentSeverity, number>;
  readonly byStatus: Record<IncidentStatus, number>;
  readonly byClassification: Record<IncidentClassification, number>;
  readonly mostRecent: IncidentSummary | null;
  readonly latestIngestedAt: string | null;
}

const EMPTY_SEVERITY: Record<IncidentSeverity, number> = {
  unknown: 0,
  informational: 0,
  low: 0,
  medium: 0,
  high: 0,
};
const EMPTY_STATUS: Record<IncidentStatus, number> = {
  active: 0,
  resolved: 0,
  inProgress: 0,
  redirected: 0,
  awaitingAction: 0,
};
const EMPTY_CLASSIFICATION: Record<IncidentClassification, number> = {
  unknown: 0,
  truePositive: 0,
  falsePositive: 0,
  informationalExpectedActivity: 0,
};

/**
 * Compute summary counts + most-recent. Excludes redirected incidents.
 * O(rows-in-partition) — acceptable at v1 scale.
 */
export async function readIncidentsCounts(
  table: TableClient,
  tenantId: string,
): Promise<IncidentsCounts> {
  const iter = table.listEntities<IncidentEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId} and HasRedirect eq false`,
    },
  });

  const bySeverity: Record<IncidentSeverity, number> = { ...EMPTY_SEVERITY };
  const byStatus: Record<IncidentStatus, number> = { ...EMPTY_STATUS };
  const byClassification: Record<IncidentClassification, number> = {
    ...EMPTY_CLASSIFICATION,
  };
  let mostRecent: IncidentEntity | null = null;
  let latestIngestedAt: string | null = null;
  let total = 0;

  for await (const e of iter) {
    total++;
    bySeverity[e.Severity] = (bySeverity[e.Severity] ?? 0) + 1;
    byStatus[e.Status] = (byStatus[e.Status] ?? 0) + 1;
    byClassification[e.Classification] =
      (byClassification[e.Classification] ?? 0) + 1;
    if (
      mostRecent === null ||
      e.LastUpdateDateTime > mostRecent.LastUpdateDateTime
    ) {
      mostRecent = e;
    }
    if (latestIngestedAt === null || e.IngestedAt > latestIngestedAt) {
      latestIngestedAt = e.IngestedAt;
    }
  }

  return {
    total,
    bySeverity,
    byStatus,
    byClassification,
    mostRecent: mostRecent ? entityToSummary(mostRecent) : null,
    latestIngestedAt,
  };
}

// --- Trends (daily counts stacked by severity) ------------------------------

export interface IncidentTrendBucket {
  /** UTC calendar day, yyyy-mm-dd. */
  readonly day: string;
  readonly bySeverity: Record<IncidentSeverity, number>;
  readonly total: number;
}

/**
 * Compute one bucket per UTC day across the supplied window, counting
 * incidents by their `CreatedDateTime`. The result includes empty days
 * so the chart shows a continuous timeline rather than spike-only x-axis
 * ticks. Excludes redirected incidents.
 *
 * Partition-scoped query with a server-side `CreatedDateTime ge sinceIso`
 * filter so the table read is bounded by the trend window — a tenant
 * with thousands of historical incidents only fetches the recent slice.
 */
export async function readIncidentsTrends(
  table: TableClient,
  tenantId: string,
  sinceIso: string,
  days: number,
): Promise<readonly IncidentTrendBucket[]> {
  const iter = table.listEntities<IncidentEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId} and HasRedirect eq false and CreatedDateTime ge ${sinceIso}`,
    },
  });

  // Pre-seed the buckets so empty days render as zero rather than missing
  // from the response. Iterate from `days-1 ago` → today inclusive.
  const todayUtc = new Date();
  const buckets = new Map<string, IncidentTrendBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayUtc.getTime() - i * 86_400_000);
    const day = isoDate(d);
    buckets.set(day, {
      day,
      bySeverity: { ...EMPTY_SEVERITY },
      total: 0,
    });
  }

  for await (const e of iter) {
    const day = (e.CreatedDateTime ?? "").slice(0, 10);
    const b = buckets.get(day);
    // Skip rows that fall outside the pre-seeded window — guards against
    // an OData filter rounding edge (unlikely but cheap).
    if (!b) continue;
    // `bySeverity` is a Record<…, number> so the individual fields are
    // mutable; the bucket's `readonly` only forbids reassigning the
    // reference itself, which we don't.
    const next = b.bySeverity[e.Severity] ?? 0;
    (b.bySeverity as Record<IncidentSeverity, number>)[e.Severity] = next + 1;
    (b as { total: number }).total++;
  }

  return [...buckets.values()];
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// --- Detail-blob write/read -------------------------------------------------

export interface DetailBlobContext {
  readonly blobEndpoint: string;
  readonly containerName: string;
  readonly managedIdentityClientId: string;
}

function getContainerClient(ctx: DetailBlobContext): ContainerClient {
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: ctx.managedIdentityClientId,
  });
  const service = new BlobServiceClient(ctx.blobEndpoint, credential);
  return service.getContainerClient(ctx.containerName);
}

/**
 * Write the detail blob for one incident. ADR-0014 §3.2: overwrite on same-day
 * re-ingest; upload via `uploadData` which implements PUT Blob semantics.
 */
export async function writeIncidentDetailBlob(
  ctx: DetailBlobContext,
  incidentId: string,
  ingestedAt: string,
  body: unknown,
): Promise<string> {
  const container = getContainerClient(ctx);
  const path = buildDetailBlobPath(incidentId, ingestedAt);
  const blob: BlockBlobClient = container.getBlockBlobClient(path);
  const json = JSON.stringify(body, null, 2);
  const bytes = Buffer.from(json, "utf-8");
  await blob.uploadData(bytes, {
    blobHTTPHeaders: {
      blobContentType: "application/json; charset=utf-8",
      blobCacheControl: "no-store",
    },
  });
  return path;
}

export interface DetailBlobLookupResult {
  readonly found: boolean;
  readonly path: string | null;
  readonly body: unknown;
  readonly modifiedAt: string | null;
}

/**
 * Look up the latest detail blob for one incident. ADR-0016 §1.3 past-day
 * walk: current-day first, then up to 7 prior days. Uses ListBlobs with a
 * `yyyy/mm/` prefix (one call current month + optionally one call previous
 * month to cover boundary) and filters by suffix `/<incidentId>.json`.
 *
 * `anchor` is the ingestedAt on the Table row — the handler's hint of where
 * the blob was last written. If the row is empty (retention trim edge case)
 * the caller should default to now.
 */
export async function readLatestDetailBlob(
  ctx: DetailBlobContext,
  incidentId: string,
  anchor: string,
  walkBackDays: number = 7,
): Promise<DetailBlobLookupResult> {
  validateIncidentId(incidentId);
  const container = getContainerClient(ctx);

  const anchorDate = new Date(anchor);
  if (Number.isNaN(anchorDate.getTime())) {
    throw new Error(`readLatestDetailBlob: invalid anchor: ${anchor}`);
  }
  const earliest = new Date(anchorDate.getTime() - walkBackDays * 86_400_000);

  // Build the list of yyyy/mm prefixes we need to scan: at most 2 (current +
  // previous month) since 7 days never spans more than two UTC months.
  const months = new Set<string>();
  for (let d = new Date(earliest); d <= anchorDate; d = new Date(d.getTime() + 86_400_000)) {
    const y = d.getUTCFullYear().toString().padStart(4, "0");
    const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    months.add(`${y}/${m}/`);
  }

  const candidates: { name: string; modifiedAt: string }[] = [];
  const suffix = `/${incidentId}.json`;
  for (const prefix of months) {
    try {
      for await (const item of container.listBlobsFlat({ prefix })) {
        if (!item.name.endsWith(suffix)) continue;
        // Extract the yyyy/mm/dd from the path and bound to the walk window.
        const parts = item.name.split("/");
        if (parts.length < 4) continue;
        const [y, m, day] = parts;
        const candidateDate = new Date(`${y}-${m}-${day}T00:00:00.000Z`);
        if (Number.isNaN(candidateDate.getTime())) continue;
        if (candidateDate > anchorDate) continue;
        if (candidateDate < earliest) continue;
        const modified =
          item.properties.lastModified?.toISOString() ?? `${y}-${m}-${day}T00:00:00.000Z`;
        candidates.push({ name: item.name, modifiedAt: modified });
      }
    } catch (err) {
      // 404 on container-level list is exceptional (container should always
      // exist) — propagate.
      throw err;
    }
  }

  if (candidates.length === 0) {
    return { found: false, path: null, body: null, modifiedAt: null };
  }
  candidates.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  const winner = candidates[0];
  if (!winner) {
    return { found: false, path: null, body: null, modifiedAt: null };
  }
  const blob = container.getBlockBlobClient(winner.name);
  try {
    const buffer = await blob.downloadToBuffer();
    const text = buffer.toString("utf-8");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Blob present but malformed — treat as not-found so the API surfaces
      // the structured detailBlobMissingClassification path (ADR-0016 §1.3).
      return { found: false, path: winner.name, body: null, modifiedAt: winner.modifiedAt };
    }
    return {
      found: true,
      path: winner.name,
      body,
      modifiedAt: winner.modifiedAt,
    };
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) {
      return { found: false, path: winner.name, body: null, modifiedAt: null };
    }
    throw err;
  }
}

function safeJson<T>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
