// GET /api/reports/snapshots?cadence=weekly&limit=N
//
// Returns a projection-only list of recent snapshots for the given cadence.
// Powers the SPA's "Recent reports" sidebar. Reader-or-admin per ADR-0030 §7.
// Default limit 12, max 50.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { resolveApiConfig } from "../lib/config.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import { listRecentSnapshots } from "../lib/reportSnapshotStore.js";
import { isReportCadence } from "../lib/reportPeriod.js";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

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

  const cadenceRaw = request.query.get("cadence") ?? "";
  if (!isReportCadence(cadenceRaw)) {
    return {
      status: 400,
      jsonBody: {
        error: {
          code: "bad_request",
          message: "cadence must be one of: weekly, monthly, quarterly",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const limitParsed = parseLimit(request.query.get("limit"));
  if (limitParsed.kind === "error") return limitParsed.response;

  try {
    const config = resolveApiConfig();
    const tableCtx = {
      endpoint: config.opsTableEndpoint,
      managedIdentityClientId: config.apiReaderMiClientId,
    };
    const table = getTableClient(tableCtx, OPS_TABLES.ReportSnapshots);
    const items = await listRecentSnapshots(table, config.tenantId, cadenceRaw, limitParsed.value);
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        cadence: cadenceRaw,
        items,
        range: { requestedLimit: limitParsed.value, returnedCount: items.length },
      },
      headers: {
        "cache-control": "private, max-age=30",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`report.list.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "report store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

type ParsedLimit =
  | { kind: "ok"; value: number }
  | { kind: "error"; response: HttpResponseInit };

export function parseLimit(raw: string | null): ParsedLimit {
  if (raw === null || raw === "") return { kind: "ok", value: DEFAULT_LIMIT };
  const trimmed = raw.trim();
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || String(n) !== trimmed || n < 1 || n > MAX_LIMIT) {
    return {
      kind: "error",
      response: {
        status: 400,
        jsonBody: {
          error: {
            code: "bad_request",
            message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
          },
        },
        headers: { "cache-control": "no-store" },
      },
    };
  }
  return { kind: "ok", value: n };
}

app.http("listReportSnapshots", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "reports/snapshots",
  handler,
});
