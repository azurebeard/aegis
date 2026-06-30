// GET /api/conditional-access/summary (ADR-0034 §3.3).
//
// Counts policies by state for the diagnostics-page section + last
// ingest health metadata. Reader-or-admin per the Phase 8B/8C precedent.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveConditionalAccessApiConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { conditionalAccessSummaryRateLimiter } from "../lib/rateLimit.js";
import {
  CONDITIONAL_ACCESS_TABLE_NAME,
  listConditionalAccessPolicies,
} from "../lib/conditionalAccessStore.js";
import { readRecentConditionalAccessChanges } from "../lib/conditionalAccessRecentChanges.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = conditionalAccessSummaryRateLimiter.check(principal.userId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limited",
          message: "per-principal rate limit exceeded on /api/conditional-access/summary",
          correlationId: context.invocationId,
        },
      },
      headers: {
        "retry-after": Math.ceil(rate.retryAfterMs / 1000).toString(),
        "cache-control": "no-store",
      },
    };
  }

  const config = resolveConditionalAccessApiConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const caTable = getTableClient(tableCtx, CONDITIONAL_ACCESS_TABLE_NAME);
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);

  try {
    const [rows, health, recentChanges] = await Promise.all([
      listConditionalAccessPolicies(caTable, config.tenantId),
      readHealthRow(healthTable, config.tenantId, config.conditionalAccessSource),
      readRecentConditionalAccessChanges(
        {
          blobEndpoint: config.auditBlobEndpoint,
          auditContainerName: config.auditContainerName,
          managedIdentityClientId: config.auditMiClientId,
        },
        config.tenantId,
      ).catch((err) => {
        // Audit-blob read failure should NOT block the counts payload —
        // the tile still renders the static enabled/disabled split. Log
        // and degrade gracefully (recentChanges = empty).
        context.warn(
          `conditionalAccess.summary.recentChanges.degraded ${String((err as Error).message ?? err)}`,
        );
        return { windowHours: 24, count: 0, samples: [] as const };
      }),
    ]);
    let enabled = 0;
    let disabled = 0;
    let reportOnly = 0;
    for (const r of rows) {
      if (r.state === "enabled") enabled += 1;
      else if (r.state === "disabled") disabled += 1;
      else if (r.state === "enabledForReportingButNotEnforced") reportOnly += 1;
    }
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        counts: {
          total: rows.length,
          enabled,
          disabled,
          reportOnly,
        },
        health: {
          status: health?.status ?? "awaiting_first_run",
          lastSuccessAt: health?.lastSuccessAt ?? null,
          consecutiveFailures: health?.consecutiveFailureCount ?? 0,
        },
        recentChanges,
      },
      headers: {
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`conditionalAccess.summary.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "conditional-access summary is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("getConditionalAccessSummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "conditional-access/summary",
  handler,
});
