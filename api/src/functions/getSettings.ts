// GET /api/settings — return the current tenant settings (ADR-0025 Phases 1–3).
//
// Serves any authenticated / reader user so the SPA can hide disabled tiles
// at render time. Role gate applied at the SWA rule layer; Easy Auth gates
// the Function App to the SWA MI. `authLevel: "anonymous"` per repo
// convention, with a defence-in-depth `readClientPrincipal` check inside.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import {
  resolveApiConfig,
  resolveBriefAgentConfig,
  resolveReportSnapshotConfig,
} from "../lib/config.js";
import { buildFullSettingsResponse } from "../lib/settingsResponse.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
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

  const apiConfig = resolveApiConfig();
  const briefConfig = resolveBriefAgentConfig();
  const reportConfig = resolveReportSnapshotConfig();
  try {
    const tableCtx = {
      endpoint: apiConfig.opsTableEndpoint,
      managedIdentityClientId: apiConfig.apiReaderMiClientId,
    };
    const body = await buildFullSettingsResponse({
      tenantId: apiConfig.tenantId,
      settingsTable: getTableClient(tableCtx, OPS_TABLES.TenantSettings),
      budgetDefaults: {
        briefManualRunCeiling: briefConfig.briefDailyManualRunCeiling,
        briefDailyTokenBudget: briefConfig.briefDailyTokenBudget,
        postureManualRunCeiling: briefConfig.postureWeeklyManualRunCeiling,
        postureWeeklyTokenBudget: briefConfig.postureWeeklyTokenBudget,
        incidentsAnalysisManualRunCeiling:
          briefConfig.incidentsAnalysisDailyManualRunCeiling,
        incidentsAnalysisDailyTokenBudget:
          briefConfig.incidentsAnalysisDailyTokenBudget,
      },
      schedules: {
        briefTimerCron: briefConfig.briefTimerCron,
        postureTimerCron: briefConfig.postureTimerCron,
        reportSnapshotAutoCaptureCron: reportConfig.autoCaptureCron,
      },
      opsTableCtx: tableCtx,
      aiPlaneEnabled: apiConfig.deployAiAgents,
    });
    return {
      status: 200,
      jsonBody: body,
      headers: {
        // Settings change rarely; 30s shields the table from per-render hits
        // without making an admin's toggle noticeably sticky.
        "cache-control": "private, max-age=30",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`settings.get.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "settings store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("getSettings", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "settings",
  handler,
});
