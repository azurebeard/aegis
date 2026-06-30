// GET /api/incidents/trends?days=N — daily-bucketed incident counts
// stacked by severity over the last N UTC days. Powers the Incidents
// trend chart.
//
// Default window 30, max 90 (matches the Secure Score trend cadence so
// operators reach for the same default mental model). Empty days are
// included as zero buckets so the chart shows a continuous timeline.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveApiConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import {
  INCIDENTS_TABLE_NAME,
  readIncidentsTrends,
} from "../lib/incidentsStore.js";
import { getTableClient } from "../lib/tables.js";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

type ParsedDays =
  | { kind: "ok"; value: number }
  | { kind: "error"; response: HttpResponseInit };

export function parseDays(raw: string | null): ParsedDays {
  if (raw === null || raw === "") return { kind: "ok", value: DEFAULT_DAYS };
  const trimmed = raw.trim();
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || String(n) !== trimmed || n < 1 || n > MAX_DAYS) {
    return {
      kind: "error",
      response: {
        status: 400,
        jsonBody: {
          error: {
            code: "bad_request",
            message: `days must be an integer between 1 and ${MAX_DAYS}`,
          },
        },
        headers: { "cache-control": "no-store" },
      },
    };
  }
  return { kind: "ok", value: n };
}

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E follow-up — Bearer required (Easy Auth retired).
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const parsed = parseDays(request.query.get("days"));
  if (parsed.kind === "error") return parsed.response;
  const days = parsed.value;

  const config = resolveApiConfig();
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const incidentsTable = getTableClient(opsCtx, INCIDENTS_TABLE_NAME);

  try {
    // `since` is at the START of the day-N-back UTC midnight to avoid a
    // sub-day window that would drop early-morning incidents from day N.
    const today = new Date();
    const start = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - (days - 1),
      ),
    );
    const buckets = await readIncidentsTrends(
      incidentsTable,
      config.tenantId,
      start.toISOString(),
      days,
    );
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        items: buckets,
        range: {
          from: buckets[0]?.day ?? null,
          to: buckets[buckets.length - 1]?.day ?? null,
          requestedDays: days,
          returnedCount: buckets.length,
        },
      },
      headers: {
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`incidents.trends.error ${(err as Error).message}`);
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

app.http("getIncidentsTrends", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "incidents/trends",
  handler,
});
