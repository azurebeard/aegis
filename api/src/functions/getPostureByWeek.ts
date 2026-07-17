// GET /api/posture/{isoWeek} — read a specific ISO-week's cached posture
// narrative (ADR-0027 §Decision.5).
//
// Mirror of `getBriefByDate`: validates `isoWeek` matches `yyyy-Www`, rejects
// future weeks, performs the same sha256 verification as `/api/posture/latest`,
// and returns the parsed-envelope shape. Powers the SPA history view's
// "open this run" expansion. Route regex excludes the literal `latest` and
// `history` so those resolve to their respective handlers.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import {
  classifyFreshness,
  POSTURE_CACHE_TABLE_NAME,
  readCacheBody,
  readCacheForWeek,
} from "../lib/postureCache.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { getTableClient } from "../lib/tables.js";
import { isoWeekOf } from "../lib/posturePromptBuilder.js";
import { parseMarkdownEnvelope } from "./getPostureLatest.js";
import { sanitiseLog } from "../lib/sanitiseLog.js";

const ISO_WEEK_REGEX = /^\d{4}-W\d{2}$/;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E follow-up — Bearer required (Easy Auth retired).
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const isoWeek = request.params.isoWeek ?? "";
  if (!ISO_WEEK_REGEX.test(isoWeek)) {
    return badRequest(context, "path parameter `isoWeek` must be YYYY-Www");
  }
  const today = isoWeekOf(new Date());
  if (isoWeek > today) {
    return badRequest(context, "path parameter `isoWeek` cannot be in the future");
  }

  const config = resolveBriefAgentConfig();
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const cacheTable = getTableClient(opsCtx, POSTURE_CACHE_TABLE_NAME);

  try {
    const row = await readCacheForWeek(cacheTable, config.tenantId, isoWeek);
    if (!row) {
      return {
        status: 404,
        jsonBody: {
          error: {
            code: "not_found",
            message: `no posture narrative cached for ${isoWeek}`,
            correlationId: context.invocationId,
          },
          isoWeek,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    const body = await readCacheBody(
      config.opsBlobEndpoint,
      config.apiReaderMiClientId,
      config.postureCacheContainer,
      row.blobPath,
    );
    if (body.sha256 !== row.outputSha256) {
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "posture_store_integrity_violation",
            message:
              "posture blob sha256 does not match cache row outputSha256 — refusing to serve",
            correlationId: context.invocationId,
          },
          isoWeek,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    const now = new Date();
    const freshness = classifyFreshness(
      row,
      now,
      config.postureStalenessFreshDays,
      config.postureStalenessCeilingDays,
    );
    const parsed = parseMarkdownEnvelope(body.body);
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        isoWeek: row.isoWeek,
        headline: parsed.headline,
        severity: parsed.severity,
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
      `posture.byWeek.error isoWeek=${sanitiseLog(isoWeek)} ${sanitiseLog((err as Error).message)}`,
    );
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "posture store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

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

// Route regex excludes `latest` and `history` so those resolve to their
// respective handlers rather than falling here with isoWeek=`latest`/`history`.
// The `{` / `}` inside the regex must be doubled to escape ASP.NET's
// route-parameter syntax — observed live 2026-04-19 (see getBriefByDate
// for the precedent).
app.http("getPostureByWeek", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "posture/{isoWeek:regex(^(?!latest$|history$)\\d{{4}}-W\\d{{2}}$)}",
  handler,
});
