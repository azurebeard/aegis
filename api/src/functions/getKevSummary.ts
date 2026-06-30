// GET /api/kev/summary — ADR-0032 §3 + dashboard tile.
//
// Returns aggregate stats for the dashboard's KevTile:
//   - Total KEV catalog size (active rows, excluding `removed`)
//   - Total matched stack items × CVEs (per tenant)
//   - Number of CVEs with `dueDate` within the next 7 days
//   - Ingest health (last success, status)
//
// Reader-or-admin via the SWA catch-all. Per-principal rate limit shared
// with the other summary endpoints (120/min).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { resolveApiConfig, resolveKevIngestConfig } from "../lib/config.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import {
  applySuppressionsToMatches,
  listKevRows,
  matchesForStackItem,
} from "../lib/kevStore.js";
import {
  indexSuppressions,
  listSuppressions,
} from "../lib/kevSuppressionsStore.js";
import { listStackItems } from "../lib/stackItemsStore.js";
import { riskyUsersSummaryRateLimiter } from "../lib/rateLimit.js";
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
  const rate = riskyUsersSummaryRateLimiter.check(principal.userId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limit",
          message: "per-principal rate limit exceeded",
          correlationId: context.invocationId,
        },
      },
      headers: {
        "retry-after": Math.ceil(rate.retryAfterMs / 1000).toString(),
        "cache-control": "no-store",
      },
    };
  }

  try {
    const apiConfig = resolveApiConfig();
    const kevConfig = resolveKevIngestConfig();
    const tableCtx = {
      endpoint: apiConfig.opsTableEndpoint,
      managedIdentityClientId: apiConfig.apiReaderMiClientId,
    };
    const stackTable = getTableClient(tableCtx, OPS_TABLES.StackItems);
    const kevTable = getTableClient(tableCtx, OPS_TABLES.KEV);
    const suppressionsTable = getTableClient(tableCtx, OPS_TABLES.KevSuppressions);
    const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);

    const [stackItems, kevRows, suppressions, health] = await Promise.all([
      listStackItems(stackTable, apiConfig.tenantId, {}),
      listKevRows(kevTable),
      listSuppressions(suppressionsTable, apiConfig.tenantId),
      readHealthRow(healthTable, apiConfig.tenantId, kevConfig.source),
    ]);

    const activeKev = kevRows.filter((r) => !r.removed);
    const suppressionsByKey = indexSuppressions(suppressions);
    const matchedOpenItemIds = new Set<string>();
    let totalPairs = 0;
    let openCount = 0;
    let acknowledgedCount = 0;
    let riskAcceptedCount = 0;
    let remediatedCount = 0;
    let notApplicableCount = 0;
    let dueThisWeek = 0;
    const nowMs = Date.now();
    const sevenDaysMs = 7 * 86_400_000;

    for (const item of stackItems) {
      const rawMatches = matchesForStackItem(activeKev, item);
      const matches = applySuppressionsToMatches(
        item.id,
        rawMatches,
        suppressionsByKey,
      );
      let hasOpen = false;
      for (const m of matches) {
        totalPairs++;
        switch (m.status) {
          case "open":
            openCount++;
            hasOpen = true;
            break;
          case "acknowledged":
            acknowledgedCount++;
            break;
          case "risk_accepted":
            riskAcceptedCount++;
            break;
          case "remediated":
            remediatedCount++;
            break;
          case "not_applicable":
            notApplicableCount++;
            break;
        }
        // ADR-0033 §3 — dueThisWeek only counts open. Operators want
        // the action queue prominent; resolved CVEs are secondary.
        if (m.status !== "open") continue;
        if (!m.dueDate) continue;
        const due = Date.parse(m.dueDate);
        if (!Number.isFinite(due)) continue;
        if (due >= nowMs && due - nowMs <= sevenDaysMs) dueThisWeek++;
      }
      if (hasOpen) matchedOpenItemIds.add(item.id);
    }

    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        catalog: {
          totalEntries: activeKev.length,
          removedEntries: kevRows.length - activeKev.length,
        },
        matches: {
          totalPairs,
          open: openCount,
          acknowledged: acknowledgedCount,
          riskAccepted: riskAcceptedCount,
          remediated: remediatedCount,
          notApplicable: notApplicableCount,
          // matchedItemCount counts only items with at least one open
          // match — the SPA shows this on the KevTile to focus the
          // operator on outstanding work.
          matchedItemCount: matchedOpenItemIds.size,
          dueThisWeek,
        },
        health: {
          status: health?.status ?? "awaiting_first_run",
          lastSuccessAt: health?.lastSuccessAt ?? null,
          consecutiveFailures: health?.consecutiveFailureCount ?? 0,
        },
      },
      headers: {
        "cache-control": "private, max-age=60",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`kev.summary.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "kev store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("getKevSummary", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "kev/summary",
  handler,
});
