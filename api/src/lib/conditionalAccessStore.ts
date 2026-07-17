// ADR-0034 §3.3 — ConditionalAccessPolicies Table accessor.
//
// Snapshot-replace semantics: each ingest run upserts every Graph CA-policy
// row (`InsertOrReplace`), then reconciles by deleting rows whose `id` was
// not observed in the current run (delete-not-found). The table holds
// CURRENT state only; policy change history is captured in the audit chain
// via `ca.policy.changed` lines from `conditionalAccessDiff.ts`.

import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import type { ConditionalAccessPolicyDomain } from "./conditionalAccessParser.js";
import { OPS_TABLES } from "./tables.js";

export const CONDITIONAL_ACCESS_TABLE_NAME = OPS_TABLES.ConditionalAccessPolicies;

const POLICY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface ConditionalAccessEntity extends TableEntity {
  readonly DisplayName: string;
  readonly State: string;
  readonly CreatedDateTime: string;
  readonly ModifiedDateTime: string;
  readonly Conditions: string;
  readonly GrantControls: string;
  readonly SessionControls: string;
  readonly IngestedAt: string;
  readonly IngestRunId: string;
}

function domainToEntity(
  tenantId: string,
  row: ConditionalAccessPolicyDomain,
): ConditionalAccessEntity {
  if (!POLICY_ID_RE.test(row.id)) {
    throw new Error(
      `conditionalAccessStore: rejected RowKey out-of-pattern: ${row.id.slice(0, 64)}`,
    );
  }
  return {
    partitionKey: tenantId,
    rowKey: row.id,
    DisplayName: row.displayName,
    State: row.state,
    CreatedDateTime: row.createdDateTime ?? "",
    ModifiedDateTime: row.modifiedDateTime ?? "",
    Conditions: row.conditions,
    GrantControls: row.grantControls,
    SessionControls: row.sessionControls ?? "",
    IngestedAt: row.ingestedAt,
    IngestRunId: row.ingestRunId,
  };
}

function entityToDomain(e: ConditionalAccessEntity): ConditionalAccessPolicyDomain {
  return {
    id: e.rowKey,
    displayName: e.DisplayName,
    state: e.State as ConditionalAccessPolicyDomain["state"],
    createdDateTime: e.CreatedDateTime || null,
    modifiedDateTime: e.ModifiedDateTime || null,
    conditions: e.Conditions,
    grantControls: e.GrantControls,
    sessionControls: e.SessionControls || null,
    ingestedAt: e.IngestedAt,
    ingestRunId: e.IngestRunId,
  };
}

/** Upsert one policy row (InsertOrReplace). The orchestrator calls this
 *  serially for every observed row in a run before reconciliation. */
export async function upsertConditionalAccessPolicy(
  table: TableClient,
  tenantId: string,
  row: ConditionalAccessPolicyDomain,
): Promise<void> {
  const entity = domainToEntity(tenantId, row);
  await table.upsertEntity(entity, "Replace");
}

/** List every policy row for the tenant. Returns domain shapes. */
export async function listConditionalAccessPolicies(
  table: TableClient,
  tenantId: string,
): Promise<ConditionalAccessPolicyDomain[]> {
  const rows: ConditionalAccessPolicyDomain[] = [];
  const iter = table.listEntities<ConditionalAccessEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  });
  for await (const e of iter) rows.push(entityToDomain(e));
  return rows;
}

/** Delete one row by id. Used by the orchestrator's reconcile-not-found
 *  pass — failures swallowed (the row may have been concurrently removed
 *  by a parallel run; the next ingest reconciles again anyway). */
export async function deleteConditionalAccessPolicyRow(
  table: TableClient,
  tenantId: string,
  id: string,
): Promise<void> {
  try {
    await table.deleteEntity(tenantId, id);
  } catch {
    /* idempotent — a missing row is the desired post-condition */
  }
}
