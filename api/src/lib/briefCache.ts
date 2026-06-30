// Daily-brief cache table + blob store (ADR-0022).
//
// Two halves:
//   1. `BriefCache` table — index row per (tenantId, briefDate). Carries the
//      authoritative `OutputSha256`, used by the read path for defence-in-depth
//      verification (ADR-0021/0022 §outputSha256 verification).
//      PK = tenantId, RK = `brief.${yyyy-mm-dd}`.
//   2. `daily-briefs` blob container — markdown body at
//      `${yyyy}/${mm}/${dd}/${tenantId}.md`.
//
// Race handling (ADR-0022 §ETag-lease):
//   First-write goes via `If-None-Match: *` (atomic create-only) on the blob
//   AND `createEntity` on the row. If a competing run wins, the loser detects
//   it on the row write (`createEntity` 409 or row already exists with a
//   different RunId) and reports `{status:"superseded", supersedingRunId}` so
//   the orchestrator emits an audit line with `runOutcome:"discarded"` and
//   `supersedingRunId` for reconciliation.
//
// Freshness (ADR-0022 §5):
//   `fresh`              — age ≤ freshHours (e.g. 26h).
//   `stale_serviceable`  — freshHours < age ≤ ceilingHours (e.g. 72h).
//   `stale_unservable`   — age > ceilingHours.
//   `missing`            — no row.

import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  type BlockBlobClient,
  type ContainerClient,
  RestError,
} from "@azure/storage-blob";
import { type TableClient } from "@azure/data-tables";
import { createHash } from "node:crypto";

export const BRIEF_CACHE_TABLE_NAME = "BriefCache";

export interface BriefCacheRow {
  readonly tenantId: string;
  readonly rowKey: string; // `brief.${yyyy-mm-dd}`
  readonly briefDate: string; // yyyy-mm-dd
  readonly runId: string;
  readonly blobPath: string; // relative path within the cache container
  readonly outputSha256: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly generatedAt: string; // ISO8601 UTC
  readonly modelDeployment: string;
  readonly etag: string;
}

interface BriefCacheEntity {
  readonly partitionKey: string;
  readonly rowKey: string;
  readonly RunId: string;
  readonly BlobPath: string;
  readonly OutputSha256: string;
  readonly TokensIn: number;
  readonly TokensOut: number;
  readonly GeneratedAt: string;
  readonly ModelDeployment: string;
  readonly etag: string;
}

export type BriefFreshness =
  | "missing"
  | "fresh"
  | "stale_serviceable"
  | "stale_unservable";

const ROW_KEY_PREFIX = "brief.";
const READ_BACK_DAYS = 14; // ADR-0022 §retention envelope

/** Build the canonical row key for a brief on `yyyy-mm-dd`. */
export function briefRowKey(yyyymmdd: string): string {
  return `${ROW_KEY_PREFIX}${yyyymmdd}`;
}

/** Build the blob path `${yyyy}/${mm}/${dd}/${tenantId}.md`. */
export function briefBlobPath(yyyymmdd: string, tenantId: string): string {
  const [y, m, d] = yyyymmdd.split("-");
  if (!y || !m || !d) {
    throw new Error(`briefBlobPath: invalid yyyy-mm-dd: ${yyyymmdd}`);
  }
  // Tenant IDs from Entra are GUIDs but path-sanitise defensively.
  const safeTenant = tenantId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${y}/${m}/${d}/${safeTenant}.md`;
}

/** Walk back up to 14 days to find the latest cached brief row. */
export async function readLatestCache(
  table: TableClient,
  tenantId: string,
  asOf: Date = new Date(),
): Promise<BriefCacheRow | null> {
  for (let i = 0; i <= READ_BACK_DAYS; i++) {
    const probe = new Date(asOf.getTime() - i * 86_400_000);
    const yyyymmdd = isoDate(probe);
    const row = await readCacheForDate(table, tenantId, yyyymmdd);
    if (row !== null) return row;
  }
  return null;
}

/**
 * List the most recent N cached brief rows for a tenant, descending by date.
 *
 * Partition-scoped query (PK = tenantId) so we don't full-scan the table.
 * Row keys are `brief.${yyyy-mm-dd}` so lexicographic order on RowKey matches
 * chronological order — sorting after the fetch keeps the call-site simple
 * even if a future row-key shape changes (lex no longer == chrono).
 *
 * Metadata only (no blob body) so a 14-row list doesn't trigger 14 blob
 * downloads. Callers fetch bodies on-demand via `readCacheForDate` +
 * `readCacheBody` when an individual run is expanded in the UI.
 */
export async function listCacheRows(
  table: TableClient,
  tenantId: string,
  limit: number,
): Promise<readonly BriefCacheRow[]> {
  const rows: BriefCacheRow[] = [];
  const filter = `PartitionKey eq '${tenantId.replace(/'/g, "''")}'`;
  const iter = table.listEntities<BriefCacheEntity>({ queryOptions: { filter } });
  for await (const e of iter) {
    // Defensive: only `brief.YYYY-MM-DD` rows belong here, but the partition
    // schema is technically open. Skip anything that doesn't match.
    if (!e.rowKey.startsWith(ROW_KEY_PREFIX)) continue;
    const yyyymmdd = e.rowKey.slice(ROW_KEY_PREFIX.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) continue;
    rows.push(entityToRow(e, yyyymmdd));
  }
  rows.sort((a, b) => (a.briefDate < b.briefDate ? 1 : a.briefDate > b.briefDate ? -1 : 0));
  return rows.slice(0, limit);
}

/** Read the cache row for a specific date. `null` on 404. */
export async function readCacheForDate(
  table: TableClient,
  tenantId: string,
  yyyymmdd: string,
): Promise<BriefCacheRow | null> {
  try {
    const got = await table.getEntity<BriefCacheEntity>(
      tenantId,
      briefRowKey(yyyymmdd),
    );
    return entityToRow(got, yyyymmdd);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export interface ReadCacheBodyResult {
  readonly body: string;
  readonly sha256: string;
}

/**
 * Read the cache blob body and compute its sha256 for defence-in-depth
 * verification against the row's OutputSha256 (ADR-0021/0022).
 */
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
  const sha256 = sha256Hex(buffer);
  return { body, sha256 };
}

export interface WriteCacheArgs {
  readonly table: TableClient;
  readonly blobServiceEndpoint: string;
  readonly miClientId: string;
  readonly container: string;
  readonly tenantId: string;
  readonly yyyymmdd: string;
  readonly body: string;
  readonly runId: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly modelDeployment: string;
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
 * Atomic write of body + index row (ADR-0022 §3 / §ETag-lease).
 *
 * Two modes:
 *
 *   First-write-of-day (no `priorEtag`):
 *     1. `ifNoneMatch: *` on the blob — atomic create-only. 409 on an
 *        existing blob means another writer won the race.
 *     2. `createEntity` on the row. 409 means another writer committed first.
 *     On either conflict, read back the current row and return
 *     `{status:"superseded", supersedingRunId:current.runId}`.
 *
 *   Refresh-within-day (`priorEtag` supplied):
 *     1. Overwrite the blob (`overwrite: true` — blob etags are independent
 *        of the row etag; the serialisation point is the row-level
 *        `If-Match`). The caller previously read the existing row and the
 *        row-etag below is the only write-lock we need.
 *     2. `updateEntity(..., "Replace", { etag: priorEtag })` on the row —
 *        412 means another writer replaced the row between our read and our
 *        write. Return `{status:"superseded", supersedingRunId:current.runId}`.
 *
 * Race-loser detection still works in refresh mode: whichever writer gets
 * its etag in first wins; the loser's `ifMatch: priorEtag` fires 412 and we
 * correctly report the winner as the superseding run.
 */
export async function writeCache(
  args: WriteCacheArgs,
): Promise<WriteCacheResult> {
  const now = args.now ?? new Date();
  const path = briefBlobPath(args.yyyymmdd, args.tenantId);
  const bodyBytes = Buffer.from(args.body, "utf-8");
  const sha256 = sha256Hex(bodyBytes);

  const credential = new DefaultAzureCredential({
    managedIdentityClientId: args.miClientId,
  });
  const service = new BlobServiceClient(args.blobServiceEndpoint, credential);
  const containerClient = service.getContainerClient(args.container);
  const blob: BlockBlobClient = containerClient.getBlockBlobClient(path);

  // Step 1: blob write. First-write uses ifNoneMatch:* to fail-closed; the
  // refresh path overwrites unconditionally — serialisation is enforced at
  // the row-level ifMatch below.
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
    // 409 (BlobAlreadyExists) or 412 (PreconditionFailed) — another run won.
    if (isBlobConflict(err)) {
      const current = await readCacheForDate(
        args.table,
        args.tenantId,
        args.yyyymmdd,
      );
      const result: WriteCacheResult = { status: "superseded" };
      if (current) {
        return { ...result, supersedingRunId: current.runId };
      }
      return result;
    }
    throw err;
  }

  // Step 2: row write. Create-first on first-write; updateEntity with
  // If-Match on refresh.
  const entity: BriefCacheEntity = {
    partitionKey: args.tenantId,
    rowKey: briefRowKey(args.yyyymmdd),
    RunId: args.runId,
    BlobPath: path,
    OutputSha256: sha256,
    TokensIn: args.tokensIn,
    TokensOut: args.tokensOut,
    GeneratedAt: now.toISOString(),
    ModelDeployment: args.modelDeployment,
    etag: "",
  };

  try {
    if (args.priorEtag) {
      // Refresh path — serialisation is enforced here. A 412 means another
      // writer updated the row between our read and our write; they win.
      await args.table.updateEntity(entity, "Replace", { etag: args.priorEtag });
    } else {
      await args.table.createEntity(entity);
    }
  } catch (err) {
    // 409 EntityAlreadyExists on create; 412 PreconditionFailed on updateEntity.
    if (isRowConflict(err)) {
      const current = await readCacheForDate(
        args.table,
        args.tenantId,
        args.yyyymmdd,
      );
      const result: WriteCacheResult = { status: "superseded" };
      if (current) {
        return { ...result, supersedingRunId: current.runId };
      }
      return result;
    }
    throw err;
  }

  return {
    status: "committed",
    outputSha256: sha256,
    blobPath: path,
  };
}

/** Decide freshness from the row + clock + thresholds (ADR-0022 §5). */
export function classifyFreshness(
  row: BriefCacheRow | null,
  now: Date,
  freshHours: number,
  ceilingHours: number,
): BriefFreshness {
  if (!row) return "missing";
  const generatedMs = Date.parse(row.generatedAt);
  if (!Number.isFinite(generatedMs)) return "stale_unservable";
  const ageHours = (now.getTime() - generatedMs) / 3_600_000;
  if (ageHours <= freshHours) return "fresh";
  if (ageHours <= ceilingHours) return "stale_serviceable";
  return "stale_unservable";
}

/** Get a typed container client for callers that want their own helpers. */
export function getCacheContainerClient(
  blobServiceEndpoint: string,
  miClientId: string,
  container: string,
): ContainerClient {
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: miClientId,
  });
  const service = new BlobServiceClient(blobServiceEndpoint, credential);
  return service.getContainerClient(container);
}

function entityToRow(e: BriefCacheEntity, yyyymmdd: string): BriefCacheRow {
  return {
    tenantId: e.partitionKey,
    rowKey: e.rowKey,
    briefDate: yyyymmdd,
    runId: e.RunId,
    blobPath: e.BlobPath,
    outputSha256: e.OutputSha256,
    tokensIn: e.TokensIn ?? 0,
    tokensOut: e.TokensOut ?? 0,
    generatedAt: e.GeneratedAt,
    modelDeployment: e.ModelDeployment,
    etag: e.etag,
  };
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
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
