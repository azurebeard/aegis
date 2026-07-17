// Weekly-posture cache table + blob store (ADR-0027 §Decision.5).
//
// Mirrors `briefCache.ts` with two deltas:
//   1. Weekly granularity — RowKey `posture.<yyyy-Www>` per ISO 8601 week.
//   2. Freshness window expressed in DAYS not hours — fresh ≤ 7d,
//      stale-serviceable ≤ 14d, stale-unservable beyond.

import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient,
  type BlockBlobClient,
  type ContainerClient,
  RestError,
} from "@azure/storage-blob";
import { type TableClient } from "@azure/data-tables";
import { createHash } from "node:crypto";

export const POSTURE_CACHE_TABLE_NAME = "PostureCache";

export interface PostureCacheRow {
  readonly tenantId: string;
  readonly rowKey: string; // `posture.<yyyy-Www>`
  readonly isoWeek: string; // yyyy-Www
  readonly runId: string;
  readonly blobPath: string;
  readonly outputSha256: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly generatedAt: string; // ISO8601 UTC
  readonly modelDeployment: string;
  readonly etag: string;
}

interface PostureCacheEntity {
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

export type PostureFreshness =
  | "missing"
  | "fresh"
  | "stale_serviceable"
  | "stale_unservable";

const ROW_KEY_PREFIX = "posture.";

/** Canonical row key for the weekly posture narrative. */
export function postureRowKey(isoWeek: string): string {
  return `${ROW_KEY_PREFIX}${isoWeek}`;
}

/** Blob path `posture-narratives/${yyyy}/${Www}/${tenantId}.md`. */
export function postureBlobPath(isoWeek: string, tenantId: string): string {
  // isoWeek is yyyy-Www. Split defensively.
  const parts = isoWeek.split("-");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`postureBlobPath: invalid isoWeek: ${isoWeek}`);
  }
  const safeTenant = tenantId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${parts[0]}/${parts[1]}/${safeTenant}.md`;
}

/**
 * List the most recent N cached posture rows for a tenant, descending by week.
 * Mirror of `briefCache.listCacheRows` — partition-scoped query (PK = tenantId)
 * with metadata-only payload; bodies fetched lazily via `readCacheForWeek` +
 * `readCacheBody`.
 */
export async function listCacheRows(
  table: TableClient,
  tenantId: string,
  limit: number,
): Promise<readonly PostureCacheRow[]> {
  const rows: PostureCacheRow[] = [];
  const filter = `PartitionKey eq '${tenantId.replace(/'/g, "''")}'`;
  const iter = table.listEntities<PostureCacheEntity>({ queryOptions: { filter } });
  for await (const e of iter) {
    if (!e.rowKey.startsWith(ROW_KEY_PREFIX)) continue;
    const isoWeek = e.rowKey.slice(ROW_KEY_PREFIX.length);
    // ISO 8601 week: yyyy-Www
    if (!/^\d{4}-W\d{2}$/.test(isoWeek)) continue;
    rows.push(entityToRow(e, isoWeek));
  }
  rows.sort((a, b) => (a.isoWeek < b.isoWeek ? 1 : a.isoWeek > b.isoWeek ? -1 : 0));
  return rows.slice(0, limit);
}

export async function readCacheForWeek(
  table: TableClient,
  tenantId: string,
  isoWeek: string,
): Promise<PostureCacheRow | null> {
  try {
    const got = await table.getEntity<PostureCacheEntity>(
      tenantId,
      postureRowKey(isoWeek),
    );
    return entityToRow(got, isoWeek);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Walk back up to `lookbackWeeks` weeks (from the provided `isoWeekOf`
 * callback) to find the most recent cached posture row. Used by the read
 * handler so a tenant in stale_serviceable window still gets a body.
 */
export async function readLatestCache(
  table: TableClient,
  tenantId: string,
  isoWeek: string,
  lookbackWeeks: number,
  isoWeekStepBack: (weeksBack: number) => string,
): Promise<PostureCacheRow | null> {
  for (let i = 0; i <= lookbackWeeks; i++) {
    const probe = i === 0 ? isoWeek : isoWeekStepBack(i);
    const row = await readCacheForWeek(table, tenantId, probe);
    if (row !== null) return row;
  }
  return null;
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
  const sha256 = sha256Hex(buffer);
  return { body, sha256 };
}

export interface WriteCacheArgs {
  readonly table: TableClient;
  readonly blobServiceEndpoint: string;
  readonly miClientId: string;
  readonly container: string;
  readonly tenantId: string;
  readonly isoWeek: string;
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
 * Atomic write of body + index row — same primitive as briefCache.writeCache
 * (ADR-0022 §ETag-lease), reshaped for the weekly key. First-write uses
 * `ifNoneMatch:*` on the blob + `createEntity` on the row; refresh-within-
 * week takes the `priorEtag` path and overwrites.
 */
export async function writeCache(args: WriteCacheArgs): Promise<WriteCacheResult> {
  const now = args.now ?? new Date();
  const path = postureBlobPath(args.isoWeek, args.tenantId);
  const bodyBytes = Buffer.from(args.body, "utf-8");
  const sha256 = sha256Hex(bodyBytes);

  const credential = new DefaultAzureCredential({
    managedIdentityClientId: args.miClientId,
  });
  const service = new BlobServiceClient(args.blobServiceEndpoint, credential);
  const containerClient = service.getContainerClient(args.container);
  const blob: BlockBlobClient = containerClient.getBlockBlobClient(path);

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
      const current = await readCacheForWeek(args.table, args.tenantId, args.isoWeek);
      const result: WriteCacheResult = { status: "superseded" };
      if (current) return { ...result, supersedingRunId: current.runId };
      return result;
    }
    throw err;
  }

  const entity: PostureCacheEntity = {
    partitionKey: args.tenantId,
    rowKey: postureRowKey(args.isoWeek),
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
      await args.table.updateEntity(entity, "Replace", { etag: args.priorEtag });
    } else {
      await args.table.createEntity(entity);
    }
  } catch (err) {
    if (isRowConflict(err)) {
      const current = await readCacheForWeek(args.table, args.tenantId, args.isoWeek);
      const result: WriteCacheResult = { status: "superseded" };
      if (current) return { ...result, supersedingRunId: current.runId };
      return result;
    }
    throw err;
  }

  return { status: "committed", outputSha256: sha256, blobPath: path };
}

/**
 * Freshness classification per ADR-0027 §Decision.5. Expressed in days
 * because the posture cadence is weekly, not daily.
 */
export function classifyFreshness(
  row: PostureCacheRow | null,
  now: Date,
  freshDays: number,
  ceilingDays: number,
): PostureFreshness {
  if (!row) return "missing";
  const generatedMs = Date.parse(row.generatedAt);
  if (!Number.isFinite(generatedMs)) return "stale_unservable";
  const ageDays = (now.getTime() - generatedMs) / 86_400_000;
  if (ageDays <= freshDays) return "fresh";
  if (ageDays <= ceilingDays) return "stale_serviceable";
  return "stale_unservable";
}

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

function entityToRow(e: PostureCacheEntity, isoWeek: string): PostureCacheRow {
  return {
    tenantId: e.partitionKey,
    rowKey: e.rowKey,
    isoWeek,
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
