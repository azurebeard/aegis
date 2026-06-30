// GET /api/secure-score/trend?days=<n> (ADR-0012 §1.2).
//
// Defence-in-depth controls beyond the SWA `authenticated+reader` gate:
//   - Strict `days` validation (integer, 1..400); out-of-range → 400.
//   - Per-principal sliding-window rate limit (60 req/min per SWA principal).
//   - Cache-Control: private, max-age=1800 (30 min — matches client staleTime).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveApiConfig } from "../lib/config.js";
import { trendRateLimiter } from "../lib/rateLimit.js";
import {
  getTableClient,
  getTrendSnapshots,
  OPS_TABLES,
} from "../lib/tables.js";
import type { SecureScoreTrendResponse } from "../lib/types.js";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 400;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E — auth is native MSAL Bearer validated in
  // authMiddleware. A null here implies the caller didn't present a valid
  // Bearer (missing header, expired token, wrong audience, etc.) — reject
  // with 401 rather than share a rate-limit bucket across unauthenticated
  // callers.
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
  const rate = trendRateLimiter.check(principal.userId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limited",
          message: "per-principal rate limit exceeded on /trend",
          correlationId: context.invocationId,
        },
      },
      headers: {
        "retry-after": Math.ceil(rate.retryAfterMs / 1000).toString(),
        "cache-control": "no-store",
      },
    };
  }

  const daysRaw = request.query.get("days");
  const days = parseDays(daysRaw);
  if (days === null) {
    return {
      status: 400,
      jsonBody: {
        error: {
          code: "bad_request",
          message: "query param `days` must be an integer in [1, 400]",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const config = resolveApiConfig();
  const snapshotTable = getTableClient(
    { endpoint: config.opsTableEndpoint, managedIdentityClientId: config.apiReaderMiClientId },
    OPS_TABLES.SecureScore,
  );

  try {
    const snapshots = await getTrendSnapshots(snapshotTable, days);
    const body: SecureScoreTrendResponse = {
      schemaVersion: 1,
      snapshots,
      range: {
        from: snapshots[0]?.snapshotDate ?? null,
        to: snapshots[snapshots.length - 1]?.snapshotDate ?? null,
        requestedDays: days,
        returnedCount: snapshots.length,
      },
    };
    return {
      status: 200,
      jsonBody: body,
      headers: {
        "cache-control": "private, max-age=1800",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`secureScore.trend.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "secure score store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

export function parseDays(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_DAYS;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) return null;
  return n;
}

app.http("getSecureScoreTrend", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "secure-score/trend",
  handler,
});
