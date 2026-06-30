# ADR-0012 — Dashboard tile contract: Secure Score

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Build-order step 3 (brief §15) closes the first vertical: ingested Secure Score snapshots in Table Storage must surface on the dashboard as a tile, trend line, and freshness/health indicator. This is the first user-facing data surface in XDR Hub, and — like ADR-0011 for ingestion — its conventions set the template for every subsequent tile (incidents, Entra risk, CA coverage, stack/KEV, daily brief).

The tile-contract decisions to settle are specific and will repeat across every later vertical:

1. **The API shape** between the Function backend and the SPA — named endpoints, response JSON, error shapes.
2. **The tile layout** — what a reader sees in the 95th-percentile happy case and in the handful of failure modes (no data, stale data, degraded ingest, backend error, auth error).
3. **The trend primitive** — which chart library, what axes, what tooltip, how much history is rendered.
4. **The rendering safety rules** — Secure Score's `controlScores[].description` field is Microsoft-authored text; it is untrusted from the SPA's point of view (ADR-0005 Input-handling controls). Every tile going forward will have an equivalent "plainly-rendered-only" rule, and the pattern is set here.
5. **The caching / freshness contract** — how often TanStack Query refetches, how the tile shows freshness, when a stale-data badge appears.
6. **Accessibility and theming** — baseline for every future tile so a11y is not a per-tile argument.

The inverse is also true: **anything not fixed here becomes implicit.** If this ADR does not specify "no HTML in `description` fields", the first developer to wire up a tile will either reach for `dangerouslySetInnerHTML` because it is quick, or hand-roll a sanitiser and duplicate it three verticals later. ADRs exist to lock the non-obvious choice before it matters.

## Decision

### 1. API surface

Two endpoints are added to the Function App for step 3. Both live under `/api/secure-score/`, both are authenticated (SWA route rule `"allowedRoles": ["authenticated", "reader"]` — matches ADR-0007 §Authorisation model), both return JSON.

#### 1.1 `GET /api/secure-score/latest`

Returns the most recent snapshot and the ingest health state.

```json
{
  "schemaVersion": 1,
  "snapshot": {
    "snapshotDate": "2026-04-18",
    "createdDateTime": "2026-04-18T00:12:03Z",
    "ingestedAt":      "2026-04-19T03:02:18.902Z",
    "currentScore": 412.0,
    "maxScore": 697.0,
    "percentage": 59.1,
    "activeUserCount": 0,
    "licensedUserCount": 100,
    "enabledServices": ["HasExchange", "HasSharePoint", "HasInTune"],
    "averageComparativeScores": [
      { "basis": "AllTenants",    "averageScore": 37.0 },
      { "basis": "TotalSeats",    "averageScore": 46.0 },
      { "basis": "IndustryTypes", "averageScore": 109.0 }
    ],
    "controlScores": [
      { "controlCategory": "Identity", "controlName": "AdminMFA", "description": "Requiring multi-factor authentication…", "score": 35.0 }
    ]
  },
  "health": {
    "status": "healthy",
    "lastSuccessAt": "2026-04-19T03:02:18.902Z",
    "consecutiveFailures": 0
  }
}
```

If there is no snapshot yet (e.g. first deploy before the first Timer fire, or a run returned `no_data`): `snapshot = null`, `health.status = "awaiting_first_run" | "no_data"`. **The API never 404s on missing data** — a structured `null` keeps the client-side error shape simple.

If the role-authenticated user is missing required roles, SWA returns 401/403 before the Function is hit (ADR-0007 route rules). The Function itself never emits auth errors — that is the SWA layer's job.

`percentage` is computed server-side (`currentScore / maxScore * 100`, rounded to 1 d.p.) so every client renders the same rounded value. Clients never recompute this.

#### 1.2 `GET /api/secure-score/trend?days=<n>`

Returns up to `n` days of snapshots for the trend chart. Default `days = 90`, cap `days = 400` (matching ADR-0011 retention).

```json
{
  "schemaVersion": 1,
  "snapshots": [
    { "snapshotDate": "2026-01-20", "currentScore": 385.0, "maxScore": 697.0, "percentage": 55.2 },
    { "snapshotDate": "2026-01-21", "currentScore": 388.0, "maxScore": 697.0, "percentage": 55.7 }
  ],
  "range": { "from": "2026-01-20", "to": "2026-04-18", "requestedDays": 90, "returnedCount": 2 }
}
```

Sparse but continuous: days where the ingest succeeded with `no_data` are omitted entirely; the chart renders gaps, not zeroes. Trend endpoint does not include `controlScores` (payload keep-down).

**Resource-consumption controls.** An authenticated user can drive the trend endpoint repeatedly; the ADR-0007 `authenticated+reader` role gate bounds the attacker pool but does not bound server cost. The following controls apply to the trend endpoint (and become the template for every future "range query" endpoint):

1. **Server-side input validation.** `days` is parsed as an integer in the closed range `[1, 400]`. Non-integer, negative, or out-of-range values return `400 bad_request` with a structured `ApiError` (no partial results, no implicit clamping). An explicit clamp would be more permissive; a 400 keeps callers honest.
2. **Server-side response caching.** The Function responds with:
   - `Cache-Control: private, max-age=1800` — 30 minutes (matches the client-side `staleTime` for the `trend` query in §6 below). `private` because the response is per-tenant and must not be cached by any shared proxy.
   - `Vary: Cookie, Authorization` — response caching keys on the authenticated principal, not just the URL.
   An SWA-edge or browser disk cache absorbs the obvious repeats; a hot-loop attacker still hits Function compute on every first request per principal per cache window.
3. **Per-principal rate limit — design intent.** The v1 implementation enforces a per-principal rate limit of **60 `/trend` requests per minute** using an in-process sliding-window Map keyed by the SWA client-principal's object ID. Flex Consumption scale-out means each instance enforces locally; the limit is therefore effectively `60 × instanceCount`, which is acceptable at single-user-tenant scale (brief §2). Breach returns `429 Too Many Requests` with a `Retry-After` header. A centralised rate-limit ADR lands if the deployment pattern ever multi-tenants.
4. **No unauthenticated surface.** The SWA route rule `allowedRoles: ["authenticated", "reader"]` (ADR-0007) remains the primary DoS control; the server-side controls above are defence-in-depth layered beneath it.

The same four controls apply to `/api/secure-score/latest` (with `max-age=300` — 5 minutes — to match its tighter `staleTime`).

#### 1.3 Error shape (both endpoints)

The Function's own error responses (not SWA's auth ones) use the `ApiError` shape already established in `/api/src/lib/errors.ts` and `/web/src/api/client.ts`:

```json
{ "error": { "code": "internal_error", "message": "…", "correlationId": "<App Insights operation id>" } }
```

Status codes used:

- `500 internal_error` — unhandled exception
- `503 dependency_unavailable` — Table query failed (surfaced so the client can show a retriable banner without guessing)

**No secure-score-specific error codes in v1.** Reserved for later if a dashboard-level "stale data" response needs its own status.

### 2. Tile layout

One card at the top of the `HomePage`, above the existing `/ping` smoke-test area (which is demoted to a dev-only page under a query-string flag after step 3 — scoped to the step 3 code pass, not this ADR).

**Happy-path tile composition:**

```text
┌────────────────────────────────────────────────────┐
│ Secure Score                          [badge]      │  ← title row
│                                                    │
│  412 / 697                                         │  ← large numeric
│  59.1%                                             │  ← subline
│                                                    │
│  ────────╱─────────╲────────────                   │  ← 90-day sparkline
│                                                    │
│  Last ingested: 4 hours ago · Snapshot: 18 Apr    │  ← freshness row
└────────────────────────────────────────────────────┘
```

- **Numeric prominence** over percentage — matches how Microsoft reports it in the Security portal, respects the reader's existing mental model (brief §2 — technical audience).
- **Sparkline, not full chart**, in the tile. A full-size trend chart is a separate route (`/secure-score`) reached by clicking the tile; reserved for step 3's code pass.
- **Freshness row** shows the ingest timestamp (human-relative) and the snapshot date (absolute). Two distinct facts — when Microsoft computed it and when we wrote it.
- **Badge slot** on the title row surfaces health/staleness — see §3.

**Empty / loading states:**

- **Loading** (first render, TanStack Query `isPending`): skeleton tile, same dimensions, shimmer animation. Never a spinner.
- **Awaiting first run** (`snapshot = null`, `health.status = "awaiting_first_run"`): the tile shows an information tone, "Awaiting first ingest run. Next scheduled run: ~03:00 UTC tomorrow." and a "Run now" button (admin-only, hits `POST /api/ingest/secure-score/run`).
- **No data** (`snapshot = null`, `health.status = "no_data"`): informational tone, "No Secure Score is published for this tenant yet." No run-now action (it would not help).
- **Error** (TanStack Query `isError`): warning tone, error message from `ApiError.message`, correlation ID in small text, retry button.

### 3. Freshness and health badges

Badge states, in order of severity:

| State | Trigger | Badge text | Colour tone |
|---|---|---|---|
| Healthy | `consecutiveFailures === 0` **and** `ingestedAt` within 36h of now | (no badge) | — |
| Stale | `ingestedAt` >36h old (soft) | "Stale" | warning |
| Very stale | `ingestedAt` >72h old | "Very stale" | warning |
| Degrading | `consecutiveFailures ∈ {1, 2}` | "Ingest retrying" | warning |
| Degraded | `consecutiveFailures >= 3` | "Ingest failing" | danger |

Thresholds are client-side constants defined in `/web/src/features/secureScore/freshness.ts` so they are unit-testable without a server round-trip. The server-side `health.status` (read from the `IngestHealth` table per ADR-0011 §5a — not from the user-data `StackItems` table) is the source of truth for failure count; staleness is a client-side derivation from `ingestedAt`.

**No telemetry-sampling caveat:** these badges are based on the ops Table, not App Insights, so sampling does not hide a real failure.

### 4. Trend chart primitive

**Library: Recharts** (`recharts@2.x`). Rationale, weighing the viable options:

| Library | Bundle (gz) | TS types | Fluent-friendly | Notes |
|---|---|---|---|---|
| **Recharts** | ~45 kB | First-party | Works with any theme; we supply colours from `tokens` | **Selected.** |
| Victory | ~70 kB | First-party | More ceremony for simple line | |
| Nivo | ~60 kB | First-party | Opinionated look competes with Fluent | |
| Apache ECharts | >200 kB | Community | Too heavy for v1 | |
| `@fluentui/react-charting` | ~40 kB | First-party | Fluent v8 API, not v9 — mismatches our stack | Avoids v8/v9 mixing |

Recharts draws D3 under the hood, renders SVG (a11y-friendly by default), and its declarative JSX fits the rest of the SPA.

**Step 3 chart specifications:**

- **Sparkline in tile:** `LineChart` with `currentScore` on y-axis, `snapshotDate` on x-axis. No axes, no gridlines, no tooltip. Single coloured stroke, 1 px. Fixed height 48 px.
- **Full chart on `/secure-score` route (step 3 code pass):** axes, gridlines, hover tooltip showing `currentScore / maxScore (percentage%) on snapshotDate`, keyboard navigation.
- **Colour:** `tokens.colorBrandForeground1` from Fluent UI v9 for the happy-state stroke, `tokens.colorPaletteRedForeground1` when a future per-point threshold check flags a regression (not v1 — reserved).
- **Baseline / comparative overlay:** the `averageComparativeScores[]` values are shown on the **full chart** as faint horizontal reference lines (AllTenants, IndustryTypes). Not in the sparkline.

### 5. Rendering safety — untrusted fields

Secure Score returns `controlScores[].description` — authored by Microsoft, containing human-readable explanations of controls. It is **not** HTML-safe in general and must never round-trip through `dangerouslySetInnerHTML`.

Rules (binding on step 3 code and every future tile that surfaces Microsoft-authored prose):

- **Plain-text rendering only.** All prose fields render inside text nodes. React's default text-node escaping handles the common case.
- **No `dangerouslySetInnerHTML` anywhere in `/web/src/features/secureScore/`.** An ESLint rule (`react/no-danger`) is enabled for this feature folder in the step 3 code pass.
- **No derived-HTML rendering** (e.g. a Markdown processor) for v1. If Microsoft ever returns Markdown in Graph fields, that gets its own ADR with a sanitiser decision (DOMPurify or equivalent).
- **Textual whitespace normalisation** — collapse `\r\n` / multi-spaces to single spaces, trim, cap length at 2000 characters with a "…" affordance. Prevents runaway-long strings from overflowing a card.
- **Link-like strings are not auto-linkified.** If a `description` contains a URL, it renders as text. Auto-linkification would open an injection vector (`javascript:`, data-URI, etc.) — out of scope for v1.

These rules are **tested** in the step 3 code pass with a unit test that passes a deliberately hostile `description` (containing `<script>`, `"><img onerror=…>`, a `javascript:` URL) and asserts the rendered output contains **literal** escaped text.

### 6. Client-side caching and freshness

TanStack Query v5, already installed in `/web`. Per-query config:

| Query | `staleTime` | `refetchInterval` | `refetchOnWindowFocus` |
|---|---|---|---|
| `/api/secure-score/latest` | 5 min | 5 min | true |
| `/api/secure-score/trend` | 30 min | false | false |

Rationale:

- **5-minute stale window on `latest`.** Matches "fresh enough for a dashboard" — the data itself updates once per day, but the freshness badge benefits from a tighter refresh so a "degraded" flag clears fast after a successful re-run.
- **30-minute stale on `trend`.** 90 days of points rarely changes; no need to re-fetch aggressively.
- **Refetch on focus** for `latest` — when a reader tabs back to the dashboard after minutes away, they see current state without refreshing the browser.

Network errors surface via the standard `ApiError` wrapper; TanStack Query's built-in retry (default 3 attempts with exponential backoff) is kept. On persistent error, the tile's error state (§2) is shown.

### 7. Accessibility — baseline for every tile

- **Landmark and heading:** the tile is a `<section aria-labelledby="secure-score-heading">` with an `<h2 id="secure-score-heading">Secure Score</h2>`. Fluent `Card` is used as the visual container but does not replace semantic markup.
- **Numeric announcement:** the large score is accompanied by a visually-hidden phrase, "Current Secure Score four hundred twelve out of six hundred ninety-seven, fifty-nine point one percent." This is derived from the JSON via a `formatScoreForScreenReader()` util. Testable in isolation.
- **Sparkline:** has `role="img"` and an `aria-label` of "Ninety-day trend: current score increased from three hundred eighty-five to four hundred twelve." Trend narrative generated from first/last points.
- **Keyboard:** the tile is focusable (`tabIndex={0}`) and Enter / Space activates the navigation to the full `/secure-score` route.
- **Contrast:** Fluent UI v9 tokens are used throughout; no raw hex values. Both light and dark themes supported without per-tile code.
- **Motion:** respect `prefers-reduced-motion` — skeleton shimmer disabled, sparkline animation disabled.

These are baseline. Per-tile deviations require their own ADR note.

### 8. Cost-of-change surface

The tile contract has one visible moving part per schema bump: the `schemaVersion` on every response. Contract evolution rules:

- **Additive-only changes** (new optional fields) do not bump `schemaVersion`. Clients tolerate unknown fields.
- **Breaking changes** (removed field, type change, semantic change) bump `schemaVersion` and the client rejects a mismatched version at parse time with an informative error. This keeps broken-client surface local and visible.
- **Old versions are supported for one release minimum** so a dashboard running an older build against a newer Function App does not hard-fail on first load after deploy.

## Consequences

### Positive

- **One tile, one contract, repeatable.** Every future vertical (incidents, Entra risk, CA coverage, stack/KEV) uses the same freshness-and-health pattern, Recharts library, a11y baseline, and untrusted-field rules.
- **XSS attack surface is contained.** Microsoft-authored prose renders as literal text; a Recharts-only choice removes the need for inline SVG from user/Microsoft data. ESLint gates the class of bug.
- **Server-computed `percentage`** removes a source of client-side drift between tiles and any exported CSV (step 10).
- **Structured error shape** reuses the existing `ApiError` path; no bespoke handling at call sites.
- **Dashboard is useful on day one of step 3.** Empty-state + run-now button closes the gap between first deploy and first Timer fire.

### Negative / trade-offs

- **Recharts is a chart library; it is not Fluent.** Visual polish is our job. For v1 a single simple line chart is the entire surface area — acceptable.
- **Server-computed derivations (`percentage`) mean every new derived field is a Function change.** Preferable to client drift in v1; revisit only if client-side math becomes cheap and typed enough to be safe (e.g. a shared `@aegis/score-utils` package).
- **TanStack Query focus-refetch** can surprise users on poor connectivity — they tab back, the UI "does something". Acceptable for a technical-audience tool; revisit if the audience broadens.
- **Sparkline without axes** is a judgement call — regression in score relative to a specific threshold is not prominent without the full chart. Click-through to `/secure-score` is the escape hatch.

### Neutral

- **`snapshotDate` is a string, not a Date.** Kept as an ISO date string (YYYY-MM-DD) on the wire; the SPA parses with `Date.UTC` for chart x-axis positioning. No timezone drift, matches what Graph gives us.
- **Percentage rounded to 1 d.p.** is a policy choice that may be revisited for export formats.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Client computes `percentage`** | Risks two tiles displaying slightly different numbers due to rounding differences; centralise server-side. |
| **Chart library per tile** | Invites inconsistency. One primitive across the dashboard. |
| **SSR or static rendering** | SWA Standard supports it, but the dashboard is intrinsically interactive and per-session — SSR buys nothing. |
| **Embed Microsoft Defender widgets / iframes** | Violates single-tenant-data-sovereignty principle (data leaves our Function) and breaks tenant-restricted access. |
| **Single `/api/secure-score` endpoint returning latest + trend** | Mixes caching domains (`latest` changes frequently, `trend` rarely). Two queries, two cache windows. |
| **Mix Fluent UI v8 `react-charting` with v9 components** | v8/v9 token systems differ; mixing them is a known source of theme drift. Pay once (Recharts) over paying again per tile. |
| **Render `description` fields with Markdown** | Unsolicited formatting surface; untested against Microsoft's actual content shape. Plain-text-only until data says otherwise. |

## Related

- `PROJECT_BRIEF.md` §2 — Users (technical audience, language register)
- `PROJECT_BRIEF.md` §9 — Security posture (the tool is a security tool; tile must meet its users' bar)
- `PROJECT_BRIEF.md` §11 — Observability (freshness badge bridges ingest and UI)
- ADR-0005 — Input-handling controls (rendering-safety rules inherit from this)
- ADR-0007 — Easy Auth configuration (route roles consumed by these endpoints)
- ADR-0009 — Frontend stack (Fluent UI v9, TanStack Query)
- ADR-0010 — Graph permissions model and consent flow (ingest scope the tile consumes)
- ADR-0011 — Ingestion schedule and retry (produces the rows this tile reads; health flag is defined there)
- Recharts — https://recharts.org/

---

## Amendments

| Date | Author | Change | Driven by |
|---|---|---|---|
| 2026-04-18 | Ben Thomas | §1.2's two-tier caching plan adjusted after live UX observation: server `Cache-Control` on `/api/secure-score/latest` reduced from `private, max-age=1800` to `private, max-age=30`. The original 1800s aligned to the client TanStack Query `staleTime` (5 min) for DoS absorption, but the two caps stacked such that a successful Run-now ingest did not surface on the tile for up to 5 minutes after action. Client `staleTime` (5 min) is the primary throttle; server 30s cap still absorbs the obvious burst case. `/trend?days=<n>` keeps its 30-minute cap — trend data changes daily at most. | Live test of the admin Run-now flow, 2026-04-18. |
| 2026-04-18 | Ben Thomas | §1.1's response-state mapping clarified: when `snapshot = null` and an `IngestHealth` row exists, the wire `health.status` passes through from the row (`failing` / `degrading`) rather than being flattened to `no_data`. `no_data` is reserved for `snapshot = null AND health.status = healthy`, which is the "Graph returned no Secure Score for this tenant yet" case. The original §1.1 implementation conflated the three states; the tile's EmptyState component returned early on `no_data` without rendering Run-now, leaving admins unable to retry a failing ingest. Fixed in `api/src/functions/getSecureScoreLatest.ts`. | Live test where `IngestHealth.Status = failing, ConsecutiveFailureCount = 4` surfaced as `no_data` on the tile, 2026-04-18. |
| 2026-04-18 | Ben Thomas | Tile's Run-now handler made deterministic: instead of `qc.invalidateQueries` relying on a subsequent refetch (which hits the browser HTTP cache), the handler now issues a direct `fetch(..., {cache: "no-store"})` on `/latest` after ingest success and pushes the fresh body into React Query via `setQueryData`. `/trend` is still invalidated because the new point lands in the sparkline. | Same live session; browser cache (even at the new 30s cap) otherwise delayed the tile transition. |

---

*End of ADR-0012.*
