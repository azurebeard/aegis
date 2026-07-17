// GET /api/brief/{date} — read a specific date's cached brief (ADR-0022).
//
// Validates `date` is `YYYY-MM-DD` and ≤ today (UTC). Same sha256 verification
// as `/api/brief/latest`. Route regex excludes the literal `latest` so
// `/api/brief/latest` resolves to that handler instead of falling here with
// `date="latest"`.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import {
  readCacheBody,
  readCacheForDate,
  classifyFreshness,
  BRIEF_CACHE_TABLE_NAME,
} from "../lib/briefCache.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { getTableClient } from "../lib/tables.js";
import { parseMarkdownSections } from "./getBriefLatest.js";
import { sanitiseLog } from "../lib/sanitiseLog.js";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E follow-up — Bearer required (Easy Auth retired).
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const date = request.params.date ?? "";
  if (!DATE_REGEX.test(date)) {
    return badRequest(context, "path parameter `date` must be YYYY-MM-DD");
  }
  const today = isoDate(new Date());
  if (date > today) {
    return badRequest(context, "path parameter `date` cannot be in the future");
  }

  const config = resolveBriefAgentConfig();
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const cacheTable = getTableClient(opsCtx, BRIEF_CACHE_TABLE_NAME);

  try {
    const row = await readCacheForDate(cacheTable, config.tenantId, date);
    if (!row) {
      return {
        status: 404,
        jsonBody: {
          error: {
            code: "not_found",
            message: `no brief cached for ${date}`,
            correlationId: context.invocationId,
          },
          briefDate: date,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    const body = await readCacheBody(
      config.opsBlobEndpoint,
      config.apiReaderMiClientId,
      config.briefCacheContainer,
      row.blobPath,
    );
    if (body.sha256 !== row.outputSha256) {
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "brief_store_integrity_violation",
            message:
              "brief blob sha256 does not match cache row outputSha256 — refusing to serve",
            correlationId: context.invocationId,
          },
          briefDate: date,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    const now = new Date();
    const freshness = classifyFreshness(
      row,
      now,
      config.briefStalenessFreshHours,
      config.briefStalenessCeilingHours,
    );
    const parsed = parseMarkdownSections(body.body);
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        briefDate: row.briefDate,
        headline: parsed.headline,
        sections: parsed.sections,
        runId: row.runId,
        generatedAt: row.generatedAt,
        outputSha256: row.outputSha256,
        modelDeployment: row.modelDeployment,
        freshness,
      },
      headers: {
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(
      `brief.byDate.error date=${sanitiseLog(date)} ${sanitiseLog((err as Error).message)}`,
    );
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "brief store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
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

// Route constraint excludes `latest` so `/api/brief/latest` resolves to
// `getBriefLatest` rather than this handler with date="latest".
//
// ASP.NET routing treats `{` / `}` inside the regex constraint as parameter
// markers, so literal braces in `\d{4}-\d{2}-\d{2}` must be doubled to
// `\d{{4}}-\d{{2}}-\d{{2}}` to escape — otherwise the route build throws
// `RoutePatternException: '{' and '}' must be escaped with '{{' and '}}'`
// at host startup (observed live 2026-04-19, Flex Consumption host stayed
// down until this was escaped).
app.http("getBriefByDate", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "brief/{date:regex(^(?!latest$)\\d{{4}}-\\d{{2}}-\\d{{2}}$)}",
  handler,
});
