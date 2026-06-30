// Store layer for the EntraRisk vertical (ADR-0023 §3).
//
// Writes: InsertOrReplace per-user Table row. No detail blob (full riskyUser
// fits the 64 KB per-property cap comfortably).
// Reads : summary counts, paged list for `/api/risky-users/list`, brief-agent
//         prompt row-set scope.
// Retention: trim-at-write, env-aware (180d prod / 14d dev).
//
// Retention uses the ingest MI's legitimate `DeleteEntity` capability on the
// `EntraRisk` table — unlike the Incidents detail-blob path (ADR-0014 §3.3),
// there is no lifecycle-only-deletes invariant here; no blobs to deal with.

import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import type {
  EntraRiskLevel,
  EntraRiskState,
  RiskyUserSummary,
} from "./types.js";
import {
  RISK_LEVELS,
  RISK_STATES,
  type RiskLevel,
  type RiskState,
  type RiskyUserDomain,
} from "./entraRiskParser.js";
import { getTableClient, OPS_TABLES, type TableContext } from "./tables.js";
import { screenPromptContext } from "./promptInjectionDenylist.js";

export const ENTRA_RISK_TABLE_NAME = OPS_TABLES.EntraRisk;

// Re-export for callers that bundle imports via this module.
export { getTableClient, type TableContext };

/**
 * ADR-0023 §3 — PascalCase Table entity shape. Stored column names match the
 * existing convention (`Incidents.Severity`, `SecureScore.CurrentScore`).
 */
export interface EntraRiskEntity extends TableEntity {
  readonly UserPrincipalName: string;
  readonly UserDisplayName: string;
  readonly RiskLevel: string; // narrowed enum or "unknown"
  readonly RiskLevelRaw: string; // raw Graph value (preserves unknownFutureValue etc.)
  readonly RiskState: string;
  readonly RiskStateRaw: string;
  readonly RiskDetail: string; // evolvable enum — stored as-is (ADR-0023 §9)
  readonly RiskLastUpdatedDateTime: string;
  readonly IsDeleted: boolean;
  readonly Processing: boolean; // ADR-0023 §3 — Option A writes always
  readonly IngestedAt: string;
  readonly IngestRunId: string;
}

function domainToEntity(tenantId: string, row: RiskyUserDomain): EntraRiskEntity {
  return {
    partitionKey: tenantId,
    rowKey: row.id,
    UserPrincipalName: row.userPrincipalName,
    UserDisplayName: row.userDisplayName,
    RiskLevel: row.riskLevel,
    RiskLevelRaw: row.riskLevelRaw,
    RiskState: row.riskState,
    RiskStateRaw: row.riskStateRaw,
    RiskDetail: row.riskDetail,
    RiskLastUpdatedDateTime: row.riskLastUpdatedDateTime,
    IsDeleted: row.isDeleted,
    Processing: row.isProcessing,
    IngestedAt: row.ingestedAt,
    IngestRunId: row.ingestRunId,
  };
}

function entityToDomain(e: EntraRiskEntity): RiskyUserDomain {
  return {
    id: e.rowKey,
    userPrincipalName: e.UserPrincipalName,
    userDisplayName: e.UserDisplayName,
    riskLevel: narrowRiskLevel(e.RiskLevel),
    riskLevelRaw: e.RiskLevelRaw ?? e.RiskLevel,
    riskState: narrowRiskState(e.RiskState),
    riskStateRaw: e.RiskStateRaw ?? e.RiskState,
    riskDetail: e.RiskDetail ?? "",
    riskLastUpdatedDateTime: e.RiskLastUpdatedDateTime,
    isDeleted: e.IsDeleted === true,
    isProcessing: e.Processing === true,
    ingestedAt: e.IngestedAt,
    ingestRunId: e.IngestRunId,
  };
}

function entityToSummary(e: EntraRiskEntity): RiskyUserSummary {
  return {
    id: e.rowKey,
    userPrincipalName: e.UserPrincipalName,
    userDisplayName: e.UserDisplayName,
    riskLevel: coerceWireRiskLevel(narrowRiskLevel(e.RiskLevel)),
    riskState: coerceWireRiskState(narrowRiskState(e.RiskState)),
    riskDetail: e.RiskDetail ?? "",
    riskLastUpdatedDateTime: e.RiskLastUpdatedDateTime,
    isDeleted: e.IsDeleted === true,
    isProcessing: e.Processing === true,
  };
}

/**
 * Upsert one risky-user row. `InsertOrReplace` semantics per ADR-0023 §4.
 */
export async function upsertRiskyUser(
  table: TableClient,
  tenantId: string,
  row: RiskyUserDomain,
): Promise<void> {
  await table.upsertEntity(domainToEntity(tenantId, row), "Replace");
}

// --- Read paths -------------------------------------------------------------

export interface ReadRecentOptions {
  readonly includeDeleted?: boolean;
  readonly includeRemediated?: boolean;
  readonly maxRows?: number;
  readonly cursorAfter?: string; // pass-through cursor token for composition
}

export interface ReadRecentResult {
  readonly rows: readonly RiskyUserDomain[];
  readonly nextCursor: string | null;
}

/**
 * Read recent risky-user rows, sorted by `RiskLastUpdatedDateTime` desc.
 *
 * Feeds the summary + list + brief-agent prompt paths. Filters are applied
 * in-memory after a partition scan — at single-tenant scale (low hundreds of
 * rows) this is < 30 ms (ADR-0024 §1.1 derivation).
 */
export async function readRecentRiskyUsers(
  table: TableClient,
  tenantId: string,
  opts: ReadRecentOptions = {},
): Promise<ReadRecentResult> {
  const includeDeleted = opts.includeDeleted === true;
  const includeRemediated = opts.includeRemediated === true;
  const maxRows = Math.max(1, opts.maxRows ?? 100);

  const iter = table.listEntities<EntraRiskEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  });
  const all: EntraRiskEntity[] = [];
  for await (const e of iter) all.push(e);

  let filtered = all;
  if (!includeDeleted) {
    filtered = filtered.filter((e) => e.IsDeleted !== true);
  }
  if (!includeRemediated) {
    filtered = filtered.filter(
      (e) =>
        e.RiskState !== "remediated" &&
        e.RiskState !== "confirmedSafe" &&
        e.RiskState !== "dismissed",
    );
  }

  filtered.sort((a, b) => {
    if (a.RiskLastUpdatedDateTime < b.RiskLastUpdatedDateTime) return 1;
    if (a.RiskLastUpdatedDateTime > b.RiskLastUpdatedDateTime) return -1;
    if (a.rowKey < b.rowKey) return 1;
    if (a.rowKey > b.rowKey) return -1;
    return 0;
  });

  if (opts.cursorAfter && opts.cursorAfter.length > 0) {
    // cursorAfter encodes (rowKey, RiskLastUpdatedDateTime) as "t|k".
    const [cursorT, cursorK] = opts.cursorAfter.split("|", 2);
    if (cursorT !== undefined && cursorK !== undefined) {
      filtered = filtered.filter((e) => {
        if (e.RiskLastUpdatedDateTime < cursorT) return true;
        if (e.RiskLastUpdatedDateTime > cursorT) return false;
        return e.rowKey < cursorK;
      });
    }
  }

  const page = filtered.slice(0, maxRows);
  const hasMore = filtered.length > page.length;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? `${last.RiskLastUpdatedDateTime}|${last.rowKey}` : null;

  return {
    rows: page.map(entityToDomain),
    nextCursor,
  };
}

/**
 * ADR-0020 amendment §Row-set scope — brief-agent prompt-builder input.
 *
 * Filters: `IsDeleted=false AND RiskState NOT IN (remediated, confirmedSafe,
 * dismissed) AND RiskLastUpdatedDateTime >= now - 7d`, capped at 25 ordered
 * descending by `RiskLastUpdatedDateTime`.
 *
 * the returned
 * row-shape is narrowed to `RiskyUserBriefRow` — it deliberately drops
 * `userDisplayName` + `userPrincipalName` (PII) and `isDeleted` /
 * `isProcessing` at the store-layer boundary. The prompt-builder's
 * column-whitelist is the primary defence; this store-layer projection is
 * belt-and-braces, so the first engineer wiring this into the agent has an
 * API-shape safety net (OWASP ASVS §8.3.4 "least data returned from data
 * access layer"; ADR-0020 Step-6 amendment §Columns included).
 */
const BRIEF_LOOKBACK_MS = 7 * 86_400_000;
const BRIEF_ROW_CAP = 25;

/**
 * Narrow row-shape for the brief-agent prompt path. Field inclusion follows
 * the tenant's `userIdentifierStrategy` (ADR-0025 §9.6):
 *   objectId      → base row only (no user-identifying fields).
 *   partial_mask  → base row + `displayNameMasked` (e.g. "J*** D***").
 *   display_name  → base row + `displayName` (full user display name).
 * The prompt builder branches on field presence. `userPrincipalName` is
 * never emitted regardless of strategy — UPN is high-signal PII and not
 * informative for the brief narrative.
 */
export interface RiskyUserBriefRow {
  readonly id: string;
  readonly riskLevel: RiskLevel;
  readonly riskState: RiskState;
  readonly riskLastUpdatedDateTime: string;
  readonly riskDetail: string;
  readonly displayName?: string;
  readonly displayNameMasked?: string;
}

export type RiskyUserBriefIdentifierStrategy =
  | "objectId"
  | "partial_mask"
  | "display_name";

/**
 * Sentinel emitted in place of an Entra `UserDisplayName` that fails the
 * 4-layer prompt-injection screen. Wire-identical to the incidents-agent's
 * `FIELD_REDACTED_SENTINEL` so the brief-agent's redaction signal reads the
 * same as the incidents-agent's. The model is instructed (ADR-0025 §9.6
 * Phase-3+) to narrate around the sentinel rather than invent content.
 *
 * Defence-in-depth role: the 4-layer screen is the primary control; emitting
 * a sentinel rather than dropping the field gives the agent (and any
 * downstream operator viewing the audit-line context) a visible redaction
 * marker and keeps the row count honest.
 */
export const RISKY_USER_DISPLAY_NAME_REDACTED_SENTINEL =
  "[field redacted — content policy]";

export type BriefRedactionField = "displayName" | "displayNameMasked";

function entityToBriefRow(
  e: EntraRiskEntity,
  strategy: RiskyUserBriefIdentifierStrategy,
  maskFn: (name: string) => string,
  onRedaction?: (field: BriefRedactionField) => void,
): RiskyUserBriefRow {
  const base: RiskyUserBriefRow = {
    id: e.rowKey,
    riskLevel: narrowRiskLevel(e.RiskLevel),
    riskState: narrowRiskState(e.RiskState),
    riskLastUpdatedDateTime: e.RiskLastUpdatedDateTime,
    riskDetail: e.RiskDetail ?? "",
  };
  // SEC-L-ADR25-P3-01 hardening (Option D / extended 2026-06-22):
  // screen the name field BEFORE it reaches JSON.stringify in fetchBriefInputs.
  // Rationale: the 4-layer prompt-injection defence wraps the whole
  // riskyUsers.recent block — one hostile UserDisplayName would otherwise
  // contaminate every risky-user row's screening verdict. Field-level
  // screening keeps benign rows usable and redacts only the offending name.
  // Attacker still needs Graph User.ReadWrite.All to write the name
  // (ADR-0025 §9.6 attacker model) — this is DiD, not the primary control.
  //
  // 2026-06-22 §6.3 parity-with-incidents-agent: on screen failure we now
  // emit a sentinel (matching `incidentsPromptBuilder.FIELD_REDACTED_SENTINEL`)
  // rather than silently dropping the field, and fire the `onRedaction`
  // callback so the brief-agent emits an observable warning in App Insights.
  // The previous drop-pattern was operator-invisible — a poisoned name was
  // absorbed with no signal. Sentinel + callback preserves row visibility and
  // surfaces redaction events.
  if (strategy === "display_name") {
    const dn = typeof e.UserDisplayName === "string" ? e.UserDisplayName : "";
    if (!dn) return base;
    const verdict = screenPromptContext(dn);
    if (!verdict.accepted || !verdict.cleaned) {
      onRedaction?.("displayName");
      return { ...base, displayName: RISKY_USER_DISPLAY_NAME_REDACTED_SENTINEL };
    }
    return { ...base, displayName: verdict.cleaned };
  }
  if (strategy === "partial_mask") {
    const dn = typeof e.UserDisplayName === "string" ? e.UserDisplayName : "";
    if (!dn) return base;
    const masked = maskFn(dn);
    if (!masked) return base;
    const verdict = screenPromptContext(masked);
    if (!verdict.accepted || !verdict.cleaned) {
      onRedaction?.("displayNameMasked");
      return {
        ...base,
        displayNameMasked: RISKY_USER_DISPLAY_NAME_REDACTED_SENTINEL,
      };
    }
    return { ...base, displayNameMasked: verdict.cleaned };
  }
  // objectId — unchanged (zero-PII default, ADR-0020 Step-6)
  return base;
}

export async function readRiskyUsersForBrief(
  table: TableClient,
  tenantId: string,
  now: Date,
  opts?: {
    readonly strategy?: RiskyUserBriefIdentifierStrategy;
    readonly maskFn?: (name: string) => string;
    /**
     * Fired once per row whose `UserDisplayName` was redacted by the 4-layer
     * screen (SEC-L-ADR25-P3-01 Option D parity-with-incidents-agent,
     * 2026-06-22). The caller is expected to aggregate and emit one
     * App-Insights warning per agent run — not one per row.
     */
     readonly onRedaction?: (field: BriefRedactionField) => void;
  },
): Promise<readonly RiskyUserBriefRow[]> {
  const cutoffIso = new Date(now.getTime() - BRIEF_LOOKBACK_MS).toISOString();
  const iter = table.listEntities<EntraRiskEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId} and IsDeleted eq false and RiskLastUpdatedDateTime ge ${cutoffIso}`,
    },
  });
  const all: EntraRiskEntity[] = [];
  for await (const e of iter) {
    if (
      e.RiskState === "remediated" ||
      e.RiskState === "confirmedSafe" ||
      e.RiskState === "dismissed"
    ) {
      continue;
    }
    all.push(e);
  }
  all.sort((a, b) => {
    if (a.RiskLastUpdatedDateTime < b.RiskLastUpdatedDateTime) return 1;
    if (a.RiskLastUpdatedDateTime > b.RiskLastUpdatedDateTime) return -1;
    return 0;
  });
  const strategy = opts?.strategy ?? "objectId";
  const maskFn = opts?.maskFn ?? ((s: string) => s);
  const onRedaction = opts?.onRedaction;
  return all
    .slice(0, BRIEF_ROW_CAP)
    .map((e) => entityToBriefRow(e, strategy, maskFn, onRedaction));
}

// --- Retention sweeper -------------------------------------------------------

/**
 * ADR-0023 §6 — delete rows with `RiskLastUpdatedDateTime < olderThan`.
 * Called by the orchestrator AFTER a successful fetch+upsert. Returns the
 * number of rows deleted.
 */
export async function sweepExpiredRows(
  table: TableClient,
  tenantId: string,
  olderThan: Date,
): Promise<number> {
  const cutoffIso = olderThan.toISOString();
  const iter = table.listEntities<EntraRiskEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId} and RiskLastUpdatedDateTime lt ${cutoffIso}`,
    },
  });
  let deleted = 0;
  for await (const e of iter) {
    await table.deleteEntity(e.partitionKey, e.rowKey);
    deleted += 1;
  }
  return deleted;
}

// --- Summary counts (for /api/risky-users/summary) --------------------------

export interface RiskyUsersCountsDerivation {
  readonly total: number;
  readonly byRiskLevel: Record<EntraRiskLevel, number>;
  readonly byRiskState: Record<EntraRiskState, number>;
  readonly processing: number;
  readonly softDeleted: number;
  readonly mostRecent: RiskyUserSummary | null;
  readonly latestIngestedAt: string | null;
}

const EMPTY_RISK_LEVEL: Record<EntraRiskLevel, number> = {
  low: 0,
  medium: 0,
  high: 0,
  hidden: 0,
  none: 0,
  unknown: 0,
};

const EMPTY_RISK_STATE: Record<EntraRiskState, number> = {
  none: 0,
  atRisk: 0,
  confirmedSafe: 0,
  confirmedCompromised: 0,
  remediated: 0,
  dismissed: 0,
  unknown: 0,
};

/**
 * Compute summary counts + most-recent, applying ADR-0024 §1.1 default
 * exclusions: `IsDeleted=true` rows feed `softDeleted` only (not `total` /
 * `byRiskLevel` / `byRiskState`); `mostRecent` filters remediated / confirmed-
 * safe / dismissed.
 */
export async function readRiskyUsersCounts(
  table: TableClient,
  tenantId: string,
): Promise<RiskyUsersCountsDerivation> {
  const iter = table.listEntities<EntraRiskEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  });

  const byRiskLevel: Record<EntraRiskLevel, number> = { ...EMPTY_RISK_LEVEL };
  const byRiskState: Record<EntraRiskState, number> = { ...EMPTY_RISK_STATE };
  let total = 0;
  let processing = 0;
  let softDeleted = 0;
  let mostRecent: EntraRiskEntity | null = null;
  let latestIngestedAt: string | null = null;

  for await (const e of iter) {
    if (e.IngestedAt && (latestIngestedAt === null || e.IngestedAt > latestIngestedAt)) {
      latestIngestedAt = e.IngestedAt;
    }
    if (e.IsDeleted === true) {
      softDeleted += 1;
      continue;
    }
    total += 1;
    if (e.Processing === true) processing += 1;
    const level = coerceWireRiskLevel(narrowRiskLevel(e.RiskLevel));
    const state = coerceWireRiskState(narrowRiskState(e.RiskState));
    byRiskLevel[level] += 1;
    byRiskState[state] += 1;

    // mostRecent: exclude remediated / confirmedSafe / dismissed — the tile's
    // "most recent" should highlight something actionable per ADR-0024 §1.1.
    if (
      state === "remediated" ||
      state === "confirmedSafe" ||
      state === "dismissed"
    ) {
      continue;
    }
    if (
      mostRecent === null ||
      e.RiskLastUpdatedDateTime > mostRecent.RiskLastUpdatedDateTime
    ) {
      mostRecent = e;
    }
  }

  return {
    total,
    byRiskLevel,
    byRiskState,
    processing,
    softDeleted,
    mostRecent: mostRecent ? entityToSummary(mostRecent) : null,
    latestIngestedAt,
  };
}

// --- Helpers ----------------------------------------------------------------

function narrowRiskLevel(raw: string): RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(raw ?? "")
    ? ((raw ?? "") as RiskLevel)
    : "unknown";
}
function narrowRiskState(raw: string): RiskState {
  return (RISK_STATES as readonly string[]).includes(raw ?? "")
    ? ((raw ?? "") as RiskState)
    : "unknown";
}

function coerceWireRiskLevel(v: string): EntraRiskLevel {
  switch (v) {
    case "low":
    case "medium":
    case "high":
    case "hidden":
    case "none":
      return v;
    default:
      return "unknown";
  }
}

function coerceWireRiskState(v: string): EntraRiskState {
  switch (v) {
    case "none":
    case "atRisk":
    case "confirmedSafe":
    case "confirmedCompromised":
    case "remediated":
    case "dismissed":
      return v;
    default:
      return "unknown";
  }
}

// Expose the entity->summary projection for callers that already have an
// entity in hand (e.g. store tests that mock TableClient).
export const internals = {
  entityToSummary,
  entityToDomain,
  coerceWireRiskLevel,
  coerceWireRiskState,
};
