// GET /api/ransomware-intel/list — ADR-0037 Layer 4.
//
// Drilldown payload: blend of victim + press rows, sorted by chrono anchor
// desc (store-side). Simpler pagination than incidentsList — no opaque
// cursor + fingerprint replay-protection — because the filter set is
// static (country is config-driven, kind is the only optional knob) and
// the per-tenant row count is bounded by retentionDays × ~daily volume
// (UK typical: ~300 rows across the 90-day window).
//
// Auth: 401 on missing principal. No admin check.
//
// Query params:
//   `limit` (1–200, default 100). Clamped, not rejected, on out-of-range.
//   `kind`  (`victim` | `press`) — when set, narrows to one side.
//
// Privacy: ADR-0037 §"Privacy" — adversarial-input free-text fields
// (`activity`, `summary`) are surfaced verbatim from the store (which
// itself was control-stripped + length-capped at Layer 3b parse time).
// The SPA renders plain-text-only at Layer 5; no `dangerouslySetInnerHTML`
// callsite consumes these strings.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveRansomwareIntelApiConfig } from "../lib/config.js";
import {
  listAll,
  listPress,
  listVictims,
  RANSOMWARE_INTEL_TABLE_NAME,
  type RansomwareIntelRow,
} from "../lib/ransomwareIntelStore.js";
import { ransomwareIntelListRateLimiter } from "../lib/rateLimit.js";
import { getTableClient } from "../lib/tables.js";
import type {
  RansomwareIntelListItem,
  RansomwareIntelListResponse,
  RansomwareIntelRowKind,
} from "../lib/types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MIN_LIMIT = 1;

function readConfiguredCountry(env: NodeJS.ProcessEnv = process.env): string {
  return (env.THREAT_INTEL_COUNTRY ?? "GB").toUpperCase();
}

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = ransomwareIntelListRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  const limitInput = request.query.get("limit");
  const limit = clampLimit(limitInput);

  const kindInput = request.query.get("kind");
  if (kindInput !== null && kindInput !== "victim" && kindInput !== "press") {
    return badRequest(context, "kind must be 'victim' or 'press' when supplied");
  }
  const kind = (kindInput as RansomwareIntelRowKind | null) ?? null;

  const config = resolveRansomwareIntelApiConfig();
  const country = readConfiguredCountry();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const dataTable = getTableClient(tableCtx, RANSOMWARE_INTEL_TABLE_NAME);

  try {
    const rows = await fetchRows(dataTable, config.tenantId, country, kind);

    // hasMore based on whether the store returned more than the limit;
    // the store already sorts desc by chrono anchor (for listAll) or
    // ascending by IngestedAt for the per-kind helpers — re-sort here
    // when kind is set so the UI gets uniform chrono-desc ordering.
    const sorted = kind ? sortByChronoAnchorDesc([...rows]) : (rows as readonly RansomwareIntelRow[]);
    const hasMore = sorted.length > limit;
    const page = sorted.slice(0, limit).map(toListItem);

    const body: RansomwareIntelListResponse = {
      schemaVersion: 1,
      rows: page,
      page: {
        count: page.length,
        limit,
        hasMore,
      },
      country,
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
    context.error(
      `ransomwareIntel.list.error ${String((err as Error).message ?? err)}`,
    );
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "ransomware intel store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

async function fetchRows(
  table: ReturnType<typeof getTableClient>,
  tenantId: string,
  country: string,
  kind: RansomwareIntelRowKind | null,
): Promise<readonly RansomwareIntelRow[]> {
  if (kind === "victim") {
    const victims = await listVictims(table, tenantId, { country });
    return victims.map((v) => ({ kind: "victim" as const, ...v }));
  }
  if (kind === "press") {
    const press = await listPress(table, tenantId, { country });
    return press.map((p) => ({ kind: "press" as const, ...p }));
  }
  return listAll(table, tenantId, { country });
}

function sortByChronoAnchorDesc(rows: RansomwareIntelRow[]): RansomwareIntelRow[] {
  return rows.sort((a, b) => chronoAnchor(b).localeCompare(chronoAnchor(a)));
}

function chronoAnchor(row: RansomwareIntelRow): string {
  if (row.kind === "victim") {
    return row.discoveredDate || row.attackDate || row.ingestedAt;
  }
  return row.publishedAt || row.ingestedAt;
}

function toListItem(row: RansomwareIntelRow): RansomwareIntelListItem {
  if (row.kind === "victim") {
    return {
      kind: "victim",
      anchorDate: chronoAnchor(row),
      headline: row.victim,
      country: row.country,
      group: row.group,
      sector: row.sector,
      activity: row.activity,
      website: row.website,
      permalink: row.permalink,
      url: "",
      source: "",
      summary: "",
    };
  }
  return {
    kind: "press",
    anchorDate: chronoAnchor(row),
    headline: row.title,
    country: row.country,
    group: "",
    sector: "",
    activity: "",
    website: "",
    permalink: "",
    url: row.url,
    source: row.source,
    summary: row.summary,
  };
}

export function clampLimit(raw: string | null): number {
  if (raw === null || raw.length === 0) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  if (n < MIN_LIMIT) return MIN_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
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

function rateLimited(
  context: InvocationContext,
  retryAfterMs: number,
): HttpResponseInit {
  return {
    status: 429,
    jsonBody: {
      error: {
        code: "rate_limited",
        message: "per-principal rate limit exceeded on /api/ransomware-intel/list",
        correlationId: context.invocationId,
      },
    },
    headers: {
      "retry-after": Math.ceil(retryAfterMs / 1000).toString(),
      "cache-control": "no-store",
    },
  };
}

app.http("getRansomwareIntelList", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "ransomware-intel/list",
  handler,
});

export { handler as getRansomwareIntelListHandler };
