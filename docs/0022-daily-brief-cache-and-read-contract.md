# ADR-0022 — Daily-brief cache and read API contract

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0018 §Decision.5 pre-committed the **existence** of a staleness ceiling on the cached brief — a finite bound so a sustained budget-drain / content-filter / tamper attack cannot suppress new critical signals indefinitely. The numeric ceiling and the concrete read contract were deferred to this ADR.

ADR-0020 locked the brief-agent's output envelope (JSON with `headline`, `severity`, `narrative`, `openQuestions`, `sourcesUsed`). ADR-0021 locked the audit-chain commitment (`outputSha256`, read-path verification on GET). This ADR settles:

1. **Cache location** — Table row for summary + Blob for body (same split as ADR-0014 §3 incidents, inherited pattern).
2. **Cache key + retention** — per-day keying, env-aware retention (180d prod / 14d dev) + lifecycle deletion.
3. **Freshness + staleness ceiling** — three states: fresh, stale-but-serveable, unavailable.
4. **Read API surface** — `GET /api/brief/latest` (tile + full page), `GET /api/brief?date=yyyy-mm-dd` (day-specific historical read).
5. **RBAC on `daily-briefs`** — agent MI writes; api-reader MI reads.
6. **Web rendering contract** — markdown pipeline with HTML disabled; sourcesUsed → UI attribution.
7. **Admin manual-trigger behaviour** — how `POST /api/ingest/brief/run` interacts with the cache.

## Decision

### 1. Storage shape — `BriefCache` Table row + `daily-briefs` blob

**Split pattern** (mirrors ADR-0014 §3 Incidents):

- **`BriefCache` Table** — one row per `(tenantId, yyyy-mm-dd)`. Summary fields for the tile + the pointer to the blob.
- **`daily-briefs` container** — one blob per day: `daily-briefs/<yyyy>/<mm>/<dd>.json`. Body is the validated JSON envelope (ADR-0020 §Decision.2 shape).

**`BriefCache` schema:**

| Column | Type | Notes |
|---|---|---|
| `PartitionKey` | `<tenantId>` | |
| `RowKey` | `<yyyy-mm-dd>` (UTC) | |
| `Status` | `fresh \| stale \| unavailable` | Derived at write time; re-evaluated by the read endpoint against current UTC time. |
| `Headline` | string (truncated 512c) | From ADR-0020 `headline` field. On the row so the tile renders without fetching the blob. |
| `Severity` | `informational \| notable \| urgent` | From ADR-0020 `severity` field. |
| `SourcesUsed` | JSON-encoded `string[]` | From ADR-0020 `sourcesUsed`. |
| `BlobPath` | `daily-briefs/<yyyy>/<mm>/<dd>.json` | Derivable but cached as a hint. |
| `OutputSha256` | 64-char lowercase hex | Matches the chain's `outputSha256` (ADR-0021). The read endpoint verifies the blob body against this hash. |
| `GeneratedAt` | ISO8601 UTC | Timestamp the brief-agent run completed. |
| `IngestRunId` | GUID | Correlates to the audit-chain `agent.aegis.brief` line with `runId`. |
| `PromptInjectionCandidates` | int | Copied from the audit line for quick UI surfacing. 0 on clean runs. |
| `SourceFabrications` | int | Copied from the audit line. 0 on clean runs. |

**Why split:** the Table row is fetched cheaply for the tile; the blob is fetched only when the user opens the full brief view. Matches the Incidents Table + detail-blob pattern already in place.

**Blob body** — exactly the ADR-0020 JSON envelope, pretty-printed with `application/json; charset=utf-8`, no compression at the blob layer. `outputSha256` = SHA-256 of the raw UTF-8 bytes written to the blob.

### 2. Retention + lifecycle

- **`BriefCache` Table rows** — trim-at-write after each successful brief run: `DELETE WHERE LastUpdateDateTime < now - retentionDays`. Same pattern as `Incidents` (ADR-0014 §5).
- **`daily-briefs` blobs** — Azure Storage lifecycle management policy:
  - Prod: `Delete after 180 days from modification`.
  - Dev / test: `Delete after 14 days from modification`.
  - Same env-aware sentinel-0 pattern as `INCIDENTS_RETENTION_DAYS`: `BRIEF_RETENTION_DAYS = 0` in app settings → resolves to `isProd ? 180 : 14` in Bicep.
- **Versioning + change feed + soft-delete** — 7-day window on the `daily-briefs` container, matching `incidents-detail` (ADR-0014 §3.2). Compensating controls for the agent MI's Blob Data Contributor role.

**Lifecycle-only-deletes invariant** (same as ADR-0014 §3.3): agent MI has `Storage Blob Data Contributor` which includes delete capability, but NO code path calls `delete`. Deletion is driven exclusively by the lifecycle management policy. Any future code path that calls `deleteBlob` on this container breaks the integrity-of-write model and requires an ADR that reopens this paragraph.

**Test-time enforcement (WS10 SEC-L):** the step 5 Phase 3 code pass lands a unit test that greps the compiled `/api/src/**/*.ts` tree for `.deleteBlob(` / `.deleteBlobs(` / `BlobContainerClient.delete(` with exemptions for the `incidents-detail` path (none expected) and the `daily-briefs` path (none expected). A match fails the test suite. This is a test-time gate, not a runtime one — a bug that somehow bypassed code review would still be caught in CI before shipping.

### 3. Staleness ceiling — three freshness states

Numeric values lock here (deferred from ADR-0018 §Decision.5):

| State | Condition | Read response | UI treatment |
|---|---|---|---|
| `fresh` | `now - GeneratedAt < 26h` | 200 with `status = "fresh"` | Normal tile rendering; no banner. |
| `stale` | `26h <= now - GeneratedAt < 72h` | 200 with `status = "stale"` + `cacheOutcome = "stale_hit"` on the audit line | Yellow "stale" badge; serve the cached brief; the read endpoint triggers a manual re-run path (next successful run replaces the cache). |
| `unavailable` | `now - GeneratedAt >= 72h` | `200` with `status = "unavailable"` + `headline = null`, `body = null` | Red "unavailable" banner on the tile: *"Daily brief has not refreshed in over 72 hours. Admin: trigger a manual run or investigate the agent chain."* No stale content served. |

**`fresh < 26h`** — the brief-agent Timer fires at 06:00 UTC; a 24h window with 2h of scheduling slack covers late fires + cold-start lag + App-Insights-ingest-lag.

**`stale >= 26h`** — at this point the schedule missed a day. Serve the cached brief but badge the tile loudly.

**`unavailable >= 72h`** — three consecutive days without a fresh run. Stop serving stale content; force the operator to investigate. This is the ADR-0018 §Decision.5 "bounded staleness" invariant concretely numeric: a sustained budget-drain / tamper / outage cannot pin the dashboard to three-day-old content indefinitely.

**Why 72h (not 48h, not 7d):** 48h is too tight given timezone + ops-store-lag edge cases (a brief run that completed successfully at 23:59 UTC two days ago is only ~48h old on read at 00:00 UTC today). 7d is too loose — a full week of pretending the brief is available would mask a sustained attack. 72h is one working long-weekend + one day; matches the typical cadence the maintainer checks on the dashboard.

### 4. Read API surface

Three endpoints, all GET, all `[authenticated, reader]` at the SWA route layer:

#### 4.1 `GET /api/brief/latest`

Returns the most recent non-`unavailable` brief or an `unavailable` shape. Tile-friendly; includes the body inline (one fetch renders the whole UI).

**Response:**

```json
{
  "schemaVersion": 1,
  "status": "fresh",
  "generatedAt": "2026-04-19T06:00:12.342Z",
  "stalenessMs": 3600000,
  "brief": {
    "schemaVersion": 1,
    "headline": "…",
    "severity": "informational",
    "narrative": "…",
    "openQuestions": ["…"],
    "sourcesUsed": ["SecureScore", "Incidents", "IngestHealth"]
  },
  "integrity": {
    "outputSha256": "a3f6…",
    "ingestRunId": "…",
    "verified": true
  },
  "flags": {
    "promptInjectionCandidates": 0,
    "sourceFabrications": 0
  }
}
```

**Unavailable shape:**

```json
{
  "schemaVersion": 1,
  "status": "unavailable",
  "generatedAt": "2026-04-16T06:00:04.221Z",
  "stalenessMs": 259200000,
  "brief": null,
  "integrity": { "outputSha256": null, "ingestRunId": null, "verified": false },
  "flags": { "promptInjectionCandidates": 0, "sourceFabrications": 0 }
}
```

**Server flow:**

1. Read `BriefCache` most-recent row for tenant (descending RowKey — first row is latest).
2. Compute staleness state from `GeneratedAt` vs `now` per §3.
3. If `unavailable`: return unavailable shape. No blob read.
4. Otherwise: fetch blob at `BlobPath`, verify SHA-256 against `OutputSha256` (ADR-0021 §Decision.2 read-path check). On mismatch (WS10 SEC-H-ADR-22-01 resolution):
   - **Append an `agent.run` audit line** via the audit-MI-scoped `appendAuditLine` helper with `status="error"`, `error.kind="output_tamper"`, `cacheOutcome="miss"`, `tokensIn=0`, `tokensOut=0`, `agentName="brief"`, `modelDeployment="aegis-small"`, `outputSha256=null`, `runId=<new UUID>`. This is the audit-chain-plane signal — the chain self-describes as "the single source of truth for what the operator saw" (ADR-0021 §Decision.6), so a mismatch MUST land there. A compromised agent MI that tampered the blob cannot suppress this write: the audit MI is a separate identity (ADR-0021 §Decision.3 writer-singleton), and the read handler runs under the api-reader MI (neither has write to the audit container beyond calling through the audit-MI-scoped helper).
   - Emit `BriefOutputTamperCandidate` App Insights event (complementary telemetry-plane signal; App Insights retention + RBAC differs from the audit chain but the chain is the load-bearing record).
   - Respond with `status = "unavailable"` + `verified: false` even if the staleness is fresh. Loud, visible failure — NOT a silent degradation.
5. On clean verify, append `agent.run` audit line with `eventType="agent.run"`, `cacheOutcome = "hit"` (or `"stale_hit"` if staleness state is `stale`), `tokensIn=0`, `tokensOut=0`, `agentName="brief"`, `modelDeployment="aegis-small"` (copied from the row's originating run — WS10 SEC-M-ADR-22-01 resolution; ADR-0021 §Decision.5 invariant-integrity verifier exit code 2 hard-fails any line with `modelDeployment ∉ ["aegis-small"]`), `status="success"`, `outputSha256 =` (the cached hash verified above), `runId =` new UUID for the read, `ingestRunId =` copied from the row for correlation back to the originating run.
6. Cache-Control: `private, max-age=60`.

**Rate limit:** 60 req/min per principal (same tier as other read endpoints).

#### 4.2 `GET /api/brief?date=yyyy-mm-dd`

Historical read — serves any brief in the retention window. Useful for day-specific investigation (e.g., "show me the brief from Monday"). Not on the tile; accessed via the brief's full-page UI.

- **Query param `date`** — strict `YYYY-MM-DD` regex. No time portion. Reject anything else with 400 `bad_request`.
- **Window check** — `date` must be within `[now - retentionDays, now]`. Out-of-range: 400.
- **Missing row** — 404 with `code: "not_found"`. **Oracle-surface note (WS10 SEC-L):** a 404 vs 200 response difference on `?date=` is minimally exploitable as an enumeration oracle (an attacker with a valid SWA session can probe "did a brief run on date X?"). Accepted: the answer is already observable via the tile's `generatedAt` + any operator-visible UI history; the 404 does not leak any data beyond what an authenticated reader would see via `/api/brief/latest` plus dashboard history. If a future ADR introduces brief-agent gating (e.g. "restrict brief access to specific users"), the 404-vs-200 difference becomes a real oracle and that ADR revisits this paragraph.
- **Staleness classification** — NOT applied here. A historical brief is classified by the date query, not by age. The response carries `generatedAt` and the client chooses how to render.
- **Integrity check** — same SHA-256 verification as §4.1. Mismatch → 503.
- **Audit line** — same `cacheOutcome = "hit"` audit pattern (with `source = "agent.aegis.brief"` — the same chain).
- Rate limit: 30 req/min per principal (tighter — historical access is lower-frequency).

#### 4.3 `POST /api/ingest/brief/run` (admin-only)

Defined by ADR-0020 §Decision.3. Admin-gated. Bypasses the cache: always triggers a fresh `runBriefAgent`, writes a new `BriefCache` row for today (replacing any existing row for today), writes the `daily-briefs/<yyyy>/<mm>/<dd>.json` blob (overwrites same-day), appends an `agent.run` audit line with `cacheOutcome = "miss"`. `ManualRunsAttempted` counter increments.

### 5. RBAC on `daily-briefs`

Matches the `incidents-detail` pattern (ADR-0014 §3.3):

- **Agent MI** — `Storage Blob Data Contributor` on the `daily-briefs` container (write path for `runBriefAgent`). Container-scoped, not account-scoped.
- **API-reader MI** — `Storage Blob Data Reader` on the `daily-briefs` container (read path for `/api/brief/latest` + `/api/brief?date=…`).
- **Lifecycle-only-deletes invariant** stated again per §2.

**Azure Table RBAC on `BriefCache`:**

- **Agent MI** — `Storage Table Data Contributor` scoped to the `BriefCache` table only (per-table scoping per ADR-0011 §5a — `:name` ABAC attribute not supported on Tables, so per-table assignments are the pattern).
- **API-reader MI** — inherits the existing `Storage Table Data Reader` at the tableService scope (already covers `BriefCache`).

### 6. Web rendering — safe markdown, HTML-stripped

The brief body is markdown (ADR-0020 §Decision.2). The SPA renders via a **constrained markdown pipeline** — HTML passthrough disabled AND URL schemes allow-listed (WS10 SEC-M-ADR-22-03 resolution; `skipHtml: true` alone doesn't close markdown-link-scheme attacks like `[x](javascript:...)` or `data:` payloads).

- **Library:** `react-markdown >=9.0.0` (pinned minimum — step 5 Phase 3 code pass pins the exact version in `web/package.json` and the Dependabot configuration watches it).
- **Configuration:**
  - `skipHtml: true` — no `<tag>` in markdown text is treated as HTML; renders as literal text.
  - **Explicit `urlTransform` allow-list** — the `react-markdown` `urlTransform` prop is set to a function that accepts `http:`, `https:`, and relative (same-origin) URLs ONLY. Returns the empty string for any other scheme (`javascript:`, `data:`, `vbscript:`, `file:`, `ftp:`, non-BMP Unicode-bypass forms, percent-encoded scheme-smuggling). Links with rejected schemes render as plain-text anchors with no `href`.
  - `components` override: custom renderers for `img` (returns `null` — no images allowed; brief is pure text), `a` (allow-listed `href` only; otherwise plain-text), `iframe` (returns `null`), `script` (returns `null`; `skipHtml` should prevent reaching this branch, defence-in-depth).
  - No `rehype-raw` plugin (would re-enable HTML passthrough).
- **ESLint `react/no-danger: error`** override extended to `src/features/brief/**` at the same time as the feature folder lands (matches ADR-0016 §6 precedent).
- **XSS defence test** — fixture asserts no `<img>`, `<script>`, or `<iframe>` in the rendered DOM for each of the following 11 hostile inputs (extended list — WS10 SEC-M-ADR-22-03):
  1. `<img src=x onerror="alert(1)">`
  2. `<script>alert(2)</script>`
  3. `<iframe src="evil.com">`
  4. `[click](javascript:alert(3))`
  5. `[click](data:text/html,<script>alert(4)</script>)`
  6. `[click](vbscript:msgbox(5))`
  7. `[click](file:///etc/passwd)`
  8. `[click](JAVASCRIPT:alert(6))` (case-smuggling)
  9. `[click](java\u0000script:alert(7))` (null-byte-smuggling)
  10. `![img](javascript:alert(8))` (image-link scheme)
  11. `<!-- <script>alert(9)</script> -->` (HTML-comment smuggling)

  Every case: the rendered markdown either strips the URL (`urlTransform` returns empty) OR renders as literal text (`skipHtml`), with zero executable sinks in the DOM.

**`sourcesUsed` → UI attribution:** the tile shows the source list as badges at the bottom ("SecureScore · Incidents · IngestHealth"). A source NOT in the server's authoritative builder set triggers `source_fabrication` at the adapter layer (ADR-0020 §Decision.2) — never reaches the UI.

### 7. Admin manual-trigger interaction with the cache

`POST /api/ingest/brief/run` bypasses the cache entirely. Specifically:

- **Does NOT check freshness before running** — the manual trigger is "generate a fresh brief now"; a bored operator running it five times in a row burns `ManualRunsAttempted` (30/day ceiling per ADR-0020 §Decision.3) and generates five fresh briefs.
- **ETag-lease on `BriefCache` row writes** (WS10 SEC-M-ADR-22-02 resolution). The Timer and a concurrent manual trigger CAN fire at the same UTC day. Both `runBriefAgent` code paths read `BriefCache` for today's row under ETag, write the blob at `daily-briefs/<yyyy>/<mm>/<dd>.json`, then commit the row with `IfMatch`. A 412 Precondition Failed on the row write means a concurrent run committed first; the losing run records the race rather than overwriting:
  - **Losing run writes a distinct audit line** with `supersedingRunId = <winning runId>` (new field on ADR-0021 §Decision.2 `AuditLineFields`, optional, only populated when a race was observed), `status="no_data"`, `cacheOutcome="miss"`. The blob it already wrote becomes orphaned; a periodic sweep (tracked operational follow-up, not blocking) cleans up blobs whose hash doesn't appear on any `BriefCache` row's `OutputSha256` within retention.
  - **Winning run writes normally.** The audit chain retains both lines (winner + loser); the chain invariant that every run is recorded is preserved.
  - **Read endpoints do NOT spuriously emit `BriefOutputTamperCandidate`** during the race window because the SHA-256 verification is against the row's `OutputSha256` — which is atomically committed with the row. A mid-race read sees either the pre-race row (blob verify against pre-race hash; clean) or the post-race row (blob verify against post-race hash; clean). The blob overwrite and the row commit are NOT transactional across stores, but the invariant "row's OutputSha256 matches the blob at BlobPath" holds because the winning run commits the row AFTER writing the blob.
- **Overwrites today's `BriefCache` row + blob** — each run's `OutputSha256` replaces the prior (when the run WINS the ETag race). The audit chain records every run (including the losing-race run with `supersedingRunId`) — no overwrite in the chain, every `agent.run` line immutable per ADR-0015.
- **Reset the staleness clock** — after a successful manual run, `status = "fresh"` until the next 26h boundary.
- **Budget-exceeded refusal** — if `TokensInToday + TokensOutToday + estTokens > TokensBudget` (ADR-0019 §Decision.2), the manual run is refused with `AgentFetchError(kind: "budget_exceeded")`; the existing cache entry remains unchanged.

## Consequences

### Positive

- **Three-state freshness (`fresh | stale | unavailable`)** closes the ADR-0018 §Decision.5 bounded-staleness invariant concretely. A sustained outage / attack cannot pin the dashboard to stale content indefinitely.
- **Split Table + blob** — tile renders fast (one Table read), full brief renders on demand (one blob read).
- **Read-path SHA-256 verification** — matches ADR-0021 §Decision.2; an agent-MI overwrite of the blob post-chain-commit fails the integrity check + surfaces `BriefOutputTamperCandidate`.
- **Historical read endpoint** — operator investigation of past briefs within retention, without bloating the tile's payload.
- **Markdown pipeline with HTML disabled** — inherits the ADR-0012/0016 plain-text rendering rule.
- **Admin manual-trigger interacts cleanly** with budget + cache + audit — no special code path, just reuses the orchestrator with `cacheOutcome="miss"`.

### Negative / trade-offs

- **72h staleness ceiling is coarse.** A brief that last refreshed 71h 59min ago is still `stale` not `unavailable`; at hour 72:01 the tile flips. Acceptable — the UX is operator-focused, and the 2-minute granularity doesn't matter for daily rhythm. A future ADR could introduce a 1h grace window if UX feedback demands it.
- **`BriefCache` table per-day rows accumulate** at retention cap (180d prod) → 180 rows per tenant. Trivial — Table Storage handles millions per partition efficiently.
- **Markdown rendering slightly slower than plain text** — 1000-word narrative in markdown = ~5ms render. Negligible.

### Neutral

- **Retention env-default inherits** the `INCIDENTS_RETENTION_DAYS` pattern. Operators familiar with incidents tune the brief the same way.
- **`sourcesUsed` UI display** is additive — future agents' sources render in the same pattern.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Serve stale content indefinitely** | Fails ADR-0018 §Decision.5 bounded-staleness invariant. Directly the failure mode we want closed. |
| **In-memory cache only** | Lost across Function App cold-starts (Flex Consumption). Durable cache = Blob + Table is correct for persistence. |
| **Single blob with all historical briefs** | Unbounded growth; every read touches a growing file. Per-day blob is O(1) per read. |
| **7-day staleness ceiling** | Too loose — a full week of "brief exists" could mask a sustained drain. 72h is three times the cadence, long-weekend-tolerant. |
| **Markdown → plain-text conversion on read** | Loses headings + list structure the operator finds useful. Safe markdown rendering is the right compromise. |
| **Outbound `href` in brief content** | Adds URL rendering surface that the agent's prompt sanitiser doesn't currently cover. ADR-gated if a future use case emerges. |
| **`dangerouslySetInnerHTML` with hand-rolled sanitiser** | Fails the `react/no-danger: error` ESLint gate (ADR-0012 §5). Safe markdown library with HTML off is the correct path. |
| **Audit-log cache hits to a separate surface** | Breaks ADR-0021 §Decision.6 "what the operator saw" invariant. Cache hits go on the chain. |

## Related

- `PROJECT_BRIEF.md §4` — Data and memory model (ops store + retention)
- `PROJECT_BRIEF.md §6` — Autonomy model (Tier 1 — surfaces only)
- `PROJECT_BRIEF.md §11` — Cost + observability
- ADR-0012 §5 — Plain-text rendering rule
- ADR-0014 §3 — Table + blob split pattern (inherited here)
- ADR-0016 §6 — `react/no-danger` ESLint override (extended to brief feature)
- ADR-0017 — Foundry identity + region (upstream constraint)
- ADR-0018 §Decision.5 — Bounded-staleness invariant (this ADR locks the numbers)
- ADR-0019 — Orchestrator + budget (budget-exceeded refusal path in §Decision.7)
- ADR-0020 §Decision.2 — Brief output schema (cache contents)
- ADR-0020 §Decision.3 — Admin manual-trigger (consumer of §Decision.7)
- ADR-0021 §Decision.2 — Read-path SHA-256 verification (implemented in §Decision.4 here)
- ADR-0021 §Decision.6 — Cache-hit audit (implemented in §Decision.4 here)

---

*End of ADR-0022.*
