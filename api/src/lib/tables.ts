// Azure Table Storage helpers for the ingest and API paths.
//
// The ingest handlers use the ingest MI (write access to SecureScore +
// IngestHealth, ABAC-restricted — infra/modules/storage-ops.bicep). The API
// handlers use the api-reader MI (read-only across all tables). Callers pick
// which MI to authenticate with by passing its clientId.
//
// ADR-0011 §3 defines the SecureScore row shape:
//   PartitionKey = "snapshot", RowKey = yyyy-MM-dd
// ADR-0011 §5a defines the IngestHealth row shape.

import { DefaultAzureCredential } from "@azure/identity";
import { TableClient, type TableEntity } from "@azure/data-tables";
import type { IngestSource } from "./ingestSources.js";
import type { SecureScoreSnapshot } from "./types.js";

export const OPS_TABLES = {
  SecureScore: "SecureScore",
  IngestHealth: "IngestHealth",
  /** ADR-0036 v1.3 — per-(tenantId, source) freshness rows for ARM-data-plane
   *  ingest sources (azure.security.*). Split from `IngestHealth` so the
   *  arm-ingest MI's Contributor scope is bounded to ARM-plane freshness
   *  rows and cannot forge rows against Graph-side sources. WS10 v1.2 MED
   *  follow-track resolution. Reader path uses `ingestHealthTableForSource`
   *  to pick between the two tables per source. */
  ArmIngestHealth: "ArmIngestHealth",
  Incidents: "Incidents",
  EntraRisk: "EntraRisk",
  TenantDirectory: "TenantDirectory",
  TenantSettings: "TenantSettings",
  BriefCache: "BriefCache",
  PostureCache: "PostureCache",
  IncidentAnalysisCache: "IncidentAnalysisCache",
  ReportSnapshots: "ReportSnapshots",
  StackItems: "StackItems",
  KEV: "KEV",
  KevSuppressions: "KevSuppressions",
  UserDormancy: "UserDormancy",
  SignIns: "SignIns",
  ConditionalAccessPolicies: "ConditionalAccessPolicies",
  AzureSecureScores: "AzureSecureScores",
  /** ADR-0037 — ransomware.live PRO threat-intel. Two RowKey families on
   *  a single PartitionKey (tenantId): `victim.<base64url(post_title@group)>`
   *  + `press.<sha256(url)>`. 90d retention (env-aware sentinel-0).
   *  threatIntel MI Contributor; api-reader MI Reader (account-scope). */
  RansomwareIntel: "RansomwareIntel",
} as const;

/**
 * ADR-0036 v1.3 — pick the IngestHealth table that owns the freshness row
 * for a given ingest source. ARM-data-plane sources (`azure.*`) live in
 * `ArmIngestHealth`; everything else lives in `IngestHealth`. The arm-ingest
 * MI has Contributor only on `ArmIngestHealth`, and the legacy ingest MI
 * has Contributor only on `IngestHealth`, so a compromise of one MI cannot
 * forge a freshness row against the other plane's sources.
 *
 * §10.71 F1 — accepts `IngestSource | string` so existing callers that pass
 * raw `string` aren't forced through a refactor right now. The catalog in
 * `ingestSources.ts` + the runtime prefix invariant test ensure no Graph
 * vertical can accidentally route to `ArmIngestHealth` by mis-prefixing
 * itself `azure.*` — that would fail the per-category prefix test.
 */
export function ingestHealthTableNameForSource(source: IngestSource | string): string {
  return source.startsWith("azure.") ? OPS_TABLES.ArmIngestHealth : OPS_TABLES.IngestHealth;
}

export interface TableContext {
  readonly endpoint: string; // https://<acct>.table.core.windows.net (from OPS_TABLE_ENDPOINT env)
  readonly managedIdentityClientId: string;
}

export function getTableClient(ctx: TableContext, tableName: string): TableClient {
  if (!ctx.endpoint) throw new Error("getTableClient: missing endpoint");
  if (!ctx.managedIdentityClientId) {
    throw new Error("getTableClient: missing managedIdentityClientId");
  }
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: ctx.managedIdentityClientId,
  });
  return new TableClient(ctx.endpoint, tableName, credential);
}

// --- SecureScore table -------------------------------------------------------

const SECURE_SCORE_PARTITION = "snapshot";

interface SecureScoreEntity extends TableEntity {
  readonly GraphId: string;
  readonly CreatedDateTime: string;
  readonly IngestedAt: string;
  readonly CurrentScore: number;
  readonly MaxScore: number;
  readonly Percentage: number;
  readonly ActiveUserCount: number;
  readonly LicensedUserCount: number;
  readonly EnabledServices: string; // JSON-encoded
  readonly AverageComparativeScores: string; // JSON-encoded
  readonly ControlScores: string; // JSON-encoded
  readonly IngestRunId: string;
}

// Azure Table Storage caps each property at 64 KB (UTF-16 → 32K characters).
// `controlScores` from Graph routinely exceeds that once Microsoft's prose
// `description` fields are included (50-100 controls × hundreds of bytes).
// Strip descriptions before serialising — the tile renders plain-text-only
// without them (ADR-0012 §5) and trend queries don't consume them. If a
// future details-view needs descriptions, fetch them lazily from Graph or
// stage them in blob storage.
const TABLE_PROPERTY_MAX_UTF16_CHARS = 32_000;

function serialiseControlScoresForStorage(
  scores: SecureScoreSnapshot["controlScores"],
): string {
  const stripped = scores.map((c) => ({
    controlCategory: c.controlCategory,
    controlName: c.controlName,
    score: c.score,
  }));
  const json = JSON.stringify(stripped);
  if (json.length <= TABLE_PROPERTY_MAX_UTF16_CHARS) return json;
  // Shouldn't happen for Secure Score (at most ~150 controls ⇒ <10 KB without
  // descriptions), but hard-truncate just in case a future Graph change
  // inflates the shape. Record the truncation inline so a verifier can see it.
  return JSON.stringify({
    truncated: true,
    reason: "controlScores exceeded TABLE_PROPERTY_MAX_UTF16_CHARS without descriptions",
    count: stripped.length,
  });
}

export function snapshotToEntity(snap: SecureScoreSnapshot): SecureScoreEntity {
  return {
    partitionKey: SECURE_SCORE_PARTITION,
    rowKey: snap.snapshotDate,
    GraphId: snap.graphId,
    CreatedDateTime: snap.createdDateTime,
    IngestedAt: snap.ingestedAt,
    CurrentScore: snap.currentScore,
    MaxScore: snap.maxScore,
    Percentage: snap.percentage,
    ActiveUserCount: snap.activeUserCount,
    LicensedUserCount: snap.licensedUserCount,
    EnabledServices: JSON.stringify(snap.enabledServices),
    AverageComparativeScores: JSON.stringify(snap.averageComparativeScores),
    ControlScores: serialiseControlScoresForStorage(snap.controlScores),
    IngestRunId: snap.ingestRunId,
  };
}

export function entityToSnapshot(e: SecureScoreEntity): SecureScoreSnapshot {
  // Stored controlScores are stripped of `description` to fit the 64 KB
  // per-property cap (see serialiseControlScoresForStorage). Backfill
  // description="" on read so downstream consumers see a consistent shape.
  // Defensive: if the stored value is the truncation-notice object, parse
  // safely to [] — tile doesn't render controlScores in v1 (ADR-0012 §5).
  const storedControlScores = safeJson<
    {
      readonly controlCategory?: string;
      readonly controlName?: string;
      readonly description?: string;
      readonly score?: number;
    }[]
  >(e.ControlScores, []);
  const controlScores = Array.isArray(storedControlScores)
    ? storedControlScores.map((c) => ({
        controlCategory: c.controlCategory ?? "",
        controlName: c.controlName ?? "",
        description: c.description ?? "",
        score: typeof c.score === "number" ? c.score : 0,
      }))
    : [];
  return {
    snapshotDate: e.rowKey,
    graphId: e.GraphId,
    createdDateTime: e.CreatedDateTime,
    ingestedAt: e.IngestedAt,
    currentScore: e.CurrentScore,
    maxScore: e.MaxScore,
    percentage: e.Percentage,
    activeUserCount: e.ActiveUserCount,
    licensedUserCount: e.LicensedUserCount,
    enabledServices: safeJson<string[]>(e.EnabledServices, []),
    averageComparativeScores: safeJson(e.AverageComparativeScores, []),
    controlScores,
    ingestRunId: e.IngestRunId,
  };
}

/**
 * Upsert the snapshot row. `InsertOrReplace` semantics per ADR-0011 §3.
 */
export async function upsertSecureScoreSnapshot(
  table: TableClient,
  snap: SecureScoreSnapshot,
): Promise<void> {
  await table.upsertEntity(snapshotToEntity(snap), "Replace");
}

/**
 * Read the latest snapshot (highest RowKey). Returns `null` if the table is
 * empty for this partition.
 */
export async function getLatestSnapshot(
  table: TableClient,
): Promise<SecureScoreSnapshot | null> {
  const iter = table.listEntities<SecureScoreEntity>({
    queryOptions: { filter: `PartitionKey eq '${SECURE_SCORE_PARTITION}'` },
  });
  // No server-side ordering on Tables; collect and sort client-side. At retention
  // cap (400) this is trivial memory.
  const rows: SecureScoreEntity[] = [];
  for await (const e of iter) rows.push(e);
  if (rows.length === 0) return null;
  rows.sort((a, b) => (a.rowKey < b.rowKey ? 1 : -1));
  return entityToSnapshot(rows[0] as SecureScoreEntity);
}

/**
 * Read a snapshot by its `snapshotDate` (RowKey). Returns `null` on 404.
 * Used by posture-agent (ADR-0027 §Decision.2) to load the ~14-day-ago
 * snapshot for top-mover delta derivation.
 */
export async function getSnapshotForDate(
  table: TableClient,
  snapshotDate: string,
): Promise<SecureScoreSnapshot | null> {
  try {
    const entity = await table.getEntity<SecureScoreEntity>(
      SECURE_SCORE_PARTITION,
      snapshotDate,
    );
    return entityToSnapshot(entity);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

export interface TrendRow {
  readonly snapshotDate: string;
  readonly currentScore: number;
  readonly maxScore: number;
  readonly percentage: number;
}

/**
 * Read the N most recent snapshots (descending by date), materialised as the
 * smaller trend-row shape.
 */
export async function getTrendSnapshots(
  table: TableClient,
  days: number,
): Promise<readonly TrendRow[]> {
  const iter = table.listEntities<SecureScoreEntity>({
    queryOptions: { filter: `PartitionKey eq '${SECURE_SCORE_PARTITION}'` },
  });
  const rows: SecureScoreEntity[] = [];
  for await (const e of iter) rows.push(e);
  rows.sort((a, b) => (a.rowKey < b.rowKey ? 1 : -1));
  const sliced = rows.slice(0, Math.max(0, days));
  // Emit in ascending date order — nicer for chart consumers.
  return sliced
    .map((e) => ({
      snapshotDate: e.rowKey,
      currentScore: e.CurrentScore,
      maxScore: e.MaxScore,
      percentage: e.Percentage,
    }))
    .reverse();
}

/**
 * Enforce the retention cap. Deletes rows beyond `cap` (oldest first).
 * Returns the number of rows deleted.
 */
export async function trimSnapshotRetention(
  table: TableClient,
  cap: number,
): Promise<number> {
  if (cap <= 0) return 0;
  const iter = table.listEntities<SecureScoreEntity>({
    queryOptions: { filter: `PartitionKey eq '${SECURE_SCORE_PARTITION}'` },
  });
  const rows: SecureScoreEntity[] = [];
  for await (const e of iter) rows.push(e);
  if (rows.length <= cap) return 0;
  rows.sort((a, b) => (a.rowKey < b.rowKey ? 1 : -1)); // descending
  const toDelete = rows.slice(cap);
  let deleted = 0;
  for (const e of toDelete) {
    await table.deleteEntity(e.partitionKey, e.rowKey);
    deleted++;
  }
  return deleted;
}

function safeJson<T>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
