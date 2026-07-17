// ADR-0036 — AzureSecureScores Table accessor.
//
// Per-(tenantId, subscriptionId, snapshotDate) snapshot. Daily writes
// accumulate; reads scan the partition. Retention sweep deletes rows
// older than `retentionDays` on each ingest run (mirrors ADR-0011 §6
// MicrosoftSecureScore pattern).

import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import type { AzureSecureScoreDomain } from "./azureSecureScoreParser.js";
import { OPS_TABLES } from "./tables.js";

export const AZURE_SECURE_SCORES_TABLE_NAME = OPS_TABLES.AzureSecureScores;

const SNAPSHOT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AzureSecureScoreEntity extends TableEntity {
  readonly SubscriptionId: string;
  readonly SubscriptionName: string;
  readonly SnapshotDate: string;
  readonly CurrentScore: number;
  readonly MaxScore: number;
  readonly Percentage: number;
  readonly Weight: number;
  readonly IngestedAt: string;
  readonly IngestRunId: string;
}

function rowKey(subscriptionId: string, snapshotDate: string): string {
  return `${subscriptionId.toLowerCase()}_${snapshotDate}`;
}

function domainToEntity(
  tenantId: string,
  row: AzureSecureScoreDomain,
): AzureSecureScoreEntity {
  if (!SNAPSHOT_DATE_RE.test(row.snapshotDate)) {
    throw new Error(
      `azureSecureScoreStore: rejected snapshotDate out-of-pattern: ${row.snapshotDate.slice(0, 32)}`,
    );
  }
  return {
    partitionKey: tenantId,
    rowKey: rowKey(row.subscriptionId, row.snapshotDate),
    SubscriptionId: row.subscriptionId,
    SubscriptionName: row.subscriptionName,
    SnapshotDate: row.snapshotDate,
    CurrentScore: row.currentScore,
    MaxScore: row.maxScore,
    Percentage: row.percentage,
    Weight: row.weight,
    IngestedAt: row.ingestedAt,
    IngestRunId: row.ingestRunId,
  };
}

function entityToDomain(e: AzureSecureScoreEntity): AzureSecureScoreDomain {
  return {
    subscriptionId: e.SubscriptionId,
    subscriptionName: e.SubscriptionName ?? "",
    snapshotDate: e.SnapshotDate,
    currentScore: typeof e.CurrentScore === "number" ? e.CurrentScore : 0,
    maxScore: typeof e.MaxScore === "number" ? e.MaxScore : 0,
    percentage: typeof e.Percentage === "number" ? e.Percentage : 0,
    weight: typeof e.Weight === "number" ? e.Weight : 1,
    ingestedAt: e.IngestedAt,
    ingestRunId: e.IngestRunId,
  };
}

export async function upsertAzureSecureScore(
  table: TableClient,
  tenantId: string,
  row: AzureSecureScoreDomain,
): Promise<void> {
  await table.upsertEntity(domainToEntity(tenantId, row), "Replace");
}

/** List every snapshot row for the tenant. Returns domain shapes. */
export async function listAzureSecureScores(
  table: TableClient,
  tenantId: string,
): Promise<AzureSecureScoreDomain[]> {
  const rows: AzureSecureScoreDomain[] = [];
  const iter = table.listEntities<AzureSecureScoreEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  });
  for await (const e of iter) rows.push(entityToDomain(e));
  return rows;
}

/** Delete snapshot rows older than `retentionDays`. Idempotent — a row
 *  concurrently deleted is silently absorbed. Returns the count of rows
 *  removed in this pass. */
export async function trimAzureSecureScoreRetention(
  table: TableClient,
  tenantId: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoffMs = now.getTime() - retentionDays * 86_400_000;
  const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
  let deleted = 0;
  const iter = table.listEntities<AzureSecureScoreEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  });
  for await (const e of iter) {
    if (e.SnapshotDate >= cutoffDay) continue;
    try {
      await table.deleteEntity(e.partitionKey, e.rowKey);
      deleted += 1;
    } catch {
      /* idempotent */
    }
  }
  return deleted;
}
