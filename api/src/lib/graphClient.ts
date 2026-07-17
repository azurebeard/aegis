// Microsoft Graph client + retry policy for the ingest path (ADR-0010 §5, ADR-0011 §5).
//
// - Managed identity only (no client secret). `INGEST_MI_CLIENT_ID` selects the
//   specific user-assigned MI to use; the caller should pass this explicitly so
//   that a misconfigured env var fails loud rather than silently picking a
//   neighbouring MI.
// - Retry with full-jitter exponential backoff, up to 3 attempts.
// - `Retry-After` honoured but clamped to the lower of
//  (remaining singleton window − 5 s) and 30 s.
// - 401/403/400 are terminal non-retry (token/permission/malformed — retrying
//   does not help; fail fast).
//
// The module only exposes `fetchLatestSecureScore` for step 3; future verticals
// extend with additional endpoints while reusing the same retry primitive.

import { DefaultAzureCredential } from "@azure/identity";
import type { InvocationContext } from "@azure/functions";
import type {
  SecureScore,
  SecureScoreControlProfile,
} from "@microsoft/microsoft-graph-types";
import { emitAievent } from "./aievent.js";

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
const GRAPH_URL_PREFIX = "https://graph.microsoft.com/";

// SSRF defence (CWE-918): every outbound URL constructed by this module must
// live under graph.microsoft.com. Callers construct URLs from the injected
// `graphBaseUrl` option plus internal path templates — the assertion is
// defence in depth against a config-misconfigure or future refactor that
// accepts a caller-supplied base URL.
function assertGraphUrl(url: string): void {
  if (!url.startsWith(GRAPH_URL_PREFIX)) {
    throw new Error(
      `graphClient: refusing to fetch URL outside Microsoft Graph (got prefix ${url.slice(0, 32)})`,
    );
  }
}

const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const RETRY_AFTER_HARD_CAP_MS = 30_000;

export interface GraphFetchOptions {
  readonly managedIdentityClientId: string;
  readonly graphBaseUrl: string; // e.g. https://graph.microsoft.com/v1.0
  readonly leaseWindowMs: number; // singleton lease remaining — clamps Retry-After
  readonly timeoutMs?: number;
}

export interface GraphFetchResult<T> {
  readonly data: T;
  readonly attempts: number;
  readonly finalHttpStatus: number;
  readonly retryEvents: readonly RetryEvent[];
}

export interface RetryEvent {
  readonly attempt: number;
  readonly statusCode: number;
  readonly retryAfterHeader: string | null;
  readonly retryAfterClamped: boolean;
  readonly retryAfterAppliedMs: number;
  readonly backoffMs: number;
}

export class GraphFetchError extends Error {
  readonly kind: "timeout" | "throttle" | "4xx" | "5xx" | "network" | "internal";
  readonly status: number | null;
  readonly attempts: number;
  constructor(
    kind: GraphFetchError["kind"],
    message: string,
    status: number | null,
    attempts: number,
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.attempts = attempts;
    this.name = "GraphFetchError";
  }
}

/**
 * Fetch the single most recent Secure Score snapshot (`$top=1`).
 * Returns `null` when Graph legitimately has no Secure Score for the tenant
 * (status 200 with empty `value` — new tenant before first nightly compute).
 */
export async function fetchLatestSecureScore(
  options: GraphFetchOptions,
  context: InvocationContext,
): Promise<GraphFetchResult<SecureScore | null>> {
  const url = `${options.graphBaseUrl.replace(/\/$/, "")}/security/secureScores?$top=1`;
  const raw = await graphGetJsonWithRetry<{ value?: SecureScore[] }>(url, options, context);
  const value = raw.data.value ?? [];
  return {
    data: value.length > 0 ? (value[0] ?? null) : null,
    attempts: raw.attempts,
    finalHttpStatus: raw.finalHttpStatus,
    retryEvents: raw.retryEvents,
  };
}

/**
 * Fetch the full `secureScoreControlProfiles` catalogue. Microsoft's
 * Graph endpoint returns one entry per control: title, maxScore, tier,
 * remediation, actionUrl, etc. Per-tenant metadata; refreshed daily by
 * the Timer.
 *
 * The endpoint paginates via `@odata.nextLink`; in practice the catalogue
 * is ~100-300 controls so a single page covers it, but follow the link
 * defensively. Caps at 1000 entries to bound memory if Microsoft ever
 * inflates the catalogue without notice.
 */
export async function fetchSecureScoreControlProfiles(
  options: GraphFetchOptions,
  context: InvocationContext,
): Promise<GraphFetchResult<readonly SecureScoreControlProfile[]>> {
  const baseUrl = options.graphBaseUrl.replace(/\/$/, "");
  let url: string | null = `${baseUrl}/security/secureScoreControlProfiles?$top=200`;
  const out: SecureScoreControlProfile[] = [];
  let attempts = 0;
  let finalHttpStatus = 0;
  const retryEvents: RetryEvent[] = [];
  let pageGuard = 0;
  while (url && pageGuard < 10) {
    pageGuard++;
    const raw: GraphFetchResult<{
      value?: SecureScoreControlProfile[];
      "@odata.nextLink"?: string;
    }> = await graphGetJsonWithRetry(url, options, context);
    attempts += raw.attempts;
    finalHttpStatus = raw.finalHttpStatus;
    retryEvents.push(...raw.retryEvents);
    const value = raw.data.value ?? [];
    out.push(...value);
    if (out.length >= 1000) break; // hard upper bound (defence)
    const next: unknown = raw.data["@odata.nextLink"];
    url = typeof next === "string" && next.length > 0 ? next : null;
  }
  return {
    data: out,
    attempts,
    finalHttpStatus,
    retryEvents,
  };
}

/**
 * Fetch up to `topN` snapshots (for backfill). Caller must decide how to
 * dedup against existing rows.
 */
export async function fetchRecentSecureScores(
  options: GraphFetchOptions,
  topN: number,
  context: InvocationContext,
): Promise<GraphFetchResult<readonly SecureScore[]>> {
  const bounded = Math.max(1, Math.min(topN, 90));
  const url = `${options.graphBaseUrl.replace(/\/$/, "")}/security/secureScores?$top=${bounded}`;
  const raw = await graphGetJsonWithRetry<{ value?: SecureScore[] }>(url, options, context);
  return {
    data: raw.data.value ?? [],
    attempts: raw.attempts,
    finalHttpStatus: raw.finalHttpStatus,
    retryEvents: raw.retryEvents,
  };
}

// --- Incidents (ADR-0014 §2) -------------------------------------------------

/**
 * A single incident's shape, as we consume it from Graph. Typed loosely here
 * because `@microsoft/microsoft-graph-types` hasn't caught up with the full
 * `security.incident` resource; the parser (`incidentsParser.ts`) narrows.
 */
export interface RawGraphIncident {
  readonly id?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly summary?: string;
  readonly status?: string;
  readonly severity?: string;
  readonly classification?: string;
  readonly determination?: string;
  readonly priorityScore?: number | null;
  readonly assignedTo?: string | null;
  readonly createdDateTime?: string;
  readonly lastUpdateDateTime?: string;
  readonly incidentWebUrl?: string;
  readonly redirectIncidentId?: string | null;
  readonly resolvingComment?: string | null;
  readonly lastModifiedBy?: string | null;
  readonly customTags?: readonly string[];
  readonly systemTags?: readonly string[];
  readonly comments?: readonly unknown[];
  readonly alerts?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface IncidentsPageFilter {
  /** Inclusive-lower bound: `lastUpdateDateTime gt <cursor>`. ISO8601 UTC. */
  readonly greaterThan?: string;
  /** Exclusive-upper bound: `lastUpdateDateTime lt <to>`. Used for backfill. */
  readonly lessThan?: string;
  /** $top per page. Default 50. Max 1000 per Graph's own limits. */
  readonly pageSize?: number;
  /** If true, include `$expand=alerts` (default true per ADR-0013/0014). */
  readonly expandAlerts?: boolean;
}

export interface IncidentsPagedResult {
  readonly incidents: readonly RawGraphIncident[];
  readonly pagesFetched: number;
  readonly attempts: number;
  readonly retryEvents: readonly RetryEvent[];
}

/**
 * Iterate `/security/incidents` using `$filter=lastUpdateDateTime gt ...` +
 * `$orderby=lastUpdateDateTime asc`, following `@odata.nextLink` until
 * exhausted. Never writes; pure read.
 *
 * The entire page walk uses one retry policy per page (same as
 * `fetchLatestSecureScore`). A mid-walk failure throws — the caller leaves
 * `LastCursor` unchanged and the next run re-reads from the same position
 * (ADR-0014 §2 "Pagination — idempotent overwrites handle duplicates").
 */
export async function fetchIncidentsPaged(
  options: GraphFetchOptions,
  filter: IncidentsPageFilter,
  context: InvocationContext,
): Promise<IncidentsPagedResult> {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 1000);
  const expand = filter.expandAlerts !== false;

  const base = options.graphBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  const clauses: string[] = [];
  if (filter.greaterThan) {
    clauses.push(`lastUpdateDateTime gt ${filter.greaterThan}`);
  }
  if (filter.lessThan) {
    clauses.push(`lastUpdateDateTime lt ${filter.lessThan}`);
  }
  if (clauses.length > 0) params.set("$filter", clauses.join(" and "));
  params.set("$orderby", "lastUpdateDateTime asc");
  params.set("$top", String(pageSize));
  if (expand) params.set("$expand", "alerts");

  const incidents: RawGraphIncident[] = [];
  const retries: RetryEvent[] = [];
  let totalAttempts = 0;
  let pagesFetched = 0;
  let url: string = `${base}/security/incidents?${params.toString()}`;
  for (;;) {
    const res: GraphFetchResult<{
      value?: RawGraphIncident[];
      "@odata.nextLink"?: string;
    }> = await graphGetJsonWithRetry<{
      value?: RawGraphIncident[];
      "@odata.nextLink"?: string;
    }>(url, options, context);
    for (const ev of res.retryEvents) retries.push(ev);
    totalAttempts += res.attempts;
    pagesFetched += 1;
    const page = res.data.value ?? [];
    for (const inc of page) incidents.push(inc);
    const next = res.data["@odata.nextLink"];
    if (!next) break;
    url = next;
  }

  return { incidents, pagesFetched, attempts: totalAttempts, retryEvents: retries };
}

// --- Identity Protection (ADR-0023 §8 + §9) ---------------------------------

/**
 * ADR-0023 §8 — path-segment match for IdP endpoints. IdP endpoints do NOT
 * return `Retry-After` on 429; the retry loop must substitute an
 * exponential-backoff fallback keyed on this match.
 *
 * match on the
 * endpoint path segment, NOT on a `/v1.0/` version prefix. Graph throttling
 * buckets are version-agnostic — a future `/beta/identityProtection/…`
 * deployment must still pick up the IdP backoff schedule. See the
 * `RISKY_USERS_PATH` invariant (below) for the paired coupling.
 */
const IDP_ENDPOINT_SEGMENTS: readonly string[] = [
  "/identityProtection/",
  "/riskDetections",
  "/namedLocations",
];

export function shouldUseExponentialBackoff(url: string): boolean {
  return IDP_ENDPOINT_SEGMENTS.some((p) => url.includes(p));
}

/**
 * IdP exponential backoff schedule — ADR-0023 §8: 1s, 2s, 4s, 8s jittered ±25%.
 * `computeBackoffMs` above uses 2s base with full-jitter; for IdP we use a
 * tighter 1s base to stay inside the 3-attempt ~14s budget while respecting
 * the shared 1 req/s bucket.
 */
export function computeIdpBackoffMs(attempt: number): number {
  const base = Math.min(1_000 * Math.pow(2, attempt - 1), 8_000);
  const jitter = (Math.random() * 0.5 - 0.25) * base; // ±25%
  return Math.max(0, Math.floor(base + jitter));
}

export interface RawGraphRiskyUser {
  readonly id?: string;
  readonly userPrincipalName?: string;
  readonly userDisplayName?: string;
  readonly riskLevel?: string;
  readonly riskState?: string;
  readonly riskDetail?: string;
  readonly riskLastUpdatedDateTime?: string;
  readonly isDeleted?: boolean;
  readonly isProcessing?: boolean;
  readonly [key: string]: unknown;
}

export interface RiskyUsersPageFilter {
  /** `$filter=riskLastUpdatedDateTime ge <value>`. ISO8601 UTC. */
  readonly greaterThanOrEqual?: string;
  /** `$top` per page. Default 500 (Graph's max for this endpoint). */
  readonly pageSize?: number;
}

export interface RiskyUsersPagedResult {
  readonly rawPages: readonly unknown[]; // untyped envelopes — parser consumes
  readonly pagesFetched: number;
  readonly attempts: number;
  readonly retryEvents: readonly RetryEvent[];
}

// Hardcoded v1.0 per ADR-0023 §9 — beta exposes /riskyUsers without the
// identityProtection/ prefix; using beta in v1 is an ADR-breaking change.
const RISKY_USERS_PATH = "/identityProtection/riskyUsers";

/**
 * Iterate `/v1.0/identityProtection/riskyUsers` sequentially with the ADR-0023
 * coordinate-not-parallelise invariant. Every request carries the
 * `Prefer: include-unknown-enum-members` header (ADR-0023 §9). Returns raw
 * envelopes for the parser to narrow.
 */
export async function fetchRiskyUsersPaged(
  options: GraphFetchOptions,
  filter: RiskyUsersPageFilter,
  context: InvocationContext,
): Promise<RiskyUsersPagedResult> {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 500, 1), 500);
  const base = options.graphBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  if (filter.greaterThanOrEqual) {
    params.set("$filter", `riskLastUpdatedDateTime ge ${filter.greaterThanOrEqual}`);
  }
  params.set("$top", String(pageSize));

  const rawPages: unknown[] = [];
  const retries: RetryEvent[] = [];
  let totalAttempts = 0;
  let pagesFetched = 0;
  let url: string = `${base}${RISKY_USERS_PATH}?${params.toString()}`;
  for (;;) {
    const res = await graphGetJsonWithRetry<{
      value?: readonly unknown[];
      "@odata.nextLink"?: string;
    }>(url, options, context, { includeUnknownEnumMembers: true });
    for (const ev of res.retryEvents) retries.push(ev);
    totalAttempts += res.attempts;
    pagesFetched += 1;
    rawPages.push(res.data);
    const next = typeof res.data["@odata.nextLink"] === "string"
      ? res.data["@odata.nextLink"]
      : undefined;
    if (!next) break;
    // ADR-0023 §8 coordinate-not-parallelise: ≥1s gap between page fetches.
    await sleep(1_000);
    url = next;
  }
  return { rawPages, pagesFetched, attempts: totalAttempts, retryEvents: retries };
}

/**
 * ADR-0023 §7 licence probe — read tenant-enabled service plans to confirm
 * Entra ID P2. Also returns `id` + `displayName` so callers can cache the
 * tenant name (used by the brief-agent prompt builder — agent MI has no
 * Graph scopes so the name must be resolved ingest-side, ADR-0017 §3).
 * Uses the directory-read bucket, not the IdP throttle bucket.
 */
export interface OrganizationAssignedPlansResponse {
  readonly value?: readonly {
    readonly id?: string;
    readonly displayName?: string;
    readonly assignedPlans?: readonly {
      readonly servicePlanId?: string;
      readonly service?: string;
      readonly capabilityStatus?: string;
      readonly assignedDateTime?: string;
    }[];
  }[];
}

export const ENTRA_ID_P2_SERVICE_PLAN_ID = "eec0eb4f-6444-4f95-aba0-50c24d67f998";

export async function fetchOrganizationAssignedPlans(
  options: GraphFetchOptions,
  context: InvocationContext,
): Promise<GraphFetchResult<OrganizationAssignedPlansResponse>> {
  const url = `${options.graphBaseUrl.replace(/\/$/, "")}/organization?$select=id,displayName,assignedPlans`;
  return graphGetJsonWithRetry<OrganizationAssignedPlansResponse>(url, options, context);
}

// --- Sign-ins (ADR-0034 §3.2) -------------------------------------

export interface SignInsPageFilter {
  /** Cursor — `createdDateTime gt {iso}` per ADR-0014 cursor pattern. */
  readonly greaterThanOrEqual: string;
  /** `$top` per page. Default 500 (Graph max for /auditLogs/signIns). */
  readonly pageSize?: number;
}

export interface SignInsPagedResult {
  readonly rawPages: readonly unknown[];
  readonly pagesFetched: number;
  readonly attempts: number;
  readonly retryEvents: readonly RetryEvent[];
}

const SIGN_INS_PATH = "/auditLogs/signIns";

/**
 * Iterate `/v1.0/auditLogs/signIns?$filter=createdDateTime gt {cursor}` —
 * ascending order, paged via `@odata.nextLink`. Same coordinate-not-
 * parallelise invariant as `/identityProtection/riskyUsers` — 1s gap
 * between pages defends against the Reporting throttle bucket.
 *
 * Requires Entra ID P1+ at the tenant level — without P1 the endpoint
 * returns 403 with "premium licence required". The orchestrator's
 * licence-detection path picks up the 403 and sticky-sets
 * `IngestHealth.Status = "licence_required"` per ADR-0034 §6.
 */
export async function fetchSignInsPaged(
  options: GraphFetchOptions,
  filter: SignInsPageFilter,
  context: InvocationContext,
): Promise<SignInsPagedResult> {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 500, 1), 500);
  const base = options.graphBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("$filter", `createdDateTime gt ${filter.greaterThanOrEqual}`);
  params.set("$orderby", "createdDateTime asc");
  params.set("$top", String(pageSize));

  const rawPages: unknown[] = [];
  const retries: RetryEvent[] = [];
  let totalAttempts = 0;
  let pagesFetched = 0;
  let url: string = `${base}${SIGN_INS_PATH}?${params.toString()}`;
  for (;;) {
    const res = await graphGetJsonWithRetry<{
      value?: readonly unknown[];
      "@odata.nextLink"?: string;
    }>(url, options, context);
    for (const ev of res.retryEvents) retries.push(ev);
    totalAttempts += res.attempts;
    pagesFetched += 1;
    rawPages.push(res.data);
    const next =
      typeof res.data["@odata.nextLink"] === "string"
        ? res.data["@odata.nextLink"]
        : undefined;
    if (!next) break;
    await sleep(1_000);
    url = next;
  }
  return { rawPages, pagesFetched, attempts: totalAttempts, retryEvents: retries };
}

// --- Users for dormancy (ADR-0034 §3.1) ----------------------------

export interface UsersPageFilter {
  /** `$top` per page. Default 999 (Graph's max for /users). */
  readonly pageSize?: number;
}

export interface UsersPagedResult {
  readonly rawPages: readonly unknown[];
  readonly pagesFetched: number;
  readonly attempts: number;
  readonly retryEvents: readonly RetryEvent[];
}

const USERS_PATH = "/users";
// $select keeps the response compact — signInActivity is the operationally
// relevant field; id/displayName/userPrincipalName/accountEnabled are needed
// to render the dormant-account drilldown rows.
const USERS_SELECT =
  "id,displayName,userPrincipalName,accountEnabled,signInActivity,createdDateTime";

/**
 * Iterate `/v1.0/users?$select=id,displayName,...,signInActivity` sequentially
 * with the same coordinate-not-parallelise invariant as ADR-0023's
 * `/identityProtection/riskyUsers`. The `signInActivity` property requires
 * Entra ID P1+; on Free / P2-only tenants the property comes back null on
 * every row — caller surfaces sticky `licence_required` IngestHealth status
 * (ADR-0034 §6).
 */
export async function fetchUsersPaged(
  options: GraphFetchOptions,
  filter: UsersPageFilter,
  context: InvocationContext,
): Promise<UsersPagedResult> {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 999, 1), 999);
  const base = options.graphBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("$select", USERS_SELECT);
  params.set("$top", String(pageSize));

  const rawPages: unknown[] = [];
  const retries: RetryEvent[] = [];
  let totalAttempts = 0;
  let pagesFetched = 0;
  let url: string = `${base}${USERS_PATH}?${params.toString()}`;
  for (;;) {
    const res = await graphGetJsonWithRetry<{
      value?: readonly unknown[];
      "@odata.nextLink"?: string;
    }>(url, options, context);
    for (const ev of res.retryEvents) retries.push(ev);
    totalAttempts += res.attempts;
    pagesFetched += 1;
    rawPages.push(res.data);
    const next =
      typeof res.data["@odata.nextLink"] === "string"
        ? res.data["@odata.nextLink"]
        : undefined;
    if (!next) break;
    // 1s gap between pages — defence-in-depth against Graph throttling on
    // a tenant with thousands of users.
    await sleep(1_000);
    url = next;
  }
  return { rawPages, pagesFetched, attempts: totalAttempts, retryEvents: retries };
}

/**
 * Extract the primary organisation's `displayName` + `id` from the probe
 * response. Graph's `/organization` endpoint is single-tenant-scoped — the
 * array has at most one entry for an MI authenticated into a single tenant.
 * Returns `null` when either field is missing so callers can fall back to
 * the tenant GUID.
 */
export function extractOrganizationDirectory(
  response: OrganizationAssignedPlansResponse,
): { id: string; displayName: string } | null {
  const org = (response.value ?? [])[0];
  if (!org) return null;
  const id = typeof org.id === "string" ? org.id.trim() : "";
  const displayName = typeof org.displayName === "string" ? org.displayName.trim() : "";
  if (!id || !displayName) return null;
  return { id, displayName };
}

/**
 * Scan a `/v1.0/organization?$select=assignedPlans` response for the P2 plan.
 * Returns `true` only when the plan is present AND `capabilityStatus` is
 * `"Enabled"` — any other combination is treated as "not present".
 */
export function hasEntraIdP2(
  response: OrganizationAssignedPlansResponse,
): boolean {
  const orgs = response.value ?? [];
  for (const org of orgs) {
    const plans = org.assignedPlans ?? [];
    for (const p of plans) {
      if (
        typeof p.servicePlanId === "string" &&
        p.servicePlanId.toLowerCase() === ENTRA_ID_P2_SERVICE_PLAN_ID &&
        p.capabilityStatus === "Enabled"
      ) {
        return true;
      }
    }
  }
  return false;
}

// --- Conditional Access policies (ADR-0034 §3.3) ------------------

export interface ConditionalAccessPagedResult {
  readonly rawPages: readonly unknown[];
  readonly pagesFetched: number;
  readonly attempts: number;
  readonly retryEvents: readonly RetryEvent[];
}

const CA_POLICIES_PATH = "/identity/conditionalAccess/policies";
// $select keeps the response surface predictable + bounds the per-row size.
// `conditions` / `grantControls` / `sessionControls` carry the bulk of the
// payload (operator-defined IP lists can run kilobytes); the parser bounds
// each at the row-level (16 KB / 16 KB / 4 KB per ADR-0034 §3.3).
const CA_POLICIES_SELECT =
  "id,displayName,state,createdDateTime,modifiedDateTime,conditions,grantControls,sessionControls";

/**
 * Walk `/v1.0/identity/conditionalAccess/policies` to completion. Tenants
 * typically have 5–20 policies so the first page covers the corpus; the
 * loop is defensive against a future Microsoft pagination policy change.
 * Sequential walk per ADR-0023 single-tenant invariant.
 *
 * Empty `value: []` is a legitimate "no policies configured" state on Free
 * tenants and on tenants that haven't enabled CA — the orchestrator does
 * NOT promote that to `licence_required` (per ADR-0034 §6).
 */
export async function fetchConditionalAccessPolicies(
  options: GraphFetchOptions,
  context: InvocationContext,
): Promise<ConditionalAccessPagedResult> {
  const base = options.graphBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("$select", CA_POLICIES_SELECT);
  // The `/conditionalAccess/policies` endpoint defaults to a server-decided
  // page size; explicit $top is unnecessary at typical corpus sizes but
  // pinning it caps the response payload predictably.
  params.set("$top", "100");

  const rawPages: unknown[] = [];
  const retries: RetryEvent[] = [];
  let totalAttempts = 0;
  let pagesFetched = 0;
  let url: string = `${base}${CA_POLICIES_PATH}?${params.toString()}`;
  for (;;) {
    const res = await graphGetJsonWithRetry<{
      value?: readonly unknown[];
      "@odata.nextLink"?: string;
    }>(url, options, context);
    for (const ev of res.retryEvents) retries.push(ev);
    totalAttempts += res.attempts;
    pagesFetched += 1;
    rawPages.push(res.data);
    const next =
      typeof res.data["@odata.nextLink"] === "string"
        ? res.data["@odata.nextLink"]
        : undefined;
    if (!next) break;
    await sleep(1_000);
    url = next;
  }
  return { rawPages, pagesFetched, attempts: totalAttempts, retryEvents: retries };
}

// --- Service principals (ADR-0034 Phase 8E /identities) ---------------------

/**
 * Filter shape for a SINGLE-page fetch of `/v1.0/servicePrincipals`.
 * Phase 8E is on-demand (operator-driven, no Timer, no persisted store)
 * so the caller controls pagination explicitly: pass `nextLink` from the
 * previous response to fetch the next page, or omit it for the first page.
 */
export interface ServicePrincipalsPageFilter {
  /** `$top` per page. Default 100, max 999 (Graph hard cap on this resource). */
  readonly pageSize?: number;
  /**
   * Optional Graph `$filter` expression. Caller is responsible for OData
   * escaping. Phase 8E uses `servicePrincipalType eq 'Application'` /
   * `'ManagedIdentity'` and `startswith(displayName, '...')`. Supplying a
   * filter clears the `$select` short-form to avoid the well-known Graph
   * 400 when `$filter` interacts with certain `$select` shapes.
   */
  readonly filter?: string;
  /**
   * `@odata.nextLink` URL from a prior page. When set, the function ignores
   * pageSize/filter and follows the URL verbatim — Graph builds the
   * pagination cursor and we MUST round-trip it unmodified.
   */
  readonly nextLink?: string;
}

export interface ServicePrincipalsPageResult {
  readonly rawPage: unknown;
  readonly attempts: number;
  readonly retryEvents: readonly RetryEvent[];
  /** Forward this back as `filter.nextLink` to fetch the next page. */
  readonly nextLink: string | null;
}

const SERVICE_PRINCIPALS_PATH = "/servicePrincipals";
// $select keeps the response compact for the page render. We pull
// servicePrincipalType so the SPA can tab-filter without a follow-up call;
// signInAudience surfaces multi-tenant exposure; tags carry workload-identity
// markers in Microsoft's roadmap. `keyCredentials` + `passwordCredentials`
// are pulled in their full shape so the SPA can render expiry-hygiene
// flags without a per-SP follow-up call.
const SERVICE_PRINCIPALS_SELECT =
  "id,appId,displayName,servicePrincipalType,signInAudience,accountEnabled,appOwnerOrganizationId,createdDateTime,tags,keyCredentials,passwordCredentials";

/**
 * Fetch ONE page of `/v1.0/servicePrincipals` with the same retry/backoff
 * envelope as the other Graph fetchers. Returns the raw page + the next-page
 * cursor (or null when the page is the last). The on-demand `/api/identities/
 * service-principals` handler returns this 1:1 so the SPA can render +
 * paginate without the FA holding a multi-page accumulator.
 */
export async function fetchServicePrincipalsPage(
  options: GraphFetchOptions,
  filter: ServicePrincipalsPageFilter,
  context: InvocationContext,
): Promise<ServicePrincipalsPageResult> {
  let url: string;
  if (filter.nextLink && filter.nextLink.length > 0) {
    // Round-trip Graph's pagination cursor unmodified per OData v4 §11.2.5.7.
    url = filter.nextLink;
  } else {
    const pageSize = Math.min(Math.max(filter.pageSize ?? 100, 1), 999);
    const base = options.graphBaseUrl.replace(/\/$/, "");
    const params = new URLSearchParams();
    params.set("$select", SERVICE_PRINCIPALS_SELECT);
    params.set("$top", String(pageSize));
    if (filter.filter && filter.filter.length > 0) {
      params.set("$filter", filter.filter);
    }
    url = `${base}${SERVICE_PRINCIPALS_PATH}?${params.toString()}`;
  }

  const res = await graphGetJsonWithRetry<{
    value?: readonly unknown[];
    "@odata.nextLink"?: string;
  }>(url, options, context);
  const nextLink =
    typeof res.data["@odata.nextLink"] === "string"
      ? res.data["@odata.nextLink"]
      : null;
  return {
    rawPage: res.data,
    attempts: res.attempts,
    retryEvents: res.retryEvents,
    nextLink,
  };
}

// --- Internal ----------------------------------------------------------------

async function acquireGraphToken(managedIdentityClientId: string): Promise<string> {
  const credential = new DefaultAzureCredential({ managedIdentityClientId });
  const token = await credential.getToken(GRAPH_DEFAULT_SCOPE);
  if (!token) {
    throw new GraphFetchError(
      "internal",
      `no Graph token returned for MI ${managedIdentityClientId}`,
      null,
      0,
    );
  }
  return token.token;
}

interface GraphGetOptions {
  /** ADR-0023 §9 — set `Prefer: include-unknown-enum-members` on IdP calls. */
  readonly includeUnknownEnumMembers?: boolean;
}

async function graphGetJsonWithRetry<T>(
  url: string,
  options: GraphFetchOptions,
  context: InvocationContext,
  getOptions: GraphGetOptions = {},
): Promise<GraphFetchResult<T>> {
  const retries: RetryEvent[] = [];
  let lastStatus = 0;
  let lastError: unknown = null;
  const idpEndpoint = shouldUseExponentialBackoff(url);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let token: string;
    try {
      token = await acquireGraphToken(options.managedIdentityClientId);
    } catch (err) {
      throw new GraphFetchError(
        "internal",
        `token acquisition failed: ${String((err as Error).message ?? err)}`,
        null,
        attempt - 1,
      );
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    );

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "aegis-xdr-hub/1.0 (+secureScore ingest)",
    };
    if (getOptions.includeUnknownEnumMembers) {
      requestHeaders.Prefer = "include-unknown-enum-members";
    }

    assertGraphUrl(url);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: requestHeaders,
        signal: controller.signal,
      });
    } catch (err) {
      lastError = err;
      const isAbort = (err as Error)?.name === "AbortError";
      const kind: GraphFetchError["kind"] = isAbort ? "timeout" : "network";
      context.warn(
        `graph fetch ${isAbort ? "timeout" : "network error"}: attempt=${attempt} err=${String((err as Error).message ?? err)}`,
      );
      if (attempt === MAX_ATTEMPTS) {
        throw new GraphFetchError(kind, `graph fetch ${kind}`, null, attempt);
      }
      const backoff = computeBackoffMs(attempt);
      retries.push({
        attempt,
        statusCode: 0,
        retryAfterHeader: null,
        retryAfterClamped: false,
        retryAfterAppliedMs: 0,
        backoffMs: backoff,
      });
      await sleep(backoff);
      continue;
    } finally {
      clearTimeout(timeoutHandle);
    }

    lastStatus = res.status;

    if (res.status >= 200 && res.status < 300) {
      const body = (await res.json()) as T;
      return { data: body, attempts: attempt, finalHttpStatus: res.status, retryEvents: retries };
    }

    // Terminal non-retry statuses.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      throw new GraphFetchError(
        "4xx",
        `graph ${res.status} terminal: ${body.slice(0, 512)}`,
        res.status,
        attempt,
      );
    }

    // Retryable: 408, 429, 500, 502, 503, 504.
    const isRetryable = [408, 429, 500, 502, 503, 504].includes(res.status);
    if (!isRetryable) {
      const body = await res.text().catch(() => "");
      throw new GraphFetchError(
        classifyStatus(res.status),
        `graph ${res.status} non-retryable: ${body.slice(0, 512)}`,
        res.status,
        attempt,
      );
    }

    if (attempt === MAX_ATTEMPTS) {
      const kind = classifyStatus(res.status);
      throw new GraphFetchError(
        kind,
        `graph ${res.status} after ${MAX_ATTEMPTS} attempts`,
        res.status,
        attempt,
      );
    }

    const retryAfterHeader = res.headers.get("retry-after");
    // ADR-0023 §8 — IdP endpoints do NOT return Retry-After on 429. When the
    // header is absent AND this is an IdP endpoint, substitute an
    // exponential-backoff fallback (1s / 2s / 4s / 8s with ±25% jitter).
    // Non-IdP endpoints keep the existing 2s `computeBackoffMs` default.
    const useIdpBackoff = idpEndpoint && !retryAfterHeader;
    if (useIdpBackoff) {
      const idpDelay = computeIdpBackoffMs(attempt);
      retries.push({
        attempt,
        statusCode: res.status,
        retryAfterHeader: null,
        retryAfterClamped: false,
        retryAfterAppliedMs: 0,
        backoffMs: idpDelay,
      });
      emitAievent(context, "EntraRiskIngestRetry", {
        attempt,
        delayMs: idpDelay,
        statusCode: res.status,
        retryAfterHeader: null,
        isIdpEndpoint: true,
      });
      await sleep(idpDelay);
      continue;
    }
    const applied = applyRetryAfterClamp(retryAfterHeader, options.leaseWindowMs, attempt);
    retries.push({
      attempt,
      statusCode: res.status,
      retryAfterHeader,
      retryAfterClamped: applied.clamped,
      retryAfterAppliedMs: applied.appliedMs,
      backoffMs: applied.backoffMs,
    });
    await sleep(applied.appliedMs > 0 ? applied.appliedMs : applied.backoffMs);
  }

  /* c8 ignore next */
  throw new GraphFetchError(
    "internal",
    `graph loop ended without return; lastStatus=${lastStatus} lastError=${String((lastError as Error)?.message ?? lastError ?? "")}`,
    lastStatus || null,
    MAX_ATTEMPTS,
  );
}

function classifyStatus(status: number): GraphFetchError["kind"] {
  if (status === 408) return "timeout";
  if (status === 429) return "throttle";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  return "internal";
}

// ─── POST helper — first POST shape in the codebase ──────────────────────────
//
// ADR-0030 §C.8 + §C.8.1 — Phase C email orchestrator uses the draft + send
// pattern via two POSTs (`/users/{from}/messages` then
// `/users/{from}/messages/{id}/send`). This helper mirrors
// `graphGetJsonWithRetry`'s retry semantics (429/5xx → backoff, 4xx → terminal,
// Retry-After clamped to the lease window) but with a JSON request body and
// support for caller-supplied headers (the orchestrator sets `client-request-id`
// per attempt for Graph-side request tracing).
//
// `TResp` is the parsed response body when the response has one; `null` is
// returned for `202 Accepted` / `204 No Content` (the second POST in the
// draft+send pair returns 202 with no body, so callers expect `TResp | null`).
// Callers needing a non-null response (e.g. create-draft) assert with `??`.

export interface GraphPostOptions {
  /** Extra headers merged with Authorization/Content-Type/Accept/User-Agent. Caller-supplied keys win. */
  readonly extraHeaders?: Record<string, string>;
  /** Override the User-Agent string. Defaults to the email-grade banner. */
  readonly userAgent?: string;
  /** Retry on `AbortError` / network failure (default true). Set false for
   *  non-idempotent POSTs (e.g. create-draft) where a transport-layer retry
   *  can produce orphan server-side side effects (Slice 1(b) WS10 MEDIUM #3). */
  readonly retryOnTransport?: boolean;
}

export async function graphPostJsonWithRetry<TBody, TResp>(
  url: string,
  body: TBody,
  options: GraphFetchOptions,
  context: InvocationContext,
  postOptions: GraphPostOptions = {},
): Promise<GraphFetchResult<TResp | null>> {
  const retries: RetryEvent[] = [];
  let lastStatus = 0;
  let lastError: unknown = null;
  const serialisedBody = JSON.stringify(body);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let token: string;
    try {
      token = await acquireGraphToken(options.managedIdentityClientId);
    } catch (err) {
      throw new GraphFetchError(
        "internal",
        `token acquisition failed: ${String((err as Error).message ?? err)}`,
        null,
        attempt - 1,
      );
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    );

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": postOptions.userAgent ?? "aegis-xdr-hub/1.0 (+reports email)",
      ...(postOptions.extraHeaders ?? {}),
    };

    assertGraphUrl(url);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: serialisedBody,
        signal: controller.signal,
      });
    } catch (err) {
      lastError = err;
      const isAbort = (err as Error)?.name === "AbortError";
      const kind: GraphFetchError["kind"] = isAbort ? "timeout" : "network";
      context.warn(
        `graph POST ${isAbort ? "timeout" : "network error"}: attempt=${attempt} err=${String((err as Error).message ?? err)}`,
      );
      // Slice 1(b) WS10 MEDIUM #3 — non-idempotent POSTs (create-draft) must
      // NOT retry on transport-layer failure: Graph may have received the
      // request before our client aborted, and a retry produces an orphan
      // draft. The caller opts out via `retryOnTransport: false`.
      const retryOnTransport = postOptions.retryOnTransport ?? true;
      if (!retryOnTransport || attempt === MAX_ATTEMPTS) {
        throw new GraphFetchError(kind, `graph POST ${kind}`, null, attempt);
      }
      const backoff = computeBackoffMs(attempt);
      retries.push({
        attempt,
        statusCode: 0,
        retryAfterHeader: null,
        retryAfterClamped: false,
        retryAfterAppliedMs: 0,
        backoffMs: backoff,
      });
      await sleep(backoff);
      continue;
    } finally {
      clearTimeout(timeoutHandle);
    }

    lastStatus = res.status;

    if (res.status >= 200 && res.status < 300) {
      // 202 / 204 — Graph send-draft endpoint returns 202 with empty body;
      // create-draft returns 201 with the message resource as JSON.
      if (res.status === 202 || res.status === 204) {
        return { data: null, attempts: attempt, finalHttpStatus: res.status, retryEvents: retries };
      }
      const text = await res.text();
      if (text.length === 0) {
        return { data: null, attempts: attempt, finalHttpStatus: res.status, retryEvents: retries };
      }
      // Slice 1(b) WS10 LOW #5 — wrap parse so a garbage 2xx body
      // surfaces as a GraphFetchError with status + attempt, not a raw
      // SyntaxError that bypasses the audit-line shape.
      try {
        const parsed = JSON.parse(text) as TResp;
        return { data: parsed, attempts: attempt, finalHttpStatus: res.status, retryEvents: retries };
      } catch (parseErr) {
        throw new GraphFetchError(
          "internal",
          `graph POST ${res.status} body not valid JSON: ${String((parseErr as Error).message ?? parseErr).slice(0, 200)}`,
          res.status,
          attempt,
        );
      }
    }

    // Terminal non-retry statuses.
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      const body = await res.text().catch(() => "");
      throw new GraphFetchError(
        "4xx",
        `graph POST ${res.status} terminal: ${body.slice(0, 512)}`,
        res.status,
        attempt,
      );
    }

    // Retryable: 408, 429, 500, 502, 503, 504.
    const isRetryable = [408, 429, 500, 502, 503, 504].includes(res.status);
    if (!isRetryable) {
      const body = await res.text().catch(() => "");
      throw new GraphFetchError(
        classifyStatus(res.status),
        `graph POST ${res.status} non-retryable: ${body.slice(0, 512)}`,
        res.status,
        attempt,
      );
    }

    if (attempt === MAX_ATTEMPTS) {
      const kind = classifyStatus(res.status);
      throw new GraphFetchError(
        kind,
        `graph POST ${res.status} after ${MAX_ATTEMPTS} attempts`,
        res.status,
        attempt,
      );
    }

    const retryAfterHeader = res.headers.get("retry-after");
    const applied = applyRetryAfterClamp(retryAfterHeader, options.leaseWindowMs, attempt);
    retries.push({
      attempt,
      statusCode: res.status,
      retryAfterHeader,
      retryAfterClamped: applied.clamped,
      retryAfterAppliedMs: applied.appliedMs,
      backoffMs: applied.backoffMs,
    });
    await sleep(applied.appliedMs > 0 ? applied.appliedMs : applied.backoffMs);
  }

  /* c8 ignore next */
  throw new GraphFetchError(
    "internal",
    `graph POST loop ended without return; lastStatus=${lastStatus} lastError=${String((lastError as Error)?.message ?? lastError ?? "")}`,
    lastStatus || null,
    MAX_ATTEMPTS,
  );
}

export function applyRetryAfterClamp(
  header: string | null,
  leaseWindowMs: number,
  attempt: number,
): { appliedMs: number; clamped: boolean; backoffMs: number } {
  const backoffMs = computeBackoffMs(attempt);
  if (!header) {
    return { appliedMs: 0, clamped: false, backoffMs };
  }
  const requestedSeconds = Number.parseInt(header, 10);
  if (!Number.isFinite(requestedSeconds) || requestedSeconds < 0) {
    return { appliedMs: 0, clamped: false, backoffMs };
  }
  const requestedMs = requestedSeconds * 1000;
  const leaseCapMs = Math.max(0, leaseWindowMs - 5_000);
  const appliedMs = Math.min(requestedMs, leaseCapMs, RETRY_AFTER_HARD_CAP_MS);
  return {
    appliedMs: Math.max(0, appliedMs),
    clamped: appliedMs < requestedMs,
    backoffMs,
  };
}

export function computeBackoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), BACKOFF_MAX_MS);
  return Math.floor(exp * Math.random());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const internals = {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
  MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  RETRY_AFTER_HARD_CAP_MS,
};
