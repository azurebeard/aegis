// Tenant directory row — cache the tenant's `displayName` from Graph so the
// brief-agent prompt builder can render a human name instead of a GUID.
//
// Why a separate table: the agent MI has NO Graph scopes (ADR-0017 §3
// "NO Graph / Defender / Sentinel scopes"). The name must therefore be
// resolved ingest-side (Organization.Read.All already granted to the ingest
// MI for the EntraRisk licence probe — ADR-0023 §7) and cached for the
// agent MI to read via its account-scope Table Reader role.
//
// Schema (single row per tenant):
//   PartitionKey = tenantId
//   RowKey       = "directory"
//   Columns      = { DisplayName: string, UpdatedAt: ISO-8601 }
//
// Freshness: the row is refreshed on every `runEntraRiskIngest` fire (4h
// cadence). The brief Timer fires at 05:00 UTC once a day — the
// TenantDirectory row will be at most 4h old when the agent reads it.
// If the row is missing (fresh tenant, EntraRisk probe hasn't yet fired),
// the agent prompt falls back to the tenant GUID.

import type { TableClient, TableEntity } from "@azure/data-tables";

const ROW_KEY = "directory";

interface TenantDirectoryEntity extends TableEntity {
  readonly DisplayName: string;
  readonly UpdatedAt: string;
}

export interface TenantDirectoryRow {
  readonly tenantId: string;
  readonly displayName: string;
  readonly updatedAt: string;
}

export async function upsertTenantDirectory(
  table: TableClient,
  row: TenantDirectoryRow,
): Promise<void> {
  const entity: TenantDirectoryEntity = {
    partitionKey: row.tenantId,
    rowKey: ROW_KEY,
    DisplayName: row.displayName,
    UpdatedAt: row.updatedAt,
  };
  await table.upsertEntity(entity, "Replace");
}

export async function readTenantDirectory(
  table: TableClient,
  tenantId: string,
): Promise<TenantDirectoryRow | null> {
  try {
    const e = await table.getEntity<TenantDirectoryEntity>(tenantId, ROW_KEY);
    const displayName = typeof e.DisplayName === "string" ? e.DisplayName : "";
    const updatedAt = typeof e.UpdatedAt === "string" ? e.UpdatedAt : "";
    if (!displayName) return null;
    return { tenantId, displayName, updatedAt };
  } catch (err) {
    // `@azure/data-tables` throws `RestError` with `statusCode: 404` when the
    // row is missing. Treat as "no cached name yet" rather than propagate.
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) return null;
    throw err;
  }
}
