// GET /api/sign-ins/summary (ADR-0034 §3.2).
//
// Aggregates SignIns table rows into total/out-of-area/CA-failure counts
// over the last 24h, returns IngestHealth + most-recent. licence_required
// short-circuit mirrors the Phase 8B summary handler.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveSignInsApiConfig } from "../lib/config.js";
import {
  computeSignInsSummary,
  listSignIns,
  SIGN_INS_TABLE_NAME,
} from "../lib/signInsStore.js";
import { readGeoFencePolicy } from "../lib/tenantSettingsStore.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import { signInsSummaryRateLimiter } from "../lib/rateLimit.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = signInsSummaryRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  const config = resolveSignInsApiConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const signInsTable = getTableClient(tableCtx, SIGN_INS_TABLE_NAME);
  const settingsTable = getTableClient(tableCtx, OPS_TABLES.TenantSettings);
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);

  try {
    const health = await readHealthRow(healthTable, config.tenantId, config.signInsSource);
    if (health?.status === "licence_required") {
      return {
        status: 200,
        jsonBody: {
          schemaVersion: 1,
          counts: null,
          policy: null,
          health: {
            status: "licence_required",
            lastSuccessAt: null,
            consecutiveFailures: 0,
          },
          ingestedAt: null,
        },
        headers: {
          "cache-control": "private, max-age=3600",
          vary: "Cookie, Authorization",
        },
      };
    }

    // Read only the last 24h for the summary — partition scan is bounded
    // by the retention trim (≤30d in prod). 24h window keeps the read
    // cost predictable as sign-in volumes scale.
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const [policy, rows] = await Promise.all([
      readGeoFencePolicy(settingsTable, config.tenantId),
      listSignIns(signInsTable, config.tenantId, { createdSince: since }),
    ]);
    const summary = computeSignInsSummary(rows);
    const wireStatus =
      health === null
        ? "awaiting_first_run"
        : summary.totalToday === 0
          ? health.status === "healthy"
            ? "no_data"
            : health.status
          : health.status;
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        counts: {
          totalToday: summary.totalToday,
          outOfAreaToday: summary.outOfAreaToday,
          caFailuresToday: summary.caFailuresToday,
        },
        mostRecent: summary.mostRecent
          ? {
              id: summary.mostRecent.id,
              userPrincipalName: summary.mostRecent.userPrincipalName,
              userDisplayName: summary.mostRecent.userDisplayName,
              country: summary.mostRecent.country,
              createdDateTime: summary.mostRecent.createdDateTime,
              outOfArea: summary.mostRecent.outOfArea,
            }
          : null,
        mostRecentOutOfArea: summary.mostRecentOutOfArea
          ? {
              id: summary.mostRecentOutOfArea.id,
              userPrincipalName: summary.mostRecentOutOfArea.userPrincipalName,
              userDisplayName: summary.mostRecentOutOfArea.userDisplayName,
              country: summary.mostRecentOutOfArea.country,
              createdDateTime: summary.mostRecentOutOfArea.createdDateTime,
              outOfArea: true,
            }
          : null,
        policy: {
          enabled: policy.enabled,
          allowedCountries: policy.allowedCountries,
          unknownLocationPolicy: policy.unknownLocationPolicy,
          source: policy.source,
        },
        health: {
          status: wireStatus,
          lastSuccessAt: health?.lastSuccessAt ?? null,
          consecutiveFailures: health?.consecutiveFailureCount ?? 0,
        },
        ingestedAt: rows.length > 0 ? (rows[0]?.ingestedAt ?? null) : null,
      },
      headers: {
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`signIns.summary.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "sign-ins store is temporarily unavailable",
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
        message: "per-principal rate limit exceeded on /api/sign-ins/summary",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}

app.http("getSignInsSummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "sign-ins/summary",
  handler,
});
