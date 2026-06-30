// GET /api/ransomware-intel/summary — ADR-0037 Layer 4.
//
// Tile payload: victims + press counts (current + prior month), distinct
// group count, most-recent victim, IngestHealth freshness. Server-
// computed at request time; no caching beyond the 30s Cache-Control
// budget — matches the incidentsSummary cadence so the dashboard's
// refresh-on-focus story is uniform.
//
// Auth: 401 on missing principal (Phase E Bearer-only). No admin check —
// any authenticated principal can read the tile.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveRansomwareIntelApiConfig } from "../lib/config.js";
import {
  computeRansomwareIntelSummary,
  listAll,
  RANSOMWARE_INTEL_TABLE_NAME,
} from "../lib/ransomwareIntelStore.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import { ransomwareIntelSummaryRateLimiter } from "../lib/rateLimit.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import type { RansomwareIntelSummaryResponse } from "../lib/types.js";

// Country filter for the tile — re-resolved at request time from the same
// env var the ingest config reads (`THREAT_INTEL_COUNTRY`). Layer 5 will
// move this to a per-tenant Table-backed config row; for now both ingest
// and reader sides agree on the env-var path.
function readConfiguredCountry(env: NodeJS.ProcessEnv = process.env): string {
  return (env.THREAT_INTEL_COUNTRY ?? "GB").toUpperCase();
}

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) {
    return unauthenticated(context);
  }
  const rate = ransomwareIntelSummaryRateLimiter.check(principal.userId);
  if (!rate.allowed) {
    return rateLimited(context, rate.retryAfterMs);
  }

  const config = resolveRansomwareIntelApiConfig();
  const country = readConfiguredCountry();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const dataTable = getTableClient(tableCtx, RANSOMWARE_INTEL_TABLE_NAME);
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);

  try {
    const [rows, health] = await Promise.all([
      // Country-filtered at the Table query layer — same partition (tenant)
      // so this is a single Table scan with an OData predicate, not a
      // full-table walk.
      listAll(dataTable, config.tenantId, { country }),
      readHealthRow(healthTable, config.tenantId, config.ransomwareIntelSource),
    ]);

    const summary = computeRansomwareIntelSummary(rows);
    const totalThisMonth = summary.victimsThisMonth + summary.pressThisMonth;

    // Health-status wire mapping mirrors incidentsSummary:
    //   - never ran     → awaiting_first_run
    //   - healthy + 0 rows this month → no_data
    //   - everything else            → the underlying status verbatim
    const wireStatus: RansomwareIntelSummaryResponse["health"]["status"] = !health
      ? "awaiting_first_run"
      : totalThisMonth === 0
        ? health.status === "healthy"
          ? "no_data"
          : health.status
        : health.status;

    const body: RansomwareIntelSummaryResponse = {
      schemaVersion: 1,
      counts: {
        victimsThisMonth: summary.victimsThisMonth,
        victimsPriorMonth: summary.victimsPriorMonth,
        pressThisMonth: summary.pressThisMonth,
        pressPriorMonth: summary.pressPriorMonth,
        distinctGroupsThisMonth: summary.distinctGroupsThisMonth,
      },
      mostRecentVictim: summary.mostRecentVictim
        ? {
            victim: summary.mostRecentVictim.victim,
            group: summary.mostRecentVictim.group,
            discoveredDate: summary.mostRecentVictim.discoveredDate,
            country: summary.mostRecentVictim.country,
          }
        : null,
      health: {
        status: wireStatus,
        lastSuccessAt: health?.lastSuccessAt ?? null,
        consecutiveFailures: health?.consecutiveFailureCount ?? 0,
      },
      country,
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
    context.error(
      `ransomwareIntel.summary.error ${String((err as Error).message ?? err)}`,
    );
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "ransomware intel store is temporarily unavailable",
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
        message: "per-principal rate limit exceeded on /api/ransomware-intel/summary",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}

app.http("getRansomwareIntelSummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "ransomware-intel/summary",
  handler,
});

export { handler as getRansomwareIntelSummaryHandler };
