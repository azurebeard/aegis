# ADR-0026 — Centralised rate-limiter strategy

**Status:** Accepted
**Date:** 2026-04-20
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

`api/src/lib/rateLimit.ts` exposes nine in-process `SlidingWindowRateLimiter` instances backed by a `Map<string, number[]>` of timestamps. At single-Function-App-instance scale this is correct; on Flex Consumption the host scales horizontally and the effective ceiling becomes `limit × instanceCount`. WS10 has repeatedly accepted this with a tracked follow-up: WS10 SEC-L-UI-POLISH-03 resolution (HANDOVER §10.0b), the Phase 1 admin-settings `settingsPatchRateLimiter` Low (WS10 verdict 2026-04-20 Phase 1), and the Option C bundle Low. Each verdict closed with "ADR for centralised limiter still tracked in §6.3." This is that ADR.

### Inventory at time of writing (2026-04-20)

| Limiter | Scope | Ceiling | Key | Caller |
|---|---|---|---|---|
| `trendRateLimiter` | per-principal | 60/min | principal | `getSecureScoreTrend` |
| `incidentsSummaryRateLimiter` | per-principal | 120/min | principal | `getIncidentsSummary` |
| `incidentsListRateLimiter` | per-principal | 60/min | principal | `getIncidentsList` |
| `incidentsDetailRateLimiter` | per-principal | 60/min | principal | `getIncidentDetail` |
| `riskyUsersSummaryRateLimiter` | per-principal | 120/min | principal | `getRiskyUsersSummary` |
| `riskyUsersListRateLimiter` | per-principal | 60/min | principal | `getRiskyUsersList` |
| `entraRiskAdminRunRateLimiter` | per-tenant | 30/day | tenantId | `runEntraRiskIngest` |
| `secureScoreAdminRunRateLimiter` | per-tenant | 30/day | tenantId | `runSecureScoreIngest` |
| `incidentsAdminRunRateLimiter` | per-tenant | 30/day | tenantId | `runIncidentsIngest` |
| `settingsPatchRateLimiter` | per-tenant | 30/day | tenantId | `patchSettings` |

Out-of-scope for this ADR because it already uses durable state:

- `runDailyBrief` — ceiling is enforced via `AgentBudget` table row (`BriefManualRunCeiling`, ADR-0019 §Decision.2 + ADR-0025 §9.5). Table ETag-lease, zero per-instance drift. The brief therefore dodges the in-process-Map problem entirely.

### Threat surface and Flex-scaling impact

The limiters are **defence-in-depth, not the authoritative control.** SWA role rules gate admin paths; Entra app-role gates reader paths; Flex concurrency caps bound Foundry + Graph throughput structurally. A compromised limiter widens the window for:

- A signed-in admin hammering Refresh-now: could over-consume Graph quota (daily call cap). Effective ceiling `30/day × instances` at peak-scale. On this deployment, Flex typically sits at 1 instance and scales to ~2–3 under brief peaks — so in practice the ceiling is 30–90/day/tenant, not 30/day. Graph's daily call budgets are multi-thousand per scope; single-tenant scale cannot burn that even at 90/day.
- A signed-in reader looping the summary endpoint: could push ops-storage read quota. 120/min × 3 instances = 360/min × 1440 min = ~500K reads/day. Still inside the Table-service per-account read cap (20,000 req/s = 1.7B/day).
- An admin PATCH on `/api/ingest/settings`: 30/day × 3 instances = 90 writes/day. TenantSettings table is cold — no contention.

At **single-tenant, single-operator scale**, the multiplier is immaterial. The concern is that the ceiling no longer expresses a predictable operator intent — the HANDOVER and ADR prose say "30/day" but the deployed behaviour is "30–90/day depending on scale". That's the problem this ADR commits to solving; WHEN it solves it is the interesting question.

### What centralising would look like

The data structure for a sliding-window limiter is:

- A keyed bucket of timestamps within the window.
- Atomic read-prune-append under a lease.

The in-process `Map<string, number[]>` provides this trivially with O(1) amortised operations. A centralised equivalent needs shared-memory semantics across N hosts with sub-50 ms latency to not blow the hot read path. Three realistic targets:

**A. Azure Cache for Redis.** Native fit. Atomic `MULTI/EXEC` with `ZADD` + `ZREMRANGEBYSCORE` + `ZCARD` implements a sliding window in 4 round-trips. Sub-10 ms p50 in-region. Downside: new dependency, new cost tier (Basic C0 ~£13/mo, Standard C0 ~£34/mo with HA), new identity surface (MI grant on the cache resource), new container for connection management. Pattern is textbook.

**B. Azure Table Storage counter rows.** Reuse the existing ops storage account + MI. Per-window rowkey (e.g. `<principal>:<yyyy-mm-ddTHH:mm>` for per-minute, `<tenant>:<yyyy-mm-dd>` for per-day) with ETag-lease increment. Zero new deps, zero new cost, consistent with `AgentBudget` / `IngestHealth` precedent. Downside: Table Storage writes are ~10–30 ms and burn one storage op per request — at 6K req/min (worst case inventoried above) that's 100 ops/sec sustained, inside per-partition limits (500 ops/sec) but not comfortable if usage grows. Table-level writes also have a contention edge on the short per-minute RowKey if multiple instances hit the same minute-bucket simultaneously (ETag 412 → retry → extra round trips).

**C. Durable Function Entities.** Single logical actor per limiter key, framework-managed serialisation. Correct semantics, but Durable adds a runtime dependency, a new hub + storage footprint, and a deployment complexity that dwarfs the problem. Out.

There is no credible edge-layer option: Front Door can rate-limit per IP but cannot scope to Entra principal or tenantId, and its budget-exhaustion 429 response bypasses the app's ingest-health / audit plane.

## Decision

### 1. Defer migration until a named trigger fires

The in-process limiter stays as the default. Migration is not scheduled. A migration commit must cite at least one of the following observed triggers, not speculation:

1. **Multi-tenant deployment.** Any change that runs more than one tenant on the same Function App / SWA tuple — immediately material because `tenantId`-keyed limits share the same Flex-scale multiplier but cross-tenant "fairness" is now a concern, not just per-tenant predictability.
2. **Observed Flex-scale drift at the ceiling.** A 7-day window in which (a) the Flex instance count crosses 3 for any sustained period (≥1h above) AND (b) the rate of 429s plateaus below the operator-intended ceiling. Both axes are observable from App Insights today (§Decision.4). A third confirming signal — Graph quota utilisation exceeding 50% of tenant cap — would reinforce the trigger if available via Graph throttling headers or usage reports, but its absence does not block migration: two-axis drift is sufficient because the "effective ceiling no longer matches stated ceiling" claim holds on those two alone.
3. **Compliance ask.** An external auditor requests proof that "30 admin runs per day per tenant" is enforced irrespective of scale. Multi-instance Flex cannot produce that proof today.
4. **Incident caused by the multiplier.** A signed-in admin burns Graph quota on a runaway Refresh-now loop, the in-process limiter held at 30 per instance, Flex was at N instances, and the observed rate was 30N/day. The incident writeup is the trigger.

Absent any of those four, the code stays as written.

### 2. Pre-select the migration target as **Azure Table Storage counter rows (Option B)** with Azure Cache for Redis (Option A) as the escalation tier

When a trigger fires, migration commits to Option B first:

- Per-day-scope limiters: one row per `(tenantId, yyyy-mm-dd)` in a new `RateLimitCounters` table. Atomic ETag-lease increment pattern (ADR-0011 §5a precedent). Single row per tenant-day — very low contention.
- Per-minute-scope limiters: one row per `(principalId, yyyy-mm-ddTHH:mm)`. TTL-style cleanup via a daily sweeper (ADR-0023 §6 precedent). Per-minute contention is bounded by concurrent requests from the same principal within a 60-second window — in practice a browser's React Query client does ≤12 calls/min against this tile surface, comfortably inside the ETag-lease retry budget.
- The limiter interface in `api/src/lib/rateLimit.ts` exposes a `check(key, nowMs): Promise<RateLimitResult>` signature (already synchronous today; becomes async under centralisation). Callers are refactored to `await` in the same commit as the interface flip.

Option A (Redis) escalates to first-class if any of:

- Per-partition Table write rate sustains above 200 ops/sec for any 5-minute window (60% of the 500 ops/sec soft limit — headroom check).
- ETag 412 retry rate exceeds 5% on any limiter key — contention is no longer tolerable under the lease pattern.
- A limiter's latency p95 blows past 50 ms and starts showing up in `/api/*` p95.

Reasoning for Option B as primary: zero new platform dependencies, consistent with three existing durable-state patterns in this codebase (`AgentBudget`, `IngestHealth`, `TenantSettings`), known RBAC posture, no new cost line. The codebase already does ETag-lease writes correctly (ADR-0011 §5a, ADR-0019 §Decision.2, ADR-0022); an additional counter-row pattern is incremental muscle-memory. Option A avoids the lease/contention question entirely but costs a new Azure resource, a new MI grant, and a new runtime dependency — not worth paying until B demonstrably doesn't fit.

### 3. Keep the synchronous `check()` signature stable — don't refactor pre-emptively

The `SlidingWindowRateLimiter.check()` method is currently synchronous (`(key, nowMs) => RateLimitResult`). Nine call-sites already `const rate = limiter.check(...)` then branch inline. A pre-emptive refactor to async-ready shape would touch every caller, gain nothing until migration, and widen today's diff surface for no security or reliability value.

**When migration lands, it lands end-to-end in one commit:** new interface, all nine call-sites flipped to `await`, new Table-backed implementation, tests. No half-state. This is an explicit choice to defer the ergonomic cost until it buys a functional change.

The only interim change that IS worth making (tracked as a follow-up, not required by this ADR): document the effective-ceiling multiplier in the rateLimit.ts header comment so a future reader doesn't misread "60/min" as the deployed ceiling. The header already says "the effective limit is `60 * instanceCount`" for `trendRateLimiter`; extend that comment to the other eight instances.

### 4. Interim observability — Flex-scale instance count in AIEVENT

Flex Consumption exposes the current instance count via App Insights custom dimensions on each request (`customDimensions.RoleInstance`). The existing `AIEVENT` custom-event emissions (`AuditWriteFailed`, `EntraRiskIngestRetry`, `BriefAgentSettingsFallback`, `TenantSettingsChange`) already land in Log Analytics — these rows implicitly include the instance identifier.

**Observability commit path (pre-migration):** a small KQL saved query that joins `customEvents` on `RoleInstance` and buckets by hour gives the operator a graph of "how many Function App instances were live during the period when rate-limit 429s were emitted". If the instance-count axis trends up while the 429 axis stays flat, that's trigger 2 from §Decision.1 materialising.

No code change required for this observability — it's a Log Analytics query the operator saves. Tracked in HANDOVER §6.3 as "saved KQL: Flex instance-count vs rate-limit 429s" (opportunistic follow-up; neither this ADR nor the code depend on it).

### 5. What this ADR does NOT decide

- It does not specify the `RateLimitCounters` table schema in field-for-field detail. That belongs in the migration ADR that fires when a §Decision.1 trigger lands — schema choices depend on whether we go per-minute buckets or fixed-window rollup, which depends on the contention profile observed at migration time.
- It does not pre-commit to keeping both sliding-window and fixed-window semantics. Sliding window is more accurate; fixed window is cheaper to implement in a shared store. Pick when migrating.
- It does not sunset the `AgentBudget` row pattern for `runDailyBrief`. That row does more than rate-limit (it also enforces the token budget — ADR-0019) and its semantics are chain-audited (ADR-0021). Centralising the admin-run limiter for brief ingest into the new system is a net code-quality loss, so brief stays on AgentBudget by design.

## Consequences

**Positive.**

- No code change today. The diff surface stays at one new ADR file.
- The "code-enforced today, centralised when a trigger lands" posture is explicit and defensible at every future WS10 review. No verdict needs to re-litigate the deferral.
- Target pattern pre-selected means the eventual migration commit is a design-executed-from-ADR, not a design-during-migration. Lower WS10 gate cost when it lands.
- Observability plan (§Decision.4) means trigger 2 will actually be observable rather than notionally observable.

**Negative / trade-offs.**

- Operators running more than one instance at any time (today: briefly during peak brief-agent runs or deploy-induced restarts) see a rate-limit that effectively means "30–3×30 per day" rather than the stated 30. Documented; acceptable at single-tenant scale.
- Future migration is a non-trivial refactor touching nine call-sites + new Table schema + new tests. Cost is real but bounded and known.
- Deferring the `check()` async refactor means callers learn `limiter.check(...)` as a synchronous idiom; when it flips, every call-site and every test touches it. Accepted because the refactor-without-backing-change would be pure churn.

**Negative we accept (explicit).**

- A narrow class of pre-migration abuse patterns — e.g. an admin account compromised during a Flex burst — would see a higher effective rate than the stated one. The compensating controls (SWA role gate on admin paths, Entra app-role gate on reader paths, Graph daily call budgets, app-budget token ceiling on agent paths, App Insights anomaly alerts at 3× daily budget) mean this is a degraded-metering incident, not a security-bypass incident. The limiter sits behind two authoritative identity-layer controls, not in front of them.

---

## Appendix A — Trigger recap

To commit a migration, the migration PR description MUST cite at least one:

- **T1 — Multi-tenant deployment decision:** link the ADR/PR that introduces a second tenant.
- **T2 — Observed drift:** attach the saved-KQL screenshot showing sustained instance-count >3 concurrent with 429-plateau below intended ceiling AND Graph-quota utilisation >50%.
- **T3 — Compliance ask:** attach the auditor request or the contractual requirement clause.
- **T4 — Incident:** attach the incident writeup doc; name the RunId / timestamp range.

A migration PR without a cited trigger should be rejected at WS10 as "no cause to migrate; over-delivery on infrastructure".

## Appendix B — Existing durable-counter precedent

The codebase already has three working ETag-lease durable-counter patterns — migration reuses these shapes, not inventing new ones:

| Pattern | Table | Row shape | Writer | Concurrency primitive |
|---|---|---|---|---|
| Agent-day budget | `AgentBudget` | `(tenantId, yyyy-mm-dd)` | `runAgent.ts` reserve/reconcile | ETag `If-Match` + 412-retry |
| Ingest health chain | `IngestHealth` | `(tenantId, sourceKey)` | `runIngest*.ts` commit-then-append | ETag `If-Match` + 412-retry |

These two are the ETag-lease counter precedents. `TenantSettings` is **not** a counter precedent — its writer uses unconditional `upsertEntity("Replace")` (last-writer-wins), appropriate for policy rows where the latest operator intent wins, but the exact anti-pattern for a counter (it drops concurrent increments). The migration ADR must copy the `AgentBudget` / `IngestHealth` shape, not the `TenantSettings` shape. WS10 verdict for this ADR (2026-04-20) flagged this distinction explicitly — documented here to prevent the future implementer from copying the wrong precedent.

Migration to the centralised limiter follows `AgentBudget` most closely — per-key per-window counter with ETag-lease increment. No new pattern required.
