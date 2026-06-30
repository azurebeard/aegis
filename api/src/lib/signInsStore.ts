// ADR-0034 §3.2 — SignIns Table accessor.
//
// Per-tenant partition; RowKey = signIn.id (Graph stable UUID-shaped).
// 30d retention default (env-aware sentinel-0 pattern). Cursor on
// `createdDateTime` mirrors ADR-0014 incidents pattern. Retention trim
// runs at the end of each ingest — purges rows older than the configured
// window. Operator-visible only; no AI-plane consumption (ADR-0034 §9).

import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import type { SignInDomain } from "./signInsParser.js";
import { OPS_TABLES } from "./tables.js";

export const SIGN_INS_TABLE_NAME = OPS_TABLES.SignIns;

export interface SignInsEntity extends TableEntity {
  readonly CreatedDateTime: string;
  readonly UserId: string;
  readonly UserPrincipalName: string;
  readonly UserDisplayName: string;
  readonly AppDisplayName: string;
  readonly IpAddress: string;
  readonly Country: string;
  readonly City: string;
  readonly State: string;
  readonly Status: string;
  readonly ConditionalAccessStatus: string;
  readonly OutOfArea: boolean;
  readonly IngestedAt: string;
  readonly IngestRunId: string;
}

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function domainToEntity(tenantId: string, row: SignInDomain): SignInsEntity {
  if (!ID_RE.test(row.id)) {
    throw new Error(`signInsStore: rejected RowKey out-of-pattern: ${row.id.slice(0, 64)}`);
  }
  return {
    partitionKey: tenantId,
    rowKey: row.id,
    CreatedDateTime: row.createdDateTime,
    UserId: row.userId,
    UserPrincipalName: row.userPrincipalName,
    UserDisplayName: row.userDisplayName,
    AppDisplayName: row.appDisplayName,
    IpAddress: row.ipAddress,
    Country: row.country,
    City: row.city,
    State: row.state,
    Status: row.status,
    ConditionalAccessStatus: row.conditionalAccessStatus,
    OutOfArea: row.outOfArea,
    IngestedAt: row.ingestedAt,
    IngestRunId: row.ingestRunId,
  };
}

function entityToDomain(e: SignInsEntity): SignInDomain {
  return {
    id: e.rowKey,
    createdDateTime: e.CreatedDateTime,
    userId: e.UserId,
    userPrincipalName: e.UserPrincipalName ?? "",
    userDisplayName: e.UserDisplayName ?? "",
    appDisplayName: e.AppDisplayName ?? "",
    ipAddress: e.IpAddress ?? "",
    country: e.Country ?? "",
    city: e.City ?? "",
    state: e.State ?? "",
    status: e.Status ?? "",
    conditionalAccessStatus: e.ConditionalAccessStatus ?? "",
    outOfArea: e.OutOfArea === true,
    ingestedAt: e.IngestedAt,
    ingestRunId: e.IngestRunId,
  };
}

export async function upsertSignIn(
  table: TableClient,
  tenantId: string,
  row: SignInDomain,
): Promise<void> {
  await table.upsertEntity(domainToEntity(tenantId, row), "Replace");
}

/** List per-tenant rows with optional filters. Used by the read-side
 *  handlers — partition scan with server-side filters where Tables OData
 *  supports them, plus client-side narrowing for the rest. */
export interface SignInsListFilter {
  readonly outOfAreaOnly?: boolean;
  readonly createdSince?: string; // ISO
  readonly userIdEquals?: string;
}

export async function listSignIns(
  table: TableClient,
  tenantId: string,
  filter: SignInsListFilter = {},
): Promise<readonly SignInDomain[]> {
  const parts: string[] = [`PartitionKey eq '${tenantId.replace(/'/g, "''")}'`];
  if (filter.createdSince) {
    parts.push(`CreatedDateTime gt '${filter.createdSince.replace(/'/g, "''")}'`);
  }
  if (filter.userIdEquals) {
    parts.push(`UserId eq '${filter.userIdEquals.replace(/'/g, "''")}'`);
  }
  if (filter.outOfAreaOnly === true) {
    parts.push(`OutOfArea eq true`);
  }
  const out: SignInDomain[] = [];
  for await (const e of table.listEntities<SignInsEntity>({
    queryOptions: { filter: parts.join(" and ") },
  })) {
    out.push(entityToDomain(e));
  }
  return out;
}

/** Trim rows older than `retentionDays`. Returns count deleted. */
export async function trimSignInsRetention(
  table: TableClient,
  tenantId: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  let deleted = 0;
  for await (const e of table.listEntities<SignInsEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId} and CreatedDateTime lt ${cutoff}`,
    },
  })) {
    try {
      await table.deleteEntity(e.partitionKey, e.rowKey);
      deleted++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 404) throw err;
    }
  }
  return deleted;
}

// --- Summary derivation ------------------------------------------------------

export interface SignInsSummary {
  readonly totalToday: number;
  readonly outOfAreaToday: number;
  readonly caFailuresToday: number;
  readonly mostRecentOutOfArea: SignInDomain | null;
  readonly mostRecent: SignInDomain | null;
}

const ONE_DAY_MS = 86_400_000;

export function computeSignInsSummary(
  rows: readonly SignInDomain[],
  now: Date = new Date(),
): SignInsSummary {
  const dayAgoIso = new Date(now.getTime() - ONE_DAY_MS).toISOString();
  let totalToday = 0;
  let outOfAreaToday = 0;
  let caFailuresToday = 0;
  let mostRecentOutOfArea: SignInDomain | null = null;
  let mostRecent: SignInDomain | null = null;
  for (const r of rows) {
    if (!mostRecent || r.createdDateTime > mostRecent.createdDateTime) {
      mostRecent = r;
    }
    if (r.createdDateTime < dayAgoIso) continue;
    totalToday++;
    if (r.outOfArea) {
      outOfAreaToday++;
      if (
        !mostRecentOutOfArea ||
        r.createdDateTime > mostRecentOutOfArea.createdDateTime
      ) {
        mostRecentOutOfArea = r;
      }
    }
    if (r.conditionalAccessStatus === "failure") {
      caFailuresToday++;
    }
  }
  return {
    totalToday,
    outOfAreaToday,
    caFailuresToday,
    mostRecentOutOfArea,
    mostRecent,
  };
}

/** Recompute the OutOfArea flag on every existing row when geo-fence policy
 *  changes. Mirrors `applyKevBaseline` bulk-orchestrator pattern — bounded
 *  by the partition scan at single-tenant volume; multi-tenant deployment
 *  would need an async path. */
export async function reconcileOutOfArea(
  table: TableClient,
  tenantId: string,
  predicate: (countryLower: string) => boolean,
): Promise<{ readonly updated: number; readonly unchanged: number }> {
  let updated = 0;
  let unchanged = 0;
  for await (const e of table.listEntities<SignInsEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  })) {
    const next = predicate(e.Country ?? "");
    if ((e.OutOfArea === true) === next) {
      unchanged++;
      continue;
    }
    await table.updateEntity({ ...e, OutOfArea: next }, "Merge");
    updated++;
  }
  return { updated, unchanged };
}
