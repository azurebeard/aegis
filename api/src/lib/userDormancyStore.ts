// ADR-0034 §3.1 — UserDormancy Table accessor.
//
// Snapshot-replace semantics: each ingest run upserts every Graph user row
// (`InsertOrReplace`), then reconciles by deleting rows whose `id` was not
// observed in the current run (delete-not-found). The dormancy report is a
// state snapshot, not a change history — historical sign-in trails belong
// in Phase C's SignIns table (ADR-0034 §3.2).
//
// Read shape: `listForTenant` returns the full per-tenant set; the orchestrator
// computes the dormancy summary in-memory using the operator-configured
// `dormancy-policy.thresholdDays` (TenantSettings, ADR-0034 §4.2). The
// summary helper is in this module for test parity with the orchestrator.

import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import type { UserDormancyDomain } from "./userDormancyParser.js";
import { OPS_TABLES } from "./tables.js";

export const USER_DORMANCY_TABLE_NAME = OPS_TABLES.UserDormancy;

/** PascalCase column convention matches every other ops Table. */
export interface UserDormancyEntity extends TableEntity {
  readonly UserPrincipalName: string;
  readonly DisplayName: string;
  readonly AccountEnabled: boolean;
  readonly LastInteractiveSignIn: string;
  readonly LastNonInteractiveSignIn: string;
  readonly LastSuccessfulSignIn: string;
  /** ISO-8601 UTC. Optional — legacy rows pre-dating the §10.55 schema
   *  extension carry no value; the API projection coerces missing → null. */
  readonly CreatedDateTime?: string;
  readonly IngestedAt: string;
  readonly IngestRunId: string;
}

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function domainToEntity(
  tenantId: string,
  row: UserDormancyDomain,
): UserDormancyEntity {
  if (!ID_RE.test(row.id)) {
    throw new Error(
      `userDormancyStore: rejected RowKey out-of-pattern: ${row.id.slice(0, 64)}`,
    );
  }
  return {
    partitionKey: tenantId,
    rowKey: row.id,
    UserPrincipalName: row.userPrincipalName,
    DisplayName: row.displayName,
    AccountEnabled: row.accountEnabled,
    LastInteractiveSignIn: row.lastInteractiveSignIn ?? "",
    LastNonInteractiveSignIn: row.lastNonInteractiveSignIn ?? "",
    LastSuccessfulSignIn: row.lastSuccessfulSignIn ?? "",
    CreatedDateTime: row.createdDateTime ?? "",
    IngestedAt: row.ingestedAt,
    IngestRunId: row.ingestRunId,
  };
}

function entityToDomain(e: UserDormancyEntity): UserDormancyDomain {
  return {
    id: e.rowKey,
    userPrincipalName: e.UserPrincipalName,
    displayName: e.DisplayName ?? "",
    accountEnabled: e.AccountEnabled === true,
    lastInteractiveSignIn:
      typeof e.LastInteractiveSignIn === "string" && e.LastInteractiveSignIn !== ""
        ? e.LastInteractiveSignIn
        : null,
    lastNonInteractiveSignIn:
      typeof e.LastNonInteractiveSignIn === "string" && e.LastNonInteractiveSignIn !== ""
        ? e.LastNonInteractiveSignIn
        : null,
    lastSuccessfulSignIn:
      typeof e.LastSuccessfulSignIn === "string" && e.LastSuccessfulSignIn !== ""
        ? e.LastSuccessfulSignIn
        : null,
    createdDateTime:
      typeof e.CreatedDateTime === "string" && e.CreatedDateTime !== ""
        ? e.CreatedDateTime
        : null,
    ingestedAt: e.IngestedAt,
    ingestRunId: e.IngestRunId,
  };
}

/** Idempotent upsert. */
export async function upsertUserDormancyRow(
  table: TableClient,
  tenantId: string,
  row: UserDormancyDomain,
): Promise<void> {
  await table.upsertEntity(domainToEntity(tenantId, row), "Replace");
}

/** Bulk delete by RowKey. Used by the delete-not-found reconciliation step. */
export async function deleteUserDormancyRow(
  table: TableClient,
  tenantId: string,
  rowKey: string,
): Promise<void> {
  await table.deleteEntity(tenantId, rowKey);
}

/** List every row for a tenant. Used by the orchestrator to compute the
 *  delete-not-found set, AND by the read-side handlers for summary + list. */
export async function listUserDormancyRows(
  table: TableClient,
  tenantId: string,
): Promise<readonly UserDormancyDomain[]> {
  const out: UserDormancyDomain[] = [];
  for await (const e of table.listEntities<UserDormancyEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  })) {
    out.push(entityToDomain(e));
  }
  return out;
}

// --- Summary derivation ------------------------------------------------------

export interface DormancyPolicy {
  readonly thresholdDays: number;
  readonly includeDisabledAccounts: boolean;
  readonly excludeServiceAccountSuffixes: readonly string[];
}

export const DORMANCY_POLICY_DEFAULTS: DormancyPolicy = Object.freeze({
  thresholdDays: 30,
  includeDisabledAccounts: false,
  excludeServiceAccountSuffixes: ["@svc."],
});

export interface DormancySummary {
  readonly total: number;
  readonly dormant: number;
  readonly enabledDormant: number;
  readonly disabledDormant: number;
  readonly excluded: number;
  readonly thresholdDays: number;
  readonly oldestDormantUpn: string | null;
  readonly oldestDormantLastSignIn: string | null;
}

/** Most-recent-of the three signInActivity timestamps, or null when all
 *  three are null. Defines "last sign-in" for the dormancy comparison. */
export function lastSignInOf(row: UserDormancyDomain): string | null {
  const candidates = [
    row.lastInteractiveSignIn,
    row.lastNonInteractiveSignIn,
    row.lastSuccessfulSignIn,
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  if (candidates.length === 0) return null;
  let max = candidates[0] as string;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i] as string;
    if (c > max) max = c;
  }
  return max;
}

function isExcluded(
  row: UserDormancyDomain,
  policy: DormancyPolicy,
): boolean {
  for (const suffix of policy.excludeServiceAccountSuffixes) {
    if (suffix !== "" && row.userPrincipalName.includes(suffix)) {
      return true;
    }
  }
  return false;
}

/** Returns true when the row is dormant under the supplied policy.
 *  - Accounts excluded by suffix don't count.
 *  - Disabled accounts only count when `includeDisabledAccounts` is true.
 *  - "Never signed in" (all three null) counts as dormant by definition.
 *  - Otherwise, dormant iff the most-recent sign-in is older than threshold. */
export function isDormant(
  row: UserDormancyDomain,
  policy: DormancyPolicy,
  now: number = Date.now(),
): boolean {
  if (isExcluded(row, policy)) return false;
  if (!row.accountEnabled && !policy.includeDisabledAccounts) return false;
  const last = lastSignInOf(row);
  if (last === null) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  const ageDays = (now - lastMs) / 86_400_000;
  return ageDays > policy.thresholdDays;
}

export function computeDormancySummary(
  rows: readonly UserDormancyDomain[],
  policy: DormancyPolicy,
  now: number = Date.now(),
): DormancySummary {
  let total = 0;
  let dormant = 0;
  let enabledDormant = 0;
  let disabledDormant = 0;
  let excluded = 0;
  let oldestUpn: string | null = null;
  let oldestSignIn: string | null = null;

  for (const r of rows) {
    total++;
    if (isExcluded(r, policy)) {
      excluded++;
      continue;
    }
    const isDormantRow = isDormant(r, policy, now);
    if (!isDormantRow) continue;
    dormant++;
    if (r.accountEnabled) enabledDormant++;
    else disabledDormant++;
    const last = lastSignInOf(r);
    if (oldestSignIn === null || (last !== null && last < oldestSignIn) || (last === null)) {
      // Prefer the "never signed in" rows (last === null) — they're the
      // longest-dormant by definition. Otherwise pick the row with the
      // smallest timestamp (oldest sign-in).
      if (oldestSignIn !== null && last !== null && last >= oldestSignIn) {
        // Existing winner is older — keep.
      } else {
        oldestSignIn = last;
        oldestUpn = r.userPrincipalName;
      }
    }
  }

  return {
    total,
    dormant,
    enabledDormant,
    disabledDormant,
    excluded,
    thresholdDays: policy.thresholdDays,
    oldestDormantUpn: oldestUpn,
    oldestDormantLastSignIn: oldestSignIn,
  };
}
