// GET /api/posture/history — list metadata for the last N cached posture
// narratives (ADR-0027 + HANDOVER §6.3 history view).
//
// Mirror of `getBriefHistory` for the weekly cadence. Default limit 12
// (≈ 3 months); cap at 26 (half a year). Metadata-only — bodies fetched
// lazily via `/api/posture/{isoWeek}`.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import {
  POSTURE_CACHE_TABLE_NAME,
  listCacheRows,
} from "../lib/postureCache.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { getTableClient } from "../lib/tables.js";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 26;

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
  const cacheTable = getTableClient(opsCtx, POSTURE_CACHE_TABLE_NAME);

  try {
    const rows = await listCacheRows(cacheTable, config.tenantId, limit);
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        items: rows.map((r) => ({
          isoWeek: r.isoWeek,
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
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`posture.history.error ${(err as Error).message}`);
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

app.http("getPostureHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "posture/history",
  handler,
});
