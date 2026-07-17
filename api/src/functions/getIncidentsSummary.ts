// GET /api/incidents/summary (ADR-0016 §1.1).
//
// Tile payload: severity/status/classification counts + most-recent incident
// + IngestHealth passthrough. Server-computed at request time; no caching
// beyond the 30 s Cache-Control budget.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveIncidentsApiConfig } from "../lib/config.js";
import { INCIDENTS_TABLE_NAME, readIncidentsCounts } from "../lib/incidentsStore.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import { incidentsSummaryRateLimiter } from "../lib/rateLimit.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import type { IncidentsSummaryResponse } from "../lib/types.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  // §10.66 Phase E — auth is MSAL Bearer validated in authMiddleware. A
  // null here implies the caller didn't present a valid Bearer — 401 is
  // safer than sharing a rate-limit bucket across unauthenticated callers
  if (!principal) {
    return unauthenticated(context);
  }
  const rate = incidentsSummaryRateLimiter.check(principal.userId);
  if (!rate.allowed) {
    return rateLimited(context, rate.retryAfterMs);
  }

  const config = resolveIncidentsApiConfig();
  const ctx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const incidentsTable = getTableClient(ctx, INCIDENTS_TABLE_NAME);
  const healthTable = getTableClient(ctx, OPS_TABLES.IngestHealth);

  try {
    const [counts, health] = await Promise.all([
      readIncidentsCounts(incidentsTable, config.tenantId),
      readHealthRow(healthTable, config.tenantId, config.incidentsSource),
    ]);

    const wireStatus: IncidentsSummaryResponse["health"]["status"] = !health
      ? "awaiting_first_run"
      : counts.total === 0
        ? health.status === "healthy"
          ? "no_data"
          : health.status
        : health.status;

    const body: IncidentsSummaryResponse = {
      schemaVersion: 1,
      counts: {
        total: counts.total,
        bySeverity: counts.bySeverity,
        byStatus: counts.byStatus,
        byClassification: counts.byClassification,
      },
      mostRecent: counts.mostRecent
        ? {
            id: counts.mostRecent.id,
            displayName: counts.mostRecent.displayName,
            severity: counts.mostRecent.severity,
            status: counts.mostRecent.status,
            lastUpdateDateTime: counts.mostRecent.lastUpdateDateTime,
          }
        : null,
      health: {
        status: wireStatus,
        lastSuccessAt: health?.lastSuccessAt ?? null,
        consecutiveFailures: health?.consecutiveFailureCount ?? 0,
      },
      ingestedAt: counts.latestIngestedAt,
    };

    return {
      status: 200,
      jsonBody: body,
      headers: {
        "cache-control": "private, max-age=30",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`incidents.summary.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "incidents store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};


function rateLimited(
  context: InvocationContext,
  retryAfterMs: number,
): HttpResponseInit {
  return {
    status: 429,
    jsonBody: {
      error: {
        code: "rate_limited",
        message: "per-principal rate limit exceeded on /api/incidents/summary",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}

app.http("getIncidentsSummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "incidents/summary",
  handler,
});
