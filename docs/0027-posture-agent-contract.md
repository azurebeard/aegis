# ADR-0027 — `posture-agent` contract

**Status:** Accepted
**Date:** 2026-04-20
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0019 locked the orchestrator router + budget pattern. ADR-0020 defined `brief-agent` — step 5's only specialist. Step 7 expands the specialist roster. This ADR defines the first step-7 specialist, `posture-agent`, which produces a **weekly SecureScore posture narrative**: what the current posture is, what moved in the past week, and which controls are the biggest available levers.

`posture-agent` is a deliberately narrower specialist than `brief-agent`:

- **Brief-agent (daily)** reads a multi-source ops-store snapshot — SecureScore + Incidents + IngestHealth + EntraRisk — and narrates "what happened across the dashboard today". Breadth-first.
- **Posture-agent (weekly)** reads only SecureScore (latest + trend + top control-score movers) and narrates "how the tenant's security posture is trending and what to prioritise next". Depth-first within one domain.

The split matches PROJECT_BRIEF.md §7's hint at "daily/weekly narrative brief generation". Daily is brief-agent; weekly is posture-agent (+ future domain-narrowed specialists). Cross-agent routing (an orchestrator choosing between specialists on a request) is out of scope here and deferred to a later ADR (likely 0028 or 0029) if it's ever needed — today each specialist has its own trigger.

### What this ADR inherits (unchanged)

To keep this ADR tight, the following are **inherited verbatim from ADR-0019 + ADR-0020** and not re-specified:

1. **Thin-router pattern** — ADR-0019 §Decision.1. `posture-agent` lands as a new adapter module `api/src/lib/runPostureAgent.ts`, statically registered. No dynamic routing.
2. **Budget enforcement** — ADR-0019 §Decision.2. Per-agent token budget on `AgentBudget` row, ETag-lease reservation + reconcile. Posture-agent gets its own `tokensBudget` + `runsDailyCeiling` (see §Decision.4 below for values).
3. **Circuit breaker + retry** — ADR-0019 §Decision.4. Per-agent `AgentHealth` row (`agentName: "posture"`), rolling consecutive-failure count, same `closed | open | half_open` state machine.
4. **Four-layer prompt-injection defence** — ADR-0020 §Decision.4 (length cap → C0/bidi strip → denylist → fenced delimiter). The shared `promptInjectionDenylist.ts` + `screenPromptContext` helpers apply unchanged. Field-level pre-JSON screening (SEC-L-ADR25-P3-01 hardening, Option D) applies automatically — posture-agent's SecureScore inputs have no user-provided strings in v1, but the machinery is in place if a future column ever carries adversary-influenceable text.
5. **JSON envelope validation** — ADR-0020 §Decision.2. Strict Zod-equivalent parse; parse-failure / source-fabrication classifications identical. `ParseFailuresToday` counter on `AgentBudget` extended to include posture-agent runs.
6. **Non-determinism bounds** — ADR-0020 §Decision.6. Temperature 0.2, top-p 0.95, max_completion_tokens 1500, deterministic seed-per-runId.
7. **Audit chain** — ADR-0021. `eventType: "agent.run"`, source `agent.aegis.posture`. Own `IngestHealth[agent.aegis.posture]` row writing its own chain (same ETag-lease singleton pattern as `agent.aegis.brief` — ADR-0019 §Decision.5). Agent MI writes only rows with RowKey prefix `agent.*` — code-enforced (HANDOVER §6.3 TenantSettings + IngestHealth row-scope ABAC entry; ADR-0022 §RBAC precedent on per-table scope).

This ADR only specifies what's **different or new** for posture-agent.

## Decision

### 1. Inputs — SecureScore-only, weekly lookback

`posturePromptBuilder.ts` (new, pure TypeScript, no I/O) takes SecureScore snapshots + trend entries + IngestHealth for the SecureScore source, returns a canonicalised prompt. Follows the ADR-0020 §Decision.1 column-whitelist discipline — any Table field NOT named in the `columns` list below is dropped before prompt concatenation. The positive-match extraction failure mode is "new column not included" rather than "new column silently leaks".

| Source | `columns` (whitelist — any other field dropped) | Size cap |
|---|---|---|
| `SecureScore` Table — latest row | `snapshotDate, currentScore, maxScore, percentage, activeUserCount, licensedUserCount, enabledServices` (space-separated-list, capped 20 entries) | <1 KB |
| `SecureScore` Table — trend rows (14-day window) | `snapshotDate, currentScore, percentage` per row (14 rows max) | <2 KB |
| `SecureScore.controlScores` — **top 10 by absolute score movement vs 14 days ago** (builder-derived, see §2) | `controlCategory, controlName, score` + derived `scoreDeltaVs14d` (signed integer) | <2 KB |
| `IngestHealth` row for `graph.security.secureScores` | `status, lastSuccessAt, consecutiveFailureCount` — NOT `lastRunId`, `lastAuditSeq`, `lastLineSha256` (correlation IDs + chain primitives stay off the prompt) | <200 B |

Total prompt input budget: **<6 KB pre-fencing** (well below ADR-0020's 32 KB `MAX_CONTEXT_CHARS`).

**Not on the prompt** (explicitly):

- **Full `controlScores` array** — a SecureScore snapshot has ~60–120 control entries each with a verbose `description`. Serialising everything blows the budget and drowns the signal. The builder surfaces only the top-10-by-movement derived set.
- **`controlScores[].description`** — Microsoft-authored prose, adversary-influenceable (ADR-0025 §9.6 attacker model for Graph-authored strings). The denylist + fence would catch most problematic content, but descriptions add ~40 KB of verbose prose with low narrative value for a weekly summary. Dropped by default; revisit if operators request "what the control actually does" in the narrative.
- **Brief-cache / BriefCache blobs** — posture-agent does NOT cross-read brief-agent's output. Agents are independent specialists; the daily brief is a separate artefact.
- **Incidents / EntraRisk / AgentBudget rows** — out of domain. If an operator wants posture in the context of recent incidents, the weekly brief (not posture-agent) is the right surface; multi-domain narration is brief-agent's job.

### 2. Top-movers derivation (builder-local, deterministic)

The "top 10 controls by absolute movement" set is computed in `posturePromptBuilder.ts` — not taken from Graph, not taken from a stored aggregate:

1. Read the latest snapshot's `controlScores[]`.
2. Read the snapshot closest to 14 days ago (looked up via `getTrendSnapshots` + pick the first whose `snapshotDate` ≤ `today - 14d`; falls back to the oldest available if none older than 14d).
3. For each control name present in both snapshots, compute `scoreDeltaVs14d = latest.score - old.score`.
4. Sort by `abs(scoreDeltaVs14d)` desc, take top 10.
5. A control present in latest but missing in old (or vice versa) yields `scoreDeltaVs14d = null` — excluded from top-movers. Rationale: can't distinguish "new control" from "renamed control" from "deprecated control" without Microsoft's own control-ID stability guarantee, which doesn't exist at the prompt layer.

This computation is deterministic and cache-friendly — identical inputs produce byte-identical prompt context.

### 3. Outputs — posture-specific JSON envelope

```json
{
  "schemaVersion": 1,
  "headline": "One-sentence summary of current posture + 7-day direction.",
  "severity": "informational | notable | urgent",
  "narrative": "Markdown body with three REQUIRED section headings.",
  "sections": {
    "currentPosture": "Prose — tenant's current score, how it compares to the tenant average seven days ago.",
    "recentMovement": "Prose — what moved up / down in the past week, citing specific control names.",
    "priorityActions": "Prose — one to three suggested actions, each tied to a named control with its current score."
  },
  "sourcesUsed": ["SecureScore", "IngestHealth"]
}
```

- **Three required section headings** — explicit shape (vs brief-agent's freeform narrative) so the tile can render each section independently if the UI ever wants to split them. Validator rejects missing or extra keys under `sections`.
- **`severity`** — three-value enum shared with brief-agent. A model tempted to say "critical" is rejected at validation.
- **`headline`** ≤ 280 chars; each `sections.*` ≤ 2000 chars; `narrative` is the concatenation with markdown heading wrappers (validator computes this server-side — the model returns only the three section prose, not the outer markdown).
- **`sourcesUsed`** — subset of `["SecureScore", "IngestHealth"]`. ADR-0020 §Decision.2 subset-check applies unchanged (`source_fabrication` classification on a claimed source the builder didn't provide).

**JSON validation:** reuses `validateBriefOutput` pattern from `briefPromptBuilder.ts` with a posture-specific schema. Parse failures classify as `AgentFetchError(kind: "parse_failure")` per ADR-0020; non-retryable; cache fall-through.

### 4. Schedule, triggers, budget

**Weekly Timer.** `posture-agent` fires on a fixed weekly cadence. Default cron: **Mondays 06:00 UTC** (`0 0 6 * * 1`), configurable via `POSTURE_TIMER_CRON` Function App setting. Rationale:

- SecureScore updates daily but meaningful posture movement is week-scale. A daily posture brief would be noise.
- Monday 06:00 UTC lands the brief in the operator's inbox / dashboard at the start of the UK working week.
- Wildcard-interpretable cron (not a fixed day-of-week hardcoded in the handler) so operators in other timezones / cadences can override.

**Admin manual-trigger.** `POST /api/ingest/posture/run` (admin-gated via the existing `/api/ingest/*` → `["admin"]` SWA rule; avoids the method-scoped-rule pitfall per HANDOVER §6.2 pitfall 25). Subject to the same 30/day rate-limit constant (`ADMIN_RUN_DAILY_CEILING`) shared across admin-run endpoints + the shared `settingsPatchRateLimiter` pattern.

**No other entry points.** No tile click "refresh now"; no `/api/posture/run` (no user-accessible trigger beyond the admin surface). The weekly cadence is the primary path.

**Budget.** New `AgentBudget` row entries keyed by `(tenantId, yyyy-mm-dd, agentName)` — the existing row schema is `(tenantId, yyyy-mm-dd)`; extend with `AgentName` column to separate brief-agent vs posture-agent accounting. Reservation logic (ADR-0019 §Decision.2) unchanged. Default **`postureTokensBudget = 20,000 tokens/day`** (≤10 × the weekly cadence + manual-run allowance; ~$0.008/day worst case at small-model PAYG pricing). Default **`postureRunsDailyCeiling = 10`** — one scheduled run + operator-manual-run headroom + failure-retry envelope.

Operator override via the existing TenantSettings `agent-budget` row, extended additively (ADR-0006 additive-only schema migration rule — cross-cited at ADR-0023 §schema evolution). **ADR-0027 commits to the flat-additive path**, not the nested-rename path: the implementation adds `PostureManualRunCeiling` and `PostureDailyTokenBudget` as new columns alongside the existing `BriefManualRunCeiling` + `BriefDailyTokenBudget`. Readers that don't know about the new columns continue to work (brief-only view); readers that do know pick up both agents' settings. No row-migration, no coordinated-rename breakage window, no "is the deployed reader ahead or behind of the row schema" question.

The nested-rename variant (`manualRunCeilings: { brief, posture }`) was considered for readability but requires a one-shot migration write to every existing tenant's row; additive is the safer shape under the existing "no coordinated writer / reader deploys" posture. The admin-settings page exposes both pairs independently (ADR-0025 §9 pattern — one section per agent).

If a future specialist pushes the flat schema to an unwieldy width (N × 2 columns), that's the trigger for a separate schema-versioning ADR that handles the nested migration with a dedicated runbook. ADR-0027 does not create that trigger on its own.

### 5. Cache contract — weekly, not daily

New table: **`PostureCache`** on the ops storage account (parallel to `BriefCache`). Row shape:

| Column | Notes |
|---|---|
| `PartitionKey` | `<tenantId>` |
| `RowKey` | `posture.<yyyy-Www>` — ISO 8601 week (e.g. `posture.2026-W17`). Weekly granularity matches the cadence; a run mid-week (admin trigger) targets the same `yyyy-Www` row as the Monday Timer fire. |
| `RunId` | GUID of the successful run. |
| `OutputSha256` | Matches the blob body. |
| `BlobPath` | `posture-narratives/<yyyy>/<Www>/<tenantId>.md` in a new blob container. |
| `TokensIn` / `TokensOut` | Per ADR-0022. |
| `ModelDeployment` | `"aegis-small"` at v1. |
| `CreatedAt` / `ExpiresAt` | `ExpiresAt = CreatedAt + 21d` (two-sprint retention + one-week buffer). Lifecycle-policy-driven delete at `ExpiresAt`. |
| `StorageVersion` | Reserve per ADR-0022 precedent. |

Read contract `/api/posture/latest` (reader-authenticated) mirrors `/api/brief/latest` — returns the current week's row, or a `stale` / `awaiting_first_run` empty state if absent. **`Cache-Control: private, max-age=300`** — five minutes is fine for weekly content.

Freshness classification (ADR-0022 pattern):

- **Fresh:** `now < CreatedAt + 7d` (within the week).
- **Stale-serviceable:** `7d ≤ now < 14d` — serve with a staleness badge; next scheduled fire will refresh.
- **Stale-unservable:** `now ≥ 14d` — tile empty state, admin-run prompt.

### 6. RBAC

**New role assignments** (Bicep, `storage-ops.bicep`):

- **Agent MI:** `Storage Table Data Contributor` on `PostureCache` + `Storage Blob Data Contributor` on `posture-narratives` container. Mirrors the `BriefCache` + `daily-briefs` grants the agent MI already has. Row-scope code-enforced (§Context inherited).
- **Api-reader MI:** `Storage Table Data Reader` on `PostureCache` + `Storage Blob Data Reader` on `posture-narratives`. Mirrors the `BriefCache` + `daily-briefs` read grants.
- **No new Graph scope.** Posture-agent reads only the ops store. SecureScore data is already ingested by the existing `graph.security.secureScores` ingest path.

No new MI. The existing agent MI is the single AI-plane writer identity (ADR-0017 §Decision.5 invariant preserved).

### 7. Failure modes + degraded-state behaviour

- **SecureScore is stale:** if `IngestHealth[graph.security.secureScores].consecutiveFailureCount ≥ 3`, the posture-agent builder emits a dedicated "no recent data" input state. The system prompt instructs the model to say "SecureScore ingest has been failing for N runs; posture narrative paused" and return a minimal envelope with `severity: "notable"`, single-section `currentPosture`. Cache still writes (so the dashboard surfaces the explanation), but the run is audited with `status: "degraded"` (**new value** on the ADR-0021 §Decision.2 audit-line `status` enum — extending the existing `success | no_data | error` set). Because the verifier enforces a strict-enum check with exit code 2 on unknown `status` values (ADR-0021 §Decision.5, SEC-H-ADR-21-01 resolution), the implementation commit that first emits `"degraded"` **MUST** land a paired update to `scripts/verify-audit-chain.mjs` that adds `"degraded"` to the accepted enum. Shipping the emitter without the verifier extension would trip exit 2 on every degraded-state run and pollute the audit-chain-verify CI job; this is a mandatory co-landing, not a deferred follow-up.
- **First-ever run on a fresh tenant (no 14-day trend):** if fewer than 2 trend entries exist, `sections.recentMovement` is skipped in the prompt (the model is prompted to omit that section if no movement data was supplied). Validator permits empty `sections.recentMovement` **only** when `sourcesUsed` excludes `"SecureScore.trend14d"` (a new fine-grained source key — see §8 below).
- **Budget exhausted mid-run:** ADR-0019 path unchanged — `AgentFetchError(kind: "budget_exceeded")`, cache-serve-stale, weekly schedule tries again next Monday.
- **Circuit breaker open:** posture-agent's `AgentHealth` row independent from brief-agent's. An incident in one specialist does not pause the other.

### 8. Source-key naming convention — dotted namespace + paired ADR-0020 amendment

**Current state** (discovered during this ADR's WS10 review, 2026-04-20): `api/src/lib/briefPromptBuilder.ts` lines 15–32 declare `AllowedSourceKey` and `ALLOWED_KEYS_ORDER` using **dotted-namespace** labels (`secureScore.latest`, `incidents.summary`, `ingestHealth.all`, `riskyUsers.summary`, etc.) — the code is already on dotted form. This diverges from ADR-0020 §Decision.2's originally-specified PascalCase labels and from SEC-M-ADR-20-AMEND-01's 2026-04-19 resolution which locked the canonical set to PascalCase + a single enumeration point. The drift happened progressively across Steps 5 / 6 / Phase 3 and was not carried back into the ADR text.

**Decision for this ADR:** adopt **dotted-namespace** as the canonical convention and land a paired **ADR-0020 amendment** in the same commit as ADR-0027 that:

1. Rewrites the §Decision.2 / §Amendment source-key enumeration to dotted form — matching what the code already does.
2. Moves the shared constant out of `briefPromptBuilder.ts` into a new `api/src/lib/agentSourceKeys.ts` exporting a single `CANONICAL_SOURCE_KEYS` tuple (SEC-M-ADR-20-AMEND-01 required "one convention enumerated in one place" — this restores that invariant under the dotted convention rather than reverting the code to PascalCase).
3. Declares the convention rule going forward: `<domain>.<facet>` lowercase-dotted. Examples: `secureScore.latest`, `secureScore.trend14d`, `ingestHealth.secureScore`, `incidents.summary`, `riskyUsers.recent`.

Posture-agent's three new source keys — `"secureScore.latest"`, `"secureScore.trend14d"`, `"ingestHealth.secureScore"` — join the unified set. The subset-check from ADR-0020 §Decision.2 (`sourcesUsed ⊆ presented`) remains exact-string and gains new canonical members.

**Rationale for picking dotted over reverting to PascalCase:** the code is already on dotted, and the dotted convention has semantic structure (`<domain>.<facet>`) that maps directly onto the ingest-source taxonomy (`graph.security.secureScores`, `graph.security.incidents`, `graph.security.riskyUsers`). Reverting the code to PascalCase would be a breaking churn across brief-agent's prompt-builder, its tests, the cached `sourcesUsed` arrays in existing `BriefCache` rows, and every WS10 verdict citing the old labels — for zero semantic gain. Going forward under dotted is the cheaper, more coherent path.

**Cross-ADR commit order:** the ADR-0020 amendment lands **in the same commit as ADR-0027** (not a follow-up), so the SEC-M-ADR-20-AMEND-01 "one convention in one place" constraint is continuously held — there is no window where the code + ADR-0020 + ADR-0027 disagree on the canonical set.

### 9. Non-surfaces (v1)

- **Per-user posture scoring.** SecureScore is tenant-level; per-user attribution is out of scope.
- **Cross-tenant comparison.** `averageComparativeScores` is available in `SecureScoreSnapshot` but deliberately dropped from the whitelist. Tenant-vs-peer comparison adds narrative value but also adds the operator-surprise surface of "why is my tenant shown as below/above average" — defer until an explicit request.
- **Remediation script generation.** Narrative suggests priority controls; it does not generate PowerShell / Graph calls. Actions-generation is a different specialist pattern (the ~Step-8 "stack-agent" hint in PROJECT_BRIEF.md) that needs its own ADR with safety bounds.
- **Evergreen / hard-coded best-practice prose.** Model is instructed to narrate only what the data shows; it does not append templated "always enable MFA" paragraphs. If operators want evergreen context, it lives in help documentation next to the tile, not in the weekly brief.

## Consequences

**Positive.**

- Single new specialist landing under ~1k LOC (adapter module + prompt builder + cache wrapper + new Table + new container + Timer handler + manual-run handler + tests) — tractable in one commit + WS10 gate per §10.9 budget.
- Reuses six major architectural primitives (orchestrator, budget, circuit breaker, 4-layer defence, envelope validation, audit chain) — maintenance cost scales sub-linearly with specialist count.
- Dotted-namespace source-key convention pre-commits ADR-0020 amendment direction without churning existing brief-agent labels.
- Operator gets weekly posture narrative without new Graph permissions, new MI, or new cost line beyond the small agent-budget ceiling.

**Negative / trade-offs.**

- AgentBudget schema gains an `AgentName` column (or a parallel flat rename) — migration path requires a one-time write to the existing today's row. Acceptable with the `upsertEntity("Replace")` + default-when-absent read pattern already in use.
- A weekly cadence means an outage between Monday firings gives no new signal for a week. The dashboard tile's stale-serviceable state (§Decision.5) surfaces this; an operator concerned about live posture still has the existing SecureScore tile for the raw number.
- Cross-agent routing is deferred. A future ADR-0028 or -0029 decides whether a single-entry-point orchestrator dispatches between specialists (vs each specialist having its own trigger, as here). The architectural cost of deferring is low because statically-registered specialists (ADR-0019 §Decision.1) already preclude dynamic dispatch — any future orchestration layer sits *above* the adapters, not *inside* them.

**Negative we accept (explicit).**

- Top-movers derivation is builder-local and deterministic, but a tenant whose `controlScores[]` array churns (Microsoft renames controls mid-year) could produce week-to-week noise where the "biggest mover" is a rename, not a real score change. The `scoreDeltaVs14d = null` for unmatched controls excludes this from the top-10 set; if the rename is systemic (all entries shift), the top-10 thins toward empty and the narrative narrows to `currentPosture` only. Documented operator expectation, not a code fix.

---

## Appendix A — Step-7 specialist roadmap

Post-ADR-0027, the specialist roster looks like:

| Specialist | Cadence | Primary source | Primary ADR |
|---|---|---|---|
| `brief-agent` | Daily | Multi-source | ADR-0020 |
| `posture-agent` | Weekly | SecureScore | ADR-0027 (this) |
| `incidents-agent` | Per-incident / on-demand | Defender XDR incidents | ADR-0028 (planned) |
| `stack-agent` (PROJECT_BRIEF §7 hint) | Not scheduled for v1 | StackItems / KEVMatches | Future |

ADR-0028 (`incidents-agent`) will follow this ADR's pattern closely — per-specialist adapter, per-agent budget row, own cache table, own Timer (or on-demand trigger), own source-key namespace (`incidents.recent`, etc.). The shape established here is the template.

## Appendix B — What this ADR is NOT deciding

- **Whether ADR-0020's existing labels get renamed to dotted convention.** That's a separate amendment triggered when a third specialist (or an operator ask, or a WS10 finding) makes the cost-benefit flip. Posture-agent picks dotted for its own new keys; the existing six stay as-is.
- **The cross-agent router.** One trigger per specialist today. If request-time routing ("pick the right specialist for this query") ever lands, it's a new ADR that sits above the adapters and does not amend this one.
- **Budget-row schema migration details.** This ADR commits to "posture has its own tunable budget on the admin page"; the exact column layout (nested record vs flat rename) is an implementation-ADR decision in the code-landing PR.
- **`controlScores[].description` inclusion.** Defaulted off; can be revisited if operators request more control-context in the narrative. The attacker-model framing from ADR-0025 §9.6 applies unchanged — any inclusion triggers a WS10 review.
