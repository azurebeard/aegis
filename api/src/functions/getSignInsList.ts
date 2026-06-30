// GET /api/sign-ins/list (ADR-0034 §3.2).
//
// Paged drilldown: ?outOfAreaOnly=true | ?caFailuresOnly=true | ?limit=N
// (default 50, max 200). Sort by createdDateTime descending (most-recent
// first). Per-row projection drops `Status` raw JSON and clamps timestamps
// to ISO — the SPA tile + table render plain-text only (ADR-0012 §5).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveSignInsApiConfig } from "../lib/config.js";
import {
  listSignIns,
  SIGN_INS_TABLE_NAME,
} from "../lib/signInsStore.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import { signInsListRateLimiter } from "../lib/rateLimit.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import type { SignInDomain } from "../lib/signInsParser.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_LOOKBACK_DAYS = 7;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = signInsListRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  const outOfAreaOnly = parseBool(request.query.get("outOfAreaOnly")) ?? false;
  const caFailuresOnly = parseBool(request.query.get("caFailuresOnly")) ?? false;
  const limitParsed = parseLimit(request.query.get("limit"));
  if (limitParsed.kind === "error") return limitParsed.response;
  const limit = limitParsed.value;

  const config = resolveSignInsApiConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const signInsTable = getTableClient(tableCtx, SIGN_INS_TABLE_NAME);
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);

  try {
    const health = await readHealthRow(healthTable, config.tenantId, config.signInsSource);
    if (health?.status === "licence_required") {
      return {
        status: 200,
        jsonBody: {
          schemaVersion: 1,
          items: [],
          range: { requestedLimit: limit, returnedCount: 0, lookbackDays: DEFAULT_LOOKBACK_DAYS },
          health: {
            status: "licence_required",
            lastSuccessAt: null,
            consecutiveFailures: 0,
          },
        },
        headers: {
          "cache-control": "private, max-age=3600",
          vary: "Cookie, Authorization",
        },
      };
    }

    const since = new Date(
      Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000,
    ).toISOString();
    const rows = await listSignIns(signInsTable, config.tenantId, {
      outOfAreaOnly,
      createdSince: since,
    });
    const filtered = caFailuresOnly
      ? rows.filter((r) => r.conditionalAccessStatus === "failure")
      : rows.slice();
    filtered.sort((a, b) =>
      a.createdDateTime > b.createdDateTime
        ? -1
        : a.createdDateTime < b.createdDateTime
          ? 1
          : 0,
    );
    const items = filtered.slice(0, limit).map(projectRow);

    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        items,
        range: {
          requestedLimit: limit,
          returnedCount: items.length,
          totalRows: rows.length,
          lookbackDays: DEFAULT_LOOKBACK_DAYS,
          outOfAreaOnly,
          caFailuresOnly,
        },
        health: {
          status: health?.status ?? "awaiting_first_run",
          lastSuccessAt: health?.lastSuccessAt ?? null,
          consecutiveFailures: health?.consecutiveFailureCount ?? 0,
        },
      },
      headers: {
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`signIns.list.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "sign-ins store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

interface ProjectedSignIn {
  readonly id: string;
  readonly createdDateTime: string;
  readonly userId: string;
  readonly userPrincipalName: string;
  readonly userDisplayName: string;
  readonly appDisplayName: string;
  readonly ipAddress: string;
  readonly country: string;
  readonly city: string;
  readonly state: string;
  readonly conditionalAccessStatus: string;
  readonly outOfArea: boolean;
}

function projectRow(r: SignInDomain): ProjectedSignIn {
  return {
    id: r.id,
    createdDateTime: r.createdDateTime,
    userId: r.userId,
    userPrincipalName: r.userPrincipalName,
    userDisplayName: r.userDisplayName,
    appDisplayName: r.appDisplayName,
    ipAddress: r.ipAddress,
    country: r.country,
    city: r.city,
    state: r.state,
    conditionalAccessStatus: r.conditionalAccessStatus,
    outOfArea: r.outOfArea,
  };
}

function parseBool(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

type ParsedLimit =
  | { kind: "ok"; value: number }
  | { kind: "error"; response: HttpResponseInit };

function parseLimit(raw: string | null): ParsedLimit {
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

function rateLimited(
  context: InvocationContext,
  retryAfterMs: number,
): HttpResponseInit {
  return {
    status: 429,
    jsonBody: {
      error: {
        code: "rate_limited",
        message: "per-principal rate limit exceeded on /api/sign-ins/list",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}

app.http("getSignInsList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "sign-ins/list",
  handler,
});
