# AGENTS.md — AI plane

Reference for the optional AI plane: the Azure AI Foundry project, the specialist agents that run against ingested tenant data, the orchestrator and budget mechanics, the audit-chain extension, and the read APIs that serve narrative output to the dashboard.

For cross-cutting system shape see `ARCHITECTURE.md`. For the upstream ingest stores the agents read see `INGEST.md`. For the user-facing explainer of what reaches Azure OpenAI see `AI-SECURITY-POSTURE.md`.

---

## 1. Overview

**The AI plane is off by default.** New deployments set `AZURE_DEPLOY_AI_AGENTS=false`; the dashboard works fully without it — every tile, every ingest path, every read API stays functional. Nothing reaches Azure OpenAI unless an operator explicitly flips the flag and re-provisions.

When enabled, the plane comprises:

- **One Azure AI Foundry Hub + one Project per environment**, deployed into the same resource group and region as the ops storage account. Region co-location is enforced at the Bicep layer and re-checked at orchestrator boot.
- **A fourth user-assigned managed identity, `id-aegis-agent-<env>-<region>`**, bound to the Function App. The agent MI reads ingest Tables + the incidents-detail blob container, writes narrative blobs + cache Tables, and never writes to the audit container directly.
- **Specialist agents** — `brief-agent` (daily), `posture-agent` (weekly), `incidents-agent` (per-incident, on-demand). Each is a statically-registered adapter behind a thin router. No dynamic registration, no plug-in surface.
- **Per-agent cache Tables + narrative blob containers** so dashboard reads serve from cache and don't block on synchronous LLM calls.
- **An audit-chain extension** appending `agent.run` lines to per-`(agent.aegis.<name>, tenantId)` chains under the same hash-chain primitives as ingest.

The plane is opt-in, single-tenant, and structurally bounded — agents have no Graph / Defender / Sentinel scopes, no tool-calling, and no ability to invoke each other.

---

## 2. Threat model

Three load-bearing properties:

- **Prompts go to Azure OpenAI in the chosen region.** Inputs are sanitised snapshots of the tenant's ingested security data. Microsoft's standard Azure OpenAI retention applies: prompts and completions are retained up to 30 days for abuse-detection scanning, with human review only on policy-flagged content. No cross-tenant data is shared; no tenant data is used to train models.
- **No cross-tenant invocation.** The Foundry project's Entra tenant is pinned to the deployer's tenant. An orchestrator boot-time check compares the subscription tenant ID against the MI token's tenant ID and fails closed on mismatch.
- **Operator-influenced inputs are adversary-influenceable.** Microsoft-authored prose fields (incident `displayName`, `description`, `summary`, alert titles, `resolvingComment`) can carry attacker-seeded text. The four-layer prompt-injection defence (length cap, control-character strip, denylist redaction, fenced delimiter) is the primary mitigation; the system prompt names the defence so the model has a non-technical override path.

`AI-SECURITY-POSTURE.md` is the full user-facing explainer. An operator whose environment cannot accept the Azure OpenAI retention posture leaves the plane disabled.

---

## 3. Foundry project

| Property | Value |
|---|---|
| Resource layout | One Hub (`aif-aegis-hub-<env>-<region>`) + one Project (`aif-aegis-proj-<env>-<region>`) per environment, in `rg-aegis-<env>-<region>`. |
| Region | Same region as the ops storage account. Pinned at the Bicep layer; re-checked at orchestrator boot. |
| Identity | User-assigned MI `id-aegis-agent-<env>-<region>`. No client secrets, no shared keys. Foundry account `disableLocalAuth: true`. |
| SDK | `@azure/ai-projects` on Node 22. `AIProjectClient` constructed with `DefaultAzureCredential({ managedIdentityClientId: agentMi })`. REST is a documented fallback only. |
| Tenant pin | Implicit (deployment tenant) and reinforced at boot. |
| Network posture | Public + Function-App-subnet allow-list in dev; private endpoint + `publicNetworkAccess: Disabled` in prod when `privateEndpointsEnabled: true`. |
| Cost controls | Subscription-scope Cost Management budget (default £25/mo dev, £100/mo prod) at 50% / 80% / 100% thresholds. RG-scope Azure Policy `aegis-foundry-model-sku-allowlist` denies non-`Standard`-tier deployments and non-allow-listed model names. |

Agent MI role assignments are narrow:

| Scope | Role |
|---|---|
| Foundry Project | Azure AI Developer |
| Ops Tables (`IngestHealth`, `Incidents`, `SecureScore`, `EntraRisk`) | Storage Table Data Reader (per-table) |
| Cache Tables (`AgentBudget`, `AgentHealth`, `BriefCache`, `PostureCache`, `IncidentAnalysisCache`) | Storage Table Data Contributor (per-table) |
| `daily-briefs`, `posture-narratives`, `incident-narratives` blob containers | Storage Blob Data Contributor |
| `incidents-detail` blob container | Storage Blob Data Reader |
| Audit container | None — audit MI is the sole writer |
| Microsoft Graph / Defender / Sentinel | None — agents are ops-store-only |

---

## 4. Model tiering

Specialists resolve a model by **deployment name**, not by SKU. Handlers reference `aegis-small`; Bicep maps the name to a specific SKU and pinned version. Version upgrades change Bicep, not code.

| Agent | Deployment | Underlying SKU | Tier | Rationale |
|---|---|---|---|---|
| `brief-agent` | `aegis-small` | `gpt-4.1-mini` | `Standard` (region-resident) | Multi-source summarisation; small model sufficient. |
| `posture-agent` | `aegis-small` | `gpt-4.1-mini` | `Standard` | Weekly Secure Score narrative; depth-first in one domain. |
| `incidents-agent` | `aegis-small` | `gpt-4.1-mini` | `Standard` | Per-incident interpretive narrative; tight token cap. |

Defaults are chosen for cost. Operators wanting a different model amend Bicep and the policy allow-list. The "try small, fall back to large" pattern is **forbidden** — it is a prompt-injection cost-exfiltration primitive. The forbid-fallback posture is enforced on three independent planes: the Azure Policy deny, an orchestrator boot-time assertion on every adapter's `modelDeployment`, and a per-invocation check inside `runAgent` before the Foundry call.

Non-determinism floor is identical across agents: `temperature: 0.2`, `top_p: 1.0`, no seed, `max_completion_tokens` per adapter. The configuration gives natural daily variation without byte-exact pinning.

---

## 5. Orchestrator pattern

The orchestrator is a thin router in three modules:

- `agentClient.ts` — Foundry SDK glue, budget check, retry, error classification.
- `runAgent.ts` — generic adapter-driven invocation: builds the thread, submits the prompt, polls the run, returns an outcome.
- `run<Name>Agent.ts` — one adapter per specialist; builds the prompt deterministically, calls `runAgent`, persists results to the cache and the audit chain.

All specialists are statically registered. There is no dynamic registry, no plug-in surface, no "raw prompt" endpoint. Each call goes through a specific adapter with a fixed agent name, allow-listed deployment, and fixed audit-event type.

### Token budget

Each agent has a per-day `(tenantId, yyyy-mm-dd, agentName)` row on a shared `AgentBudget` Table. Reservations use a commit-then-call ETag lease:

1. Read today's row under `IfMatch`. Sweep any reservation past its TTL (process-death cleanup; emits `AgentReservationSwept`).
2. If `tokensInToday + tokensOutToday + estTokens > tokensBudget`, refuse with `budget_exhausted`. If `runsAttempted >= runsDailyCeiling`, refuse with `rate_limit_daily`. No Foundry call.
3. Write the row back with a provisional reservation (`estIn`, `maxOut`, `runId`, `expiresAt = now + 10min`). `412` → retry once, then refuse with `lease_contended`.
4. Issue the Foundry call.
5. Reconcile against the same row key the run started on (not a fresh "today" lookup): replace the reservation with actuals, clear the reservation columns.

Defaults: `brief-agent` 200,000 tokens/day + 30 manual runs/day; `posture-agent` 20,000 + 10/day; `incidents-agent` 15,000 + 20/day. Operators override per agent via the admin settings page (§9).

A `budget_exhausted` outcome surfaces in the SPA's Agent observability page and is recorded as an `agent.run` audit line with `tokensIn=0`, `tokensOut=0`, `status="error"`, `error.kind="budget_exceeded"`.

### Circuit breaker, timeout, retry

A per-agent `AgentHealth` row holds rolling consecutive-failure state independent of the daily budget. Five consecutive failures open the circuit for ten minutes with exponential back-off (capped at four hours); a `half_open` probe lets one call through. The breaker outlives UTC day-rolls.

Single-run wall-clock is 180 s. Retries: three attempts with full-jitter exponential back-off; retry on `timeout` / `throttle` / `5xx` / `network`; never on `4xx` / `content_filter` / `budget_exceeded` / `forbidden_deployment`.

---

## 6. Per-agent contracts

### 6.1 `brief-agent` — daily brief

| Property | Value |
|---|---|
| Purpose | Daily narrative summarising the tenant's security posture across ingested sources. |
| Trigger | Timer `0 0 6 * * *` (06:00 UTC daily); `POST /api/ingest/brief/run` (admin-only, 30/day). |
| Inputs | `SecureScore` (latest + 7-day delta), `IngestHealth` (all rows), `Incidents` (last 24h, summary rows only — no detail blobs), `EntraRisk` (last-7-day active risky users, top 25), `AgentBudget` (today). |
| Prompt minimisation | Positive-match column whitelist per source — any field not whitelisted is dropped at the builder boundary. Object GUIDs by default for user identifiers (per `UserIdentifierStrategy`). Service counts not service lists. URL fields, correlation IDs, audit-chain primitives, MI identifiers, KV references, and tenant ID are never on the prompt. |
| Output | JSON envelope `{ schemaVersion, headline, severity, narrative, openQuestions, sourcesUsed }`. `severity` is `informational \| notable \| urgent`. Narrative is plain-markdown prose, hard-capped at `max_completion_tokens: 1500`. An adapter-side subset-check rejects any `sourcesUsed` entry the builder didn't include (`source_fabrication`). |
| Cache | `BriefCache` Table row per `(tenantId, yyyy-mm-dd)` + `daily-briefs/<yyyy>/<mm>/<dd>.json` blob. Three freshness states: `fresh` (<26h), `stale` (26h–72h, serves cached with badge), `unavailable` (≥72h, empty state). |
| Read API | `GET /api/brief/latest` (tile + full page; body inlined), `GET /api/brief?date=YYYY-MM-DD` (historical, within retention). Both verify the blob body SHA-256 against the chain-recorded `outputSha256`; mismatch returns `unavailable` and writes an `output_tamper` audit line. |
| Audit | `eventType: "agent.run"`, source `agent.aegis.brief`. |

### 6.2 `posture-agent` — weekly posture narrative

| Property | Value |
|---|---|
| Purpose | Weekly narrative describing Secure Score posture, week-over-week movement, and top control-score priorities. |
| Trigger | Timer `0 0 6 * * 1` (Mondays 06:00 UTC); `POST /api/ingest/posture/run` (admin-only, shared 30/day ceiling). |
| Inputs | `SecureScore` (latest + 14-day trend), `SecureScore.controlScores` (top 10 by absolute movement vs 14 days ago — builder-derived, deterministic), `IngestHealth` for `graph.security.secureScores`. No multi-source data — depth-first in one domain. |
| Prompt minimisation | Same whitelist discipline as brief-agent. `controlScores[].description` is dropped by default — verbose Microsoft-authored prose with low narrative value. Cross-tenant comparative scores out of scope. |
| Output | JSON envelope with three required section keys (`currentPosture`, `recentMovement`, `priorityActions`). Headline ≤ 280 chars; each section ≤ 2,000 chars. `sourcesUsed` must be a subset of `["secureScore.latest", "secureScore.trend14d", "ingestHealth.secureScore"]`. |
| Cache | `PostureCache` Table row keyed by ISO week `posture.<yyyy-Www>` + `posture-narratives/<yyyy>/<Www>/<tenantId>.md` blob. Freshness: `fresh` <7d, `stale-serviceable` 7d–14d, `stale-unservable` ≥14d. |
| Read API | `GET /api/posture/latest`. Returns the current week's row or an `awaiting_first_run` empty state. `Cache-Control: private, max-age=300`. |
| Audit | `eventType: "agent.run"`, source `agent.aegis.posture`. |

### 6.3 `incidents-agent` — per-incident analysis

| Property | Value |
|---|---|
| Purpose | On-demand interpretive narrative for a specific incident — attack characterisation, blast-radius assessment, suggested next steps. |
| Trigger | `POST /api/ingest/incidents/{id}/analyse` (admin-only, 20/day). No Timer — operator opt-in per incident. |
| Inputs | `Incidents` summary row for the requested ID + the parsed `incidents-detail/<id>.json` blob (`description`, `summary`, `resolvingComment`, top-10 alerts) + `IngestHealth` for `graph.security.incidents`. The agent MI gains read on `incidents-detail` for this specialist only. |
| Prompt minimisation | Per-field screening before `JSON.stringify` — each adversary-influenceable field passes through the four-layer defence individually. A denylist hit on one field redacts to `[redacted — content policy]` without dropping the source. `incident.comments[]`, URL fields, and any cross-incident correlation are out of scope. The adapter is the only caller of `getIncidentDetailBlob`; the `incidentId` is drawn from the authoritative run context, never from model output. |
| Output | JSON envelope with three required section keys (`attackNarrative`, `impactAssessment`, `suggestedNextSteps`). `sourcesUsed` accepts the static keys plus suffixed `incidents.summary.<id>` / `incidents.detail.<id>` where `<id>` must equal the run's incident ID. |
| Cache | `IncidentAnalysisCache` Table row keyed by `incidents.analysis.<incidentId>` + `incident-narratives/<incidentId>.md` blob. Freshness is content-addressable: a cache hit requires `AnalysedContentSha256` to match the canonicalised hash of current whitelisted prompt inputs — timestamp bumps without content change don't invalidate. |
| Read API | `GET /api/incidents/{id}/analysis`. Returns the cached envelope plus `AnalysedIncidentLastUpdateDateTime` so the SPA can surface "incident has been updated since — re-analyse" states. `Cache-Control: private, max-age=30`. |
| Audit | `eventType: "agent.run"`, source `agent.aegis.incidents`. The `redactedFields` field carries the per-field redaction trail. `RedactionLockRunCount ≥ 2` trips a 24h per-incident lock returning the cached "analysis withheld" envelope without spending budget; an admin clears it via `DELETE /api/ingest/incidents/{id}/redaction-lock`. |

---

## 7. Agent audit chain

Agent runs extend the ingest audit chain primitives without changing them. Each agent gets its own per-`(source, tenantId)` chain: `agent.aegis.brief`, `agent.aegis.posture`, `agent.aegis.incidents`. Lines land in `<audit-container>/<source>/<yyyy>/<mm>/<dd>/agent-run.ndjson` — the filename differs from ingest's `ingest.ndjson` so the blob layout distinguishes agent activity at a glance. Each line uses `eventType: "agent.run"` with the same `prevLineSha256` / `lineSha256` primitives, JCS-canonical form, and per-source `IngestHealth` row driving the singleton-writer ETag lease.

The **audit MI remains the sole writer.** The agent MI calls through the existing `appendAuditLine` helper, which authenticates as the audit MI. Single-writer is what gives the chain its root of trust — multiple legitimate writers would dissolve the verifier's ability to distinguish tamper from a writer race.

Agent-line schema beyond the ingest primitives:

| Field | Notes |
|---|---|
| `agentName` | `brief \| posture \| incidents`. |
| `modelDeployment` | Always an allow-listed name (`aegis-small`). |
| `tokensIn` / `tokensOut` | Foundry-reported; `0` on refused or cache-served runs. |
| `durationMs`, `retryAttempts` | Wall-clock and retry telemetry. |
| `status` | `success \| no_data \| degraded \| error`. |
| `outputSha256` | SHA-256 of the persisted narrative blob body. Read endpoints verify against this on every read. |
| `cacheOutcome` | `miss \| hit \| stale_hit \| no_cache \| null`. Cache hits are audited so the chain remains the single source of truth for "what the operator saw". |
| `promptInjectionCandidates` | Count of denylist matches the sanitiser redacted. |
| `sourceFabrications` | Count of `sourcesUsed` entries the subset-check rejected. |
| `redactedFields` | (incidents-agent only) per-field redaction trail. |
| `error` | `{ kind, message }`; `message` truncated to 2,000 chars and credential-pattern-redacted. |

Prompt text and model output text are never on the audit line — `outputSha256` is the only commitment to output content. The line scrub is positive-match + null-prototype + credential-pattern-redacted: new fields cannot silently reach the chain.

`scripts/verify-audit-chain.mjs` is source-agnostic. It applies invariant-integrity assertions on `agent.run` lines (allow-listed `modelDeployment`, strict `status` enum, allow-listed `agentName`, `error` iff `status === "error"`, `outputSha256` 64-char-hex-or-null, non-negative token counts) with two exit codes: `1` for chain-integrity failure (hash mismatch, seq gap); `2` for invariant-integrity failure (hash verifies but a line violates a locked invariant). Per-agent verification:

```bash
node scripts/verify-audit-chain.mjs --source agent.aegis.brief --tenant <tenantId>
node scripts/verify-audit-chain.mjs --source agent.aegis.posture --tenant <tenantId>
node scripts/verify-audit-chain.mjs --source agent.aegis.incidents --tenant <tenantId>
```

---

## 8. Caching

Each agent's output lives in two places: a summary Table row and a body blob. The split matches the Table-plus-detail-blob pattern used by ingested incidents — tiles render from the row in one read; full content fetches from the blob on demand.

| Agent | Cache Table | Blob container | Granularity | Retention (prod / dev) |
|---|---|---|---|---|
| `brief-agent` | `BriefCache` | `daily-briefs/<yyyy>/<mm>/<dd>.json` | Per UTC day | 180d / 14d |
| `posture-agent` | `PostureCache` | `posture-narratives/<yyyy>/<Www>/<tenantId>.md` | Per ISO week | 21d |
| `incidents-agent` | `IncidentAnalysisCache` | `incident-narratives/<incidentId>.md` | Per incident | Until parent incident is purged |

Caches are **lazily populated** — written on successful agent run. Read APIs serve from cache; they never trigger a synchronous agent run on miss (a miss returns an empty / `awaiting_first_run` state). Timer-driven specialists keep the cache warm; admin manual-triggers refresh on demand. Read paths verify the blob SHA-256 against the chain's recorded `outputSha256` on every fetch; mismatch returns an `unavailable` state and emits an `output_tamper` audit line.

Cache Tables and blob containers persist across the `AZURE_DEPLOY_AI_AGENTS` toggle. Flipping the plane off and on doesn't lose data. Deletes are lifecycle-policy-driven only — no code path calls `deleteBlob` on any of these containers; a CI test greps the compiled API tree and fails the build on a match.

---

## 9. User-identifier strategy

User identifiers in agent narratives are governed by a tenant-wide setting under `TenantSettings[user-identifier-strategy]`. The strategy controls how user references reach the LLM prompt — and therefore Azure OpenAI's retention surface and the chain's `outputSha256`-committed output.

| Strategy | Prompt projection | Posture |
|---|---|---|
| `objectId` (default) | `{ id: <user objectId GUID> }` | Privacy-by-default. No PII in the prompt, in the model context, in the audit chain, or in the persisted narrative blob. The SPA joins object IDs to display names client-side at render. |
| `partial_mask` | `{ id, displayNameMasked: "J*** D**" }` | Reader-friendly enough for muscle-memory recognition while strongly PII-reduced. The builder generates the mask; raw display names never reach the prompt. |
| `display_name` | `{ id, displayName: "Jane Doe" }` | Opts the tenant into sending Entra `userDisplayName` to Azure OpenAI. The four-layer defence applies, plus pre-`JSON.stringify` field-level screening on the display-name string. Acknowledged risk relaxation — appropriate for SMB tenants where the admin knows every user, demo environments, or deployments where operational benefit outweighs the residency surface. |

The strategy is a per-tenant policy, not a per-brief toggle. Changes are surfaced in the admin settings page (§10) and audited as `action: "user-identifier-strategy-update"` with `from` / `to` values. Changes do not retroactively re-render cached briefs; the next agent run picks up the new projection.

---

## 10. Admin settings interactions

Two AI-plane sections on the admin settings page:

- **Agent budget overrides.** Per-agent sliders for `<Agent>ManualRunCeiling` (1–100) and `<Agent>DailyTokenBudget` (50,000–500,000) per enabled specialist. The row is pure override — deleting it reverts to the environment default. Validation rejects out-of-range or non-integer values at the PATCH handler.
- **User identifier strategy.** Radio group with the three options above; default selection is `objectId`.

Both rows live under `TenantSettings` as `RowKey = "agent-budget"` and `RowKey = "user-identifier-strategy"`. Writes go through `patchSettings.ts` → a single `upsert*` per RowKey; an ABAC condition on the writer MIs restricts the allowed RowKey set. Reads land on `GET /api/settings` under `agentBudget` and `userIdentifierStrategy`, each carrying a `source: "default" | "tenant"` discriminator the SPA uses for the "Using defaults" label.

---

## 11. Disabling the AI plane

`AZURE_DEPLOY_AI_AGENTS=false` is the default. With it off:

- The Foundry Bicep module does not deploy. No Hub, no Project, no model deployment, no AI-plane Cost Management budget, no Azure Policy on model SKUs.
- The agent MI is not provisioned and not bound to the Function App.
- The ESM gate in the API package excludes agent handler modules from the bundle, so the Function App has no code paths that could attempt a Foundry call.
- The SPA hides the `BriefTile`, `PostureTile`, the Incident-detail AI tab, the Agent observability page, and the admin settings sections for **AgentBudget** and **UserIdentifierStrategy**. Secure Score, Incidents, Entra risky-users, ingest-health, and every other read tile render normally.

Tables (`AgentBudget`, `AgentHealth`, `BriefCache`, `PostureCache`, `IncidentAnalysisCache`) and blob containers (`daily-briefs`, `posture-narratives`, `incident-narratives`) persist across the toggle. A deployment flipping the plane off keeps prior cached output addressable until lifecycle policy trims it. Flipping back on resumes the schedule from the next Timer fire; no migration step.

The toggle is the cheapest, strongest AI-plane control: an environment that cannot accept the Azure OpenAI residency posture leaves it off and loses no dashboard functionality.
