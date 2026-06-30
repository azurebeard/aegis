# ADR-0024 — EntraRisk summary + list API contract

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0023 defines how `/v1.0/identityProtection/riskyUsers` lands in the `EntraRisk` Table. This ADR defines the API surface the SPA consumes to render:

1. The **dashboard tile** — counts by `riskLevel` / `riskState` + most-recent risky user + health status.
2. The full **`/risky-users` page** — paginated list with filters (`riskLevel`, `riskState`, `includeDeleted`, `includeRemediated`), mirrors the `/incidents` page shape (ADR-0016).
3. An **admin manual-trigger** endpoint — parity with the incidents admin trigger (ADR-0014 §admin / ADR-0016 implicitly), for debug / licence re-probe / deploy verification.

The tile-contract precedent from ADR-0012 (Secure Score) covers: server-authoritative derivations, `Cache-Control` headers, rate limiting, plain-text-only rendering, health/freshness passthrough. The list-contract precedent from ADR-0016 (Incidents) covers: filter semantics, opaque-cursor pagination with filter-fingerprinting, route-constraint collision handling for `/summary` vs future `/{id}` paths, storage RBAC extension pattern.

Step 6 inherits all of those rules. This ADR adds only what's new:

1. **Three endpoints** — summary, list, admin-run.
2. **No detail endpoint** — full riskyUser row is compact; summary + list cover dashboard needs.
3. **`licence_required` health-status handling** — the ADR-0023 §7 status value surfaces as a specific empty-state on the tile.
4. **Pagination** — nextCursor on `riskLastUpdatedDateTime` (there's no `/{id}` endpoint so the route constraint for `/summary` is simpler than ADR-0016).
5. **Reader + admin roles** — per the SWA config pattern.
6. **Admin rate limit 30/day** — mirrors the brief-agent manual trigger (ADR-0020 §3) and the HANDOVER §7 rate-limit conventions.

The decisions to settle:

1. Three endpoints — summary / list / admin-run.
2. Route-constraint pattern for `/summary` vs future `/{id}`.
3. Filter primitives — which fields are filterable, enum validation, `includeDeleted` and `includeRemediated` defaults.
4. Pagination — opaque cursor on `riskLastUpdatedDateTime`, filter-fingerprint per ADR-0016 §2a.
5. `health.status` passthrough — `licence_required` rendering.
6. Caching / rate limits.
7. Response shape — `schemaVersion: 1`.
8. Storage RBAC — no change from step 4 (api-reader already has Table Reader on ops).

## Decision

### 1. Three endpoints

All endpoints live under `/api/risky-users/` and return JSON. Route rules (`web/swa-config.template.json`):

```json
[
  { "route": "/api/risky-users/summary", "allowedRoles": ["authenticated", "reader"] },
  { "route": "/api/risky-users/list",    "allowedRoles": ["authenticated", "reader"] },
  { "route": "/api/admin/entra-risk/*",  "allowedRoles": ["authenticated", "admin"] }
]
```

Reader + admin role binding: consistent with ADR-0016 §1. Admin-only endpoints sit under `/api/admin/entra-risk/` (a distinct prefix from the data-read routes) so a SWA role-rule misconfiguration can't silently expose admin endpoints to the reader role.

**Why `/api/risky-users/list` instead of plain `/api/risky-users`.** ADR-0016 uses `/api/incidents` for the list endpoint and `/api/incidents/{id}` for detail. Step 4 hit a live Functions-routing pitfall (HANDOVER §6.2 pitfall 17: `/api/incidents/summary` was caught by `incidents/{id}` with `id="summary"` until a route-regex negative-lookahead fix). EntraRisk has no `/{id}` detail endpoint in v1 (see §1.4 below — no detail-blob, row is compact, already in the list). To future-proof against someone later adding `/api/risky-users/{id}` and re-hitting the same pitfall, **the list endpoint is explicit: `/api/risky-users/list`**. The `summary` vs `list` literal paths are mutually unambiguous; a future `/{id}` endpoint would sit alongside with a negative-lookahead constraint like the incidents precedent.

**Route-constraint regex for a future `/{id}`.** Documented here so a future implementer doesn't have to re-derive from HANDOVER §6.2: if `/api/risky-users/{id}` is ever added, use `route: "risky-users/{id:regex(^(?!summary$|list$).+$)}"` — this prevents the literal paths from being caught by the parameterised route. Any new literal sub-path added at that time MUST extend the lookahead.

#### 1.1 `GET /api/risky-users/summary`

Tile payload — small, aggregated, cheap-to-cache.

```json
{
  "schemaVersion": 1,
  "counts": {
    "total": 12,
    "byRiskLevel": { "high": 2, "medium": 4, "low": 5, "hidden": 0, "none": 1, "unknown": 0 },
    "byRiskState": {
      "atRisk": 8,
      "confirmedCompromised": 1,
      "remediated": 2,
      "confirmedSafe": 0,
      "dismissed": 1,
      "none": 0,
      "unknown": 0
    },
    "processing": 2,
    "softDeleted": 3
  },
  "mostRecent": {
    "id": "3f7da1c2-4e56-4a89-8b30-99e4a2c1d7e5",
    "userPrincipalName": "alice@contoso.com",
    "userDisplayName": "Alice Example",
    "riskLevel": "high",
    "riskState": "atRisk",
    "riskDetail": "unfamiliarFeatures",
    "riskLastUpdatedDateTime": "2026-04-18T19:41:08.902Z",
    "isProcessing": false
  },
  "health": {
    "status": "healthy",
    "lastSuccessAt": "2026-04-18T20:00:00.000Z",
    "consecutiveFailures": 0
  },
  "ingestedAt": "2026-04-18T20:00:00.000Z"
}
```

**Derivation on the server.** Counts are computed from the `EntraRisk` Table at request time — no pre-aggregation. At single-tenant scale (low hundreds of rows at most) this is a single-partition scan + in-memory bucket operation (<30 ms). If volume grows, an aggregation row on IngestHealth (or a dedicated `EntraRiskSummary` row) can cache counts; not needed for v1.

**Default exclusions in `counts`.** To match the list-view defaults (§1.2):

- **`IsDeleted=true` rows are EXCLUDED from `counts.total` and the `byRiskLevel` / `byRiskState` buckets by default** — soft-deleted users are not actionable for ongoing posture. They are surfaced as a **separate `counts.softDeleted` integer** so the UI can render a subtle badge ("3 soft-deleted — [show all]") without polluting the primary counts.
- **`RiskState = "remediated" | "confirmedSafe" | "dismissed"` rows ARE counted in `byRiskState`** (so the user sees resolution volume), but `mostRecent` still filters them out in favour of an active-risk user — the tile's "most recent" should draw attention to something actionable, not a closed case.
- **`Processing=true` rows are counted in `counts.total`** (they're real risky users whose evaluation is mid-recalc), AND surfaced as a separate `counts.processing` integer so the tile can render a "2 recalculating" sub-label.

**`mostRecent`** is the single row with the latest `RiskLastUpdatedDateTime` where `IsDeleted=false` AND `RiskState NOT IN ('remediated', 'confirmedSafe', 'dismissed')`. `null` if no matching row exists (e.g. all risks resolved; empty-but-healthy state).

**`health`** mirrors the ADR-0012 pattern: pass-through from the `IngestHealth` row for `graph.security.riskyUsers`. Wire-status mapping extends ADR-0012's:

| `IngestHealth.Status` | Wire `health.status` | Tile treatment |
|---|---|---|
| `healthy` | `"healthy"` | Green badge, counts rendered normally. |
| `degrading` | `"degrading"` | Amber badge; counts rendered with a "last successful run: {lastSuccessAt}" caption. |
| `failing` | `"failing"` | Red badge; counts rendered with a "{N} consecutive failures" caption. |
| `licence_required` | `"licence_required"` | **Dedicated empty state** — no counts, no mostRecent; tile renders the "Entra ID P2 required" copy from ADR-0023 §7, with a `Learn more →` link to Microsoft's Identity Protection licensing page. |

The `licence_required` status is the new value this ADR consumes (added per ADR-0023 §7's amendment to ADR-0011 §5a).

**Response body shape on `licence_required`** (WS10 SEC-M-ADR-24-01 resolution). The summary handler MUST still return HTTP 200 with a well-formed `IncidentsSummaryResponse`-shaped body — clients never see a distinct status code — but the data-bearing fields are explicitly null/zero so the SPA can render the dedicated empty state without null-checking every field individually:

```json
{
  "schemaVersion": 1,
  "counts": null,
  "mostRecent": null,
  "health": {
    "status": "licence_required",
    "lastSuccessAt": null,
    "consecutiveFailures": 0
  },
  "ingestedAt": null
}
```

**Cache-Control override on `licence_required`.** The default `/summary` response carries `Cache-Control: private, max-age=60` (see §3). On `licence_required` responses the handler SETS `Cache-Control: private, max-age=3600` (one hour) — a P1 tenant's tile state changes only on admin action, so a 1h cache is strictly correct AND bounds hard-refresh-loop blast radius from any upstream page-refresh bug. This is a **server-side override** and is what the SPA actually honours; the client-side TanStack Query `staleTime` override described in §3 is a belt-and-braces second layer. Tile render path: SWA fetches `/summary` once per hour (or on admin action), receives the `licence_required` body shape, renders the "Entra ID P2 required" copy. The tile's query key remains unchanged so TanStack doesn't re-fire on route changes during the cache window. The earlier paragraph that read *"the tile does NOT issue the /summary fetch"* is corrected: the tile DOES issue `/summary` (that's the only signal source for `licence_required`), but it does so at 1h cadence rather than 5min thanks to the combined server + client cache override.

#### 1.2 `GET /api/risky-users/list?<filters>&<pagination>`

Paginated list view — the `/risky-users` page's data source. Query parameters:

| Param | Values | Default | Notes |
|---|---|---|---|
| `riskLevel` | `high` / `medium` / `low` / `hidden` / `none` / `unknown` (repeatable) | (any) | Strict enum; invalid values → 400. `unknown` matches rows whose raw value fell outside the whitelist at ingest time (per ADR-0023 §9). |
| `riskState` | `atRisk` / `confirmedCompromised` / `remediated` / `confirmedSafe` / `dismissed` / `none` / `unknown` (repeatable) | (any but remediated / confirmedSafe / dismissed — see `includeRemediated`) | Strict enum. |
| `since` | ISO8601 UTC datetime | — | If specified, filter `RiskLastUpdatedDateTime >= since`. |
| `includeDeleted` | `true` / `false` | `false` | When `false`, filter `IsDeleted=false`. Soft-delete admin opt-in per ADR-0023 §4. |
| `includeRemediated` | `true` / `false` | `false` | When `false`, filter `RiskState NOT IN ('remediated', 'confirmedSafe', 'dismissed')`. |
| `limit` | integer 1–50 | 25 | Out-of-range → 400. |
| `cursor` | opaque base64url string | (first page) | Returned by a previous page's `nextCursor`. |

Filter semantics: multi-valued filters are **OR within one param, AND across params** (same as ADR-0016 §1.2). E.g. `riskLevel=high&riskLevel=medium&riskState=atRisk` → "(high OR medium) AND atRisk".

**`includeDeleted` default is `false`** (not `true`) because the primary UX is ongoing-posture, not offboarded-account audit. An admin who wants to audit offboarded-risky-accounts flips the toggle; the UX surfaces the toggle as a prominent "Show soft-deleted users" checkbox rather than burying it in a menu.

**`includeRemediated` default is `false`** because the list's primary purpose is "users I should act on". A future "show historical" toggle flips this.

Response:

```json
{
  "schemaVersion": 1,
  "riskyUsers": [
    {
      "id": "3f7da1c2-4e56-4a89-8b30-99e4a2c1d7e5",
      "userPrincipalName": "alice@contoso.com",
      "userDisplayName": "Alice Example",
      "riskLevel": "high",
      "riskState": "atRisk",
      "riskDetail": "unfamiliarFeatures",
      "riskLastUpdatedDateTime": "2026-04-18T19:41:08.902Z",
      "isDeleted": false,
      "isProcessing": false
    }
  ],
  "page": {
    "count": 25,
    "limit": 25,
    "nextCursor": "eyJrIjoiM2Y3…",
    "hasMore": true
  }
}
```

**Order:** `RiskLastUpdatedDateTime DESC` by default. No `orderBy` parameter in v1 — a future ADR can add one. Graph's `/riskyUsers` does not support `$orderby` on the ingest side (ADR-0023 §5), but the Table Storage query is our own — we control ordering.

**Fields returned:** match the EntraRisk Table row (ADR-0023 §3) minus internal fields (`IngestedAt`, `IngestRunId`, `PartitionKey`). The rendered fields are what the list UX needs; the row is compact enough that "fields returned here" and "fields on the Table" are very nearly the same set — so a future detail-drawer endpoint would be redundant (§1.4).

**`userPrincipalName` / `userDisplayName` rendering.** Plain-text-only per ADR-0012 §5 / ADR-0016 §6. The `react/no-danger` ESLint override extends to `web/src/features/risky-users/**` when the feature folder is added. Adversary-influenceable prose fields (none on riskyUser — UPN and display name are directory-authored, not user-free-text) are still subject to the plain-text rule as defence-in-depth.

#### 1.3 `POST /api/admin/entra-risk/run`

Admin manual-trigger. Parity with the brief-agent admin trigger (ADR-0020 §3) and the incidents / SecureScore admin triggers (ADR-0014 §admin / ADR-0011 §1 manual-trigger companion).

- **Method:** `POST`.
- **Auth:** admin role (via SWA route rule + Easy Auth SWA-MI binding).
- **Body:** `{}` only (1 KB request-body cap, 400 `bad_request` on any other content). **Query string:** MUST be empty — any query param rejects with 400 `bad_request` (WS10 SEC-M-ADR-24-02 resolution, matching the `runIncidentsIngest.ts` precedent; also bounds accidental PII-in-query-string leakage into SWA access logs / Function App request logs).
- **Behaviour:** fires the same `runEntraRiskIngest` handler as the Timer. Bypasses the cache check; the next `GET /api/risky-users/summary` serves the fresh result.
- **On every admin invocation:** the handler **unconditionally runs a fresh `/v1.0/organization?$select=assignedPlans` licence probe** per ADR-0023 §7 before the fetch — regardless of the existing `IngestHealth.Status` value (WS10 SEC-M-ADR-23-02 + SEC-M-ADR-24-02 resolution — the authoritative column name is `Status` per ADR-0011 §5a, not `LastStatus`; the re-probe condition is "always on admin POST" rather than "only when current status is licence_required"). This closes the operator-action path for *"I upgraded to P2, please re-check"*: if the probe finds P2 now present, the sticky `licence_required` state is overwritten to `healthy` and the run proceeds to the fetch; if P2 is still absent, `licence_required` persists.
- **Rate-limited to 30 req/day per tenant.** Matches the brief-agent limit (ADR-0020 §3). Enforced on a distinct `EntraRiskManualRunsAttempted` counter on the IngestHealth row (new column — additive per ADR-0011 §5a) with a distinct `AdminRateLimitExceeded` error (kind `rate_limit_endpoint`). Separate counter from any Timer-side throttle so an operator exhausting the endpoint budget doesn't deny the scheduled 4h Timer its slot. The ADR-0019 `RunsDailyCeiling` (default 200/day) remains the overarching attacker-drain defence; this 30/day is a finer-grained legitimate-user hygiene bound.
- **Response** (200):

  ```json
  {
    "schemaVersion": 1,
    "runId": "3f7d…",
    "startedAt": "2026-04-19T10:01:17.413Z",
    "status": "success",
    "riskyUsersIngested": 12,
    "riskyUsersProcessing": 2,
    "licenceState": "present"
  }
  ```

- **Response (429):** standard `rate_limited` shape per ADR-0012 §1.3, `error.code = "rate_limit_endpoint"`.
- **Response (503):** standard `dependency_unavailable` on ingest failures (Graph / Table error).

#### 1.4 No detail endpoint — deliberate non-decision

Unlike incidents (ADR-0016 §1.3 defines `/api/incidents/{id}`), **there is NO `/api/risky-users/{id}` endpoint in v1**. Rationale:

- **Row is compact and complete.** The full `EntraRisk` Table row fits the list-response schema; every field a user would render in a detail drawer is already on the list row. Adding a `/{id}` endpoint would return identical data at the cost of an additional route, route-constraint, test surface, and rate-limit bucket.
- **No detail blob.** ADR-0023 §3 keeps the schema in a single store. The `/{id}` endpoint in ADR-0016 exists to merge Table-row + blob; here there's no blob to merge.
- **Future extensions.** If Microsoft's `/v1.0/identityProtection/riskyUsers/{id}/history` is ever ingested (capturing state-transition history per user), a `/{id}` endpoint with the history sub-path would be additive. The route-constraint pattern documented in §1 is ready for it.

**Deep-link shape.** The list-view renders each row with a deep-link to the Entra portal's user-risk page:

```text
https://entra.microsoft.com/#view/Microsoft_AAD_IAM/UserDetailsMenuBlade/~/RiskInformation/userId/{userObjectId}/hidePreviewBanner~/true
```

No deep-link on the server response — the SPA constructs it client-side from the row's `id`. Keeps the API response free of environment-specific URL templates.

### 2. Pagination — opaque cursor

`nextCursor` is an opaque base64url-encoded string whose contents are a handler-controlled JSON:

```json
{
  "k": "<RowKey of the last item returned>",
  "t": "<ISO8601 riskLastUpdatedDateTime of the last item>",
  "f": "<SHA-256 of the canonical filter set — see below>"
}
```

- **Opacity to clients.** The SPA treats `nextCursor` as a string and passes it through unmodified. Contents are an implementation detail that may change without a schema bump as long as old cursors remain decodable.
- **Filter fingerprint (`f`).** Prevents cursor replay against a different filter. Computed identically to ADR-0016 §2a; this ADR does NOT re-derive the canonicalisation algorithm — it inherits it. The only diff is the set of canonical keys (see §2a below).

#### 2a. Filter-fingerprint canonicalisation (inherits ADR-0016 §2a)

The handler builds a plain JSON object with the following keys (omitting any whose value is absent per the enum-array rule — arrays that resolve to empty are omitted entirely):

```json
{
  "riskLevel":         ["high","low"],
  "riskState":         ["atRisk"],
  "since":             "2026-04-18T00:00:00.000Z",
  "includeDeleted":    true,
  "includeRemediated": true,
  "limit":             25
}
```

Canonicalisation rules follow ADR-0016 §2a **in full**:

1. Enum arrays are lowercased, deduplicated, lexicographically sorted, and omitted when empty.
2. `since` is normalised to strict `YYYY-MM-DDTHH:mm:ss.sssZ`; other forms are 400.
3. `includeDeleted` and `includeRemediated` are included only when `true` (the default `false` is omitted from canonical form — a fingerprint from "no `includeDeleted` param" equals one from explicit `includeDeleted=false`).
4. `limit` is the resolved integer value (default `25` is included).
5. Canonicalise with the same vetted JCS library (`json-canonicalize` v1) used by the audit chain (ADR-0015 §2) and the incidents API (ADR-0016 §2a). No second canonicalisation surface introduced.
6. SHA-256 the canonical bytes; emit lowercase hex.

**Case sensitivity rule.** Enum values on the wire are lowercase (`high`, `atRisk`, …); the handler accepts only the documented casing. Mixed casing (e.g. `High`) returns 400 — not case-insensitive accept + normalise. This is a literal inheritance from ADR-0016 §2a.

**Unit-test requirement.** The step-6 test suite asserts identical `f` values across:

- `?riskLevel=high&riskLevel=medium` vs `?riskLevel=medium&riskLevel=high` (ordering)
- `?riskLevel=high&riskLevel=high&riskLevel=medium` vs `?riskLevel=high&riskLevel=medium` (dedupe)
- `?` (no filters) vs `?limit=25` (default limit resolved)
- `?includeDeleted=false&includeRemediated=false` vs `?` (default falses omitted)

…and asserts different `f` values for:

- `?` vs `?riskLevel=high&riskLevel=medium&riskLevel=low&riskLevel=hidden&riskLevel=none&riskLevel=unknown` (no filter vs every value explicit)
- `?limit=25` vs `?limit=50`
- `?riskLevel=high` vs `?riskLevel=High` (case is rejected, not normalised — second is 400)
- `?includeDeleted=true` vs `?` (includeDeleted flip)
- `?includeRemediated=true` vs `?` (includeRemediated flip)

Cursors are stateless on the server — no DB row, no cache entry. A cursor is valid as long as its `(k, t)` pair still points at a row that satisfies the filter. If the row has since been deleted (retention trim), the handler's next-page query returns 0 rows at that position; the response has `hasMore: false` and the client stops paging.

**Failure-mode documentation.** `cursor_filter_mismatch` is the failure shape for both legitimate filter-set drift and replay attacks — same as ADR-0016 §2a. The SPA treats both the same way: drop the cursor and refetch from the first page. No additional signal in the error response.

**`hasMore`** is `true` when a full `limit` of rows was returned; `false` when fewer were returned. The handler does not count total matching rows.

### 3. Caching and rate limits

Inherits ADR-0012 §1.2 template. The 4h ingest cadence (ADR-0023 §1) is slower than incidents' 15-min, so cache TTLs are tuned longer:

| Endpoint | Server `Cache-Control` | Client `staleTime` (TanStack Query) | Rate limit (per-principal) |
|---|---|---|---|
| `/api/risky-users/summary` | `private, max-age=60` | 5 min, refetchOnWindowFocus, refetchInterval = 5 min | 120 req/min |
| `/api/risky-users/list` | `private, max-age=60` | 5 min | 60 req/min |
| `/api/admin/entra-risk/run` | `private, no-store` | — (POST) | 30 req/day (§1.3) |

`Vary: Cookie, Authorization` on every response (per-principal response). `private` on Cache-Control because payloads are tenant-scoped.

**Why 60 s server-side, not 30 s (incidents' cap).** Incidents refresh every 15 minutes; a 30 s server cap lets the tile reflect a manual re-ingest promptly. Risky users refresh every 4 hours; a 60 s cap is well inside the ingest cadence and reduces Table Storage read volume at no UX cost.

**Why 5 min client `staleTime`, not 2 min.** Same logic — the 4h ingest cadence means fresh data exists only once per 240 minutes. A 2-min `staleTime` would drive TanStack Query to re-fetch needlessly often; 5 minutes is comfortably inside the data-freshness window while still keeping the tile responsive to window-focus events.

**`licence_required` short-circuit.** When the summary response has `health.status = "licence_required"`, TanStack Query caches the response with an **extended `staleTime` of 1 hour** (via `useQuery`'s per-response `staleTime` override). A tenant on P1 does not need a fresh summary every 5 minutes — the status changes only on an operator action (admin manual-trigger, ADR-0023 §7). The override is implemented client-side; the server Cache-Control is unchanged (still `private, max-age=60`) because the server has no knowledge of the client's intent to short-circuit.

Rate-limit implementation reuses the `SlidingWindowRateLimiter` from step 3 (`api/src/lib/rateLimit.ts`). Three new limiter instances (one per endpoint); same in-process per-Function-App-instance scope as incidents / SecureScore.

### 4. Error shape (all endpoints)

Inherits ADR-0012 §1.3 `ApiError` shape. Status codes used:

| Status | Code | Trigger |
|---|---|---|
| 400 | `bad_request` | Unknown enum, out-of-range `limit`, malformed `since`, cursor decode failure, admin body ≠ `{}` |
| 400 | `cursor_filter_mismatch` | Cursor fingerprint doesn't match current filter set |
| 401 | `unauthenticated` | No principal (SWA should not forward — defence in depth) |
| 403 | `forbidden` | Principal authenticated but not in required role (admin-only endpoints) |
| 429 | `rate_limited` | Per-principal rate limit exceeded |
| 429 | `rate_limit_endpoint` | Admin-endpoint-specific daily budget exhausted (§1.3) |
| 503 | `dependency_unavailable` | Table query failed; ingest handler failed for admin-run |
| 500 | `internal_error` | Unhandled |

No `404 not_found` because there's no `/{id}` endpoint in v1.

### 5. Storage RBAC — no change

The api-reader MI already has:

- `Storage Table Data Reader` on the ops Table service (all tables, including `EntraRisk`).
- `Storage Blob Data Owner` on the `func-deployments` container (Functions runtime).

EntraRisk has no detail blob (ADR-0023 §3). No new RBAC assignment needed; the `/api/risky-users/*` handlers read `EntraRisk` via the existing Table Reader grant.

The ingest MI (the admin-run handler uses the same identity as the Timer) already has `Storage Table Data Contributor` on the `EntraRisk` table (granted by the step-6 infra pass per ADR-0023's Bicep additions). No RBAC surface change at this API-contract layer.

### 6. Rendering safety inherited from ADR-0012 §5

Every field on the list and summary responses is rendered **plain-text only**. No `dangerouslySetInnerHTML`. The `react/no-danger` ESLint override extends to `web/src/features/risky-users/**` at the same time as the feature folder is added (web side of step 6).

No long-form prose fields on riskyUser (unlike `incident.description` / `summary`). The list view is the densest surface; defence-in-depth still applies because `userPrincipalName` and `userDisplayName` are directory-authored strings — a compromised directory admin could theoretically seed prompt-injection-style payloads there. The plain-text rendering rule closes that surface at the React layer; the prompt-builder sanitisation (ADR-0020 §4, as amended by ADR-0020's Step 6 amendment note) closes it at the LLM layer.

### 7. Rejected: detail drawer, write endpoints, long-polling

- **`/api/risky-users/{id}` detail drawer** — out of v1 scope per §1.4. Row is compact; list renders everything that would appear in a drawer.
- **`POST /api/risky-users/{id}/dismiss` or similar write endpoints** — out of v1 scope. XDR Hub is read-only (brief §1). Dismissal / remediation is done in the Entra portal via the deep-link; the ingest re-fetches the updated `riskState` on the next 4h fire.
- **Long-polling or SSE for list updates** — out of v1 scope. A client polls `/api/risky-users/summary` on `refetchInterval: 300_000`; the 4h ingest cadence doesn't benefit from sub-minute polling.

## Consequences

### Positive

- **UX matches the 4h ingest cadence.** Tile refreshes every 5 min client-side + 60 s server cap — freshness bounded at ~6 min after an ingest run completes, without over-polling an endpoint whose upstream updates every 4 hours.
- **Soft-delete + remediated-state toggles** give operators a clean "ongoing posture" default view with a one-click escape-hatch for audit.
- **`licence_required` short-circuit** prevents P1 tenants from pounding the summary endpoint when the tile will always render the "P2 required" empty state.
- **Filter-fingerprint cursor** inherits the proven ADR-0016 §2a design — no new canonicalisation surface; the audit-chain JCS library is the single source of truth.
- **Admin manual-trigger with 30/day limit** gives operators a debug / licence-re-probe path without exposing an attacker-drain surface.
- **No detail endpoint** keeps the API surface lean — one fewer route, one fewer test surface, one fewer route-constraint to get wrong at Functions runtime.

### Negative / trade-offs

- **Server-side summary counts on every request** at a full-partition scan. At low-hundreds-of-rows this is <30 ms; the same watchpoint as ADR-0016 §Negative applies — cache an aggregation row if volume ever reaches tens of thousands (i.e. never, at single-tenant scale).
- **Cursor is opaque but not cryptographically opaque.** A client can base64-decode to see the last `rowKey`. Same as ADR-0016 — the cursor exposes no secret, only referencing keys already in the payload.
- **No `orderBy` parameter.** If a future user wants to sort by `riskLevel` or `riskState` instead of `riskLastUpdatedDateTime`, a new ADR adds it. Client-side sort of the current page is the v1 workaround.
- **`licence_required` tile state is implicit.** A P1 tenant never sees risky-user data, which is correct but may be surprising the first time. Mitigated by the copy ("Entra ID P2 required — upgrade to unlock...") and the Learn more link.
- **`/api/risky-users/list` (not `/api/risky-users`) is a minor URL-shape quirk.** Documented trade-off — the explicit list path future-proofs against re-hitting HANDOVER §6.2 pitfall 17.

### Neutral

- **Rate limits are per-Function-App-instance** (inherited from step 3). At Flex Consumption scale-out, effective limit is `limit × instanceCount`. Acceptable at single-user scale.
- **`riskDetail` rendered as a raw string in the list.** UI label lookup falls back to prettified raw value on unknowns per ADR-0023 §9; no UX regression for new Microsoft-added values.
- **Admin-run response shape intentionally minimal.** Returns enough for operator to confirm success; full audit-chain inspection is via the audit blob, not a response field.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **`/api/risky-users` (no `/list` suffix)** | Revives HANDOVER §6.2 pitfall 17 if a future `/{id}` route is added. Explicit `/list` path is a small URL-shape cost for a large future-proofing win. |
| **Single `/api/risky-users` returning summary + first page** | Mixes two cache domains (summary polls every 5 min; list rarely beyond first page). Two endpoints (same reasoning as ADR-0016 §Alternatives). |
| **Offset-based pagination (`skip=`, `top=`)** | Doesn't survive row deletion between page fetches (retention trim on `isDeleted=true` rows); skip-pagination drifts. Cursor on `(riskLastUpdatedDateTime, id)` is stable against trim. |
| **Include `IsDeleted=true` by default; require opt-out** | Clutters the primary UX with offboarded accounts. Admin audit is a secondary use case; the toggle defaults should match the primary. |
| **Include `remediated` / `confirmedSafe` / `dismissed` in the list by default** | Same reasoning — the primary UX is "who should I act on"; historical resolution is a secondary filter toggle. |
| **Return full Graph JSON verbatim in the list response** | Exposes `@odata.*` envelope properties and upstream shape that the SPA doesn't need; complicates wire-contract evolution when Microsoft adds a field. Our canonical shape is narrower by design. |
| **Separate `/api/risky-users/counts` endpoint for tile** | Adds a third route for data already cheap enough to serve from `/summary`. Summary handler already does the bucketing in-memory. |
| **Combined `/api/admin/ingest/run` endpoint (all verticals)** | Couples per-vertical rate limits and response shapes; denies future verticals independent budgets. Per-vertical admin endpoints scale cleanly. |
| **GraphQL single endpoint** | Same reasoning as ADR-0016 §Alternatives — REST is the right shape for a small tile/list/admin triple; GraphQL would introduce a query-language surface the rate-limiter + SWA route rules can't enforce without a parser. |
| **Long-polling / SignalR for live updates** | Out of v1 scope; the 4h ingest cadence doesn't benefit from sub-minute push updates. Polling at 5 min is adequate. |

## Related

- `PROJECT_BRIEF.md` §2 — Users (technical audience)
- `PROJECT_BRIEF.md` §6 — Autonomy model (read-only v1)
- `PROJECT_BRIEF.md` §11 — Observability (summary surface feeds the tile's freshness row)
- `PROJECT_BRIEF.md` §13 — MVP scope (Entra risk tile + dashboard list)
- ADR-0005 — Input-handling controls (plain-text rendering inherits)
- ADR-0007 — Easy Auth configuration (authenticated + reader / admin route gates)
- ADR-0009 — Frontend stack (Fluent UI v9, TanStack Query, feature-folder ESLint)
- ADR-0011 — Ingestion schedule + `IngestHealth.Status` taxonomy (this ADR consumes the `licence_required` value; the amendment is owned by ADR-0023 §7)
- ADR-0012 — Dashboard tile contract (Secure Score) — template this ADR inherits
- ADR-0014 — Incidents cadence + schema (admin-run pattern precedent)
- ADR-0015 — Audit hash-chain (JCS library reused for filter-fingerprint canonicalisation — no second canonicalisation surface)
- ADR-0016 — Incidents list + detail API contract (structural precedent; filter-fingerprint canonicalisation inherited in full)
- ADR-0020 — brief-agent contract (the amendment note adds `EntraRisk` as the 6th source key; this API's `/summary` handler is what the prompt-builder reads through)
- ADR-0023 — EntraRisk cadence + schema (defines the store shape this API serves; §7 amends ADR-0011 §5a with `licence_required` status)
- [Microsoft Learn — riskyUser resource](https://learn.microsoft.com/en-us/graph/api/resources/riskyuser?view=graph-rest-1.0)
- [Microsoft Learn — Identity Protection licensing](https://learn.microsoft.com/en-us/entra/id-protection/overview-identity-protection)
- HANDOVER §6.2 pitfall 17 — Functions-routing `/summary` vs `/{id}` collision
- HANDOVER §6.3 — admin-tile-toggle follow-up consumes `licence_required` status from this ADR's tile handler

---

*End of ADR-0024.*
