// GET /api/reports/snapshots/<periodKey>?version=N
//
// Returns the stored envelope for a (tenantId, periodKey, version). When
// `version` is omitted, returns the highest-versioned row for the period.
// 404 when nothing matches. Reader-or-admin per ADR-0030 §7.

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
import {
  readLatestSnapshot,
  readVersion,
} from "../lib/reportSnapshotStore.js";

const PERIOD_KEY_RE = /^\d{4}-(?:W\d{2}|\d{2}|Q[1-4])$/;

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

  const periodKey = request.params["periodKey"] ?? "";
  if (!PERIOD_KEY_RE.test(periodKey)) {
    return {
      status: 400,
      jsonBody: {
        error: {
          code: "bad_request",
          message: "periodKey must match YYYY-Www | YYYY-MM | YYYY-Qn",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const versionRaw = request.query.get("version");
  const versionParsed = parseVersion(versionRaw);
  if (versionParsed.kind === "error") return versionParsed.response;

  try {
    const config = resolveApiConfig();
    const tableCtx = {
      endpoint: config.opsTableEndpoint,
      managedIdentityClientId: config.apiReaderMiClientId,
    };
    const table = getTableClient(tableCtx, OPS_TABLES.ReportSnapshots);
    const envelope =
      versionParsed.value === null
        ? await readLatestSnapshot(table, config.tenantId, periodKey)
        : await readVersion(table, config.tenantId, periodKey, versionParsed.value);

    if (!envelope) {
      return {
        status: 404,
        jsonBody: {
          error: {
            code: "not_found",
            message: `no snapshot for periodKey=${periodKey}${
              versionParsed.value !== null ? ` version=${versionParsed.value}` : ""
            }`,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    return {
      status: 200,
      jsonBody: envelope,
      headers: {
        "cache-control": "private, max-age=300", // historical = stable for 5 min
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`report.snapshot.error ${String((err as Error).message ?? err)}`);
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

type ParsedVersion =
  | { kind: "ok"; value: number | null }
  | { kind: "error"; response: HttpResponseInit };

export function parseVersion(raw: string | null): ParsedVersion {
  if (raw === null || raw === "") return { kind: "ok", value: null };
  const trimmed = raw.trim();
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || String(n) !== trimmed || n < 1) {
    return {
      kind: "error",
      response: {
        status: 400,
        jsonBody: {
          error: {
            code: "bad_request",
            message: "version must be a positive integer",
          },
        },
        headers: { "cache-control": "no-store" },
      },
    };
  }
  return { kind: "ok", value: n };
}

app.http("getReportSnapshot", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "reports/snapshots/{periodKey}",
  handler,
});
