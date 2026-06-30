// GET /api/brief/history — list metadata for the last N cached briefs.
//
// Powers the SPA history view.
// Metadata-only — body content is fetched lazily via `/api/brief/{date}` when
// the user expands a row. This avoids N blob downloads to render an N-row
// list.
//
// `?limit` query param caps the response size; default 14 (matches the cache
// retention envelope per ADR-0022 §retention). Maximum 60 — anything beyond
// that exceeds the operator's reasonable memory window for a daily artefact.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import {
  BRIEF_CACHE_TABLE_NAME,
  listCacheRows,
} from "../lib/briefCache.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { getTableClient } from "../lib/tables.js";

const DEFAULT_LIMIT = 14;
const MAX_LIMIT = 60;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E follow-up — Bearer required (Easy Auth retired).
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const parsed = parseLimit(request.query.get("limit"));
  if (parsed.kind === "error") return parsed.response;
  const limit = parsed.value;

  const config = resolveBriefAgentConfig();
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const cacheTable = getTableClient(opsCtx, BRIEF_CACHE_TABLE_NAME);

  try {
    const rows = await listCacheRows(cacheTable, config.tenantId, limit);
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        items: rows.map((r) => ({
          briefDate: r.briefDate,
          generatedAt: r.generatedAt,
          runId: r.runId,
          outputSha256: r.outputSha256,
          modelDeployment: r.modelDeployment,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
        })),
        limit,
        count: rows.length,
      },
      headers: {
        "cache-control": "private, max-age=60",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`brief.history.error ${(err as Error).message}`);
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

app.http("getBriefHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "brief/history",
  handler,
});
