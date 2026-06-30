# ADR-0028 — `incidents-agent` contract

**Status:** Accepted
**Date:** 2026-04-20
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0027 landed `posture-agent` as the first step-7 specialist — weekly SecureScore narrative. This ADR defines the second step-7 specialist, `incidents-agent`, which produces **per-incident analysis narratives** on operator demand.

Cadence and shape distinguish the three specialists clearly:

- **`brief-agent` (daily, multi-source):** breadth-first "what happened across the dashboard today". ADR-0020.
- **`posture-agent` (weekly, SecureScore-only):** depth-first "how the tenant's security posture is trending and what to prioritise". ADR-0027.
- **`incidents-agent` (on-demand, per-incident):** depth-first "what does this specific incident mean, what's its likely impact, what should the operator do next". This ADR.

The per-incident pattern is distinct from the other two specialists because:

1. **No Timer.** Operators trigger it from the incident detail drawer when they want AI interpretation of a specific signal. There is no scheduled run. Rationale: most incidents are routine and self-explanatory from the raw data; the operator picks which ones need narrative enrichment. Auto-firing on every ingested incident would burn budget on noise and create a "did the agent look at this yet" race with the operator's own investigation.
2. **Detail-blob input.** Unlike brief-agent + posture-agent which read only Table summary rows, incidents-agent needs the full incident JSON blob (description, alerts, comments) to produce anything better than summary restatement. Detail blobs contain Microsoft-authored + operator-authored strings — the prompt-injection surface is materially larger than either existing specialist.
3. **Per-incident cache.** Cache key is incident ID, not date/week. An analysis written today for incident X stays cached until the incident changes (`lastUpdateDateTime` bumps).

### What this ADR inherits (unchanged)

Identical to ADR-0027 §Context inheritance. Verbatim from ADR-0019 + ADR-0020:

1. **Thin-router pattern** — ADR-0019 §Decision.1. New adapter `api/src/lib/runIncidentsAgent.ts`, statically registered.
2. **Budget enforcement** — ADR-0019 §Decision.2. Per-agent token budget on `AgentBudget`, ETag-lease. Own columns under the flat-additive schema (§Decision.4).
3. **Circuit breaker + retry** — ADR-0019 §Decision.4. Per-agent `AgentHealth` row (`agentName: "incidents"`).
4. **Four-layer prompt-injection defence** — ADR-0020 §Decision.4. Materially load-bearing here (§Decision.1 and §Decision.7 below).
5. **JSON envelope validation** — ADR-0020 §Decision.2. Strict schema; parse-failure + source-fabrication classifications.
6. **Non-determinism bounds** — ADR-0020 §Decision.6. Same model + temperature + max-tokens defaults.
7. **Audit chain** — ADR-0021. `eventType: "agent.run"`, source `agent.aegis.incidents`. Own `IngestHealth[agent.aegis.incidents]` row. Agent MI writes only rows with RowKey prefix `agent.*` — code-enforced (HANDOVER §6.3 TenantSettings + IngestHealth row-scope ABAC entry; ADR-0022 §RBAC precedent).
8. **Source-key canonical lock** — ADR-0020 amendment (2026-04-20, paired with ADR-0027). New keys join `CANONICAL_SOURCE_KEYS` in `api/src/lib/agentSourceKeys.ts` under dotted-namespace form.

This ADR specifies only deltas.

## Decision

### 1. Inputs — summary row + detail blob for a single incident

`incidentsPromptBuilder.ts` (new, pure TypeScript, no I/O) takes one `IncidentSummary` row + the parsed detail JSON blob + the tenant's IngestHealth row for `graph.security.incidents`, returns a canonicalised prompt. Follows ADR-0020 §Decision.1 positive-match column-whitelist discipline.

| Source | `columns` (whitelist — any other field dropped) | Size cap |
|---|---|---|
| `Incidents` Table — the summary row for the requested incident | `id, severity, status, classification, displayName, alertCount, createdDateTime, lastUpdateDateTime, assignedTo` (present/absent only — not the value), `determination, detectionSource` | <2 KB |
| Detail blob — `incident` object | `description` (cap 4 KB post-screening), `summary` (cap 2 KB post-screening), `resolvingComment` (cap 1 KB post-screening) | <7 KB cap before screening |
| Detail blob — `alerts[]` (up to top 10 by `severity` then `createdDateTime` desc) | Per alert: `id, title, severity, status, category, serviceSource, providerName, createdDateTime` | <6 KB |
| `IngestHealth` row for `graph.security.incidents` | `status, lastSuccessAt, consecutiveFailureCount` | <200 B |

Total prompt input budget: **<16 KB pre-fencing** (inside ADR-0020's 32 KB `MAX_CONTEXT_CHARS` with headroom for the screening + fencing overhead).

**Field-level screening** — load-bearing here. `description`, `summary`, `resolvingComment`, `alerts[].title` are all adversary-influenceable:

- `description` and `summary` come from Microsoft Defender with unconstrained text content pulled from alert rule definitions, detection names, and observable metadata. A compromised third-party detector or a crafted workload could land a prompt-injection string in these fields.
- `resolvingComment` is operator-authored free text — typically benign, but a compromised admin account is a credible writer with access to this field.
- `alerts[].title` is Microsoft-authored but drawn from a long tail of detection rules across MDE / MDI / MDO / MDCA — the surface is wide.

Each of the four fields runs through `screenPromptContext` (ADR-0020 §Decision.4 four-layer defence: length cap → control-char strip → denylist → fence) **individually before `JSON.stringify`** — matching the SEC-L-ADR25-P3-01 Option D hardening pattern for EntraRisk `UserDisplayName`. A denylist hit on one field redacts that field to `"[redacted — content policy]"` and continues building the prompt with the other fields intact. The subset-check-relevant `sourcesUsed` entry (`"incidents.detail"`) is still emitted — redaction is per-field, not per-source.

**Not on the prompt** (explicitly):

- **`incident.comments[]`** — operator conversation history. Dropped from v1 because (a) comments are the least-structured adversary surface in the detail blob, (b) they often contain PII about specific users, (c) restating operator context in the model prompt before the model analyses the incident is a circular reasoning trap. If a future operator ask demands "summarise the investigation comments", that's a separate specialist (or a dedicated feature of this one) with its own ADR.
- **`incident.webUrl` / `incident.incidentWebUrl`** — URL fields are injection-surface and low narrative value.
- **Any Microsoft Graph call beyond the ops-store detail blob.** The agent is ops-store-only (ADR-0020 §Decision.1 inherited).
- **Cross-incident correlation.** Incidents-agent analyses one incident per run. A future "campaign-agent" that correlates across incidents is a separate specialist. Non-surface.
- **All 5 verticals' data.** Incidents-agent does NOT read SecureScore, EntraRisk, or IngestHealth for sources other than `graph.security.incidents`. Scope-narrowing is deliberate — mixing in cross-domain data duplicates brief-agent's pattern.

### 2. Outputs — per-incident JSON envelope

```json
{
  "schemaVersion": 1,
  "headline": "One-sentence characterisation of the incident.",
  "severity": "informational | notable | urgent",
  "sections": {
    "attackNarrative": "Prose — what the incident appears to represent in plain language, citing specific alerts by title.",
    "impactAssessment": "Prose — blast radius given the incident's severity, classification, and alert mix. Names assets only if named in the prompt.",
    "suggestedNextSteps": "Prose — one to three next-step suggestions tied to alert categories or incident status."
  },
  "sourcesUsed": ["incidents.summary.<id>", "incidents.detail.<id>", "ingestHealth.incidents"]
}
```

- **Three required section headings** match ADR-0027's envelope shape — same validator pattern (missing/extra section → reject). Operators get a consistent reading experience across the two depth-first specialists.
- **`severity`** shared three-value enum. The model may not invent "critical" even if the underlying incident is severity=high; narrative severity is separate from alert severity by design (a low-severity incident with a credible compromise signal can be narratively urgent).
- **`headline`** ≤ 280 chars; each `sections.*` ≤ 2000 chars.
- **`sourcesUsed`** — the two incident-specific keys are suffixed with the incident ID (`incidents.summary.<id>`, `incidents.detail.<id>`) so the cache + audit can attribute the run to a specific incident. The subset-check (ADR-0020 §Decision.2) is amended to accept the suffixed form as "any string matching `/^incidents\.(summary|detail)\.[A-Za-z0-9_-]+$/`" alongside the static `CANONICAL_SOURCE_KEYS` entries. This is the first specialist to introduce per-entity source-key dynamicity — tracked below (§Decision.8).

### 3. Cadence and triggers — admin on-demand only

**No Timer.** Not a scheduled specialist. Rationale:

- Most incidents are self-explanatory from the Incidents tile / detail drawer — narrative enrichment is high-value only on a subset.
- A Timer that auto-fires on every incoming incident burns budget for no operator benefit and creates the "did the agent look at this yet" race with operator investigation.
- Proactive monitoring is already covered by the Incidents ingest + email alerts; AI narrative is an interpretive overlay, not a detection surface.

**Admin manual-trigger.** New handler `POST /api/ingest/incidents/{id}/analyse` (admin-gated via `/api/ingest/*` → `["admin"]` SWA rule — avoids the method-scoped-rule pitfall per HANDOVER §6.2 pitfall 25). Request body is empty (the `{id}` path param identifies the incident). Response body returns the JSON envelope on success, `202 Accepted` + cache-hit envelope if a fresh cached analysis exists.

**Freshness policy for the manual-trigger — two-axis content-addressable check (WS10 SEC-M-ADR28-02 resolution).** `lastUpdateDateTime` alone is an unreliable freshness proxy: Microsoft Graph bumps it on **any** incident mutation (assignee change, tag add/remove, classification change, comment add, alert re-correlation) including zero-semantic-content-change events. A compromised admin account (credible writer on `resolvingComment`) or operator tag churn could invalidate the cache on every operator click and burn the 20/day ceiling through no prompt-injection payload at all. The freshness predicate therefore is:

```text
cache_hit iff
  cached.AnalysedContentSha256 == sha256(canonicalise(current_whitelisted_prompt_inputs))
  OR (cached.AnalysedIncidentLastUpdateDateTime == incident.lastUpdateDateTime
      AND cached.AnalysedContentSha256 is non-null)
```

`AnalysedContentSha256` hashes the canonicalised JSON of the whitelisted prompt-input columns (summary row fields per §Decision.1 + post-screening detail-blob fields). Content hash is the primary predicate; the timestamp is a fast-path check when hashes collide or for first-write forward-compatibility. If the content hash matches, the cached envelope is fresh regardless of `lastUpdateDateTime`. Operators clicking "analyse" on an incident whose metadata has bumped but whose content-relevant fields haven't pay no budget cost.

The hash is canonical — stable field order via `json-canonicalize` (already a project dep for the audit-chain), numeric-vs-string-shape tolerance via explicit coercion, identical prompt-input shaping as the prompt builder.

**Rate limit.** Same `ADMIN_RUN_DAILY_CEILING` (30/day per tenant) as the other admin-run endpoints — per the shared-constant pattern resolved in the Option C bundle.

### 4. Budget — additive columns, lower ceilings

Additive schema extension to `TenantSettings[agent-budget]` row following ADR-0027 §Decision.4's flat-additive discipline:

- New columns: `IncidentsAnalysisManualRunCeiling` (default 20/day), `IncidentsAnalysisDailyTokenBudget` (default 15,000 tokens/day).
- Existing `BriefManualRunCeiling` + `BriefDailyTokenBudget` + `PostureManualRunCeiling` + `PostureDailyTokenBudget` stay untouched.
- The admin-page agent-budget section (Phase 3 admin settings + ADR-0027 additions) gains a third slider pair for incidents-agent. UI pattern is identical to the existing two.

Rationale for lower ceilings: incidents-agent fires only on explicit operator demand (not scheduled), and each run consumes more tokens than brief/posture (detail blob is ~3× the size of the summary-row inputs). 20 runs × ~750 tokens/run ≈ 15,000 tokens fits a full investigation day plus retry headroom; scales operator-side rather than pipeline-side.

### 5. Cache contract — per-incident, invalidated by `lastUpdateDateTime` change

New table: **`IncidentAnalysisCache`** on the ops storage account. Row shape:

| Column | Notes |
|---|---|
| `PartitionKey` | `<tenantId>` |
| `RowKey` | `incidents.analysis.<incidentId>` — one row per incident, ever. Re-analysis overwrites. |
| `RunId` | GUID of the successful run. |
| `OutputSha256` | Matches the blob body. |
| `BlobPath` | `incident-narratives/<incidentId>.md` in a new blob container. Flat path (not yyyy/mm/dd) because the RowKey is the lookup primitive, not the date. |
| `AnalysedIncidentLastUpdateDateTime` | The `incident.lastUpdateDateTime` value that was analysed — fast-path check in the two-axis freshness predicate (§Decision.3). |
| `AnalysedContentSha256` | SHA-256 over the canonicalised JSON of the whitelisted prompt-input columns — **primary** freshness predicate (§Decision.3). Resistant to adversary-bumpable timestamps. |
| `RedactionLockUntil` | ISO8601 UTC or null — set when §Decision.7d's budget-grind short-circuit fires. Returns cached envelope without spending a run until this timestamp passes or an admin clears the flag via `DELETE /api/ingest/incidents/{id}/redaction-lock` (admin-gated). |
| `RedactionLockRunCount` | Rolling count of consecutive redaction-heavy runs on this incident that led to the current lock. Reset to 0 when the lock clears. |
| `TokensIn` / `TokensOut` | Per ADR-0022. |
| `ModelDeployment` | `"aegis-small"` at v1. |
| `CreatedAt` | ISO8601. |
| `StorageVersion` | Reserve per ADR-0022 precedent. |

**Retention:** row + blob are kept while the parent incident is live; a sweep job (runs daily alongside the existing incident-detail trim — ADR-0014 §3) removes the analysis row + blob when the parent incident summary row has been purged. Pattern is identical to the existing `incidents-detail` container lifecycle.

**Read contract** `GET /api/incidents/{id}/analysis` — reader-authenticated. Returns the cached envelope + the `AnalysedIncidentLastUpdateDateTime` so the SPA can surface "analysis is based on the incident as of <time>; incident has been updated since — re-analyse" states. No blanket time-based staleness — the freshness predicate is purely "was this analysis produced for the current `lastUpdateDateTime`?".

**`Cache-Control: private, max-age=30`** — short because the staleness predicate is event-driven (incident update bumps), and the operator should see a fresh view quickly after a re-analyse.

### 6. RBAC

**New role assignments** (Bicep, `storage-ops.bicep`):

- **Agent MI:** `Storage Table Data Contributor` on `IncidentAnalysisCache` + `Storage Blob Data Contributor` on `incident-narratives` container + `Storage Blob Data Reader` on the existing `incidents-detail` container (agent MI needs to READ detail blobs; it does not write them — the ingest MI remains the sole writer of that container).
- **Api-reader MI:** `Storage Table Data Reader` on `IncidentAnalysisCache` + `Storage Blob Data Reader` on `incident-narratives`.
- **No new Graph scope.** Incidents data is already ingested by `graph.security.incidents` under the ingest MI's existing scopes.
- **No new MI.** Agent MI remains the sole AI-plane writer identity (ADR-0017 §Decision.5 invariant preserved).

The agent MI's new `incidents-detail` read grant is the only cross-container read the agent plane performs — posture-agent is SecureScore-table-only, brief-agent reads summaries not details. Documented explicitly because any future specialist following this pattern will want to reference it.

**Compensating control for the whole-container read grant (WS10 SEC-L-ADR28-03 resolution).** Blob container reads are not ABAC-row-scoped the way Table entity reads are (pitfall 15 + ADR-0026's Table Storage ABAC unsupported investigation). A compromised agent MI can in principle enumerate every incident's detail blob, not only the one the operator requested. The compensating control is code-enforced at the adapter boundary:

- `runIncidentsAgent.ts` is the **only** caller of `getIncidentDetailBlob(ctx, incidentId)` on the agent plane.
- The `incidentId` argument is drawn from `ctx.incidentId` (the admin-run handler's path param) — **never** model-provided.
- Before I/O, the adapter asserts `incidentId === ctx.incidentId` (defensive; guards against a future refactor that accidentally threads a model-provided ID into the read call).
- Any future specialist wanting to read `incidents-detail` blobs must follow the same discipline — authoritative run context, adapter-boundary assertion, single-call-site — and go through a WS10 review.

This matches the §Decision.8 validator's "authoritative run context, not model-provided" discipline. The model never sees raw blob contents beyond what the adapter fenced into the prompt; it cannot request different blobs. A compromised model is structurally unable to cross-read; a compromised adapter has already defeated a different layer of the defence and this grant's blast radius is additive, not foundational.

### 7. Prompt-injection containment — materially elevated surface

The detail blob is the first specialist input with four distinct adversary-influenceable free-text fields (`description`, `summary`, `resolvingComment`, `alerts[].title`). The ADR-0020 four-layer defence applies unchanged, with three concrete elevations:

**(a) Per-field screening before JSON.stringify.** §Decision.1 covers this in the input table — screening runs on each field individually so a denylist hit on one (e.g. `description`) redacts that field without dropping the whole detail source. Matches the SEC-L-ADR25-P3-01 Option D resolution pattern.

**(b) Lower tolerance on size caps.** `description` 4 KB, `summary` 2 KB, `resolvingComment` 1 KB — tighter than the `MAX_CONTEXT_CHARS` 32 KB global cap. Narrows the attacker's crafted-text budget per field.

**(c) Operator-visible redaction trail.** When a field is redacted, the prompt emits `Source: incidents.detail.<id>` with a marker `[field <name> redacted — content policy]` inside the fenced block. The audit line records `redactedFields: ["description"]` (new optional array on the `AgentRun` event) so operators can detect a tenant under sustained prompt-injection attempt via Log Analytics query on `customEvents | where customDimensions.redactedFields != ""`.

**(d) Redaction-lock short-circuit — budget-grind mitigation (WS10 SEC-M-ADR28-01 resolution).** The per-field redaction pattern in isolation is correct, but without a rate-limit it enables a **budget-grind attack**: an attacker who lands denylist-bait text in any of the four adversary-influenceable fields — or in an alert title shared across incidents — causes every operator click on that incident to burn one of the 20/day runs and produce near-zero narrative value. Mitigation:

- The adapter tracks `RedactionLockRunCount` on the `IncidentAnalysisCache` row. Each run that redacts ≥3 of the 4 adversary-influenceable fields increments the counter. Each run that redacts <3 fields resets it to 0.
- When `RedactionLockRunCount ≥ 2` (two consecutive heavily-redacted runs on the same incident), the adapter sets `RedactionLockUntil = now + 24h` and returns a cached "analysis withheld — content policy" envelope on subsequent operator clicks **without spending a run against the budget**, until either (a) `RedactionLockUntil` expires, or (b) an admin clears the flag via `DELETE /api/ingest/incidents/{id}/redaction-lock` (admin-gated).
- Admin-clear is the intentional operator override — a legitimately-complex investigation whose incident genuinely contains denylist-adjacent language can be force-analysed by a security engineer with explicit acknowledgment.
- The lock is **per-incident, not per-tenant** — a single poisoned incident cannot starve analysis on unrelated incidents.
- `customEvents | where name == "RedactionLockActivated"` fires on every lock set, matching the existing AIEVENT pattern. Operators can alert on sustained lock activity.

The 2-run trigger is tuned conservatively — one accidental redaction on a benign incident does not engage the lock. The 24h TTL matches typical investigation cadence; if the poisoned content persists longer, the pattern is deliberate rather than opportunistic and warrants operator attention anyway.

Degraded-state (§Decision.9) includes the "all four fields redacted" case as a known failure mode — the model receives only the summary row + alert titles + ingest-health, and the system prompt instructs it to narrate "detail blob content was unavailable for policy reasons" rather than hallucinate. This path **also** increments `RedactionLockRunCount`.

### 8. Source-key suffix pattern — first dynamic canonical key

`"incidents.summary.<id>"` and `"incidents.detail.<id>"` are the first dynamic members of `CANONICAL_SOURCE_KEYS`. The set is no longer a static tuple — it's a tuple plus a regex-allow-list for the incident-suffixed forms.

**Validator amendment** (adapter-side, `runIncidentsAgent` subset-check): accept a `sourcesUsed` entry if either:

1. It matches a static member of `CANONICAL_SOURCE_KEYS`, OR
2. It matches `/^incidents\.(summary|detail)\.[A-Za-z0-9_-]+$/` AND the `<id>` suffix equals the incident ID the current run was invoked with.

The second clause forbids fabricated incident IDs — a model claiming analysis of a different incident than the one it was invoked with fails subset-check as `source_fabrication`. The authoritative run context carries the incident ID (adapter parameter, not model-provided); the validator compares against that.

**Other specialists are unaffected:** brief-agent and posture-agent continue using static keys only. The dynamic pattern is specialist-opt-in.

**Helper function** `isCanonicalSourceKey(key: string, context: { incidentId?: string }): boolean` lands in `api/src/lib/agentSourceKeys.ts` alongside `CANONICAL_SOURCE_KEYS`. The adapter-side subset-check calls it with the run context. No specialist re-implements the accept logic locally.

**Mandatory-context safeguard (forward-discipline, WS10 informational #5):** when `key` matches the dynamic regex, `context.incidentId` MUST be present. If absent, the helper throws `AgentFetchError(kind: "missing_context")` rather than silently accepting any suffix. The adapter is the only legitimate caller and always has the ID; an accidental caller that forgets context fails loudly at test time, not silently at runtime. Unit-test fixture covers `isCanonicalSourceKey("incidents.detail.abc", undefined)` → throws.

### 9. Failure modes + degraded-state behaviour

- **Incident not found / detail blob missing:** the adapter 404s before spending a run. Manual-trigger handler returns `404 Not Found` with a structured error body `{ code: "incident_not_found", incidentId }`. No budget spend, no audit line for this class (matches the existing `/api/incidents/{id}` detail handler's 404 semantics — ADR-0016 §3).
- **All four free-text fields redacted by the denylist:** proceeds with summary + alert titles + ingest health only. System prompt instructs the model to state "detail blob content was unavailable for policy reasons"; envelope still writes to cache; audit-line records `redactedFields: ["description", "summary", "resolvingComment", "alerts.titles"]` and `status: "degraded"`.
- **SecureScore-style stale-ingest degraded path:** mirrors ADR-0027 §Decision.7 — `IngestHealth[graph.security.incidents].consecutiveFailureCount ≥ 3` triggers a minimal envelope with a degradation notice in `attackNarrative`, cache-write proceeds, audit-line records `status: "degraded"`. **Same mandatory co-landing constraint as ADR-0027: the commit that introduces `status: "degraded"` pairs with an update to `scripts/verify-audit-chain.mjs` accepting the new enum value.** ADR-0027 and ADR-0028 both emit this status — the verifier-extension commit is shared.
- **Budget exhausted:** standard `AgentFetchError(kind: "budget_exceeded")` → handler returns `429 Too Many Requests` with `Retry-After`. Operator tries again after the daily reset.
- **Circuit breaker open:** incidents-agent's `AgentHealth` row is independent of brief/posture. One open breaker does not pause the others.

### 10. Non-surfaces (v1)

- **Auto-run on incident ingest.** Explicitly rejected (§Decision.3 rationale). Future "auto-analyse high-severity" policy is a separate ADR with a budget model.
- **Investigation-comment summarisation.** Comments dropped from the prompt (§Decision.1). Surfacing them would require a dedicated specialist with its own prompt-injection review.
- **Cross-incident correlation.** Not this specialist. A future "campaign-agent" is the home for cross-incident patterns — separate ADR.
- **Remediation script generation.** `suggestedNextSteps` is narrative, not executable code. Actions-generation is out of scope for v1 per PROJECT_BRIEF §5 "deterministic first, LLM last".
- **Sub-tasks on incidents.** Dashboard provides a read view; incidents-agent analyses; it does not mutate incident state (no `POST /incidents/{id}/close` or similar).

## Consequences

**Positive.**

- Closes the step-7 specialist trio (brief + posture + incidents). Each specialist has distinct cadence, distinct depth, distinct cache pattern — the three-ADR trio maps cleanly onto PROJECT_BRIEF §7's "daily / weekly / per-incident" hint.
- On-demand-only trigger sidesteps the "is it worth scheduling" question the other two specialists had to resolve. Operator opt-in is the simplest auth model for an interpretive layer.
- Per-field screening pattern established here becomes the template for any future specialist with multiple adversary-influenceable text fields.
- Dynamic source-key validator (§Decision.8) unlocks per-entity analysis patterns for any future specialist (e.g. per-risky-user analysis, per-CVE analysis) without further ADR-0020 amendments.
- Agent MI only gains one additional read grant (`incidents-detail` blob reader) — smallest RBAC delta of the three specialists.

**Negative / trade-offs.**

- The agent MI now has read access to operator-authored content (`resolvingComment`). That expands its read surface slightly — still read-only, still prefix-scoped within the agent plane, but worth documenting. Compensating control: the same MI-on-read pattern is already used for incident-detail blobs consumed by the incident-detail handler path under api-reader MI; the risk shape is understood.
- Dynamic source-key validation (§Decision.8) splits the "one-place, one-convention" invariant slightly — `CANONICAL_SOURCE_KEYS` is no longer a complete enumeration. The regex + adapter-context pattern is documented in `agentSourceKeys.ts` with tests; the "one place" principle is preserved as "the helper function is the authoritative check" rather than "the tuple is the authoritative enumeration".
- The specialist surface is now three specialists with three different cache topologies (daily, weekly, per-entity). Future operators reading the codebase need to orient across all three patterns. Mitigated by consistent module naming (`run<Name>Agent.ts`, `<name>PromptBuilder.ts`) and the shared primitives in `runAgent.ts`.

**Negative we accept (explicit).**

- An operator running incidents-agent across many incidents in a short window can hit the 20/day ceiling. Intended behaviour at the stated budget — operators who want more run a single admin action to raise the ceiling on the admin-settings page. The budget is an input to the control, not an impediment.
- Per-field redaction on a heavily-poisoned incident detail leaves the model with a thin narrative surface. The resulting brief will be narrow ("incident was flagged but detail could not be included for policy reasons"). This is the correct safe default — a poisoned detail should not pollute the narrative.

---

## Appendix A — Step-7 specialist trio, finalised

| Specialist | Cadence | Primary source | Budget ceiling (default) | Cache granularity | Primary ADR |
|---|---|---|---|---|---|
| `brief-agent` | Daily 05:00 UTC | Multi-source | 30 manual/day + 200K tokens | Per-day | ADR-0020 |
| `posture-agent` | Weekly Monday 06:00 UTC | SecureScore + 14d trend | 10 manual/day + 20K tokens | Per-ISO-week | ADR-0027 |
| `incidents-agent` | On-demand only | Incidents detail blob | 20 manual/day + 15K tokens | Per-incident | ADR-0028 (this) |

Future candidates (not scheduled):

- `stack-agent` — StackItems / KEVMatches. PROJECT_BRIEF §7 hint. Own ADR.
- `campaign-agent` — cross-incident correlation. Triggered by this ADR's non-surface clause. Own ADR if ever scheduled.

## Appendix B — What this ADR is NOT deciding

- **Whether the "analyse" button lives in the incident detail drawer vs a dedicated analysis panel.** UX choice, belongs to the implementation PR.
- **The exact regex tolerance on `/^incidents\.(summary|detail)\.[A-Za-z0-9_-]+$/`.** The regex permits alphanumerics + dash + underscore because those are the observed character classes in Defender incident IDs. If Microsoft Graph starts emitting incident IDs with other characters (e.g. dots), the regex tightens in the implementation PR (not a re-ADR — additive regex broadening under the same subset-check invariant).
- **`comments[]` surfacing.** Explicitly non-surface here. A future ADR decides if operators want it.
- **Budget-schema continued additive discipline.** This ADR adds two columns; the trigger for a nested-rename schema versioning ADR (per ADR-0027 §Decision.4) is still "when flat schema hits practical width limits" — adding two more columns for this specialist is inside that envelope. **Concrete trip-wire** (new, per WS10 SEC-L-ADR28-04 resolution): a schema-versioning ADR is required before either (a) `AgentBudget` reaches **≥8 agent-specific columns** OR (b) more than **two additional specialists** land since this ADR. After this ADR the column count is 6 (`Brief{Manual,Tokens}` + `Posture{Manual,Tokens}` + `Incidents{Manual,Tokens}`); a hypothetical `stack-agent` + `campaign-agent` landing without schema change would push to 10 and trip axis (a). Either axis warrants the nested-rename ADR with an explicit migration runbook, not a continued flat-additive commit.
