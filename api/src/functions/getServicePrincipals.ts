// GET /api/identities/service-principals (ADR-0034 Phase 8E).
//
// Read-only on-demand enumeration of `/v1.0/servicePrincipals`. No Timer,
// no persisted store — each authenticated SPA tab call walks one Graph
// page and returns the typed rows + pagination cursor. The 5-minute
// `cache-control: private` header per ADR-0034 §7 is the SPA-side
// damper; the server-side rate limiter is the second layer.
//
// Query params:
//   ?kind=application|managedIdentity|all  (default 'all')
//   ?search=<displayName-prefix>            (optional, max 64 chars)
//   ?top=N                                  (default 100, max 999)
//   ?nextLink=<base64-url-encoded Graph @odata.nextLink>
//                                          (round-trip the prior page's
//                                           cursor; mutually exclusive
//                                           with kind/search/top per OData)
//
// Reader-or-admin gated (matches the rest of /api/identities/* per
// ADR-0034 §7 IA — operators with Reader role need to see the SP roster
// for inventory hygiene). The deny-list at ADR-0013 §3 still rejects any
// `*.ReadWrite.*` Graph scope; this endpoint only ever issues GETs.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveIdentitiesApiConfig } from "../lib/config.js";
import {
  fetchServicePrincipalsPage,
  GraphFetchError,
} from "../lib/graphClient.js";
import { identitiesServicePrincipalsRateLimiter } from "../lib/rateLimit.js";
import {
  parseServicePrincipalsPage,
  type ServicePrincipalKind,
  type ServicePrincipalRow,
} from "../lib/servicePrincipalParser.js";

const MAX_TOP = 999;
const DEFAULT_TOP = 100;
const MAX_SEARCH_LEN = 64;
// Graph `startswith` accepts a-z, A-Z, 0-9, space, dot, hyphen, underscore.
// Reject anything else so we don't have to OData-escape unknown punctuation.
const SEARCH_RE = /^[\p{L}\p{N} ._-]+$/u;
// Cursor opaqueness: the FE round-trips `nextLink` verbatim. We require it
// to be an `https://graph.microsoft.com/...` URL so the handler can't be
// tricked into proxying an attacker-controlled URL. Caller can never see
// the unencoded cursor — it sits in the JSON body.
const NEXTLINK_HOST_RE = /^https:\/\/(?:[a-z0-9-]+\.)*graph\.microsoft\.com\//i;

interface KindFilter {
  readonly kind: "application" | "managedIdentity" | "all";
}

interface ParsedQuery {
  readonly kindFilter: KindFilter;
  readonly search: string | null;
  readonly top: number;
  readonly nextLink: string | null;
}

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = identitiesServicePrincipalsRateLimiter.check(principal.userId);
  if (!rate.allowed) return rateLimited(context, rate.retryAfterMs);

  const parsed = parseQuery(request);
  if (parsed.kind === "error") return badRequest(context, parsed.message);
  const q = parsed.value;

  const config = resolveIdentitiesApiConfig();
  const graphFilter = buildGraphFilter(q.kindFilter, q.search);
  try {
    const page = await fetchServicePrincipalsPage(
      {
        graphBaseUrl: config.graphBaseUrl,
        timeoutMs: config.graphApiTimeoutMs,
        managedIdentityClientId: config.ingestMiClientId,
        // On-demand SP endpoint is not lease-gated (no Timer / no IngestHealth
        // ETag). Clamp the retry-after to the same envelope as the request
        // timeout so a Graph 503 on a transient hiccup does not stall the
        // SPA's tab fetch beyond the user's visible patience window.
        leaseWindowMs: config.graphApiTimeoutMs,
      },
      q.nextLink !== null
        ? { nextLink: q.nextLink }
        : { pageSize: q.top, ...(graphFilter !== null ? { filter: graphFilter } : {}) },
      context,
    );
    const nowIso = new Date().toISOString();
    const batch = parseServicePrincipalsPage(page.rawPage, nowIso);
    // When the operator selected ?kind=application, drop ManagedIdentity rows
    // a server-side `$filter` couldn't fully exclude (defence-in-depth — the
    // Graph query already filters but a stale cached page from `nextLink`
    // would carry the prior filter only).
    const items = filterByKind(batch.rows, q.kindFilter);
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        items,
        retrievedAt: nowIso,
        nextLink: page.nextLink,
        skippedMalformed: batch.skippedMalformed,
      },
      headers: {
        // Per ADR-0034 §7 — 5-minute SPA-side cache. `private` so a shared
        // proxy (e.g. SWA edge) cannot pool responses across operators.
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    if (err instanceof GraphFetchError) {
      context.warn(
        `identities.servicePrincipals.graphError ${err.kind} ${err.message}`,
      );
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "dependency_unavailable",
            message: "service-principal enumeration is temporarily unavailable",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    context.error(
      `identities.servicePrincipals.error ${String((err as Error).message ?? err)}`,
    );
    return {
      status: 500,
      jsonBody: {
        error: {
          code: "internal_error",
          message: "service-principal enumeration failed",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

function filterByKind(
  rows: readonly ServicePrincipalRow[],
  kind: KindFilter,
): readonly ServicePrincipalRow[] {
  if (kind.kind === "all") return rows;
  // Phase 8E IA: "Application" tab + "Agents" tab both pull from Graph
  // type "Application". The SPA does the agent-vs-application split via
  // `kind === "agent"` (set when the future `agentSubtype` field is non-
  // null); both the Application and Agents tabs request `kind=application`
  // here and discriminate client-side. ManagedIdentity is its own request.
  const targets: ReadonlyArray<ServicePrincipalKind> =
    kind.kind === "application" ? ["application", "agent"] : ["managedIdentity"];
  return rows.filter((r) => targets.includes(r.kind));
}

function buildGraphFilter(kind: KindFilter, search: string | null): string | null {
  const clauses: string[] = [];
  if (kind.kind === "application") {
    clauses.push("servicePrincipalType eq 'Application'");
  } else if (kind.kind === "managedIdentity") {
    clauses.push("servicePrincipalType eq 'ManagedIdentity'");
  }
  if (search !== null) {
    // Single-quote escape per OData v4 §5.1.1.6 — replace `'` with `''`.
    const escaped = search.replace(/'/g, "''");
    clauses.push(`startswith(displayName,'${escaped}')`);
  }
  return clauses.length === 0 ? null : clauses.join(" and ");
}

type ParsedResult =
  | { readonly kind: "ok"; readonly value: ParsedQuery }
  | { readonly kind: "error"; readonly message: string };

function parseQuery(request: HttpRequest): ParsedResult {
  // nextLink takes precedence — round-tripping a cursor MUST NOT be
  // perturbed by other params per OData v4 §11.2.5.7.
  const nextLinkRaw = request.query.get("nextLink");
  if (nextLinkRaw !== null && nextLinkRaw !== "") {
    if (!NEXTLINK_HOST_RE.test(nextLinkRaw)) {
      return { kind: "error", message: "nextLink must be a graph.microsoft.com URL" };
    }
    return {
      kind: "ok",
      value: { kindFilter: { kind: "all" }, search: null, top: DEFAULT_TOP, nextLink: nextLinkRaw },
    };
  }
  const kindRaw = (request.query.get("kind") ?? "all").toLowerCase();
  let kindFilter: KindFilter;
  if (kindRaw === "all") kindFilter = { kind: "all" };
  else if (kindRaw === "application") kindFilter = { kind: "application" };
  else if (kindRaw === "managedidentity") kindFilter = { kind: "managedIdentity" };
  else return { kind: "error", message: "kind must be one of: all, application, managedIdentity" };

  const searchRaw = request.query.get("search");
  let search: string | null = null;
  if (searchRaw !== null && searchRaw !== "") {
    if (searchRaw.length > MAX_SEARCH_LEN) {
      return {
        kind: "error",
        message: `search must be ≤ ${MAX_SEARCH_LEN} characters`,
      };
    }
    if (!SEARCH_RE.test(searchRaw)) {
      return { kind: "error", message: "search contains unsupported characters" };
    }
    search = searchRaw;
  }

  const topRaw = request.query.get("top");
  let top = DEFAULT_TOP;
  if (topRaw !== null && topRaw !== "") {
    const n = Number.parseInt(topRaw.trim(), 10);
    if (!Number.isFinite(n) || String(n) !== topRaw.trim() || n < 1 || n > MAX_TOP) {
      return {
        kind: "error",
        message: `top must be an integer between 1 and ${MAX_TOP}`,
      };
    }
    top = n;
  }

  return { kind: "ok", value: { kindFilter, search, top, nextLink: null } };
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
        message: "per-principal rate limit exceeded on /api/identities/service-principals",
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

app.http("getServicePrincipals", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "identities/service-principals",
  handler,
});

// Exported for unit tests.
export const __test__ = { parseQuery, buildGraphFilter, filterByKind };
