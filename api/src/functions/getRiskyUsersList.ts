// GET /api/risky-users/list?<filters>&<pagination> (ADR-0024 §1.2).
//
// Strict enum + limit validation; opaque cursor with filter-fingerprint
// inherited from ADR-0016 §2a; per-principal 60 req/min rate limit.
// Cache-Control `private, max-age=60`; Vary: Cookie, Authorization.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveEntraRiskApiConfig } from "../lib/config.js";
import {
  ENTRA_RISK_TABLE_NAME,
  readRecentRiskyUsers,
} from "../lib/entraRiskStore.js";
import {
  canonicaliseRiskyUsersFilterSet,
  computeRiskyUsersFilterFingerprint,
  FilterValidationError,
  RISKY_USERS_DEFAULT_LIMIT,
  type RiskyUsersListFilterInput,
} from "../lib/filterFingerprint.js";
import { riskyUsersListRateLimiter } from "../lib/rateLimit.js";
import { getTableClient } from "../lib/tables.js";
import { getAllMulti } from "../lib/queryParams.js";
import type {
  EntraRiskLevel,
  EntraRiskState,
  RiskyUserSummary,
  RiskyUsersListResponse,
} from "../lib/types.js";

const ISO8601_STRICT_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = riskyUsersListRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  let input: RiskyUsersListFilterInput;
  try {
    input = parseQuery(request);
  } catch (err) {
    return validationError(context, err);
  }

  let canonicalSet;
  try {
    canonicalSet = canonicaliseRiskyUsersFilterSet(input);
  } catch (err) {
    return validationError(context, err);
  }

  const fingerprint = computeRiskyUsersFilterFingerprint(input);

  const cursorRaw = request.query.get("cursor");
  let cursorAfter: string | undefined;
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
              "cursor was issued for a different filter set; refetch from the first page",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    cursorAfter = `${decoded.t}|${decoded.k}`;
  }

  const config = resolveEntraRiskApiConfig();
  const table = getTableClient(
    {
      endpoint: config.opsTableEndpoint,
      managedIdentityClientId: config.apiReaderMiClientId,
    },
    ENTRA_RISK_TABLE_NAME,
  );

  try {
    const result = await readRecentRiskyUsers(table, config.tenantId, {
      includeDeleted: canonicalSet.includeDeleted,
      includeRemediated: canonicalSet.includeRemediated,
      maxRows: canonicalSet.limit,
      ...(cursorAfter !== undefined ? { cursorAfter } : {}),
    });

    // Apply enum filters client-side (the store's read path is filter-agnostic).
    let rows = result.rows;
    if (canonicalSet.riskLevel.length > 0) {
      const allow = new Set<string>(canonicalSet.riskLevel);
      rows = rows.filter((r) => allow.has(r.riskLevel === "unknown" ? "unknown" : r.riskLevel));
    }
    if (canonicalSet.riskState.length > 0) {
      const allow = new Set<string>(canonicalSet.riskState);
      rows = rows.filter((r) => allow.has(r.riskState === "unknown" ? "unknown" : r.riskState));
    }
    if (canonicalSet.since) {
      rows = rows.filter((r) => r.riskLastUpdatedDateTime >= canonicalSet.since!);
    }

    const summaries: RiskyUserSummary[] = rows.map((r) => ({
      id: r.id,
      userPrincipalName: r.userPrincipalName,
      userDisplayName: r.userDisplayName,
      riskLevel: toWireRiskLevel(r.riskLevel),
      riskState: toWireRiskState(r.riskState),
      riskDetail: r.riskDetail,
      riskLastUpdatedDateTime: r.riskLastUpdatedDateTime,
      isDeleted: r.isDeleted,
      isProcessing: r.isProcessing,
    }));

    // Build nextCursor (encodes (t,k) of last row + filter fingerprint).
    const last = summaries[summaries.length - 1];
    const storeHasMore = result.nextCursor !== null;
    const nextCursor =
      storeHasMore && last
        ? encodeCursor({
            t: last.riskLastUpdatedDateTime,
            k: last.id,
            f: fingerprint,
          })
        : null;

    const body: RiskyUsersListResponse = {
      schemaVersion: 1,
      riskyUsers: summaries,
      page: {
        count: summaries.length,
        limit: canonicalSet.limit,
        nextCursor,
        hasMore: storeHasMore,
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
    context.error(`riskyUsers.list.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "risky-users store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

function parseQuery(request: HttpRequest): RiskyUsersListFilterInput {
  const q = request.query;
  // SEC-BUG-INCIDENTS-LIST-MULTI — defensive parser; see
  // `lib/queryParams.ts` header. Accepts both native repeats and the
  // comma-joined form the SWA linked-backend proxy produces.
  const riskLevel = getAllMulti(q, "riskLevel");
  const riskState = getAllMulti(q, "riskState");
  const since = q.get("since");
  if (since !== null && since !== "" && !ISO8601_STRICT_Z.test(since)) {
    throw new FilterValidationError(
      "since_format",
      "since",
      "must match strict ISO8601 UTC: YYYY-MM-DDTHH:mm:ss.sssZ",
    );
  }
  let includeDeleted: boolean | undefined;
  const idRaw = q.get("includeDeleted");
  if (idRaw === "true") includeDeleted = true;
  else if (idRaw === "false") includeDeleted = false;
  else if (idRaw !== null && idRaw !== "") {
    throw new FilterValidationError(
      "enum_invalid",
      "includeDeleted",
      "must be `true` or `false`",
    );
  }
  let includeRemediated: boolean | undefined;
  const irRaw = q.get("includeRemediated");
  if (irRaw === "true") includeRemediated = true;
  else if (irRaw === "false") includeRemediated = false;
  else if (irRaw !== null && irRaw !== "") {
    throw new FilterValidationError(
      "enum_invalid",
      "includeRemediated",
      "must be `true` or `false`",
    );
  }
  let limit: number | undefined;
  const limitRaw = q.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^\d+$/.test(limitRaw)) {
      throw new FilterValidationError(
        "limit_integer",
        "limit",
        "must be a non-negative integer",
      );
    }
    limit = Number.parseInt(limitRaw, 10);
  }
  const input: RiskyUsersListFilterInput = {
    ...(riskLevel.length > 0 ? { riskLevel } : {}),
    ...(riskState.length > 0 ? { riskState } : {}),
    ...(since !== null && since !== "" ? { since } : {}),
    ...(includeDeleted !== undefined ? { includeDeleted } : {}),
    ...(includeRemediated !== undefined ? { includeRemediated } : {}),
    ...(limit !== undefined ? { limit } : { limit: RISKY_USERS_DEFAULT_LIMIT }),
  };
  return input;
}

function encodeCursor(payload: { t: string; k: string; f: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function decodeCursor(raw: string): { t: string; k: string; f: string } | null {
  try {
    const bytes = Buffer.from(raw, "base64url").toString("utf-8");
    const parsed = JSON.parse(bytes) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { t?: unknown }).t === "string" &&
      typeof (parsed as { k?: unknown }).k === "string" &&
      typeof (parsed as { f?: unknown }).f === "string"
    ) {
      return parsed as { t: string; k: string; f: string };
    }
    return null;
  } catch {
    return null;
  }
}

function toWireRiskLevel(v: string): EntraRiskLevel {
  switch (v) {
    case "low":
    case "medium":
    case "high":
    case "hidden":
    case "none":
      return v;
    default:
      return "unknown";
  }
}

function toWireRiskState(v: string): EntraRiskState {
  switch (v) {
    case "none":
    case "atRisk":
    case "confirmedSafe":
    case "confirmedCompromised":
    case "remediated":
    case "dismissed":
      return v;
    default:
      return "unknown";
  }
}

function validationError(context: InvocationContext, err: unknown): HttpResponseInit {
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

function badRequest(context: InvocationContext, message: string): HttpResponseInit {
  return {
    status: 400,
    jsonBody: {
      error: { code: "bad_request", message, correlationId: context.invocationId },
    },
    headers: { "cache-control": "no-store" },
  };
}

function rateLimited(context: InvocationContext, retryAfterMs: number): HttpResponseInit {
  return {
    status: 429,
    jsonBody: {
      error: {
        code: "rate_limited",
        message: "per-principal rate limit exceeded on /api/risky-users/list",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}


app.http("getRiskyUsersList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "risky-users/list",
  handler,
});
