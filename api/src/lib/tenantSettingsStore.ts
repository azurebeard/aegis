// Per-tenant operator settings (ADR-0025 Phase 1).
//
// Schema:
//   PartitionKey  = tenantId
//   RowKey        = "tile-visibility"
//   SecureScore   = bool (default true when row absent)
//   Incidents     = bool (default true)
//   Brief         = bool (default true)
//   RiskyUsers    = bool (default true)
//   UpdatedAt     = ISO-8601 UTC
//   UpdatedBy     = principal upn or oid (max 256 chars)
//
// Default-when-absent: all tiles visible (`true`). Missing row ≡ "no
// operator has ever visited the admin page" — fresh tenants must render
// everything by default. Only once a row exists does the stored mix
// become authoritative.

import { odata, type TableClient, type TableEntity } from "@azure/data-tables";

export const TILE_VISIBILITY_ROW_KEY = "tile-visibility";
export const AGENT_BUDGET_ROW_KEY = "agent-budget";
export const USER_IDENTIFIER_STRATEGY_ROW_KEY = "user-identifier-strategy";
export const BRANDING_ROW_KEY = "branding";
export const REPORT_CADENCE_ROW_KEY = "report-cadence"; // ADR-0030 Phase A
export const KEV_BASELINE_ROW_KEY = "kev-baseline";    // ADR-0033 Phase 2.5
export const DORMANCY_POLICY_ROW_KEY = "dormancy-policy"; // ADR-0034 §4.2 Phase 8B
export const GEO_FENCE_ROW_KEY = "geo-fence"; // ADR-0034 §4.1 Phase 8C
/** ADR-0030 Phase C — admin-managed report-email config (recipients, enabled,
 *  subjectPrefix, external-allowlist toggle). Singleton RowKey, not in the
 *  internal `report-email-send:*` prefix (which is mailSender-MI-only). */
export const REPORT_EMAIL_CONFIG_ROW_KEY = "report-email-config";
/** ADR-0030 Phase C §C.7 — RowKey prefix reserved for per-send history rows
 *  (`report-email-send:<graphMessageId>`). Writes from any path OTHER than
 *  the mailSender MI / orchestrator are rejected at validation time. The
 *  `report-email-config` admin row is NOT under this prefix. */
export const REPORT_EMAIL_SEND_ROW_PREFIX = "report-email-send:";
/** ADR-0030 Phase C §C.5.1 — 24h Idempotency-Key replay cache RowKey prefix.
 *  Stored response body returned verbatim on key match within window.
 *  Written by the mailSender MI alongside the send-history row. */
export const REPORT_EMAIL_IDEMPOTENCY_ROW_PREFIX = "report-email-idempotency:";
/** §C.5.1 — replay window in milliseconds. 24h is the spec; readers reject
 *  rows older than this regardless of whether a cleanup job has trimmed them. */
export const REPORT_EMAIL_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Canonical tile keys. Any unknown key is rejected at the PATCH handler.
 *  Additive over time — adding a new key is forward-compatible because
 *  legacy rows (without the new column) coerce to the documented default. */
export const TILE_KEYS = [
  "secureScore",
  "incidents",
  "brief",
  "riskyUsers",
  "posture",
  "stack", // ADR-0031 Phase A
  "kev",   // ADR-0032
  "userDormancy", // ADR-0034 Phase 8B
  "signIns", // ADR-0034 Phase 8C
  "conditionalAccess", // ADR-0034 Phase 8D
  "azureSecureScore", // ADR-0036
  "ransomwareIntel", // ADR-0037
] as const;
export type TileKey = (typeof TILE_KEYS)[number];

export type TileVisibility = Record<TileKey, boolean>;

export const DEFAULT_TILE_VISIBILITY: Readonly<TileVisibility> = Object.freeze({
  secureScore: true,
  incidents: true,
  brief: true,
  riskyUsers: true,
  posture: true,
  stack: true,
  kev: true,
  userDormancy: true,
  signIns: true,
  conditionalAccess: true,
  azureSecureScore: true,
  ransomwareIntel: true,
});

export interface TenantSettings {
  readonly tileVisibility: TileVisibility;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/** Per-tile capability derived from IngestHealth (ADR-0025 §8). */
export type TileCapability = "present" | "licence_required" | "unknown";
export type TileCapabilities = Record<TileKey, TileCapability>;

/**
 * Source-key map — each tile's capability is derived from the Status column
 * of the `IngestHealth` row for the listed `graph.*` / `agent.*` source.
 * Order is load-bearing only for the type-level ergonomics (Record<TileKey,…>).
 * Kept alongside the TILE_KEYS declaration so a single edit covers both.
 */
export const TILE_INGEST_SOURCE: Readonly<Record<TileKey, string>> = Object.freeze({
  secureScore: "graph.security.secureScores",
  incidents: "graph.security.incidents",
  brief: "agent.aegis.brief",
  riskyUsers: "graph.security.riskyUsers",
  posture: "agent.aegis.posture",
  // ADR-0031 stack inventory has no scheduled ingest — operator-curated.
  // The synthetic source name will never have an IngestHealth row, so
  // capabilityFromStatus returns "unknown" → effective visibility passes
  // through. There is no licence dimension on stack.
  stack: "operator.stack",
  // ADR-0032 KEV ingest. CISA feed is unauthenticated public — no licence
  // dimension. Capability reflects daily-Timer health (healthy / failing /
  // awaiting_first_run) but never licence_required.
  kev: "cisa.kev",
  // ADR-0034 Phase 8B — UserDormancy. Entra ID P1 gate detected at ingest
  // time (signInActivity null on every row → sticky `licence_required`).
  // Effective visibility flips off automatically on P1-absent tenants per
  // computeEffectiveVisibility.
  userDormancy: "graph.users.dormancy",
  // ADR-0034 Phase 8C — SignIns. Entra ID P1 gate detected at ingest time
  // (403 with "premium licence required" on /auditLogs/signIns). Same
  // auto-hide pattern.
  signIns: "graph.auditLogs.signIns",
  // ADR-0034 Phase 8D — Conditional Access policy state ingest. No licence
  // dimension on the endpoint itself (Free tenants return empty value:[]
  // which is a legitimate "no policies" state, not a licence absence per
  // ADR-0034 §6); capability reflects hourly-Timer health only.
  conditionalAccess: "graph.identity.conditionalAccess.policies",
  // ADR-0036 — Defender for Cloud Secure Score. ARM data plane (not Graph);
  // no licence dimension on the read endpoint (Free-tier subscriptions
  // return a low score, but a valid one — not licence_required). Capability
  // reflects daily-Timer health only.
  azureSecureScore: "azure.security.defenderForCloud.secureScores",
  // ADR-0037 — ransomware.live PRO threat-intel. External HTTP source
  // (not Graph, not ARM); capability reflects hourly-Timer health only.
  // No licence dimension on the upstream — the PRO API key is the gate
  // (auth_unavailable when KV-secret is unseeded), and that's surfaced
  // via the latest audit line's error.kind rather than the IngestHealth
  // Status field.
  ransomwareIntel: "external.ransomware.live",
});

/** Derive a TileCapability from an IngestHealth row's Status column. */
export function capabilityFromStatus(status: string | null | undefined): TileCapability {
  if (status === "licence_required") return "licence_required";
  if (status === undefined || status === null) return "unknown";
  return "present";
}

/** Server-side effective visibility — ADR-0025 §8.3. */
export function computeEffectiveVisibility(
  visibility: TileVisibility,
  capabilities: TileCapabilities,
): TileVisibility {
  const out = {} as TileVisibility;
  for (const k of TILE_KEYS) {
    out[k] = visibility[k] && capabilities[k] !== "licence_required";
  }
  return out;
}

interface TileVisibilityEntity extends TableEntity {
  readonly SecureScore: boolean;
  readonly Incidents: boolean;
  readonly Brief: boolean;
  readonly RiskyUsers: boolean;
  readonly Posture?: boolean;
  readonly Stack?: boolean; // ADR-0031 — optional for legacy rows
  readonly Kev?: boolean;   // ADR-0032 — optional for legacy rows
  readonly UserDormancy?: boolean; // ADR-0034 Phase 8B — optional for legacy rows
  readonly SignIns?: boolean;      // ADR-0034 Phase 8C — optional for legacy rows
  readonly ConditionalAccess?: boolean; // ADR-0034 Phase 8D — optional for legacy rows
  readonly AzureSecureScore?: boolean; // ADR-0036 — optional for legacy rows
  readonly RansomwareIntel?: boolean;  // ADR-0037 — optional for legacy rows
  readonly UpdatedAt: string;
  readonly UpdatedBy: string;
}

/**
 * Read the settings row for a tenant. Returns defaults (all tiles visible,
 * no metadata) when the row is missing.
 */
export async function readTenantSettings(
  table: TableClient,
  tenantId: string,
): Promise<TenantSettings> {
  try {
    const e = await table.getEntity<TileVisibilityEntity>(tenantId, TILE_VISIBILITY_ROW_KEY);
    return {
      tileVisibility: {
        secureScore: coerceBool(e.SecureScore, true),
        incidents: coerceBool(e.Incidents, true),
        brief: coerceBool(e.Brief, true),
        riskyUsers: coerceBool(e.RiskyUsers, true),
        posture: coerceBool(e.Posture, true),
        stack: coerceBool(e.Stack, true),
        kev: coerceBool(e.Kev, true),
        userDormancy: coerceBool(e.UserDormancy, true),
        signIns: coerceBool(e.SignIns, true),
        conditionalAccess: coerceBool(e.ConditionalAccess, true),
        azureSecureScore: coerceBool(e.AzureSecureScore, true),
        ransomwareIntel: coerceBool(e.RansomwareIntel, true),
      },
      updatedAt: typeof e.UpdatedAt === "string" && e.UpdatedAt ? e.UpdatedAt : null,
      updatedBy: typeof e.UpdatedBy === "string" && e.UpdatedBy ? e.UpdatedBy : null,
    };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      return {
        tileVisibility: { ...DEFAULT_TILE_VISIBILITY },
        updatedAt: null,
        updatedBy: null,
      };
    }
    throw err;
  }
}

/**
 * Merge-upsert the settings row. Reads the existing row (or defaults) and
 * applies the supplied partial patch, then writes the full row back with
 * `InsertOrReplace` semantics. Writer (admin PATCH handler) has already
 * validated that every key in `patch` is a known `TileKey` and every value
 * is a boolean.
 */
export async function upsertTileVisibility(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly patch: Partial<TileVisibility>;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<TenantSettings> {
  const current = await readTenantSettings(table, args.tenantId);
  const merged: TileVisibility = {
    ...current.tileVisibility,
    ...args.patch,
  };
  const entity: TileVisibilityEntity = {
    partitionKey: args.tenantId,
    rowKey: TILE_VISIBILITY_ROW_KEY,
    SecureScore: merged.secureScore,
    Incidents: merged.incidents,
    Brief: merged.brief,
    RiskyUsers: merged.riskyUsers,
    Posture: merged.posture,
    Stack: merged.stack,
    Kev: merged.kev,
    UserDormancy: merged.userDormancy,
    SignIns: merged.signIns,
    ConditionalAccess: merged.conditionalAccess,
    AzureSecureScore: merged.azureSecureScore,
    RansomwareIntel: merged.ransomwareIntel,
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    tileVisibility: merged,
    updatedAt: args.updatedAt,
    updatedBy: args.updatedBy,
  };
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  // Defensive: Table Storage returns bools as bools, but on older rows /
  // manual edits a string "true" could leak in. Accept the common
  // representations; fall back to the declared default for anything else.
  if (v === "true" || v === "True") return true;
  if (v === "false" || v === "False") return false;
  return fallback;
}

// --- Phase 3: agent-budget row (ADR-0025 §9) --------------------------------

export interface AgentBudgetRecord {
  readonly briefManualRunCeiling: number;
  readonly briefDailyTokenBudget: number;
  readonly postureManualRunCeiling: number;
  readonly postureWeeklyTokenBudget: number;
  readonly incidentsAnalysisManualRunCeiling: number;
  readonly incidentsAnalysisDailyTokenBudget: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** "default" when no row exists — values came from env fallback; "tenant" when operator has saved. */
  readonly source: "default" | "tenant";
}

export interface AgentBudgetDefaults {
  readonly briefManualRunCeiling: number;
  readonly briefDailyTokenBudget: number;
  readonly postureManualRunCeiling: number;
  readonly postureWeeklyTokenBudget: number;
  readonly incidentsAnalysisManualRunCeiling: number;
  readonly incidentsAnalysisDailyTokenBudget: number;
}

/** Validation bounds — ADR-0025 §9.3 + ADR-0027 §Decision.4 + ADR-0028 §Decision.4 (flat-additive).
 *  Posture token field is `Weekly` because the budget row is keyed per
 *  ISO week for posture; the per-day "manual
 *  run ceiling" still gates short-window operator click-storms. */
export const AGENT_BUDGET_BOUNDS = Object.freeze({
  briefManualRunCeiling: { min: 1, max: 100 } as const,
  briefDailyTokenBudget: { min: 50_000, max: 500_000 } as const,
  postureManualRunCeiling: { min: 1, max: 50 } as const,
  postureWeeklyTokenBudget: { min: 5_000, max: 200_000 } as const,
  incidentsAnalysisManualRunCeiling: { min: 1, max: 100 } as const,
  // SEC-BUG-INCIDENTS-BUDGET-MIN — min == per-run reservation
  // (`estimateReservedTokens` in runIncidentsAgent.ts returns 3_000
  // as of 2026-06-22).
  // max = 60_000 = 20 runs/day worth at the new reservation.
  // Mirrors web/src/features/settings/types.ts:AGENT_BUDGET_BOUNDS.
  incidentsAnalysisDailyTokenBudget: { min: 3_000, max: 60_000 } as const,
});

interface AgentBudgetEntity extends TableEntity {
  readonly BriefManualRunCeiling: number;
  readonly BriefDailyTokenBudget: number;
  readonly PostureManualRunCeiling?: number;
  readonly PostureWeeklyTokenBudget?: number;
  /** Legacy column name (pre-SEC-L-B2-01 rename). Read-only
   *  fallback when `PostureWeeklyTokenBudget` is absent on a row written
   *  before the rename — supports the dev tenant's existing rows
   *  without a one-shot migration. New writes always use the renamed
   *  column. */
  readonly PostureDailyTokenBudget?: number;
  readonly IncidentsAnalysisManualRunCeiling?: number;
  readonly IncidentsAnalysisDailyTokenBudget?: number;
  readonly UpdatedAt: string;
  readonly UpdatedBy: string;
}

export async function readAgentBudget(
  table: TableClient,
  tenantId: string,
  defaults: AgentBudgetDefaults,
): Promise<AgentBudgetRecord> {
  try {
    const e = await table.getEntity<AgentBudgetEntity>(tenantId, AGENT_BUDGET_ROW_KEY);
    return {
      briefManualRunCeiling: coerceInt(e.BriefManualRunCeiling, defaults.briefManualRunCeiling),
      briefDailyTokenBudget: coerceInt(e.BriefDailyTokenBudget, defaults.briefDailyTokenBudget),
      postureManualRunCeiling: coerceInt(
        e.PostureManualRunCeiling,
        defaults.postureManualRunCeiling,
      ),
      // Read the renamed column first; fall back to the legacy column if a
      // pre-SEC-L-B2-01 row hasn't been re-saved yet.
      postureWeeklyTokenBudget: coerceInt(
        e.PostureWeeklyTokenBudget,
        coerceInt(e.PostureDailyTokenBudget, defaults.postureWeeklyTokenBudget),
      ),
      incidentsAnalysisManualRunCeiling: coerceInt(
        e.IncidentsAnalysisManualRunCeiling,
        defaults.incidentsAnalysisManualRunCeiling,
      ),
      incidentsAnalysisDailyTokenBudget: coerceInt(
        e.IncidentsAnalysisDailyTokenBudget,
        defaults.incidentsAnalysisDailyTokenBudget,
      ),
      updatedAt: typeof e.UpdatedAt === "string" && e.UpdatedAt ? e.UpdatedAt : null,
      updatedBy: typeof e.UpdatedBy === "string" && e.UpdatedBy ? e.UpdatedBy : null,
      source: "tenant",
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        briefManualRunCeiling: defaults.briefManualRunCeiling,
        briefDailyTokenBudget: defaults.briefDailyTokenBudget,
        postureManualRunCeiling: defaults.postureManualRunCeiling,
        postureWeeklyTokenBudget: defaults.postureWeeklyTokenBudget,
        incidentsAnalysisManualRunCeiling: defaults.incidentsAnalysisManualRunCeiling,
        incidentsAnalysisDailyTokenBudget: defaults.incidentsAnalysisDailyTokenBudget,
        updatedAt: null,
        updatedBy: null,
        source: "default",
      };
    }
    throw err;
  }
}

export interface AgentBudgetPatch {
  readonly briefManualRunCeiling?: number;
  readonly briefDailyTokenBudget?: number;
  readonly postureManualRunCeiling?: number;
  readonly postureWeeklyTokenBudget?: number;
  readonly incidentsAnalysisManualRunCeiling?: number;
  readonly incidentsAnalysisDailyTokenBudget?: number;
}

export async function upsertAgentBudget(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly patch: AgentBudgetPatch;
    readonly defaults: AgentBudgetDefaults;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<AgentBudgetRecord> {
  const current = await readAgentBudget(table, args.tenantId, args.defaults);
  const merged = {
    briefManualRunCeiling:
      args.patch.briefManualRunCeiling ?? current.briefManualRunCeiling,
    briefDailyTokenBudget:
      args.patch.briefDailyTokenBudget ?? current.briefDailyTokenBudget,
    postureManualRunCeiling:
      args.patch.postureManualRunCeiling ?? current.postureManualRunCeiling,
    postureWeeklyTokenBudget:
      args.patch.postureWeeklyTokenBudget ?? current.postureWeeklyTokenBudget,
    incidentsAnalysisManualRunCeiling:
      args.patch.incidentsAnalysisManualRunCeiling ??
      current.incidentsAnalysisManualRunCeiling,
    incidentsAnalysisDailyTokenBudget:
      args.patch.incidentsAnalysisDailyTokenBudget ??
      current.incidentsAnalysisDailyTokenBudget,
  };
  const entity: AgentBudgetEntity = {
    partitionKey: args.tenantId,
    rowKey: AGENT_BUDGET_ROW_KEY,
    BriefManualRunCeiling: merged.briefManualRunCeiling,
    BriefDailyTokenBudget: merged.briefDailyTokenBudget,
    PostureManualRunCeiling: merged.postureManualRunCeiling,
    PostureWeeklyTokenBudget: merged.postureWeeklyTokenBudget,
    IncidentsAnalysisManualRunCeiling: merged.incidentsAnalysisManualRunCeiling,
    IncidentsAnalysisDailyTokenBudget: merged.incidentsAnalysisDailyTokenBudget,
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    ...merged,
    updatedAt: args.updatedAt,
    updatedBy: args.updatedBy,
    source: "tenant",
  };
}

// --- Phase 3: user-identifier-strategy row (ADR-0025 §9) -------------------

export const USER_IDENTIFIER_STRATEGIES = [
  "objectId",
  "partial_mask",
  "display_name",
] as const;
export type UserIdentifierStrategy = (typeof USER_IDENTIFIER_STRATEGIES)[number];
const USER_IDENTIFIER_STRATEGY_SET = new Set<string>(USER_IDENTIFIER_STRATEGIES);

export interface UserIdentifierStrategyRecord {
  readonly strategy: UserIdentifierStrategy;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

interface UserIdentifierStrategyEntity extends TableEntity {
  readonly Strategy: string;
  readonly UpdatedAt: string;
  readonly UpdatedBy: string;
}

export const DEFAULT_USER_IDENTIFIER_STRATEGY: UserIdentifierStrategy = "objectId";

export async function readUserIdentifierStrategy(
  table: TableClient,
  tenantId: string,
): Promise<UserIdentifierStrategyRecord> {
  try {
    const e = await table.getEntity<UserIdentifierStrategyEntity>(
      tenantId,
      USER_IDENTIFIER_STRATEGY_ROW_KEY,
    );
    const s = typeof e.Strategy === "string" && USER_IDENTIFIER_STRATEGY_SET.has(e.Strategy)
      ? (e.Strategy as UserIdentifierStrategy)
      : DEFAULT_USER_IDENTIFIER_STRATEGY;
    return {
      strategy: s,
      updatedAt: typeof e.UpdatedAt === "string" && e.UpdatedAt ? e.UpdatedAt : null,
      updatedBy: typeof e.UpdatedBy === "string" && e.UpdatedBy ? e.UpdatedBy : null,
      source: "tenant",
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        strategy: DEFAULT_USER_IDENTIFIER_STRATEGY,
        updatedAt: null,
        updatedBy: null,
        source: "default",
      };
    }
    throw err;
  }
}

export async function upsertUserIdentifierStrategy(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly strategy: UserIdentifierStrategy;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<UserIdentifierStrategyRecord> {
  const entity: UserIdentifierStrategyEntity = {
    partitionKey: args.tenantId,
    rowKey: USER_IDENTIFIER_STRATEGY_ROW_KEY,
    Strategy: args.strategy,
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    strategy: args.strategy,
    updatedAt: args.updatedAt,
    updatedBy: args.updatedBy,
    source: "tenant",
  };
}

// --- ADR-0030 Phase A: report-cadence row -----------------------------------

export const REPORT_CADENCES = ["weekly", "monthly", "quarterly"] as const;
export type ReportCadenceValue = (typeof REPORT_CADENCES)[number];
const REPORT_CADENCE_SET = new Set<string>(REPORT_CADENCES);
export const DEFAULT_REPORT_CADENCE: ReportCadenceValue = "monthly";

export interface ReportCadenceRecord {
  readonly cadence: ReportCadenceValue;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

interface ReportCadenceEntity extends TableEntity {
  readonly Cadence: string;
  readonly UpdatedAt: string;
  readonly UpdatedBy: string;
}

export async function readReportCadence(
  table: TableClient,
  tenantId: string,
): Promise<ReportCadenceRecord> {
  try {
    const e = await table.getEntity<ReportCadenceEntity>(tenantId, REPORT_CADENCE_ROW_KEY);
    const c =
      typeof e.Cadence === "string" && REPORT_CADENCE_SET.has(e.Cadence)
        ? (e.Cadence as ReportCadenceValue)
        : DEFAULT_REPORT_CADENCE;
    return {
      cadence: c,
      updatedAt: typeof e.UpdatedAt === "string" && e.UpdatedAt ? e.UpdatedAt : null,
      updatedBy: typeof e.UpdatedBy === "string" && e.UpdatedBy ? e.UpdatedBy : null,
      source: "tenant",
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        cadence: DEFAULT_REPORT_CADENCE,
        updatedAt: null,
        updatedBy: null,
        source: "default",
      };
    }
    throw err;
  }
}

// ─── ADR-0030 Phase C — report-email-config (admin-managed) ─────────────────

export interface ReportEmailConfigRecord {
  readonly enabled: boolean;
  readonly recipients: readonly string[];
  readonly allowExternalRecipients: boolean;
  readonly externalRecipientDomains: readonly string[];
  readonly subjectPrefix: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

interface ReportEmailConfigEntity extends TableEntity {
  readonly Enabled: boolean;
  readonly Recipients: string; // JSON-encoded string[]
  readonly AllowExternalRecipients: boolean;
  readonly ExternalRecipientDomains: string; // JSON-encoded string[]
  readonly SubjectPrefix: string;
  readonly UpdatedAt: string;
  readonly UpdatedBy: string;
}

export const DEFAULT_REPORT_EMAIL_CONFIG: Readonly<ReportEmailConfigRecord> = Object.freeze({
  enabled: false,
  recipients: [],
  allowExternalRecipients: false,
  externalRecipientDomains: [],
  subjectPrefix: null,
  updatedAt: null,
  updatedBy: null,
  source: "default",
});

function safeJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

export async function readReportEmailConfig(
  table: TableClient,
  tenantId: string,
): Promise<ReportEmailConfigRecord> {
  try {
    const e = await table.getEntity<ReportEmailConfigEntity>(
      tenantId,
      REPORT_EMAIL_CONFIG_ROW_KEY,
    );
    return {
      enabled: typeof e.Enabled === "boolean" ? e.Enabled : false,
      recipients: safeJsonStringArray(e.Recipients),
      allowExternalRecipients:
        typeof e.AllowExternalRecipients === "boolean" ? e.AllowExternalRecipients : false,
      externalRecipientDomains: safeJsonStringArray(e.ExternalRecipientDomains),
      subjectPrefix:
        typeof e.SubjectPrefix === "string" && e.SubjectPrefix.length > 0
          ? e.SubjectPrefix
          : null,
      updatedAt: typeof e.UpdatedAt === "string" && e.UpdatedAt ? e.UpdatedAt : null,
      updatedBy: typeof e.UpdatedBy === "string" && e.UpdatedBy ? e.UpdatedBy : null,
      source: "tenant",
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { ...DEFAULT_REPORT_EMAIL_CONFIG };
    }
    throw err;
  }
}

export interface ReportEmailConfigPatch {
  readonly enabled: boolean;
  readonly recipients: readonly string[];
  readonly allowExternalRecipients: boolean;
  readonly externalRecipientDomains: readonly string[];
  readonly subjectPrefix: string | null;
}

/**
 * Insert or update the `report-email-config` row. Caller is the admin
 * patch endpoint (uses the ingest MI's TenantSettings TDC grant — same
 * one tile-visibility and branding writes go through). The mailSender MI
 * does NOT use this writer; that MI's TDC scope is for the send-history
 * + idempotency-cache rows only.
 */
export async function upsertReportEmailConfig(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly patch: ReportEmailConfigPatch;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<ReportEmailConfigRecord> {
  const entity: ReportEmailConfigEntity = {
    partitionKey: args.tenantId,
    rowKey: REPORT_EMAIL_CONFIG_ROW_KEY,
    Enabled: args.patch.enabled,
    Recipients: JSON.stringify(args.patch.recipients),
    AllowExternalRecipients: args.patch.allowExternalRecipients,
    ExternalRecipientDomains: JSON.stringify(args.patch.externalRecipientDomains),
    SubjectPrefix: args.patch.subjectPrefix ?? "",
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    enabled: args.patch.enabled,
    recipients: [...args.patch.recipients],
    allowExternalRecipients: args.patch.allowExternalRecipients,
    externalRecipientDomains: [...args.patch.externalRecipientDomains],
    subjectPrefix: args.patch.subjectPrefix,
    updatedAt: args.updatedAt,
    updatedBy: args.updatedBy,
    source: "tenant",
  };
}

// ─── ADR-0030 Phase C — report-email-send:<graphMessageId> history rows ─────

export interface ReportEmailSendRecord {
  readonly graphMessageId: string;
  readonly tenantId: string;
  readonly periodKey: string;
  readonly sentAt: string;
  readonly senderMailbox: string;
  readonly recipients: readonly string[];
  readonly operatorPrincipal: string;
  readonly internetMessageId: string;
  readonly clientRequestId: string;
  readonly auditLineSeq: number;
  readonly auditLineSha256: string;
  readonly schemaVersion: 1;
}

interface ReportEmailSendEntity extends TableEntity {
  readonly SchemaVersion: number;
  readonly PeriodKey: string;
  readonly SentAt: string;
  readonly SenderMailbox: string;
  readonly Recipients: string; // JSON-encoded string[]
  readonly OperatorPrincipal: string;
  readonly InternetMessageId: string;
  readonly ClientRequestId: string;
  readonly AuditLineSeq: number;
  readonly AuditLineSha256: string;
}

/**
 * Insert a `report-email-send:<graphMessageId>` row into TenantSettings.
 * Internal-only: callers MUST be the mailSender MI's orchestrator (the patch
 * surface rejects writes with this RowKey prefix). The Table-Data-Contributor
 * grant on TenantSettings is scoped to the mailSender MI by Bicep (§C.9).
 */
// ─── ADR-0030 Phase C §C.5.1 — Idempotency-Key replay cache ─────────────────

export interface ReportEmailIdempotencyRecord {
  readonly idempotencyKey: string;
  readonly periodKey: string;
  readonly responseBody: Record<string, unknown>; // verbatim handler response
  readonly cachedAt: string;
  readonly expiresAt: string;
}

interface ReportEmailIdempotencyEntity extends TableEntity {
  readonly SchemaVersion: number;
  readonly IdempotencyKey: string;
  readonly PeriodKey: string;
  readonly ResponseBody: string; // JSON-encoded
  readonly CachedAt: string;
  readonly ExpiresAt: string;
}

/**
 * Read a previously-cached idempotency entry. Returns null if no row exists
 * OR if the row exists but is older than `REPORT_EMAIL_IDEMPOTENCY_TTL_MS`.
 * The TTL check defends against the cleanup job lagging — a stale row in
 * storage MUST NOT serve a replay outside the spec'd window.
 */
export async function readReportEmailIdempotency(
  table: TableClient,
  tenantId: string,
  idempotencyKey: string,
  now: number = Date.now(),
): Promise<ReportEmailIdempotencyRecord | null> {
  const rowKey = `${REPORT_EMAIL_IDEMPOTENCY_ROW_PREFIX}${idempotencyKey}`;
  try {
    const e = await table.getEntity<ReportEmailIdempotencyEntity>(tenantId, rowKey);
    const expiresAtMs = Date.parse(e.ExpiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      return null;
    }
    let responseBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(e.ResponseBody);
      if (typeof parsed !== "object" || parsed === null) return null;
      responseBody = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    return {
      idempotencyKey: typeof e.IdempotencyKey === "string" ? e.IdempotencyKey : idempotencyKey,
      periodKey: typeof e.PeriodKey === "string" ? e.PeriodKey : "",
      responseBody,
      cachedAt: typeof e.CachedAt === "string" ? e.CachedAt : "",
      expiresAt: typeof e.ExpiresAt === "string" ? e.ExpiresAt : "",
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/**
 * Insert (or overwrite) an idempotency cache row. Internal-only; the patch
 * surface (KNOWN allowlist in `patchSettings.ts`) does not target this prefix.
 * Caller MUST be authenticated as the mailSender MI (the only principal with
 * Storage Table Data Contributor on TenantSettings, ADR-0030 §C.9).
 */
export async function upsertReportEmailIdempotency(
  table: TableClient,
  tenantId: string,
  record: ReportEmailIdempotencyRecord,
): Promise<void> {
  const entity: ReportEmailIdempotencyEntity = {
    partitionKey: tenantId,
    rowKey: `${REPORT_EMAIL_IDEMPOTENCY_ROW_PREFIX}${record.idempotencyKey}`,
    SchemaVersion: 1,
    IdempotencyKey: record.idempotencyKey,
    PeriodKey: record.periodKey,
    ResponseBody: JSON.stringify(record.responseBody),
    CachedAt: record.cachedAt,
    ExpiresAt: record.expiresAt,
  };
  await table.upsertEntity(entity, "Replace");
}

/**
 * Read a single `report-email-send:<graphMessageId>` row.
 * Returns null when absent (e.g. erased via DELETE) — caller surfaces 404.
 */
export async function readReportEmailSend(
  table: TableClient,
  tenantId: string,
  graphMessageId: string,
): Promise<ReportEmailSendRecord | null> {
  const rowKey = `${REPORT_EMAIL_SEND_ROW_PREFIX}${graphMessageId}`;
  try {
    const e = await table.getEntity<ReportEmailSendEntity>(tenantId, rowKey);
    return entityToReportEmailSendRecord(e, tenantId, graphMessageId);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/**
 * Delete a single send-history row (right-to-erasure, §C.10). Returns true
 * if a row was deleted, false if it was already absent (idempotent DELETE).
 * Audit chain entries (intent + sent/failed) are NOT touched — chain
 * integrity is non-negotiable; only the plaintext recipient row goes.
 */
export async function deleteReportEmailSend(
  table: TableClient,
  tenantId: string,
  graphMessageId: string,
): Promise<boolean> {
  const rowKey = `${REPORT_EMAIL_SEND_ROW_PREFIX}${graphMessageId}`;
  try {
    await table.deleteEntity(tenantId, rowKey);
    return true;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    throw err;
  }
}

/**
 * List send-history rows for a tenant. §C.16 — descending `sentAt`, default
 * `limit=20`, hard cap `limit=100`, opaque continuationToken.
 *
 * v1 implementation note: Azure Tables natively orders by (PartitionKey,
 * RowKey). RowKey is `report-email-send:<graphMessageId>` and graphMessageId
 * is not time-ordered, so server-side `sentAt`-desc ordering requires reading
 * the full prefix range and sorting in memory. Send volume is bounded by the
 * 10/day rate-limit (§C.5), so even an aged tenant holds at most a few
 * thousand rows — well within a single page scan.
 *
 * The opaque `continuationToken` is base64-encoded `{ "i": <next-offset> }`.
 * Pagination is offset-based, not snapshot-based — concurrent writes shift
 * offsets, so a client reading deep pages may see duplicate or missed rows
 * mid-paginate. Acceptable for an admin-facing send-history view where
 * writes are infrequent.
 */
export interface ListReportEmailSendsArgs {
  readonly tenantId: string;
  readonly limit: number;
  readonly continuationToken: string | null;
}

export interface ReportEmailSendListItem {
  readonly schemaVersion: 1;
  readonly graphMessageId: string;
  readonly periodKey: string;
  readonly sentAt: string;
  readonly senderMailbox: string;
  readonly recipientCount: number;
  readonly operatorPrincipal: string;
  readonly auditLineSeq: number;
}

export interface ListReportEmailSendsResult {
  readonly items: readonly ReportEmailSendListItem[];
  readonly continuationToken: string | null;
}

export const LIST_REPORT_EMAIL_SENDS_DEFAULT_LIMIT = 20;
export const LIST_REPORT_EMAIL_SENDS_MAX_LIMIT = 100;

export async function listReportEmailSends(
  table: TableClient,
  args: ListReportEmailSendsArgs,
): Promise<ListReportEmailSendsResult> {
  const limit = Math.min(
    Math.max(1, args.limit | 0),
    LIST_REPORT_EMAIL_SENDS_MAX_LIMIT,
  );
  const offset = parseOpaqueOffset(args.continuationToken);

  // Range filter: rowKey >= 'report-email-send:' AND rowKey < 'report-email-send;'.
  // ASCII codepoint after ':' is ';' — the natural upper bound for a prefix range.
  const lowerBound = REPORT_EMAIL_SEND_ROW_PREFIX;
  const upperBound = REPORT_EMAIL_SEND_ROW_PREFIX.slice(0, -1) + ";";

  // WS10 Slice 1(c)/B3 MEDIUM — use the `odata` tagged template instead of
  // hand-rolled string concatenation. `tenantId` flows from config today so
  // OData injection is not a live concern, but the tagged template locks
  // the pattern for future maintainers (e.g. when adding a `?since=` filter).
  const all: ReportEmailSendListItem[] = [];
  const iter = table.listEntities<ReportEmailSendEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${args.tenantId} and RowKey ge ${lowerBound} and RowKey lt ${upperBound}`,
    },
  });
  for await (const e of iter) {
    const graphMessageId = (e.rowKey ?? "").slice(REPORT_EMAIL_SEND_ROW_PREFIX.length);
    if (!graphMessageId) continue;
    const recipients = safeJsonStringArray(e.Recipients);
    all.push({
      schemaVersion: 1,
      graphMessageId,
      periodKey: typeof e.PeriodKey === "string" ? e.PeriodKey : "",
      sentAt: typeof e.SentAt === "string" ? e.SentAt : "",
      senderMailbox: typeof e.SenderMailbox === "string" ? e.SenderMailbox : "",
      recipientCount: recipients.length,
      operatorPrincipal: typeof e.OperatorPrincipal === "string" ? e.OperatorPrincipal : "",
      auditLineSeq: typeof e.AuditLineSeq === "number" ? e.AuditLineSeq : 0,
    });
  }
  // Newest-first by sentAt. Ties broken by graphMessageId (stable).
  all.sort((a, b) => {
    if (a.sentAt === b.sentAt) return a.graphMessageId < b.graphMessageId ? 1 : -1;
    return a.sentAt < b.sentAt ? 1 : -1;
  });

  const page = all.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const more = nextOffset < all.length;
  return {
    items: page,
    continuationToken: more ? encodeOpaqueOffset(nextOffset) : null,
  };
}

function entityToReportEmailSendRecord(
  e: ReportEmailSendEntity,
  tenantId: string,
  graphMessageId: string,
): ReportEmailSendRecord {
  return {
    schemaVersion: 1,
    graphMessageId,
    tenantId,
    periodKey: typeof e.PeriodKey === "string" ? e.PeriodKey : "",
    sentAt: typeof e.SentAt === "string" ? e.SentAt : "",
    senderMailbox: typeof e.SenderMailbox === "string" ? e.SenderMailbox : "",
    recipients: safeJsonStringArray(e.Recipients),
    operatorPrincipal: typeof e.OperatorPrincipal === "string" ? e.OperatorPrincipal : "",
    internetMessageId: typeof e.InternetMessageId === "string" ? e.InternetMessageId : "",
    clientRequestId: typeof e.ClientRequestId === "string" ? e.ClientRequestId : "",
    auditLineSeq: typeof e.AuditLineSeq === "number" ? e.AuditLineSeq : 0,
    auditLineSha256: typeof e.AuditLineSha256 === "string" ? e.AuditLineSha256 : "",
  };
}

function encodeOpaqueOffset(n: number): string {
  return Buffer.from(JSON.stringify({ i: n }), "utf-8").toString("base64");
}

function parseOpaqueOffset(token: string | null): number {
  if (!token) return 0;
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (typeof parsed === "object" && parsed !== null) {
      const i = (parsed as { i?: unknown }).i;
      if (typeof i === "number" && Number.isFinite(i) && i >= 0) return Math.floor(i);
    }
  } catch {
    // Fall through — invalid tokens reset to offset 0 rather than 400 the
    // request, mirroring how most paginated readers tolerate corruption.
  }
  return 0;
}

export async function upsertReportEmailSend(
  table: TableClient,
  record: Omit<ReportEmailSendRecord, "schemaVersion">,
): Promise<void> {
  const entity: ReportEmailSendEntity = {
    partitionKey: record.tenantId,
    rowKey: `${REPORT_EMAIL_SEND_ROW_PREFIX}${record.graphMessageId}`,
    SchemaVersion: 1,
    PeriodKey: record.periodKey,
    SentAt: record.sentAt,
    SenderMailbox: record.senderMailbox,
    Recipients: JSON.stringify(record.recipients),
    OperatorPrincipal: record.operatorPrincipal,
    InternetMessageId: record.internetMessageId,
    ClientRequestId: record.clientRequestId,
    AuditLineSeq: record.auditLineSeq,
    AuditLineSha256: record.auditLineSha256,
  };
  await table.createEntity(entity);
}

export async function upsertReportCadence(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly cadence: ReportCadenceValue;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<ReportCadenceRecord> {
  const entity: ReportCadenceEntity = {
    partitionKey: args.tenantId,
    rowKey: REPORT_CADENCE_ROW_KEY,
    Cadence: args.cadence,
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    cadence: args.cadence,
    updatedAt: args.updatedAt,
    updatedBy: args.updatedBy,
    source: "tenant",
  };
}

/**
 * ADR-0025 §9.6 masking rule — split on whitespace, keep first unicode char
 * of each token + fixed-length `***` suffix. Joined with single space.
 * Fixed-length suffix avoids leaking original name length as a side channel.
 * Returns an empty string if input has no usable tokens (caller should fall
 * back to the object ID in that case).
 */
export function maskDisplayName(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  const tokens = trimmed.split(/\s+/);
  const parts: string[] = [];
  for (const t of tokens) {
    const chars = [...t]; // code-point iterate, NOT char iterate (emoji-safe).
    if (chars.length === 0) continue;
    parts.push(`${chars[0]}***`);
  }
  return parts.join(" ");
}

function coerceInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// --- ADR-0033 Phase 2.5: kev-baseline row -----------------------------------

export const KEV_BASELINE_MODES = ["historic", "from-deploy"] as const;
export type KevBaselineMode = (typeof KEV_BASELINE_MODES)[number];
const KEV_BASELINE_MODE_SET = new Set<string>(KEV_BASELINE_MODES);
export const DEFAULT_KEV_BASELINE_MODE: KevBaselineMode = "historic";

/** YYYY-MM-DD only — operator picks a calendar day, not a timestamp. */
export const KEV_BASELINE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface KevBaselineRecord {
  readonly mode: KevBaselineMode;
  /** Empty string when mode === "historic" (no cutoff). */
  readonly baselineDate: string;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

interface KevBaselineEntity extends TableEntity {
  readonly Mode: string;
  readonly BaselineDate: string;
  readonly UpdatedAt: string;
  readonly UpdatedBy: string;
}

export async function readKevBaseline(
  table: TableClient,
  tenantId: string,
): Promise<KevBaselineRecord> {
  try {
    const e = await table.getEntity<KevBaselineEntity>(tenantId, KEV_BASELINE_ROW_KEY);
    const mode: KevBaselineMode =
      typeof e.Mode === "string" && KEV_BASELINE_MODE_SET.has(e.Mode)
        ? (e.Mode as KevBaselineMode)
        : DEFAULT_KEV_BASELINE_MODE;
    const baselineDate =
      typeof e.BaselineDate === "string" && KEV_BASELINE_DATE_PATTERN.test(e.BaselineDate)
        ? e.BaselineDate
        : "";
    return {
      mode,
      baselineDate,
      updatedAt: typeof e.UpdatedAt === "string" && e.UpdatedAt ? e.UpdatedAt : null,
      updatedBy: typeof e.UpdatedBy === "string" && e.UpdatedBy ? e.UpdatedBy : null,
      source: "tenant",
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        mode: DEFAULT_KEV_BASELINE_MODE,
        baselineDate: "",
        updatedAt: null,
        updatedBy: null,
        source: "default",
      };
    }
    throw err;
  }
}

// --- Dormancy policy row (ADR-0034 §4.2) ----------------------------

export interface DormancyPolicyRecord {
  readonly thresholdDays: number;
  readonly includeDisabledAccounts: boolean;
  readonly excludeServiceAccountSuffixes: readonly string[];
  /** §10.55 follow-up — new-user highlight window for the /identities Humans
   *  tab. Users created within this many days are flagged as "new" in the
   *  SPA. Stored alongside the dormancy threshold because both knobs govern
   *  user-lifecycle UX; physically one TenantSettings row keeps the admin
   *  surface coherent. */
  readonly newUserThresholdDays: number;
  readonly source: "tenant" | "default";
}

interface DormancyPolicyEntity extends TableEntity {
  readonly ThresholdDays?: number;
  readonly IncludeDisabledAccounts?: boolean;
  /** Comma-joined; suffix strings can't legitimately contain commas. */
  readonly ExcludeServiceAccountSuffixes?: string;
  readonly NewUserThresholdDays?: number;
}

export const DORMANCY_POLICY_DEFAULTS = Object.freeze({
  thresholdDays: 30,
  includeDisabledAccounts: false,
  excludeServiceAccountSuffixes: ["@svc."],
  newUserThresholdDays: 7,
});

export const DORMANCY_POLICY_BOUNDS = Object.freeze({
  thresholdDays: { min: 7, max: 365 } as const,
  newUserThresholdDays: { min: 1, max: 90 } as const,
  excludeServiceAccountSuffixes: { maxEntries: 20, maxCharsPerEntry: 64 } as const,
});

export async function readDormancyPolicy(
  table: TableClient,
  tenantId: string,
): Promise<DormancyPolicyRecord> {
  try {
    const e = await table.getEntity<DormancyPolicyEntity>(
      tenantId,
      DORMANCY_POLICY_ROW_KEY,
    );
    const td =
      typeof e.ThresholdDays === "number" &&
      Number.isFinite(e.ThresholdDays) &&
      e.ThresholdDays >= DORMANCY_POLICY_BOUNDS.thresholdDays.min &&
      e.ThresholdDays <= DORMANCY_POLICY_BOUNDS.thresholdDays.max
        ? e.ThresholdDays
        : DORMANCY_POLICY_DEFAULTS.thresholdDays;
    const includeDisabled = e.IncludeDisabledAccounts === true;
    const suffixesRaw =
      typeof e.ExcludeServiceAccountSuffixes === "string"
        ? e.ExcludeServiceAccountSuffixes
        : "";
    const suffixes = suffixesRaw === ""
      ? [...DORMANCY_POLICY_DEFAULTS.excludeServiceAccountSuffixes]
      : suffixesRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .slice(0, DORMANCY_POLICY_BOUNDS.excludeServiceAccountSuffixes.maxEntries);
    const newUserTd =
      typeof e.NewUserThresholdDays === "number" &&
      Number.isFinite(e.NewUserThresholdDays) &&
      e.NewUserThresholdDays >= DORMANCY_POLICY_BOUNDS.newUserThresholdDays.min &&
      e.NewUserThresholdDays <= DORMANCY_POLICY_BOUNDS.newUserThresholdDays.max
        ? e.NewUserThresholdDays
        : DORMANCY_POLICY_DEFAULTS.newUserThresholdDays;
    return {
      thresholdDays: td,
      includeDisabledAccounts: includeDisabled,
      excludeServiceAccountSuffixes: suffixes,
      newUserThresholdDays: newUserTd,
      source: "tenant",
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        thresholdDays: DORMANCY_POLICY_DEFAULTS.thresholdDays,
        includeDisabledAccounts: DORMANCY_POLICY_DEFAULTS.includeDisabledAccounts,
        excludeServiceAccountSuffixes: [
          ...DORMANCY_POLICY_DEFAULTS.excludeServiceAccountSuffixes,
        ],
        newUserThresholdDays: DORMANCY_POLICY_DEFAULTS.newUserThresholdDays,
        source: "default",
      };
    }
    throw err;
  }
}

/** §10.55 follow-up — admin write path. Currently only the
 *  newUserThresholdDays field is patchable; other fields keep using
 *  defaults until a dedicated dormancy-policy admin UI lands. The upsert
 *  reads the current row, merges the patch, and writes back so legacy
 *  fields are not clobbered. */
export interface DormancyPolicyPatch {
  readonly newUserThresholdDays?: number;
}

export async function upsertDormancyPolicy(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly patch: DormancyPolicyPatch;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<DormancyPolicyRecord> {
  const prior = await readDormancyPolicy(table, args.tenantId);
  const next: DormancyPolicyRecord = {
    thresholdDays: prior.thresholdDays,
    includeDisabledAccounts: prior.includeDisabledAccounts,
    excludeServiceAccountSuffixes: prior.excludeServiceAccountSuffixes,
    newUserThresholdDays:
      args.patch.newUserThresholdDays ?? prior.newUserThresholdDays,
    source: "tenant",
  };
  const entity: DormancyPolicyEntity & {
    UpdatedAt: string;
    UpdatedBy: string;
  } = {
    partitionKey: args.tenantId,
    rowKey: DORMANCY_POLICY_ROW_KEY,
    ThresholdDays: next.thresholdDays,
    IncludeDisabledAccounts: next.includeDisabledAccounts,
    ExcludeServiceAccountSuffixes: next.excludeServiceAccountSuffixes.join(","),
    NewUserThresholdDays: next.newUserThresholdDays,
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return next;
}

// --- Geo-fence policy row (ADR-0034 §4.1) ---------------------------

export type UnknownLocationPolicy = "alert" | "ignore";

export interface GeoFencePolicyRecord {
  readonly enabled: boolean;
  /** ISO 3166-1 alpha-2 codes, lowercased. Capped at 50 entries. */
  readonly allowedCountries: readonly string[];
  /** CIDR strings; bypass the country check when source IP matches.
   *  Capped at 100 entries. v1 stores them but does NOT yet evaluate
   *  against signIn.ipAddress (out of scope for Phase 8C ingest;
   *  reserved for a follow-up). */
  readonly allowedIpRanges: readonly string[];
  readonly unknownLocationPolicy: UnknownLocationPolicy;
  readonly source: "tenant" | "default";
}

interface GeoFencePolicyEntity extends TableEntity {
  readonly Enabled?: boolean;
  /** Comma-joined; ISO codes can't legitimately contain commas. */
  readonly AllowedCountries?: string;
  readonly AllowedIpRanges?: string;
  readonly UnknownLocationPolicy?: string;
}

export const GEO_FENCE_DEFAULTS: Readonly<{
  readonly enabled: boolean;
  readonly allowedCountries: readonly string[];
  readonly allowedIpRanges: readonly string[];
  readonly unknownLocationPolicy: UnknownLocationPolicy;
}> = Object.freeze({
  enabled: false, // operator opts in explicitly — no out-of-area alerts until configured
  allowedCountries: [],
  allowedIpRanges: [],
  unknownLocationPolicy: "alert",
});

export const GEO_FENCE_BOUNDS = Object.freeze({
  allowedCountries: { maxEntries: 50 } as const,
  allowedIpRanges: { maxEntries: 100, maxCharsPerEntry: 64 } as const,
});

const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

export async function readGeoFencePolicy(
  table: TableClient,
  tenantId: string,
): Promise<GeoFencePolicyRecord> {
  try {
    const e = await table.getEntity<GeoFencePolicyEntity>(tenantId, GEO_FENCE_ROW_KEY);
    const enabled = e.Enabled === true;
    const countriesRaw = typeof e.AllowedCountries === "string" ? e.AllowedCountries : "";
    const allowedCountries = countriesRaw === ""
      ? []
      : countriesRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => COUNTRY_CODE_RE.test(s))
          .map((s) => s.toLowerCase())
          .slice(0, GEO_FENCE_BOUNDS.allowedCountries.maxEntries);
    const ipsRaw = typeof e.AllowedIpRanges === "string" ? e.AllowedIpRanges : "";
    const allowedIpRanges = ipsRaw === ""
      ? []
      : ipsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "" && s.length <= GEO_FENCE_BOUNDS.allowedIpRanges.maxCharsPerEntry)
          .slice(0, GEO_FENCE_BOUNDS.allowedIpRanges.maxEntries);
    const unknown =
      e.UnknownLocationPolicy === "ignore" ? "ignore" : "alert";
    return {
      enabled,
      allowedCountries,
      allowedIpRanges,
      unknownLocationPolicy: unknown,
      source: "tenant",
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        enabled: GEO_FENCE_DEFAULTS.enabled,
        allowedCountries: [...GEO_FENCE_DEFAULTS.allowedCountries],
        allowedIpRanges: [...GEO_FENCE_DEFAULTS.allowedIpRanges],
        unknownLocationPolicy: GEO_FENCE_DEFAULTS.unknownLocationPolicy,
        source: "default",
      };
    }
    throw err;
  }
}

export async function upsertGeoFencePolicy(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly enabled: boolean;
    readonly allowedCountries: readonly string[];
    readonly allowedIpRanges: readonly string[];
    readonly unknownLocationPolicy: UnknownLocationPolicy;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<GeoFencePolicyRecord> {
  const entity: GeoFencePolicyEntity = {
    partitionKey: args.tenantId,
    rowKey: GEO_FENCE_ROW_KEY,
    Enabled: args.enabled,
    AllowedCountries: args.allowedCountries.map((c) => c.toLowerCase()).join(","),
    AllowedIpRanges: args.allowedIpRanges.join(","),
    UnknownLocationPolicy: args.unknownLocationPolicy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    enabled: args.enabled,
    allowedCountries: [...args.allowedCountries].map((c) => c.toLowerCase()),
    allowedIpRanges: [...args.allowedIpRanges],
    unknownLocationPolicy: args.unknownLocationPolicy,
    source: "tenant",
  };
}

export async function upsertKevBaseline(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly mode: KevBaselineMode;
    readonly baselineDate: string;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<KevBaselineRecord> {
  const entity: KevBaselineEntity = {
    partitionKey: args.tenantId,
    rowKey: KEV_BASELINE_ROW_KEY,
    Mode: args.mode,
    BaselineDate: args.baselineDate,
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    mode: args.mode,
    baselineDate: args.baselineDate,
    updatedAt: args.updatedAt,
    updatedBy: args.updatedBy,
    source: "tenant",
  };
}

// --- Branding row (ADR-0029 §Decision.1 + §Decision.2) ---------------------

export const DEFAULT_THEMES = ["light", "dark", "system"] as const;
export type DefaultTheme = (typeof DEFAULT_THEMES)[number];
const DEFAULT_THEME_SET = new Set<string>(DEFAULT_THEMES);

export const BRANDING_DEFAULTS = Object.freeze({
  productName: "Aegis",
  primaryHex: "#0078D4", // Fluent blue 10 — ADR-0029 §Decision.1
  footerText: "",
  defaultTheme: "system" as DefaultTheme,
});

export const BRANDING_BOUNDS = Object.freeze({
  productName: { maxChars: 64 } as const,
  primaryHex: { pattern: /^#[0-9a-fA-F]{6}$/ } as const,
  footerText: { maxChars: 128 } as const,
});

/** ADR-0029 §Decision.1 Phase B — logo asset allowlist. SVG deliberately
 *  excluded (§Decision.5). Upload handler's magic-byte validator cross-
 *  references this list. */
export const LOGO_CONTENT_TYPES = [
  "image/png",
  "image/webp",
  "image/jpeg",
] as const;
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

/** ADR-0029 §Decision.5 — 1 MB ceiling on uploads. */
export const LOGO_MAX_BYTES = 1_048_576;

export interface BrandingRecord {
  readonly productName: string;
  readonly primaryHex: string;
  readonly footerText: string;
  readonly defaultTheme: DefaultTheme;
  /** ADR-0029 §Decision.1 Phase B. Empty string means no logo. */
  readonly logoSha256: string;
  /** Empty string means no logo. One of LOGO_CONTENT_TYPES when present. */
  readonly logoContentType: string;
  /** 0 means no logo. Validated ≤ LOGO_MAX_BYTES on upload. */
  readonly logoSize: number;
  /** Computed same-origin URL the SPA can `<img src=>` against. `null`
   *  when no logo is set. Cache-busted via `?v=<sha>` so a logo
   *  replacement bypasses the browser cache on the old URL.
   *  (ADR-0029 §Decision.6 — served from the SWA origin, not a third-
   *  party CDN, so CSP `img-src 'self'` holds.) */
  readonly logoUrl: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

/** Build the same-origin logo URL the SPA renders. Exported for tests +
 *  symmetry with `brandingLogoBlobPath` in the upload handler. Returns
 *  `null` when any triple component is absent — callers should fall back
 *  to text-only branding. */
export function computeBrandingLogoUrl(
  tenantId: string,
  logoSha256: string,
): string | null {
  if (!tenantId || !logoSha256) return null;
  // URI-encode each segment defensively; tenantId is normally a GUID but
  // the path is operator-controllable via the route template in a future
  // multi-tenant fork.
  return `/api/branding/${encodeURIComponent(tenantId)}/logo?v=${encodeURIComponent(logoSha256)}`;
}

interface BrandingEntity extends TableEntity {
  readonly ProductName: string;
  readonly PrimaryHex: string;
  readonly FooterText: string;
  readonly DefaultTheme: string;
  /** Phase B. Optional on the entity for backwards-compat with
   *  Phase-A-written rows that predate the column addition. */
  readonly LogoSha256?: string;
  readonly LogoContentType?: string;
  readonly LogoSize?: number;
  readonly UpdatedAt: string;
  readonly UpdatedBy: string;
}

const LOGO_CONTENT_TYPE_SET = new Set<string>(LOGO_CONTENT_TYPES);

export async function readBranding(
  table: TableClient,
  tenantId: string,
): Promise<BrandingRecord> {
  try {
    const e = await table.getEntity<BrandingEntity>(tenantId, BRANDING_ROW_KEY);
    const productName =
      typeof e.ProductName === "string" && e.ProductName
        ? e.ProductName
        : BRANDING_DEFAULTS.productName;
    const primaryHex =
      typeof e.PrimaryHex === "string" &&
      BRANDING_BOUNDS.primaryHex.pattern.test(e.PrimaryHex)
        ? e.PrimaryHex
        : BRANDING_DEFAULTS.primaryHex;
    const footerText =
      typeof e.FooterText === "string" ? e.FooterText : BRANDING_DEFAULTS.footerText;
    const defaultTheme =
      typeof e.DefaultTheme === "string" && DEFAULT_THEME_SET.has(e.DefaultTheme)
        ? (e.DefaultTheme as DefaultTheme)
        : BRANDING_DEFAULTS.defaultTheme;
    // Phase B logo columns — defence-in-depth: only surface a logo triple
    // when all three pieces are consistent (non-empty sha + allowed MIME +
    // positive size ≤ cap). A partially-written row (from a mid-flight
    // write failure) falls back to no-logo rather than a dangling pointer
    // the serve handler would later 404 on.
    const rawSha = typeof e.LogoSha256 === "string" ? e.LogoSha256 : "";
    const rawType = typeof e.LogoContentType === "string" ? e.LogoContentType : "";
    const rawSize =
      typeof e.LogoSize === "number" && Number.isInteger(e.LogoSize) ? e.LogoSize : 0;
    const logoIntact =
      /^[a-f0-9]{64}$/.test(rawSha) &&
      LOGO_CONTENT_TYPE_SET.has(rawType) &&
      rawSize > 0 &&
      rawSize <= LOGO_MAX_BYTES;
    const logoSha256 = logoIntact ? rawSha : "";
    return {
      productName,
      primaryHex,
      footerText,
      defaultTheme,
      logoSha256,
      logoContentType: logoIntact ? rawType : "",
      logoSize: logoIntact ? rawSize : 0,
      logoUrl: computeBrandingLogoUrl(tenantId, logoSha256),
      updatedAt:
        typeof e.UpdatedAt === "string" && e.UpdatedAt ? e.UpdatedAt : null,
      updatedBy:
        typeof e.UpdatedBy === "string" && e.UpdatedBy ? e.UpdatedBy : null,
      source: "tenant",
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return {
        ...BRANDING_DEFAULTS,
        logoSha256: "",
        logoContentType: "",
        logoSize: 0,
        logoUrl: null,
        updatedAt: null,
        updatedBy: null,
        source: "default",
      };
    }
    throw err;
  }
}

export interface BrandingPatch {
  readonly productName?: string;
  readonly primaryHex?: string;
  readonly footerText?: string;
  readonly defaultTheme?: DefaultTheme;
}

export async function upsertBranding(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly patch: BrandingPatch;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<BrandingRecord> {
  // Merge patch with current row (or defaults when absent) so omitted fields
  // retain their prior values — same semantics as the other three RowKeys.
  // Logo columns pass through unchanged: text-path PATCH must NEVER clobber
  // the logo pointer; clear / overwrite goes via DELETE / POST logo handler.
  const current = await readBranding(table, args.tenantId);
  const merged = {
    productName: args.patch.productName ?? current.productName,
    primaryHex: args.patch.primaryHex ?? current.primaryHex,
    footerText: args.patch.footerText ?? current.footerText,
    defaultTheme: args.patch.defaultTheme ?? current.defaultTheme,
  };
  const entity: BrandingEntity = {
    partitionKey: args.tenantId,
    rowKey: BRANDING_ROW_KEY,
    ProductName: merged.productName,
    PrimaryHex: merged.primaryHex,
    FooterText: merged.footerText,
    DefaultTheme: merged.defaultTheme,
    LogoSha256: current.logoSha256,
    LogoContentType: current.logoContentType,
    LogoSize: current.logoSize,
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    ...merged,
    logoSha256: current.logoSha256,
    logoContentType: current.logoContentType,
    logoSize: current.logoSize,
    logoUrl: computeBrandingLogoUrl(args.tenantId, current.logoSha256),
    updatedAt: args.updatedAt,
    updatedBy: args.updatedBy,
    source: "tenant",
  };
}

/**
 * Phase B — write the logo-pointer triple, preserving all text columns.
 * Counterpart to `upsertBranding`: symmetrical preservation discipline
 * across the two write paths means neither clobbers the other.
 */
export async function upsertBrandingLogo(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly logoSha256: string;
    readonly logoContentType: LogoContentType;
    readonly logoSize: number;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<BrandingRecord> {
  const current = await readBranding(table, args.tenantId);
  const entity: BrandingEntity = {
    partitionKey: args.tenantId,
    rowKey: BRANDING_ROW_KEY,
    ProductName: current.productName,
    PrimaryHex: current.primaryHex,
    FooterText: current.footerText,
    DefaultTheme: current.defaultTheme,
    LogoSha256: args.logoSha256,
    LogoContentType: args.logoContentType,
    LogoSize: args.logoSize,
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    ...current,
    logoSha256: args.logoSha256,
    logoContentType: args.logoContentType,
    logoSize: args.logoSize,
    logoUrl: computeBrandingLogoUrl(args.tenantId, args.logoSha256),
    updatedAt: args.updatedAt,
    updatedBy: args.updatedBy,
    source: "tenant",
  };
}

/**
 * Phase B — clear the logo triple (set all three columns to empty / 0),
 * preserving text columns. Idempotent: safe to call when no logo exists.
 */
export async function clearBrandingLogo(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly updatedBy: string;
    readonly updatedAt: string;
  },
): Promise<BrandingRecord> {
  const current = await readBranding(table, args.tenantId);
  const entity: BrandingEntity = {
    partitionKey: args.tenantId,
    rowKey: BRANDING_ROW_KEY,
    ProductName: current.productName,
    PrimaryHex: current.primaryHex,
    FooterText: current.footerText,
    DefaultTheme: current.defaultTheme,
    LogoSha256: "",
    LogoContentType: "",
    LogoSize: 0,
    UpdatedAt: args.updatedAt,
    UpdatedBy: args.updatedBy,
  };
  await table.upsertEntity(entity, "Replace");
  return {
    ...current,
    logoSha256: "",
    logoContentType: "",
    logoSize: 0,
    logoUrl: null,
    updatedAt: args.updatedAt,
    updatedBy: args.updatedBy,
    source: "tenant",
  };
}
