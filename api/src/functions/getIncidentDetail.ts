// GET /api/incidents/{id} (ADR-0016 §1.3).
//
// Merge: Table row summary + latest detail blob. Past-day walk bounded at 7
// days. `detailBlobMissingClassification` classifies each miss as
// `lifecycle-trim | lookup-failure | unexplained` so the UI banner matches
// tone to cause (ADR-0016 §1.3).

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
  getIncidentById,
  INCIDENTS_TABLE_NAME,
  readLatestDetailBlob,
} from "../lib/incidentsStore.js";
import {
  INCIDENT_ID_REGEX,
  validateIncidentId,
  IncidentIdRejectedError,
} from "../lib/incidentsParser.js";
import { incidentsDetailRateLimiter } from "../lib/rateLimit.js";
import { getTableClient } from "../lib/tables.js";
import type { IncidentDetailResponse, IncidentSummary } from "../lib/types.js";
import { sanitiseLog } from "../lib/sanitiseLog.js";

const DETAIL_WALK_BACK_DAYS = 7;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = incidentsDetailRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  // Path parameter
  const rawId = request.params.id;
  const decodedId = rawId ? decodeURIComponent(rawId) : "";
  try {
    validateIncidentId(decodedId);
  } catch (err) {
    if (err instanceof IncidentIdRejectedError) {
      return badRequest(
        context,
        `path parameter \`id\` does not match ${INCIDENT_ID_REGEX.source}: ${err.reason}`,
      );
    }
    return badRequest(context, "path parameter `id` is invalid");
  }

  const config = resolveIncidentsApiConfig();
  const ctx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const incidentsTable = getTableClient(ctx, INCIDENTS_TABLE_NAME);

  try {
    const row = await getIncidentById(incidentsTable, config.tenantId, decodedId);
    if (row === null) {
      return {
        status: 404,
        jsonBody: {
          error: {
            code: "not_found",
            message: `incident ${decodedId} not found`,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }

    let detailBlobPath: string = row.id ? `${config.incidentsDetailContainerName}/${row.id}.json` : "";
    let detailBody: Record<string, unknown> | null = null;
    let detailBlobMissing = false;
    let detailBlobMissingClassification:
      | "lifecycle-trim"
      | "lookup-failure"
      | "unexplained"
      | undefined = undefined;

    const anchor = row.ingestedAt ?? new Date().toISOString();
    try {
      const lookup = await readLatestDetailBlob(
        {
          blobEndpoint: config.opsBlobEndpoint,
          containerName: config.incidentsDetailContainerName,
          managedIdentityClientId: config.apiReaderMiClientId,
        },
        decodedId,
        anchor,
        DETAIL_WALK_BACK_DAYS,
      );
      if (lookup.found && lookup.body !== null) {
        detailBody = lookup.body as Record<string, unknown>;
        if (lookup.path) {
          detailBlobPath = `${config.incidentsDetailContainerName}/${lookup.path}`;
        }
      } else {
        detailBlobMissing = true;
        detailBlobMissingClassification = classifyMissingBlob(row, anchor);
      }
    } catch (err) {
      context.warn(
        `incidents.detail.blob_lookup_error id=${sanitiseLog(decodedId)} ${sanitiseLog((err as Error).message ?? err)}`,
      );
      detailBlobMissing = true;
      detailBlobMissingClassification = "lookup-failure";
    }

    const mergedIncident = mergeIncident(row, detailBody);

    const body: IncidentDetailResponse = {
      schemaVersion: 1,
      incident: mergedIncident,
      ingest: {
        ingestedAt: row.ingestedAt,
        ingestRunId: row.ingestRunId,
        detailBlobPath,
        ...(detailBlobMissing ? { detailBlobMissing: true } : {}),
        ...(detailBlobMissingClassification
          ? { detailBlobMissingClassification }
          : {}),
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
    context.error(`incidents.detail.error ${String((err as Error).message ?? err)}`);
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

function classifyMissingBlob(
  row: IncidentSummary,
  anchor: string,
): "lifecycle-trim" | "unexplained" {
  // "lifecycle-trim" if the anchor is older than the walk window; otherwise
  // "unexplained" (the blob should still exist). "lookup-failure" is set by
  // the caller on exception only.
  const anchorMs = Date.parse(anchor);
  const now = Date.now();
  if (!Number.isFinite(anchorMs)) return "unexplained";
  const ageMs = now - anchorMs;
  // Past-day walk bounded at DETAIL_WALK_BACK_DAYS — if the anchor is within
  // that window, the blob should have been found.
  if (ageMs > DETAIL_WALK_BACK_DAYS * 86_400_000) return "lifecycle-trim";
  // Suppress unused-var warning via suppress, until a future pass adds the
  // row-field derivation (e.g. last update date drives the tone more
  // specifically).
  void row;
  return "unexplained";
}

function mergeIncident(
  row: IncidentSummary,
  detail: Record<string, unknown> | null,
): IncidentDetailResponse["incident"] {
  // Table row's summary fields take precedence; the blob fills in prose and
  // nested structures that don't fit on the row.
  if (!detail) return { ...row };
  const withProse: IncidentDetailResponse["incident"] = {
    ...row,
    ...(typeof detail.description === "string"
      ? { description: detail.description }
      : {}),
    ...(typeof detail.summary === "string" ? { summary: detail.summary } : {}),
    ...(typeof detail.resolvingComment === "string" ||
    detail.resolvingComment === null
      ? { resolvingComment: detail.resolvingComment as string | null }
      : {}),
    ...(typeof detail.lastModifiedBy === "string" ||
    detail.lastModifiedBy === null
      ? { lastModifiedBy: detail.lastModifiedBy as string | null }
      : {}),
    ...(Array.isArray(detail.comments) ? { comments: detail.comments } : {}),
    ...(Array.isArray(detail.alerts) ? { alerts: detail.alerts } : {}),
  };
  return withProse;
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
        message: "per-principal rate limit exceeded on /api/incidents/{id}",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}

// Route constraint `regex(^(?!summary$).+$)` excludes the literal `summary`
// so `/api/incidents/summary` resolves to `getIncidentsSummary` rather than
// this detail handler with id="summary". The
// per-ID character-class + length check lives inside the handler, not the
// template — a constraint-level violation would return the runtime's own
// opaque 404, whereas the handler returns a structured bad_request.
app.http("getIncidentDetail", {
  methods: ["GET"],
  authLevel: "anonymous",
  // Exclude the literal `summary` and `trends` path segments so those
  // resolve to their dedicated handlers (getIncidentsSummary,
  // getIncidentsTrends) instead of being parsed as `id`.
  route: "incidents/{id:regex(^(?!summary$|trends$).+$)}",
  handler,
});
