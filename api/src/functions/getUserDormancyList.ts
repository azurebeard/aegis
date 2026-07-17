// GET /api/user-dormancy/list (ADR-0034 §3.1).
//
// Returns the per-tenant user-dormancy rows projected to the SPA-safe shape.
// Filters: ?dormantOnly=true (default false). Sort: ?sort=lastSignIn|upn|displayName
// (default lastSignIn ascending = oldest first). Pagination: ?limit=N (default 50,
// max 200). Skip-token style cursor not needed at single-tenant volume; the SPA
// fetches the full page and renders a virtualised table client-side.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveUserDormancyApiConfig } from "../lib/config.js";
import {
  isDormant,
  lastSignInOf,
  listUserDormancyRows,
  USER_DORMANCY_TABLE_NAME,
} from "../lib/userDormancyStore.js";
import { readDormancyPolicy } from "../lib/tenantSettingsStore.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import { userDormancyListRateLimiter } from "../lib/rateLimit.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import type { UserDormancyDomain } from "../lib/userDormancyParser.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = userDormancyListRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  const dormantOnly = parseBoolParam(request.query.get("dormantOnly")) ?? false;
  const sort = parseSortParam(request.query.get("sort"));
  if (sort.kind === "error") return badRequest(context, sort.message);
  const limitParsed = parseLimit(request.query.get("limit"));
  if (limitParsed.kind === "error") return limitParsed.response;
  const limit = limitParsed.value;

  const config = resolveUserDormancyApiConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const dormancyTable = getTableClient(tableCtx, USER_DORMANCY_TABLE_NAME);
  const settingsTable = getTableClient(tableCtx, OPS_TABLES.TenantSettings);
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);

  try {
    const health = await readHealthRow(healthTable, config.tenantId, config.userDormancySource);
    if (health?.status === "licence_required") {
      return {
        status: 200,
        jsonBody: {
          schemaVersion: 1,
          items: [],
          range: { requestedLimit: limit, returnedCount: 0, dormantOnly },
          policy: null,
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

    const [policy, rows] = await Promise.all([
      readDormancyPolicy(settingsTable, config.tenantId),
      listUserDormancyRows(dormancyTable, config.tenantId),
    ]);

    const now = Date.now();
    const filtered = dormantOnly
      ? rows.filter((r) => isDormant(r, policy, now))
      : rows.slice();
    sortInPlace(filtered, sort.kind === "ok" ? sort.value : "lastSignIn");
    const items = filtered
      .slice(0, limit)
      .map((r) => projectRow(r, policy, policy.newUserThresholdDays, now));

    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        items,
        range: {
          requestedLimit: limit,
          returnedCount: items.length,
          totalRows: rows.length,
          dormantOnly,
        },
        policy: {
          thresholdDays: policy.thresholdDays,
          includeDisabledAccounts: policy.includeDisabledAccounts,
          excludeServiceAccountSuffixes: policy.excludeServiceAccountSuffixes,
          newUserThresholdDays: policy.newUserThresholdDays,
          source: policy.source,
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
    context.error(`userDormancy.list.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "user-dormancy store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

interface ProjectedRow {
  readonly id: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
  readonly accountEnabled: boolean;
  readonly lastSignIn: string | null;
  readonly lastInteractiveSignIn: string | null;
  readonly lastNonInteractiveSignIn: string | null;
  readonly ageDays: number | null;
  readonly isDormant: boolean;
  /** §10.55 — Microsoft Graph createdDateTime, ISO8601 UTC. Null when
   *  Graph omitted the field on this row (very old tenants pre-dating
   *  Microsoft's tracking) or on legacy rows pre-dating this schema. */
  readonly createdDateTime: string | null;
  /** True iff `now - createdDateTime <= newUserThresholdDays`. Computed
   *  server-side so the SPA renders without re-deriving the policy. */
  readonly isNewUser: boolean;
}

function projectRow(
  r: UserDormancyDomain,
  policy: Parameters<typeof isDormant>[1],
  newUserThresholdDays: number,
  now: number,
): ProjectedRow {
  const last = lastSignInOf(r);
  const lastMs = last !== null ? Date.parse(last) : null;
  const ageDays =
    lastMs !== null && Number.isFinite(lastMs)
      ? Math.floor((now - lastMs) / 86_400_000)
      : null;
  const createdMs = r.createdDateTime !== null ? Date.parse(r.createdDateTime) : null;
  const isNewUser =
    createdMs !== null &&
    Number.isFinite(createdMs) &&
    now - createdMs <= newUserThresholdDays * 86_400_000;
  return {
    id: r.id,
    userPrincipalName: r.userPrincipalName,
    displayName: r.displayName,
    accountEnabled: r.accountEnabled,
    lastSignIn: last,
    lastInteractiveSignIn: r.lastInteractiveSignIn,
    lastNonInteractiveSignIn: r.lastNonInteractiveSignIn,
    ageDays,
    isDormant: isDormant(r, policy, now),
    createdDateTime: r.createdDateTime,
    isNewUser,
  };
}

type SortKey = "lastSignIn" | "upn" | "displayName";
const SORT_KEYS: ReadonlyArray<SortKey> = ["lastSignIn", "upn", "displayName"];

function parseSortParam(
  raw: string | null,
):
  | { readonly kind: "ok"; readonly value: SortKey }
  | { readonly kind: "error"; readonly message: string } {
  if (raw === null || raw === "") return { kind: "ok", value: "lastSignIn" };
  for (const k of SORT_KEYS) {
    if (k === raw) return { kind: "ok", value: k };
  }
  return { kind: "error", message: `sort must be one of: ${SORT_KEYS.join(", ")}` };
}

function sortInPlace(rows: UserDormancyDomain[], by: SortKey): void {
  if (by === "upn") {
    rows.sort((a, b) => a.userPrincipalName.localeCompare(b.userPrincipalName));
    return;
  }
  if (by === "displayName") {
    rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return;
  }
  // lastSignIn — null first (never-signed-in = most-dormant), then ascending.
  rows.sort((a, b) => {
    const la = lastSignInOf(a);
    const lb = lastSignInOf(b);
    if (la === null && lb === null) return 0;
    if (la === null) return -1;
    if (lb === null) return 1;
    return la.localeCompare(lb);
  });
}

function parseBoolParam(raw: string | null): boolean | null {
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
        message: "per-principal rate limit exceeded on /api/user-dormancy/list",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
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

app.http("getUserDormancyList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "user-dormancy/list",
  handler,
});
