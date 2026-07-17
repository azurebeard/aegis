// GET /api/incidents?<filters>&<pagination> (ADR-0016 §1.2).
//
// Defence-in-depth beyond the SWA authenticated+reader gate:
//   - Strict enum validation on severity/status/classification (reject mixed case).
//   - `limit` integer in [1,50]; `since` strict ISO8601 UTC form.
//   - Per-principal 60 req/min rate limit.
//   - Opaque base64url cursor with JCS-canonical filter fingerprint (ADR-0016 §2).
//   - Cache-Control: private, max-age=60; Vary: Cookie, Authorization.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveIncidentsApiConfig } from "../lib/config.js";
import {
  canonicaliseFilterSet,
  computeFilterFingerprint,
  DEFAULT_LIMIT,
  FilterValidationError,
  type IncidentsListFilterInput,
} from "../lib/filterFingerprint.js";
import {
  INCIDENTS_TABLE_NAME,
  listIncidents,
  type ListIncidentsFilter,
} from "../lib/incidentsStore.js";
import {
  INCIDENT_ANALYSIS_CACHE_TABLE_NAME,
  listAnalysedIncidentIds,
} from "../lib/incidentAnalysisCache.js";
import { incidentsListRateLimiter } from "../lib/rateLimit.js";
import { getTableClient } from "../lib/tables.js";
import { getAllMulti } from "../lib/queryParams.js";
import type { IncidentsListResponse } from "../lib/types.js";

const ISO8601_STRICT_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = incidentsListRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  // Parse + validate filter input.
  let input: IncidentsListFilterInput;
  try {
    input = parseQuery(request);
  } catch (err) {
    return validationError(context, err);
  }

  // Canonicalise filter set — throws on enum casing / range violations.
  let canonicalSet;
  try {
    canonicalSet = canonicaliseFilterSet(input);
  } catch (err) {
    return validationError(context, err);
  }

  // Compute canonical fingerprint for this request.
  const fingerprint = computeFilterFingerprint(input);

  // Cursor decode + validate + fingerprint-mismatch check.
  const cursorRaw = request.query.get("cursor");
  let decodedCursor: { k: string; t: string } | undefined;
  if (cursorRaw && cursorRaw.length > 0) {
    const decoded = decodeCursor(cursorRaw);
    if (decoded === null) {
      return badRequest(context, "cursor decode failed");
    }
    if (decoded.f !== fingerprint) {
      return {
        status: 400,
        jsonBody: {
          error: {
            code: "cursor_filter_mismatch",
            message:
              "cursor was issued for a different filter set; refetch from the first page with current filters",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    decodedCursor = { k: decoded.k, t: decoded.t };
  }

  const config = resolveIncidentsApiConfig();
  const table = getTableClient(
    {
      endpoint: config.opsTableEndpoint,
      managedIdentityClientId: config.apiReaderMiClientId,
    },
    INCIDENTS_TABLE_NAME,
  );

  const storeFilter: ListIncidentsFilter = {
    severity: canonicalSet.severity,
    status: canonicalSet.status,
    classification: canonicalSet.classification,
    since: canonicalSet.since,
    includeRedirected: canonicalSet.includeRedirected,
    limit: canonicalSet.limit,
    cursor: decodedCursor,
  };

  try {
    const result = await listIncidents(table, config.tenantId, storeFilter);

    // Stamp `hasAnalysis` on each row — drives the "AI" column on the SPA.
    // Read the full set of analysed incident IDs in this tenant's
    // partition with a single projected `listEntities`, then Set-membership
    // check per row. One extra round-trip per list call, ~5-15ms in dev.
    // Best-effort: a failure here downgrades to `hasAnalysis: false`
    // everywhere rather than failing the list. The list-level cache (or
    // a hard refresh) recovers the column on the next call.
    let analysedIds = new Set<string>();
    try {
      const analysisTable = getTableClient(
        {
          endpoint: config.opsTableEndpoint,
          managedIdentityClientId: config.apiReaderMiClientId,
        },
        INCIDENT_ANALYSIS_CACHE_TABLE_NAME,
      );
      analysedIds = await listAnalysedIncidentIds(analysisTable, config.tenantId);
    } catch (probeErr) {
      context.warn(
        `incidents.list.hasAnalysis_probe_failed ${String((probeErr as Error).message ?? probeErr)}`,
      );
    }

    const incidentsWithAnalysisFlag = result.incidents.map((inc) => ({
      ...inc,
      hasAnalysis: analysedIds.has(inc.id),
    }));

    const nextCursor = result.nextCursor
      ? encodeCursor({ k: result.nextCursor.k, t: result.nextCursor.t, f: fingerprint })
      : null;
    const body: IncidentsListResponse = {
      schemaVersion: 1,
      incidents: incidentsWithAnalysisFlag,
      page: {
        count: incidentsWithAnalysisFlag.length,
        limit: canonicalSet.limit,
        nextCursor,
        hasMore: result.hasMore,
      },
    };
    return {
      status: 200,
      jsonBody: body,
      headers: {
        "cache-control": "private, max-age=60",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`incidents.list.error ${String((err as Error).message ?? err)}`);
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

function parseQuery(request: HttpRequest): IncidentsListFilterInput {
  const q = request.query;

  // SEC-BUG-INCIDENTS-LIST-MULTI — use the defensive parser that accepts
  // BOTH native repeated params (`?severity=high&severity=medium`) and the
  // comma-joined form the SWA linked-backend proxy collapses repeats into
  // (`?severity=high,medium`). See `lib/queryParams.ts` header for context.
  const severity = getAllMulti(q, "severity");
  const status = getAllMulti(q, "status");
  const classification = getAllMulti(q, "classification");

  const since = q.get("since");
  if (since !== null && since !== "" && !ISO8601_STRICT_Z.test(since)) {
    throw new FilterValidationError(
      "since_format",
      "since",
      "must match strict ISO8601 UTC: YYYY-MM-DDTHH:mm:ss.sssZ",
    );
  }

  let includeRedirected: boolean | undefined = undefined;
  const ir = q.get("includeRedirected");
  if (ir === "true") includeRedirected = true;
  else if (ir === "false") includeRedirected = false;
  else if (ir !== null && ir !== "") {
    throw new FilterValidationError(
      "enum_invalid",
      "includeRedirected",
      "must be `true` or `false`",
    );
  }

  let limit: number | undefined = undefined;
  const limitRaw = q.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^\d+$/.test(limitRaw)) {
      throw new FilterValidationError(
        "limit_integer",
        "limit",
        "must be a non-negative integer",
      );
    }
    const parsed = Number.parseInt(limitRaw, 10);
    limit = parsed;
  }

  const input: IncidentsListFilterInput = {
    ...(severity.length > 0 ? { severity } : {}),
    ...(status.length > 0 ? { status } : {}),
    ...(classification.length > 0 ? { classification } : {}),
    ...(since !== null && since !== "" ? { since } : {}),
    ...(includeRedirected !== undefined ? { includeRedirected } : {}),
    ...(limit !== undefined ? { limit } : { limit: DEFAULT_LIMIT }),
  };
  return input;
}

function encodeCursor(payload: { k: string; t: string; f: string }): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf-8").toString("base64url");
}

function decodeCursor(
  raw: string,
): { k: string; t: string; f: string } | null {
  try {
    const bytes = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed = JSON.parse(bytes) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { k?: unknown }).k === "string" &&
      typeof (parsed as { t?: unknown }).t === "string" &&
      typeof (parsed as { f?: unknown }).f === "string"
    ) {
      return parsed as { k: string; t: string; f: string };
    }
    return null;
  } catch {
    return null;
  }
}

function validationError(
  context: InvocationContext,
  err: unknown,
): HttpResponseInit {
  if (err instanceof FilterValidationError) {
    return {
      status: 400,
      jsonBody: {
        error: {
          code: "bad_request",
          message: `${err.field}: ${err.detail}`,
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
  return {
    status: 400,
    jsonBody: {
      error: {
        code: "bad_request",
        message: String((err as Error).message ?? "invalid request"),
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

function badRequest(
  context: InvocationContext,
  message: string,
): HttpResponseInit {
  return {
    status: 400,
    jsonBody: {
      error: {
        code: "bad_request",
        message,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

function rateLimited(
  context: InvocationContext,
  retryAfterMs: number,
): HttpResponseInit {
  return {
    status: 429,
    jsonBody: {
      error: {
        code: "rate_limited",
        message: "per-principal rate limit exceeded on /api/incidents",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}


app.http("getIncidentsList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "incidents",
  handler,
});
