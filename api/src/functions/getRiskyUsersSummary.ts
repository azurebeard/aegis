// GET /api/risky-users/summary (ADR-0024 §1.1).
//
// Aggregates EntraRisk counts by riskLevel + riskState + processing +
// softDeleted, returns IngestHealth passthrough + most-recent. ADR-0024 §1.1
// licence_required handling: counts:null + mostRecent:null + Cache-Control
// `private, max-age=3600`.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveEntraRiskApiConfig } from "../lib/config.js";
import {
  ENTRA_RISK_TABLE_NAME,
  readRiskyUsersCounts,
} from "../lib/entraRiskStore.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import { riskyUsersSummaryRateLimiter } from "../lib/rateLimit.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import type {
  EntraRiskWireHealthStatus,
  RiskyUsersSummaryResponse,
} from "../lib/types.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = riskyUsersSummaryRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  const config = resolveEntraRiskApiConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const entraRiskTable = getTableClient(tableCtx, ENTRA_RISK_TABLE_NAME);
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);

  try {
    const health = await readHealthRow(healthTable, config.tenantId, config.entraRiskSource);

    // licence_required short-circuit — ADR-0024 §1.1 WS10 SEC-M-ADR-24-01.
    if (health?.status === "licence_required") {
      const body: RiskyUsersSummaryResponse = {
        schemaVersion: 1,
        counts: null,
        mostRecent: null,
        health: {
          status: "licence_required",
          lastSuccessAt: null,
          consecutiveFailures: 0,
        },
        ingestedAt: null,
      };
      return {
        status: 200,
        jsonBody: body,
        headers: {
          "cache-control": "private, max-age=3600",
          vary: "Cookie, Authorization",
        },
      };
    }

    const counts = await readRiskyUsersCounts(entraRiskTable, config.tenantId);

    const wireStatus: EntraRiskWireHealthStatus = !health
      ? "awaiting_first_run"
      : counts.total === 0 && counts.softDeleted === 0
        ? health.status === "healthy"
          ? "no_data"
          : health.status
        : health.status;

    const body: RiskyUsersSummaryResponse = {
      schemaVersion: 1,
      counts: {
        total: counts.total,
        byRiskLevel: counts.byRiskLevel,
        byRiskState: counts.byRiskState,
        processing: counts.processing,
        softDeleted: counts.softDeleted,
      },
      mostRecent: counts.mostRecent,
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
        "cache-control": "private, max-age=60",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`riskyUsers.summary.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "risky-users store is temporarily unavailable",
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
        message: "per-principal rate limit exceeded on /api/risky-users/summary",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}

app.http("getRiskyUsersSummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "risky-users/summary",
  handler,
});
