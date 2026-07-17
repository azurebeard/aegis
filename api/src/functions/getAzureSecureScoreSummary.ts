// GET /api/azure-secure-score/summary (ADR-0036).
//
// Returns the latest snapshot per tracked subscription + a 90-day trend
// for sparkline rendering on the dashboard tile + diagnostics page.
// Reader-or-admin per the Phase 8B/8C/8D/8E precedent (ADR-0034 §9
// amendment).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveAzureSecureScoreApiConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { azureSecureScoreSummaryRateLimiter } from "../lib/rateLimit.js";
import {
  AZURE_SECURE_SCORES_TABLE_NAME,
  listAzureSecureScores,
} from "../lib/azureSecureScoreStore.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = azureSecureScoreSummaryRateLimiter.check(principal.userId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limited",
          message: "per-principal rate limit exceeded on /api/azure-secure-score/summary",
          correlationId: context.invocationId,
        },
      },
      headers: {
        "retry-after": Math.ceil(rate.retryAfterMs / 1000).toString(),
        "cache-control": "no-store",
      },
    };
  }

  const config = resolveAzureSecureScoreApiConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const scoresTable = getTableClient(tableCtx, AZURE_SECURE_SCORES_TABLE_NAME);
  // ADR-0036 v1.3 — azure.* freshness lives in ArmIngestHealth post-split.
  const healthTable = getTableClient(tableCtx, OPS_TABLES.ArmIngestHealth);

  try {
    const [rows, health] = await Promise.all([
      listAzureSecureScores(scoresTable, config.tenantId),
      readHealthRow(healthTable, config.tenantId, config.azureSecureScoreSource),
    ]);

    // Group by subscriptionId, take the most recent snapshot per sub +
    // the per-day trend points (sorted ascending by snapshotDate so the
    // SPA renders a left-to-right sparkline directly).
    const bySub = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = bySub.get(r.subscriptionId);
      if (list) list.push(r);
      else bySub.set(r.subscriptionId, [r]);
    }
    // ADR-0036 v1.1 observation — server-side retention filter. The trend
    // window is bounded by snapshot retention (90d in prod, env-aware
    // shorter in dev), but the lifecycle-only-delete sweep runs daily,
    // not on read. Slice the most recent 90 entries per subscription at
    // the API boundary so a brief retention overrun doesn't bloat the
    // response body or push stale points into the sparkline.
    const TREND_MAX = 90;
    const subscriptions = Array.from(bySub.entries()).map(([subscriptionId, list]) => {
      const sortedAsc = [...list].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
      const trendWindow = sortedAsc.slice(-TREND_MAX);
      const latest = sortedAsc[sortedAsc.length - 1]!;
      return {
        subscriptionId,
        subscriptionName: latest.subscriptionName,
        latest: {
          snapshotDate: latest.snapshotDate,
          currentScore: latest.currentScore,
          maxScore: latest.maxScore,
          percentage: latest.percentage,
          weight: latest.weight,
        },
        trend: trendWindow.map((r) => ({
          snapshotDate: r.snapshotDate,
          percentage: r.percentage,
        })),
      };
    });

    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        subscriptions,
        health: {
          status: health?.status ?? "awaiting_first_run",
          lastSuccessAt: health?.lastSuccessAt ?? null,
          consecutiveFailures: health?.consecutiveFailureCount ?? 0,
        },
      },
      headers: {
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`azureSecureScore.summary.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "Defender for Cloud Secure Score summary is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("getAzureSecureScoreSummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "azure-secure-score/summary",
  handler,
});
