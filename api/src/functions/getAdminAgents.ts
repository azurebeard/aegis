// GET /api/admin/agents — admin-only "what's the AI plane doing right now"
// observability page.
//
// Aggregates per-agent state for the three AI specialists into one envelope
// so the SPA renders a single page-load. Sources:
//
//   * AgentHealth table   — circuit-breaker state per agent (closed /
//                            half_open / open + consecutiveFailures +
//                            nextProbeAt + lastFailure*).
//   * BriefCache /
//     PostureCache /
//     IncidentAnalysisCache — most-recent successful run per agent.
//   * AgentBudget table   — current spend bucket per agent (today for
//                            brief + incidents, this-ISO-week for posture).
//   * Settings cron strings → next-fire ETA via the existing
//     `cronNextFire.nextFireOf` helper.
//
// Read-only — uses `readHealthOptional` and `readBudgetSummary` (neither
// auto-creates rows) so the api-reader MI's narrow Storage Table Data
// Reader scope is sufficient. No writes, no Graph calls, no Foundry.
//
// §10.66 Phase E — auth is native MSAL Bearer validated by
// authMiddleware.authenticate(). The Function is `authLevel:"anonymous"`
// per the repo-wide pattern; the handler enforces admin role in-process via
// `principal.userRoles.includes("admin")`.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { type TableClient } from "@azure/data-tables";
import {
  AGENT_HEALTH_TABLE_NAME,
  readHealthOptional,
  type AgentHealthRow,
} from "../lib/agentHealth.js";
import {
  AGENT_BUDGET_TABLE_NAME,
  readBudgetSummary,
  type BudgetSummary,
} from "../lib/agentBudget.js";
import {
  BRIEF_CACHE_TABLE_NAME,
  listCacheRows as listBriefRows,
  type BriefCacheRow,
} from "../lib/briefCache.js";
import {
  POSTURE_CACHE_TABLE_NAME,
  listCacheRows as listPostureRows,
  type PostureCacheRow,
} from "../lib/postureCache.js";
import {
  findLatestAnalysisRow,
  INCIDENT_ANALYSIS_CACHE_TABLE_NAME,
  type IncidentAnalysisCacheRow,
} from "../lib/incidentAnalysisCache.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { nextFireOf } from "../lib/cronNextFire.js";
import { isoWeekOf } from "../lib/posturePromptBuilder.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import {
  readAgentBudget,
  type AgentBudgetRecord,
} from "../lib/tenantSettingsStore.js";

interface AgentObservability {
  readonly agentName: "brief" | "posture" | "incidents-analysis";
  readonly cadence: "daily" | "weekly" | "on-demand";
  readonly health: AgentHealthView;
  readonly latestRun: AgentLatestRunView | null;
  readonly budget: AgentBudgetView;
  readonly schedule: AgentScheduleView;
}

interface AgentHealthView {
  readonly state: "closed" | "open" | "half_open";
  readonly consecutiveFailures: number;
  readonly nextProbeAt: string | null;
  readonly lastFailureKind: string | null;
  readonly lastFailureAt: string | null;
  readonly updatedAt: string | null;
}

interface AgentLatestRunView {
  readonly runId: string;
  readonly generatedAt: string;
  readonly modelDeployment: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly outputSha256: string;
  /** "briefDate" / "isoWeek" / "incidentId" — the agent-specific key. */
  readonly keyKind: "briefDate" | "isoWeek" | "incidentId";
  readonly key: string;
}

interface AgentBudgetView {
  readonly bucketKey: string;
  readonly bucketCadence: "daily" | "weekly";
  readonly tokensActualTotal: number;
  readonly runsSucceeded: number;
  readonly runsFailed: number;
  readonly manualRunsToday: number;
  readonly empty: boolean;
  readonly ceilings: { readonly manualRun: number; readonly tokens: number };
}

interface AgentScheduleView {
  readonly cron: string | null;
  readonly nextFireAt: string | null;
  readonly cadence: "daily" | "weekly" | "on-demand";
}

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E — Bearer-only `readClientPrincipal`. Two-tier gate:
  // 401 if unauthenticated (no Bearer or invalid JWT), 403 if authenticated
  // but lacking the admin role (ASVS V2.5.1 — distinguish unauth from forbid).
  const principal = await readClientPrincipal(request, context);
  if (!principal) {
    return {
      status: 401,
      jsonBody: {
        error: {
          code: "unauthenticated",
          message: "authentication required",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
  const roles = principal.userRoles ?? [];
  if (!roles.includes("admin")) {
    return {
      status: 403,
      jsonBody: {
        error: {
          code: "forbidden",
          message: "agent observability requires the admin role",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const config = resolveBriefAgentConfig();
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const healthTable = getTableClient(opsCtx, AGENT_HEALTH_TABLE_NAME);
  const budgetTable = getTableClient(opsCtx, AGENT_BUDGET_TABLE_NAME);
  const briefTable = getTableClient(opsCtx, BRIEF_CACHE_TABLE_NAME);
  const postureTable = getTableClient(opsCtx, POSTURE_CACHE_TABLE_NAME);
  const analysisTable = getTableClient(
    opsCtx,
    INCIDENT_ANALYSIS_CACHE_TABLE_NAME,
  );
  const settingsTable = getTableClient(opsCtx, OPS_TABLES.TenantSettings);

  try {
    const now = new Date();
    const todayYmd = isoDate(now);
    const thisWeek = isoWeekOf(now);

    // Concurrent reads — table client manages its own connection pool;
    // these queries are independent partitions/rows.
    const [
      briefHealth,
      postureHealth,
      incidentsHealth,
      latestBriefList,
      latestPostureList,
      latestAnalysis,
      briefBudget,
      postureBudget,
      incidentsBudget,
      currentBudgetCeilings,
    ] = await Promise.all([
      readHealthOptional(healthTable, config.tenantId, "brief"),
      readHealthOptional(healthTable, config.tenantId, "posture"),
      readHealthOptional(healthTable, config.tenantId, "incidents-analysis"),
      listBriefRows(briefTable, config.tenantId, 1),
      listPostureRows(postureTable, config.tenantId, 1),
      findLatestAnalysisRow(analysisTable, config.tenantId),
      readBudgetSummary(budgetTable, config.tenantId, "brief", todayYmd),
      readBudgetSummary(budgetTable, config.tenantId, "posture", thisWeek),
      readBudgetSummary(budgetTable, config.tenantId, "incidents-analysis", todayYmd),
      readCeilings(settingsTable, config),
    ]);

    const briefSchedule = scheduleFromCron(config.briefTimerCron);
    const postureSchedule = scheduleFromCron(config.postureTimerCron);
    const incidentsSchedule: AgentScheduleView = {
      cron: null,
      nextFireAt: null,
      cadence: "on-demand",
    };

    const agents: readonly AgentObservability[] = [
      {
        agentName: "brief",
        cadence: "daily",
        health: healthView(briefHealth),
        latestRun: briefLatest(latestBriefList),
        budget: budgetView(
          briefBudget,
          "daily",
          currentBudgetCeilings.briefManualRunCeiling,
          currentBudgetCeilings.briefDailyTokenBudget,
        ),
        schedule: briefSchedule,
      },
      {
        agentName: "posture",
        cadence: "weekly",
        health: healthView(postureHealth),
        latestRun: postureLatest(latestPostureList),
        budget: budgetView(
          postureBudget,
          "weekly",
          currentBudgetCeilings.postureManualRunCeiling,
          currentBudgetCeilings.postureWeeklyTokenBudget,
        ),
        schedule: postureSchedule,
      },
      {
        agentName: "incidents-analysis",
        cadence: "on-demand",
        health: healthView(incidentsHealth),
        latestRun: incidentsLatest(latestAnalysis),
        budget: budgetView(
          incidentsBudget,
          "daily",
          currentBudgetCeilings.incidentsAnalysisManualRunCeiling,
          currentBudgetCeilings.incidentsAnalysisDailyTokenBudget,
        ),
        schedule: incidentsSchedule,
      },
    ];

    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        agents,
      },
      headers: {
        "cache-control": "private, max-age=30",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`admin.agents.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "agent observability data is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

async function readCeilings(
  settingsTable: TableClient,
  config: ReturnType<typeof resolveBriefAgentConfig>,
): Promise<AgentBudgetRecord> {
  // The TenantSettings store API uses unprefixed field names (briefManualRunCeiling)
  // while the env-derived config uses cadence-prefixed names (briefDailyManualRunCeiling).
  // Bridge them here so a fresh tenant with no row inherits the env defaults.
  return readAgentBudget(settingsTable, config.tenantId, {
    briefManualRunCeiling: config.briefDailyManualRunCeiling,
    briefDailyTokenBudget: config.briefDailyTokenBudget,
    postureManualRunCeiling: config.postureWeeklyManualRunCeiling,
    postureWeeklyTokenBudget: config.postureWeeklyTokenBudget,
    incidentsAnalysisManualRunCeiling: config.incidentsAnalysisDailyManualRunCeiling,
    incidentsAnalysisDailyTokenBudget: config.incidentsAnalysisDailyTokenBudget,
  });
}

function healthView(row: AgentHealthRow | null): AgentHealthView {
  if (!row) {
    return {
      state: "closed",
      consecutiveFailures: 0,
      nextProbeAt: null,
      lastFailureKind: null,
      lastFailureAt: null,
      updatedAt: null,
    };
  }
  return {
    state: row.state,
    consecutiveFailures: row.consecutiveFailures,
    nextProbeAt: row.nextProbeAt,
    lastFailureKind: row.lastFailureKind,
    lastFailureAt: row.lastFailureAt,
    updatedAt: row.updatedAt,
  };
}

function briefLatest(rows: readonly BriefCacheRow[]): AgentLatestRunView | null {
  const r = rows[0];
  if (!r) return null;
  return {
    runId: r.runId,
    generatedAt: r.generatedAt,
    modelDeployment: r.modelDeployment,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    outputSha256: r.outputSha256,
    keyKind: "briefDate",
    key: r.briefDate,
  };
}

function postureLatest(
  rows: readonly PostureCacheRow[],
): AgentLatestRunView | null {
  const r = rows[0];
  if (!r) return null;
  return {
    runId: r.runId,
    generatedAt: r.generatedAt,
    modelDeployment: r.modelDeployment,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    outputSha256: r.outputSha256,
    keyKind: "isoWeek",
    key: r.isoWeek,
  };
}

function incidentsLatest(
  row: IncidentAnalysisCacheRow | null,
): AgentLatestRunView | null {
  if (!row) return null;
  return {
    runId: row.runId,
    generatedAt: row.generatedAt,
    modelDeployment: row.modelDeployment,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    outputSha256: row.outputSha256,
    keyKind: "incidentId",
    key: row.incidentId,
  };
}

function budgetView(
  s: BudgetSummary,
  cadence: "daily" | "weekly",
  manualCeiling: number,
  tokenCeiling: number,
): AgentBudgetView {
  return {
    bucketKey: s.yyyymmdd,
    bucketCadence: cadence,
    tokensActualTotal: s.tokensActualTotal,
    runsSucceeded: s.runsSucceeded,
    runsFailed: s.runsFailed,
    manualRunsToday: s.manualRunsToday,
    empty: s.empty,
    ceilings: { manualRun: manualCeiling, tokens: tokenCeiling },
  };
}

function scheduleFromCron(cron: string | null | undefined): AgentScheduleView {
  if (!cron) return { cron: null, nextFireAt: null, cadence: "on-demand" };
  const result = nextFireOf(cron);
  if (!result) return { cron, nextFireAt: null, cadence: "on-demand" };
  return {
    cron: result.cron,
    nextFireAt: result.nextFireAt,
    cadence: result.cadence,
  };
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Route: /api/agents/observability (NOT /api/admin/agents). The SWA route
// rule for /api/admin/* prevents forwarding to the linked Function App
// backend in this deployment — the symptom is a refresh-time 404 even for
// users that hold the admin role. Moving the function under /api/* lets
// the request reach the backend; the admin role gate is enforced inside
// the handler via the authMiddleware-validated Bearer JWT (§10.66 Phase E).
app.http("getAdminAgents", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "agents/observability",
  handler,
});
