// GET /api/user-dormancy/summary (ADR-0034 §3.1).
//
// Aggregates UserDormancy table rows into total/dormant/enabled-dormant
// counts using the operator-configured dormancy-policy row (TenantSettings
// ADR-0034 §4.2). licence_required short-circuit mirrors the riskyUsers
// summary handler — `private, max-age=3600` cache hint.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveUserDormancyApiConfig } from "../lib/config.js";
import {
  computeDormancySummary,
  listUserDormancyRows,
  USER_DORMANCY_TABLE_NAME,
} from "../lib/userDormancyStore.js";
import { readDormancyPolicy } from "../lib/tenantSettingsStore.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import { userDormancySummaryRateLimiter } from "../lib/rateLimit.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = userDormancySummaryRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  const config = resolveUserDormancyApiConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const dormancyTable = getTableClient(tableCtx, USER_DORMANCY_TABLE_NAME);
  const settingsTable = getTableClient(tableCtx, OPS_TABLES.TenantSettings);
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);

  try {
    const health = await readHealthRow(healthTable, config.tenantId, config.userDormancySource);
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

    const [policy, rows] = await Promise.all([
      readDormancyPolicy(settingsTable, config.tenantId),
      listUserDormancyRows(dormancyTable, config.tenantId),
    ]);
    const summary = computeDormancySummary(rows, policy);

    const wireStatus =
      health === null
        ? "awaiting_first_run"
        : summary.total === 0
          ? health.status === "healthy"
            ? "no_data"
            : health.status
          : health.status;

    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        counts: {
          total: summary.total,
          dormant: summary.dormant,
          enabledDormant: summary.enabledDormant,
          disabledDormant: summary.disabledDormant,
          excluded: summary.excluded,
          oldestDormantUpn: summary.oldestDormantUpn,
          oldestDormantLastSignIn: summary.oldestDormantLastSignIn,
        },
        policy: {
          thresholdDays: policy.thresholdDays,
          includeDisabledAccounts: policy.includeDisabledAccounts,
          excludeServiceAccountSuffixes: policy.excludeServiceAccountSuffixes,
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
    context.error(`userDormancy.summary.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "user-dormancy store is temporarily unavailable",
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
        message: "per-principal rate limit exceeded on /api/user-dormancy/summary",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}

app.http("getUserDormancySummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "user-dormancy/summary",
  handler,
});
