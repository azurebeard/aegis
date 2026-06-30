# ADR-0016 — Incidents list + detail API contract

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADRs 0013/0014 define how incidents land in the ops stores (`Incidents` Table row + `incidents-detail` blob). This ADR defines the API surface that the SPA consumes to render the dashboard tile, the list page, and the detail drawer.

The tile-contract precedent from ADR-0012 (Secure Score) covers: server-authoritative derivations, Cache-Control, rate limiting, plain-text-only rendering, health/freshness passthrough. Step 4 inherits all of those rules — this ADR adds only what's new: **paginated list with filters**, **detail fetch that merges Table row + blob**, and **tile-level summary (counts by severity)**.

The decisions to settle:

1. **Three endpoints** — summary (tile), list (page), detail (drawer).
2. **Pagination** — cursor-based, opaque, forward-only.
3. **Filter primitives** — which fields are filterable, enum validation.
4. **Caching / rate limits** — tuned for the 15-minute ingest cadence.
5. **Response shape** — schemaVersion convention, error shape inheritance.
6. **Storage RBAC extension** — api-reader MI needs blob read on the detail container.

## Decision

### 1. Three endpoints

All endpoints live under `/api/incidents/` and return JSON. Route rules (`web/swa-config.template.json`):

```json
{ "route": "/api/incidents/*", "allowedRoles": ["authenticated", "reader"] }
```

No admin-only endpoints in this ADR (incident writes, re-sync, etc. are out of v1 scope per brief §1 — read-only).

#### 1.1 `GET /api/incidents/summary`

Tile payload — small, aggregated, cheap-to-cache.

```json
{
  "schemaVersion": 1,
  "counts": {
    "total": 47,
    "bySeverity":       { "high": 3,  "medium": 12, "low": 27, "informational": 4, "unknown": 1 },
    "byStatus":         { "active": 18, "inProgress": 5, "resolved": 24, "redirected": 0, "awaitingAction": 0 },
    "byClassification": { "unknown": 2, "truePositive": 6, "falsePositive": 1, "informationalExpectedActivity": 38 }
  },
  "mostRecent": {
    "id": "29",
    "displayName": "Multi-stage incident involving …",
    "severity": "high",
    "status": "active",
    "lastUpdateDateTime": "2026-04-18T19:41:08.902Z"
  },
  "health": {
    "status": "healthy",
    "lastSuccessAt": "2026-04-18T19:45:00.000Z",
    "consecutiveFailures": 0
  },
  "ingestedAt": "2026-04-18T19:45:00.000Z"
}
```

**Derivation on the server.** Counts are computed from the `Incidents` Table at request time — no pre-aggregation. At single-tenant scale (low thousands of rows) this is a single full-partition scan plus an in-memory bucket operation (<50 ms). If volume grows, an aggregation row on the `IngestHealth` table (or a dedicated `IncidentsSummary` row per-tenant) can cache counts — not needed for v1.

**Redirected incidents** are excluded from `counts` and `mostRecent` by default — they're merge-into-another-incident placeholders and don't represent a user-actionable incident. The list endpoint includes them only with the explicit filter `includeRedirected=true`.

**`mostRecent`** is the single incident with the latest `lastUpdateDateTime` that isn't redirected. `null` if the store is empty.

**`health`** mirrors the ADR-0012 pattern: pass-through from the `IngestHealth` row for the `graph.security.incidents` source, with the same wire-status mapping as `/api/secure-score/latest` (ADR-0012 §1.1 amendments).

#### 1.2 `GET /api/incidents?<filters>&<pagination>`

Paginated list view. Query parameters:

| Param | Values | Default | Notes |
|---|---|---|---|
| `severity` | `high` / `medium` / `low` / `informational` / `unknown` (repeatable) | (any) | Strict enum; invalid values → 400 |
| `status` | `active` / `inProgress` / `resolved` / `redirected` / `awaitingAction` (repeatable) | (any but `redirected`) | Strict enum; `redirected` excluded by default (see `includeRedirected`) |
| `classification` | `unknown` / `truePositive` / `falsePositive` / `informationalExpectedActivity` (repeatable) | (any) | Strict enum |
| `since` | ISO8601 UTC datetime | — | If specified, filter `lastUpdateDateTime >= since` |
| `includeRedirected` | `true` / `false` | `false` | |
| `limit` | integer 1–50 | 25 | Out-of-range → 400 |
| `cursor` | opaque base64 string | (first page) | Returned by a previous page's `nextCursor` |

Filter semantics: multi-valued filters are **OR within one param, AND across params**. E.g. `severity=high&severity=medium&status=active` → "(high OR medium) AND active".

Response:

```json
{
  "schemaVersion": 1,
  "incidents": [
    {
      "id": "29",
      "displayName": "Multi-stage incident …",
      "severity": "high",
      "status": "active",
      "classification": "truePositive",
      "determination": "multiStagedAttack",
      "priorityScore": 100,
      "assignedTo": "admin@contoso.com",
      "createdDateTime": "2026-01-22T12:09:23.143Z",
      "lastUpdateDateTime": "2026-02-25T16:29:33.100Z",
      "alertCount": 1,
      "customTags": ["Demo"],
      "systemTags": [],
      "incidentWebUrl": "https://security.microsoft.com/incident2/29/overview?tid=…",
      "hasRedirect": false,
      "redirectIncidentId": null
    }
  ],
  "page": {
    "count": 25,
    "limit": 25,
    "nextCursor": "eyJrIjoiMjA…",
    "hasMore": true
  }
}
```

**Order:** `lastUpdateDateTime DESC` by default (most-recently-updated first). No `orderBy` parameter in v1 — a future ADR can add one if a use case emerges.

**`description` and `summary` are NOT included** in the list response. They're only in the detail fetch. This keeps the list payload bounded and the list view fast.

#### 1.3 `GET /api/incidents/{id}`

Detail drawer. Merges Table row (summary) with the most recent detail blob (full JSON with alerts and evidence).

Path parameter `id` is URL-encoded; handler un-encodes, validates against `^[A-Za-z0-9._-]{1,128}$` (matches the sanitisation rule used for the blob path in ADR-0014 §3.2 — the 128-char cap derived from observed Graph ID envelope with a 2× tolerance margin; reject-not-truncate on violation), else 400 `bad_request`. This alignment prevents an attacker from asking the API for an ID the ingest layer rejected.

Response:

```json
{
  "schemaVersion": 1,
  "incident": {
    "id": "29",
    "displayName": "…",
    "severity": "high",
    "status": "active",
    "classification": "truePositive",
    "determination": "multiStagedAttack",
    "priorityScore": 100,
    "assignedTo": "admin@contoso.com",
    "description": "Microsoft observed Raspberry Robin worm activity …",
    "summary": "Defender Experts has identified malicious activity …",
    "resolvingComment": null,
    "lastModifiedBy": "API-App:admin@contoso.com",
    "createdDateTime": "2026-01-22T12:09:23.143Z",
    "lastUpdateDateTime": "2026-02-25T16:29:33.100Z",
    "customTags": ["Demo"],
    "systemTags": [],
    "incidentWebUrl": "https://security.microsoft.com/incident2/29/overview?tid=…",
    "comments": [],
    "alerts": [
      { "id": "…", "title": "…", "severity": "medium", "description": "…", "evidence": [ … ] }
    ]
  },
  "ingest": {
    "ingestedAt": "2026-04-18T19:45:00.000Z",
    "ingestRunId": "3f7d…",
    "detailBlobPath": "incidents-detail/2026/04/18/29.json"
  }
}
```

**Merge algorithm:**

1. `getEntity` on `Incidents` Table with `(tenantId, incidentId)`. If not present → 404.
2. Construct detail blob path from `ingestedAt` date + `incidentId`. If multiple past-day blobs exist (historical versions), read the **latest by modification time**.
3. Parse blob JSON. Merge shallow: summary fields from Table take precedence where present; remaining fields (`description`, `summary`, `comments`, `alerts`) come from the blob.
4. Return the merged shape under `incident`. The `ingest` sub-object carries provenance.

**If the detail blob is missing** (retention expired, blob-write failed, manual deletion):

- Status 200, with `incident` populated from Table-only data (summary fields, but `description`/`summary`/`alerts` omitted).
- `ingest.detailBlobPath` still included (the hint path); `ingest.detailBlobMissing: true`; and a classification field **`ingest.detailBlobMissingClassification`** taking one of:

  | Value | Derivation | UI treatment |
  |---|---|---|
  | `"lifecycle-trim"` | The blob's expected modification date (derived from `ingestedAt`) is older than the current retention window (ADR-0014 §5). | Informational — expected for older incidents. |
  | `"lookup-failure"` | The blob lookup itself failed with a Storage 5xx / network error. | Transient warning; the drawer offers a retry. |
  | `"unexplained"` | The blob is within the retention window and the lookup returned a clean 404. | Strong warning — indicates out-of-band delete or a writer-side anomaly that the `detailBlobsWritten` audit field (ADR-0014 §6 / ADR-0015) should cross-reference. |

The classification is computed by the detail handler; the UI renders a banner whose tone matches. `"unexplained"` is the signal an attacker who deletes blobs to forge degraded state would try to induce; the compensating controls (blob versioning + change feed per ADR-0014 §3.2, and the `detailBlobsWritten` audit field) close the loop.

**Past-day walk bounded at 7 days.** If the current-day blob is absent, the handler walks back at most 7 days looking for the most recent prior version (the soft-delete recovery window). Beyond 7 days, the handler returns `detailBlobMissing: true` with `detailBlobMissingClassification: "lifecycle-trim"` — a longer walk would scan most of the retention directory on every missing-detail request, an unnecessary operational cost.

**Walk is Storage-list, not brute-force date iteration.** The handler issues a `ListBlobs` against `incidents-detail` with prefix `incidents-detail/<yyyy>/<mm>/` and filters to entries whose suffix matches `/<incidentId>.json`, then picks the latest by modification time. Two `ListBlobs` calls at most (current month + previous month) to cover the 7-day window safely.

This failure mode is considered acceptable because the Table row always carries the user-actionable summary; losing detail is a degraded-but-still-useful state.

### 2. Pagination — opaque cursor

`nextCursor` is an opaque base64url-encoded string whose contents are a handler-controlled JSON:

```json
{
  "k": "<RowKey of the last item returned>",
  "t": "<ISO8601 lastUpdateDateTime of the last item>",
  "f": "<SHA-256 of the canonical filter set — see below>"
}
```

- **Opacity to clients.** The SPA treats `nextCursor` as a string and passes it through unmodified. The contents are an implementation detail that may change without a schema bump as long as old cursors remain decodable.
- **Filter fingerprint (`f`).** Prevents cursor replay against a different filter. If the handler decodes a cursor whose `f` doesn't match the current request's filter set (computed per the canonicalisation rules below), it returns 400 `cursor_filter_mismatch` — the client re-fetches from the first page.
- **Not reversible.** The cursor doesn't hide information (everything it carries is already in the list response), but the `f` fingerprint makes it non-transferable between filter combinations.

#### 2a. Filter-fingerprint canonicalisation

The `f` value MUST be computed identically for two equivalent filter sets, regardless of HTTP query-string ordering, case, or default-value inclusion. Under-specified canonicalisation is a false-positive source for `cursor_filter_mismatch` errors that look identical to replay-attack detection, and surfaces as inconsistent pagination depending on which order the user clicked filter checkboxes.

Canonicalisation algorithm — the handler MUST follow these steps exactly:

1. **Build a plain JSON object** with the following keys (omitting any whose value is absent per step 2):

   ```json
   {
     "severity":          ["high","low"],
     "status":            ["active"],
     "classification":    ["truePositive"],
     "since":             "2026-04-18T00:00:00.000Z",
     "includeRedirected": true,
     "limit":             25
   }
   ```

2. **For each enum-array filter** (`severity`, `status`, `classification`):
   - Convert every value to lowercase (enforcing the enum casing regardless of client input).
   - Remove duplicates.
   - Sort lexicographically by UTF-16 code-unit order (the same ordering rule as the audit chain's JCS — see ADR-0015 §2).
   - If the resulting array is empty, **omit the key entirely**. An empty filter is distinct from "all values explicitly listed" — a client that passes every enum value explicitly represents a different intent from one that passes no filter, and their fingerprints correctly differ.

3. **For `since`:** normalise to the strict ISO 8601 UTC form `YYYY-MM-DDTHH:mm:ss.sssZ` (always-three-digit fractional seconds; always `Z` suffix; never a local offset). The handler rejects (400 `bad_request`) any other form — the canonicalisation is a parse, not a reshape. Omit the key if `since` is not supplied.

4. **For `includeRedirected`:** include the key only when `true`. The default `false` is omitted for canonical form — a fingerprint computed from "no `includeRedirected` param" equals one computed from "explicit `includeRedirected=false`".

5. **For `limit`:** include the **resolved** integer value (default `25` is included; a different `limit` on a re-fetch is a legitimate filter change and the mismatch is desired).

6. **Canonicalise** the resulting object with **the same vetted JCS library referenced in ADR-0015** (`json-canonicalize` at v1). Invent no second canonicalisation surface.

7. **SHA-256** the canonical bytes; emit lowercase hex. This is `f`.

**Case sensitivity rule.** Enum values on the wire are lowercase (`high`, `medium`, …); the handler accepts only lowercase (400 on any other casing — not case-insensitive accept + normalise). This keeps the API self-documenting and removes a class of subtle mismatches from the canonicalisation.

**Unit-test requirement.** The step-4 test suite asserts identical `f` values across the following pairs of requests:

- `?severity=high&severity=medium` vs `?severity=medium&severity=high`
- `?severity=high&severity=high&severity=medium` vs `?severity=high&severity=medium` (dedupe)
- `?` (no filters) vs `?limit=25` (default limit resolved)
- `?includeRedirected=false` vs `?` (default false omitted from canonical form)

…and asserts **different** `f` values for:

- `?` vs `?severity=high&severity=medium&severity=low&severity=informational&severity=unknown` (no filter vs every value explicit)
- `?limit=25` vs `?limit=50` (limits are load-bearing for pagination)
- `?severity=high` vs `?severity=High` (case is rejected, not normalised — the second request is a 400, not a mismatched fingerprint)

Cursors are stateless on the server — no DB row, no cache entry. A cursor is valid as long as its `k`/`t` pair still points at a row that satisfies the filter. If the row has since been deleted (retention trim), the handler's next-page query returns 0 rows at that position; the response has `hasMore: false` and the client stops paging.

**Failure-mode documentation.** `cursor_filter_mismatch` is the failure shape for both (a) legitimate filter-set drift between the client's cursor-issuing request and the client's cursor-consuming request, and (b) replay attacks. The SPA treats both the same way: drop the cursor and refetch from the first page with the current filter. Servers do not distinguish the two cases in the error response — no additional signal is provided because none of the information would help a legitimate client and all of it would help an attacker.

**`hasMore`** is `true` when a full `limit` of rows was returned; `false` when fewer were returned (meaning no more exist for this filter). The handler does not count total matching rows.

### 3. Caching and rate limits

Per ADR-0012 §1.2 template:

| Endpoint | Server `Cache-Control` | Client `staleTime` (TanStack Query) | Rate limit (per-principal) |
|---|---|---|---|
| `/api/incidents/summary` | `private, max-age=30` | 60 s, refetchOnWindowFocus, refetchInterval = 60 s | 120 req/min |
| `/api/incidents` | `private, max-age=60` | 2 min | 60 req/min |
| `/api/incidents/{id}` | `private, max-age=60` | 5 min | 60 req/min |

`Vary: Cookie, Authorization` on every response (per-principal response). `private` on Cache-Control because payloads are tenant-scoped.

The 30 s cap on summary reflects the same lesson from the ADR-0012 amendment: a short server-side cap lets manual re-ingests surface on the tile promptly; client-side TanStack Query is the primary throttle.

Rate-limit implementation reuses the `SlidingWindowRateLimiter` from step 3 (`api/src/lib/rateLimit.ts`). Three new limiter instances (one per endpoint); same in-process per-Function-App-instance scope.

### 4. Error shape (all endpoints)

Inherits ADR-0012 §1.3 `ApiError` shape. Status codes used:

| Status | Code | Trigger |
|---|---|---|
| 400 | `bad_request` | Unknown enum, out-of-range `limit`, malformed `since`, cursor decode failure |
| 400 | `cursor_filter_mismatch` | Cursor fingerprint doesn't match current filter set |
| 404 | `not_found` | `/api/incidents/{id}` with unknown id |
| 429 | `rate_limited` | Per-principal rate limit exceeded |
| 503 | `dependency_unavailable` | Table query or blob read failed |
| 500 | `internal_error` | Unhandled |

### 5. Storage RBAC extension

The api-reader MI currently has:

- `Storage Table Data Reader` on the ops Table service (all tables)
- `Storage Blob Data Owner` on the `func-deployments` container (Functions runtime)

For the detail endpoint, add:

- `Storage Blob Data Reader` scoped to the `incidents-detail` container on the ops storage account.

Added in `infra/modules/storage-ops.bicep` as a container-scoped role assignment on the new `incidents-detail` container (paralleling the existing `funcDeploymentsRoleAssignment` pattern). Strictly narrower than an account-scope Blob Reader.

### 6. Rendering safety inherited from ADR-0012 §5

Every Microsoft-authored prose field on the detail view (`description`, `summary`, `resolvingComment`, `comments[].comment`, `alerts[].description`, `alerts[].recommendedActions`, `alerts[].evidence[]` sub-fields containing strings) is rendered **plain-text only**. No `dangerouslySetInnerHTML`. The `react/no-danger` ESLint override is extended to `web/src/features/incidents/**` at the same time as the feature folder is added (web side of step 4).

The list view intentionally omits long-form prose; the detail drawer is where it appears. The drawer's list-of-alerts-and-evidence renders as typed fields — no raw JSON dump — to keep the safety rule enforceable at the React component layer rather than at a generic "render anything" sink.

### 7. Rejected: partial/patch writes, polling-style long updates

- **PATCH/POST endpoints** are out of v1 scope. XDR Hub is read-only (brief §1). When Tier 2 "Suggest & Approve" lands (brief §6), a new ADR defines write surfaces; none are in this ADR.
- **Long-polling or SSE for list updates** is out of v1 scope. A client polls `/api/incidents/summary` on `refetchInterval: 60_000`; the tile tells the user when the last ingest succeeded. A future ADR can introduce SignalR or Graph change-notifications if perceived latency becomes a real complaint.

## Consequences

### Positive

- **UX matches the 15-minute ingest cadence.** Tile refreshes every 60 s (client) + 30 s server cap = freshness bounded at ~90 s after an ingest run completes, without spamming the API.
- **Detail drawer always has a meaningful answer.** Even when the detail blob has been trimmed, the Table row's summary renders.
- **Filter-fingerprint cursor** prevents a client from accidentally paging through a filter mismatch (and surfacing data from a different filter's ordering).
- **Plain-text-only rendering rule** composes with the step-3 feature-folder ESLint gate — step 4 reuses it at zero marginal effort.

### Negative / trade-offs

- **Server-side summary counts on every request** at a full-partition scan. At low-thousands-of-rows this is <50 ms; if the store ever reaches tens of thousands, add a cached aggregation row. A watchpoint, not a design flaw.
- **Cursor is opaque but not cryptographically opaque.** A client can base64-decode to see the last `rowKey`. This is by design — the cursor exposes no secret, only referencing keys already in the payload.
- **Two store reads per detail fetch (Table + blob).** Lower latency than a single Graph call, but higher than reading a single denormalised row. Trade-off already made in ADR-0014 §3.3.
- **No `orderBy` parameter.** If a future user wants to sort by `priorityScore` or `severity` instead of `lastUpdateDateTime`, a new ADR adds it (the Table doesn't have the right indexes for cheap alternate orderings; a client-side sort of the current page is the v1 workaround).

### Neutral

- **Rate limits are per-Function-App-instance** (inherited from step 3). At Flex Consumption scale-out, effective limit is `limit × instanceCount`. Acceptable at single-user scale; centralised rate-limit ADR lands only if the deployment pattern multi-tenants.
- **`customTags` / `systemTags` are exposed** on both list and detail. No filter on tags in v1 (future additive ADR).

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Single `/api/incidents` returning summary + first page** | Mixes two cache domains (summary updates often, pages rarely beyond the first); complicates Cache-Control. Two endpoints. |
| **Offset-based pagination (`skip=`, `top=`)** | Doesn't survive row deletion between page fetches (retention trim); skip-pagination drifts. Cursor on `(lastUpdateDateTime, id)` is stable against trim. |
| **GraphQL single endpoint** | Introduces a query language surface the rate-limiter + SWA route rules can't enforce without a parser. REST is the right shape for a small tile/list/detail triple. |
| **Return full detail in the list response** | Blows up the list response size; defeats ADR-0014 §3.3 split. |
| **Long-polling or SignalR** for live updates | Out of v1 scope; polling at 60 s matches the 15-minute ingest cadence adequately. |
| **Fetch detail blob via SAS URL returned to the client** | Avoids a round-trip through the Function, but leaks a time-limited URL to the client that bypasses the route-rule + rate-limit controls. Direct-read via the Function keeps the boundary clean at v1 scale. |

## Related

- `PROJECT_BRIEF.md` §2 — Users (technical audience)
- `PROJECT_BRIEF.md` §6 — Autonomy model (read-only v1)
- `PROJECT_BRIEF.md` §11 — Observability (summary surface feeds the tile's freshness row)
- ADR-0005 — Input-handling controls (plain-text rendering inherits)
- ADR-0007 — Easy Auth configuration (authenticated+reader route gate)
- ADR-0009 — Frontend stack (Fluent UI v9, TanStack Query, feature-folder ESLint)
- ADR-0012 — Dashboard tile contract (Secure Score) — template this ADR inherits
- ADR-0013 — Incidents source + scopes (what feeds the store)
- ADR-0014 — Incidents cadence + schema (defines the store shape this API serves)
- ADR-0015 — Audit hash-chain (every run this ADR's data depends on is chain-audited)
- Microsoft Learn — [incident resource](https://learn.microsoft.com/graph/api/resources/security-incident)

---

*End of ADR-0016.*
