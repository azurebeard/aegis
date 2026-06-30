// Shared read-shape builder for GET /api/settings and the tail of PATCH
// /api/ingest/settings — both return the same full body so the SPA can
// `setQueryData` the cache in one pass (ADR-0025 §3.1 + §9.4).

import type { TableClient } from "@azure/data-tables";
import { emitAievent } from "./aievent.js";
import {
  AGENT_BUDGET_TABLE_NAME,
  readBudgetSummary,
  type BudgetSummary,
} from "./agentBudget.js";
import { nextFireOf, type CronNextFireResult } from "./cronNextFire.js";
import { getIngestHealthTableForSource, readHealthRow } from "./ingestHealth.js";
import { isoWeekOf } from "./posturePromptBuilder.js";
import { getTableClient, type TableContext } from "./tables.js";
import {
  capabilityFromStatus,
  computeEffectiveVisibility,
  readAgentBudget,
  readBranding,
  readGeoFencePolicy,
  readKevBaseline,
  readReportCadence,
  readReportEmailConfig,
  readTenantSettings,
  readUserIdentifierStrategy,
  TILE_INGEST_SOURCE,
  TILE_KEYS,
  type AgentBudgetRecord,
  type BrandingRecord,
  type GeoFencePolicyRecord,
  type KevBaselineRecord,
  type ReportCadenceRecord,
  type ReportEmailConfigRecord,
  type TenantSettings,
  type TileCapabilities,
  type TileVisibility,
  type UserIdentifierStrategyRecord,
} from "./tenantSettingsStore.js";

/**
 * Per-agent Timer schedule projection — Bicep is the authoritative
 * source for the cron strings; this surface lets the SPA render
 * "next fire in Nh / Nd" badges without hard-coding the cron client-
 * side. `incidents` is on-demand only (no Timer) so that field is
 * always `null`. (B4 — Timer ETA badges.)
 */
export interface AgentSchedules {
  readonly brief: CronNextFireResult | null;
  readonly posture: CronNextFireResult | null;
  readonly incidents: null;
}

/**
 * ADR-0030 Phase B — Timer schedule for the report-snapshot auto-capture.
 * Surfaced so the /reports page can render "next auto-capture in Nh" without
 * hard-coding the cron client-side.
 */
export interface ReportSchedules {
  readonly autoCapture: CronNextFireResult | null;
}

/** Per-agent CURRENT-bucket actuals so the admin page can render a
 *  reality-check next to the slider before the operator raises the
 *  ceiling (B4 — today's-spend visualisation). `bucketKey` is the
 *  partition the row uses — daily for brief / incidents, weekly
 *  ISO-week for posture. */
export interface AgentSpendBucket {
  readonly bucketKey: string;
  readonly bucketCadence: "daily" | "weekly";
  readonly tokensActualTotal: number;
  readonly runsSucceeded: number;
  readonly runsFailed: number;
  readonly manualRunsToday: number;
  readonly empty: boolean;
}

export interface AgentSpendCurrent {
  readonly brief: AgentSpendBucket;
  readonly posture: AgentSpendBucket;
  readonly incidents: AgentSpendBucket;
}

export interface FullSettingsResponse extends TenantSettings {
  readonly tileCapabilities: TileCapabilities;
  readonly effectiveVisibility: TileVisibility;
  readonly agentBudget: AgentBudgetRecord;
  readonly userIdentifierStrategy: UserIdentifierStrategyRecord;
  readonly branding: BrandingRecord;
  readonly reportCadence: ReportCadenceRecord;
  readonly reportEmailConfig: ReportEmailConfigRecord;
  /** ADR-0030 Phase C Slice 1(d)/C — operator-configured sender UPN from
   *  the Function App's AZURE_MAIL_SENDER_UPN env var. Surfaced so the
   *  SPA's consent dialog can render the From: address + derive sender
   *  domain for external-recipient detection (WS10 Slice 1(d)/C MED #1).
   *  Empty string when not configured. */
  readonly reportEmailSenderUpn: string;
  readonly kevBaseline: KevBaselineRecord;
  readonly geoFence: GeoFencePolicyRecord;
  readonly agentSchedules: AgentSchedules;
  readonly reportSchedules: ReportSchedules;
  readonly agentSpendCurrent: AgentSpendCurrent;
  /** HANDOVER §6.3 `deployAiAgents` — SPA gates tile + admin-section
   *  rendering on this flag. When false, the agent-plane handlers are
   *  not registered (so calls to /api/brief/* or /api/posture/* return
   *  404), AgentBudget reads still execute (for API stability — table
   *  persists across toggle per the design note) but the SPA hides the
   *  admin-page sections that would drive them. */
  readonly aiPlaneEnabled: boolean;
}

export async function buildFullSettingsResponse(args: {
  readonly tenantId: string;
  readonly settingsTable: TableClient;
  /** ADR-0036 v1.3 — IngestHealth + ArmIngestHealth resolved per-source
   *  via `getIngestHealthTableForSource(args.opsTableCtx, source)`. The
   *  previous `ingestHealthTable: TableClient` field is dropped — there
   *  is no single table that covers every freshness row anymore. */
  readonly budgetDefaults: {
    readonly briefManualRunCeiling: number;
    readonly briefDailyTokenBudget: number;
    readonly postureManualRunCeiling: number;
    readonly postureWeeklyTokenBudget: number;
    readonly incidentsAnalysisManualRunCeiling: number;
    readonly incidentsAnalysisDailyTokenBudget: number;
  };
  /** Per-agent Bicep-pinned cron schedules — Timer ETA badges (B4) +
   *  ADR-0030 Phase B report auto-capture. */
  readonly schedules: {
    readonly briefTimerCron: string;
    readonly postureTimerCron: string;
    readonly reportSnapshotAutoCaptureCron: string;
  };
  /** Ops-store table context for the AgentBudget read (B4 — today's
   *  spend viz). The CALLER passes its own ctx so the existing identity
   *  selection (api-reader vs ingest MI) is preserved per route. */
  readonly opsTableCtx: TableContext;
  /** HANDOVER §6.3 `deployAiAgents` — echoed into the response so the
   *  SPA can gate tile + admin-section rendering. Callers pass
   *  `config.deployAiAgents` (from `resolveApiConfig()` /
   *  `resolveIngestConfig()`). */
  readonly aiPlaneEnabled: boolean;
  readonly now?: Date;
}): Promise<FullSettingsResponse> {
  const [
    settings,
    agentBudget,
    userIdentifierStrategy,
    branding,
    reportCadence,
    reportEmailConfig,
    kevBaseline,
    geoFence,
    ...healthRows
  ] = await Promise.all([
    readTenantSettings(args.settingsTable, args.tenantId),
    readAgentBudget(args.settingsTable, args.tenantId, args.budgetDefaults),
    readUserIdentifierStrategy(args.settingsTable, args.tenantId),
    readBranding(args.settingsTable, args.tenantId),
    readReportCadence(args.settingsTable, args.tenantId),
    readReportEmailConfig(args.settingsTable, args.tenantId),
    readKevBaseline(args.settingsTable, args.tenantId),
    readGeoFencePolicy(args.settingsTable, args.tenantId),
    // ADR-0036 v1.3 — pick IngestHealth or ArmIngestHealth per source
    // (azure.* lives in ArmIngestHealth after the split). Each per-tile
    // read resolves independently so a Graph-source freshness read can't
    // miss the new arm-plane row.
    ...TILE_KEYS.map((k) =>
      readHealthRow(
        getIngestHealthTableForSource(args.opsTableCtx, TILE_INGEST_SOURCE[k]),
        args.tenantId,
        TILE_INGEST_SOURCE[k],
      ),
    ),
  ]);

  const tileCapabilities = {} as TileCapabilities;
  for (let i = 0; i < TILE_KEYS.length; i++) {
    const k = TILE_KEYS[i] as (typeof TILE_KEYS)[number];
    tileCapabilities[k] = capabilityFromStatus(healthRows[i]?.status ?? null);
  }
  const effectiveVisibility = computeEffectiveVisibility(
    settings.tileVisibility,
    tileCapabilities,
  );

  const now = args.now ?? new Date();
  const agentSchedules: AgentSchedules = {
    brief: nextFireOf(args.schedules.briefTimerCron, now),
    posture: nextFireOf(args.schedules.postureTimerCron, now),
    incidents: null, // ADR-0028 §Decision.3 — on-demand only.
  };
  const reportSchedules: ReportSchedules = {
    autoCapture: nextFireOf(args.schedules.reportSnapshotAutoCaptureCron, now),
  };

  // B4 — today's-spend visualisation. Each agent's budget row has a
  // distinct partition key per its cadence: brief + incidents are
  // daily (`yyyy-mm-dd`); posture is weekly per the SEC-L-B2-01
  // resolution (`yyyy-Www`). 404s are silently swallowed inside
  // `readBudgetSummary` to a zero-initialised result.
  const yyyymmdd = isoDateUtc(now);
  const isoWeek = isoWeekOf(now);
  const budgetTable = getTableClient(args.opsTableCtx, AGENT_BUDGET_TABLE_NAME);
  const [briefSpend, postureSpend, incidentsSpend] = await Promise.all([
    safeReadBudget(budgetTable, args.tenantId, "brief", yyyymmdd),
    safeReadBudget(budgetTable, args.tenantId, "posture", isoWeek),
    safeReadBudget(budgetTable, args.tenantId, "incidents", yyyymmdd),
  ]);
  const agentSpendCurrent: AgentSpendCurrent = {
    brief: toSpendBucket(briefSpend, "daily"),
    posture: toSpendBucket(postureSpend, "weekly"),
    incidents: toSpendBucket(incidentsSpend, "daily"),
  };

  return {
    ...settings,
    tileCapabilities,
    effectiveVisibility,
    agentBudget,
    userIdentifierStrategy,
    branding,
    reportCadence,
    reportEmailConfig,
    reportEmailSenderUpn: process.env.AZURE_MAIL_SENDER_UPN ?? "",
    kevBaseline,
    geoFence,
    agentSchedules,
    reportSchedules,
    agentSpendCurrent,
    aiPlaneEnabled: args.aiPlaneEnabled,
  };
}

/**
 * Tolerant wrapper — a transient AgentBudget read failure should not
 * fail the whole settings response. Operators see a zero-spend row +
 * a warning chip in the UI; underlying actuals remain enforced inside
 * `runAgent`'s reservation loop, so this is purely a viz fallback.
 *
 * SEC-L-B4-01 resolution: the swallow used to be silent. A repeated
 * AgentBudget read failure is operationally relevant — it means the
 * spend viz on the admin page will under-report actuals indefinitely.
 * Emit `AIEVENT AgentBudgetReadFallback` so an operator can alert via
 * Log Analytics on the customEvent name and detect a sustained
 * RBAC drift / table-availability issue. Single AIEVENT per failed
 * read; no payload escalation if the swallow path becomes hot.
 */
async function safeReadBudget(
  table: TableClient,
  tenantId: string,
  agentName: string,
  bucketKey: string,
): Promise<BudgetSummary> {
  try {
    return await readBudgetSummary(table, tenantId, agentName, bucketKey);
  } catch (err) {
    const rawMessage = String((err as Error).message ?? err);
    // Strip control chars before logging — cheap defence-in-depth on
    // log-injection (matches the SEC-L-ADMIN-SETTINGS-01 hygiene
    // pattern from `patchSettings.deriveUpdatedBy`).
    const scrubbedMessage = rawMessage
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .slice(0, 512);
    // Console-side fallback notice — settingsResponse runs inside an
    // HTTP handler that owns the InvocationContext, but this helper
    // doesn't take context to keep it pure-ish; the AIEVENT below is
    // the operator-visible signal. console.warn lands in App Insights
    // traces under the function-host correlation.
    // `safeReadBudget` is a pure-shaped helper that does NOT take an
    // InvocationContext (deliberate — keeps it simple-to-call from any
    // settings-response code path). Console logging is the chosen
    // operator-visible fallback because the Functions Node host
    // forwards both `console.warn` and `console.log` straight into
    // App Insights traces under the function-host correlation. Linter
    // suppressions are scoped to this single call site.
    // eslint-disable-next-line no-console
    console.warn(
      `[settingsResponse] AgentBudget read failed; viz will under-report — ` +
        `tenant=${tenantId} agent=${agentName} bucket=${bucketKey} message=${scrubbedMessage}`,
    );
    // emitAievent normally takes an InvocationContext, but the helper
    // also accepts any `{ log: (msg) => void }` shape so we route
    // through the same AIEVENT pipeline (FunctionAppLogs grep line +
    // App Insights customEvents). Bind `console.log` so the SDK init
    // can lazy-load against APPLICATIONINSIGHTS_CONNECTION_STRING.
    emitAievent(
      // eslint-disable-next-line no-console
      { log: (msg: string) => console.log(msg) },
      "AgentBudgetReadFallback",
      {
        tenantId,
        agentName,
        bucketKey,
        errorType: (err as Error)?.constructor?.name ?? "Error",
        errorMessage: scrubbedMessage,
      },
    );
    return {
      agentName,
      yyyymmdd: bucketKey,
      tokensActualTotal: 0,
      runsSucceeded: 0,
      runsFailed: 0,
      manualRunsToday: 0,
      empty: true,
    };
  }
}

function toSpendBucket(
  s: BudgetSummary,
  cadence: "daily" | "weekly",
): AgentSpendBucket {
  return {
    bucketKey: s.yyyymmdd,
    bucketCadence: cadence,
    tokensActualTotal: s.tokensActualTotal,
    runsSucceeded: s.runsSucceeded,
    runsFailed: s.runsFailed,
    manualRunsToday: s.manualRunsToday,
    empty: s.empty,
  };
}

function isoDateUtc(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}
