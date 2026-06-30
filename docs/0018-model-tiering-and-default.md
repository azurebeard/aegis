# ADR-0018 — Model tiering and default SKU for the agent layer

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0017 locked the Azure AI Foundry project's **shape** — one Hub + one Project per environment, West Europe co-located with the ops stores, a dedicated `id-aegis-agent-<env>-<region>` MI, `@azure/ai-projects@^2.1.0` on Node 22. It deferred **which model SKU** the orchestrator's specialist agents would use to this ADR.

Step 5's scope is a single specialist (`brief-agent`, ADR-0020) doing text summarisation of the ops store + a routing orchestrator (ADR-0019). Step 7 expands the specialist roster (`posture-agent`, `incidents-agent`, `stack-agent`). All five agents in the v1 roster are text-only: no vision, no audio, no tool-calling beyond ops-store reads the handler has already done before the LLM is invoked (per `PROJECT_BRIEF.md §5` "deterministic first, LLM last").

The decisions this ADR locks:

1. **Which model deploys** to the AI Services account at step 5 Phase 2 provision time.
2. **How the orchestrator + specialists address the model** (deployment name, request shape).
3. **Tiering policy** — when a future agent may upgrade to a larger class (and when it may NOT).
4. **Version pinning + deployment lifecycle** — how to evolve the SKU without breaking in-flight agent threads.
5. **Fallback behaviour** — what the orchestrator does on deployment outage / quota-exceeded / terminal error.

Research as of 2026-04-19 confirms (via [Microsoft Learn model-region-support](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/model-region-support?view=foundry-classic), updated 2026-04-15):

- **West Europe** has `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-4.1-nano` available on Global Standard and Standard deployment tiers.
- **West Europe** does NOT have `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, or `gpt-5-chat`.
- Microsoft's current positioning groups `gpt-4o-mini` with legacy `gpt-4o` as "multimodal with vision," and positions the `gpt-4.1` family as the "cost-effective models for general-purpose agent workloads" for text-only tasks.

Exact West Europe PAYG token pricing was not machine-scriptable at ADR authoring time (Azure pricing page is JS-rendered + blocked to scrapers); third-party trackers report rough parity with gpt-4o-mini ($0.15/M input, $0.60/M output globally). Exact calibration deferred to the first live week.

## Decision

### 1. Default SKU — `gpt-4.1-mini` on the Standard deployment tier

The step-5 `brief-agent` and any step-7 specialist defaults to a **`gpt-4.1-mini`** model deployment named `aegis-small` on the AI Services account.

- **Deployment name:** `aegis-small`. Stable and opaque to handler code — the orchestrator resolves the model via the deployment name, never the underlying SKU.
- **SKU:** `gpt-4.1-mini`. Microsoft-current "cheapest capable" small-model SKU for text classification, routing, and summarisation. `gpt-4o-mini` is functionally equivalent but is positioned by Microsoft as multimodal-with-vision and is therefore a superset of what we need. `gpt-4.1-nano` is cheaper still but documented as lower-quality on summarisation-style tasks; it remains available under the `aegis-nano` name for future fine-grained routing decisions within the orchestrator (ADR-0019 scope), not here.
- **Deployment tier:** `Standard` (strictly region-resident). The RG-scope Azure Policy named `aegis-foundry-model-sku-allowlist` (pre-committed in ADR-0017 §Decision.8 point 2) denies any `Microsoft.CognitiveServices/accounts/deployments` whose `properties.sku.name` is not in `['Standard']`, i.e. forbids `GlobalStandard` / `DataZoneStandard` / `GlobalProvisionedManaged`. That Policy is extended in ADR-0018 (see §Decision.3 enforcement below) with an additional `allowedModelNames` matcher on `properties.model.name`. Together these pin inference + telemetry to the single region that matches the ops stores AND restrict the underlying model SKUs the deployment can carry (WS10 SEC-L-ADR-18-01 + SEC-M-ADR-18-01 resolution).
- **Version pinning:** the deployment points at a specific model version (e.g. `gpt-4.1-mini` `2025-04-14`) rather than `latest`. Version upgrades are ADR-gated; a silent upgrade to a new model version is the category of change that could subtly alter output shape or cost, and every agent's prompt fixtures are calibrated against a specific version.
- **Capacity:** one TPM unit at v1 scale; the Foundry portal surfaces capacity per subscription + region and the dev deploy pre-flight check (ADR-0017 §Neutral deferral) lands before step 5 Phase 2 provisions the deployment.

Rationale:

- **Data-residency first, cost second, capability third.** West Europe has both our ops stores and our only legally-resident small-model tier. Locking the default to `gpt-4.1-mini` on `Standard` preserves both invariants.
- **`gpt-4.1-mini` is the current "cheapest capable".** Microsoft's own documentation as of 2026-04 groups `gpt-4.1-mini` as the small-model default for general-purpose agent workloads. We are not the first user of this SKU; the published fixture set for summarisation-style tasks is stable.
- **`aegis-small` (not `gpt-4.1-mini`) in the handler.** The deployment name abstracts the SKU. When a future ADR lifts the SKU (e.g. to `gpt-4.1` if summary quality proves insufficient, or to a gpt-5-class model if region changes), only the Bicep changes; the handler references `process.env.BRIEF_MODEL_DEPLOYMENT = "aegis-small"` unchanged.

### 2. How agents invoke the model

The orchestrator + specialists construct the model request via `@azure/ai-projects`:

```typescript
const client = new AIProjectClient(
  config.foundryProjectEndpoint,
  new DefaultAzureCredential({ managedIdentityClientId: config.agentMiClientId }),
);

const agent = await client.agents.createAgent({
  model: config.briefModelDeployment,  // "aegis-small"
  name: "brief-agent",
  instructions: BRIEF_AGENT_SYSTEM_PROMPT,
});

const thread = await client.agents.threads.create();
await client.agents.messages.create(thread.id, { role: "user", content: prompt });
const run = await client.agents.runs.create(thread.id, { agentId: agent.id });
// Poll run status → fetch assistant message → parse.
```

The `model` field is the **deployment name**, NOT the SKU. Bicep sets `BRIEF_MODEL_DEPLOYMENT = "aegis-small"` on the Function App app settings; handlers never see the underlying SKU.

### 3. Tiering policy — when to upgrade, when NOT to

XDR Hub's LLM cost plane is the primary cost-control concern (`PROJECT_BRIEF.md §5`). This ADR locks a **default-small, upgrade-by-ADR** policy:

1. **Step 5's `brief-agent` uses `aegis-small` only.** No orchestrator-side routing logic tries larger SKUs on its own.
2. **Step 7 specialists default to `aegis-small`.** `incidents-agent` narrative summarisation, `posture-agent` Secure Score explanation, `stack-agent` CVE/KEV correlation are all text tasks well within small-model capability.
3. **A future specialist may warrant a larger SKU** (not yet in scope, but the policy is stated so the next ADR author doesn't have to re-derive it):
   - **Chain-of-thought reasoning requiring gpt-5 or gpt-4.1 full.** An ADR must justify both the capability need AND the regional move (West Europe doesn't have gpt-5; either the agent runs cross-region with a data-residency ADR, or the region moves).
   - **Token-budget math that makes a larger-but-fewer-calls SKU cheaper net.** An ADR must publish the per-task cost comparison (calls × avg-tokens × per-token price).
4. **An orchestrator-side "try small, fall back to large"** pattern is **explicitly forbidden** at v1. Prompt-injection on the small model's output could steer the orchestrator into a large-model retry, which is a cost-exfiltration primitive the in-code budget (ADR-0019) alone doesn't bound tightly enough. A future ADR can revisit once the budget-breach observability (ADR-0019) has real telemetry.

**Three-plane enforcement of the forbid-fallback posture (WS10 SEC-M-ADR-18-01 resolution).** ADR-prose is the strategy; three concrete mechanical gates are the enforcement:

   1. **Azure Policy plane** — the RG-scope `aegis-foundry-model-sku-allowlist` Policy (ADR-0017 §Decision.8 point 2) is extended with an `allowedModelNames` array parameter whose default is `['gpt-4.1-mini', 'gpt-4.1-nano']`. Effect: `Deny` on any `Microsoft.CognitiveServices/accounts/deployments` whose `properties.model.name` is not in that list. A compromised deployer cannot provision a `gpt-4.1` (full) or `gpt-5-*` deployment into this RG without first amending the Policy, which itself requires subscription-level permission.

   2. **Orchestrator boot-time assertion** — `api/src/lib/agentClient.ts` throws `ConfigError` at construction time if `config.briefModelDeployment !== "aegis-small"`. Pre-committed here so ADR-0019's orchestrator cannot silently accept a different deployment name from a misconfigured app setting. The assertion list is extended as each future specialist lands (e.g. `config.postureModelDeployment === "aegis-small"`); any extension is itself ADR-gated.

   3. **Per-invocation check** — the `runAgentOnce` code path (ADR-0019 §Decision.agentClient) validates the deployment name passed to `client.agents.createAgent({ model: <name>, ... })` against the allow-list `["aegis-small"]` before issuing the Foundry call. Surfaces as `AgentFetchError(kind: "internal", message: "forbidden deployment: <name>")`. Fails the run and records the attempt in the audit log.

The three planes are independent: an attacker who bypasses one still faces the other two. Policy + boot assertion + per-call check is strictly stronger than any single layer.

### 4. Version + deployment lifecycle

- **Pin the model version** in Bicep via the deployment's `properties.model.version` field (`2025-04-14` at ADR authoring, subject to confirmation at step-5 Phase 2 against the live Foundry catalogue).
- **Version upgrades** are a Bicep change + an ADR addendum stating the test fixture diff (the brief-agent's test harness in `api/tests/` runs the deterministic prompt against the new version and asserts output-shape parity before the upgrade ships).
- **Deployment replacement is atomic.** The Foundry deployment resource is `InsertOrReplace`-equivalent at ARM level; in-flight agent threads holding the old deployment ID receive the new deployment on their next run (Foundry's thread metadata does not pin the deployment version).
- **The deployment name stays stable across version upgrades** (`aegis-small` regardless of the underlying SKU version). This keeps handler code version-agnostic and keeps the audit log's `modelDeployment` field stable for forensic comparison across months.

### 5. Fallback behaviour

When the orchestrator's `createRun` or `pollRun` returns a terminal error, the budget is exceeded, or the deployment is unreachable:

1. **Classify the error** (`AgentFetchError` kind per ADR-0019 §agentClient) as one of: `throttle`, `content_filter`, `budget_exceeded`, `dependency_unavailable`, `internal`.
2. **Serve cached result if available, bounded by a staleness ceiling (WS10 SEC-M-ADR-18-02 resolution).** `brief-agent` caches the day's brief (ADR-0022); a failed run falls through to the cached version with a `cacheStale: true` flag surfaced to the UI. The staleness ceiling is load-bearing: without it, a sustained attack that force-drains the token budget (via a prompt-injection induced retry storm) would suppress every subsequent agent run indefinitely, silently re-serving the last good brief while new high-priority Incidents / EntraRisk signals accumulate unnoticed. This ADR pre-commits the **existence** of a ceiling; the exact duration (numeric value) lands in ADR-0022's cache contract but MUST be finite. Beyond the ceiling, the read endpoint returns a distinct `status="unavailable"` response (not cached-stale), the tile renders a warning banner that the brief has aged out, and the failure cannot be suppressed by continued error runs. A future ADR may introduce an operator-authored override for extended outages, but v1 treats "stale past ceiling" as a loud, user-visible failure mode.
3. **Never auto-fail-over to a larger SKU.** §Decision.3 point 4 above.
4. **Emit `AgentRun` custom event** with `status="error"` and the kind. App Insights alert on consecutive failures (ADR-0019).
5. **Commit the IngestHealth-equivalent row** for `agent.aegis.brief` source with `status=degrading`, same pattern as ingest handlers (ADR-0011 §5a / ADR-0015 chain).
6. **Write a `status=error` audit.run line** with `tokensIn` / `tokensOut` populated if the call got as far as Foundry (the billed cost is audited even when the response is unusable).

## Consequences

### Positive

- **Cost-controlled by construction.** Small model default + forbid-fallback policy bounds the LLM cost plane at the model-tier layer, complementing the ADR-0019 in-code budget.
- **Deployment-name abstraction.** Handler code doesn't reference SKU strings; a future SKU change is a Bicep + Azure Policy deny-list update, not a code change.
- **Data-residency preserved.** `Standard` tier pins inference to West Europe; `GlobalStandard` etc. already forbidden by ADR-0017 §Decision.8's Policy deny.
- **Model-version pinning + ADR-gated upgrades.** Closes the silent-quality-regression failure mode that `latest`-style references produce when Microsoft rolls a new snapshot.
- **Forbid-fallback posture.** Removes a prompt-injection cost-exfiltration primitive.

### Negative / trade-offs

- **Capability ceiling.** Small-model tier is sufficient for step 5's `brief-agent` (summarisation-style task) and the step-7 specialist roster. If a future agent's task genuinely needs larger reasoning, an ADR must revisit both the SKU and the region.
- **No graceful-degradation fallback.** An outage on the `aegis-small` deployment fails the agent run entirely, served from cache where possible (ADR-0022). Accepted for v1 as the right trade-off vs. a cost-exfiltration surface.
- **Third-party supply-chain surface.** The `openai@^6.16.0` transitive of `@azure/ai-projects@^2.1.0` is tracked as OBS-ADR-17-01 (non-blocking). If that surface ever concerns WS10 enough to want a Microsoft-controlled alternative, falling through to Foundry's REST API is the documented exit (ADR-0017 §Decision.4).
- **Test-harness cost.** Running the brief-agent's deterministic fixture on every version upgrade spends ~1-2K tokens per fixture run. Acceptable — fixtures run on ADR-addendum cadence, not per-commit.

### Neutral

- **Microsoft could reclassify `gpt-4.1-mini` as "legacy"** if a gpt-5-mini regional rollout reaches West Europe. In that case this ADR is amended, the deployment's underlying SKU flips, and the `aegis-small` name persists.
- **Token-budget calibration** remains deferred to the first live week per ADR-0017 §Consequences. This ADR does not pre-commit a per-run budget; that's ADR-0019's scope.
- **Per-subscription TPM default** must be checked in the Foundry portal before step 5 Phase 2 provisions the deployment (tracked OBS item from ADR-0017).

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **`gpt-4o-mini` as default** (equal-or-cheaper PAYG, available in West Europe) | Microsoft's current positioning groups `gpt-4o-mini` with legacy multimodal family; `gpt-4.1-mini` is the actively-maintained small-model SKU. Functionally equivalent for our text-only workload today, but diverges over time as `gpt-4o-mini` receives less tuning attention. Same-cost, diverging-quality trajectory → pick the one on the active path. |
| **`gpt-4.1-nano` as default** (cheapest PAYG in West Europe) | Documented by Microsoft as lower-quality on summarisation workloads; `brief-agent`'s output is user-visible prose, not a classification label. The cost delta is pennies per month at single-user scale; quality is the larger consideration. Kept in Bicep as `aegis-nano` for the orchestrator to reach for future classification-only sub-tasks (ADR-0019 scope). |
| **`gpt-5-mini` as default** | Not deployable in West Europe as of 2026-04-15. Cross-region deploy would cross the data-residency boundary ADR-0017 §Decision.2 forbids. Revisit when Microsoft ships gpt-5 in West Europe. |
| **PTU (Provisioned Throughput Units) instead of PAYG Standard** | PTU is billed monthly regardless of usage — prohibitive at single-user dev-tenant scale (<£25/month cost target, `PROJECT_BRIEF.md §11`). PAYG Standard pays only for tokens consumed. PTU revisit candidate when a production deployer's sustained load exceeds 2-3 hours of continuous inference per day. |
| **`latest` model version rather than pinned** | Silent-quality-regression failure mode on Microsoft-side snapshot rolls. Pinning keeps the test-fixture calibration meaningful over time. Cost: ADR-addendum overhead per version bump. Accepted. |
| **Orchestrator "try small, fall back to large"** | Prompt-injection cost-exfiltration primitive: a compromised upstream field that steers the small model's output can induce the orchestrator to retry on the large model, bypassing the per-call cost-small assumption. Forbidden by §Decision.3 point 4. |
| **Multiple deployment names per env** (e.g. `aegis-small-a`, `aegis-small-b` for blue-green) | Over-engineered for v1. A Bicep-level deployment replacement is atomic; in-flight threads get the new deployment on their next run. Revisit when multi-tenant / SLA guarantees enter scope. |

## Related

- `PROJECT_BRIEF.md §5` — Deterministic first, LLM last (upstream cost-control principle)
- `PROJECT_BRIEF.md §11` — Cost target (<£25/mo single-user)
- `PROJECT_BRIEF.md §14` item 3 — "Which small model for classification/routing tasks" open decision (this ADR closes it)
- ADR-0005 — Foundry Agent Service (locked architecture)
- ADR-0017 — Foundry identity + region + connection (upstream constraint)
- ADR-0019 (pending) — Orchestrator pattern + token budget enforcement (consumes §Decision.5)
- ADR-0020 (pending) — `brief-agent` contract (references `aegis-small` deployment)
- ADR-0021 (pending) — Agent audit-log extension (records `modelDeployment` field)
- [Microsoft Learn — model-region-support](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/model-region-support?view=foundry-classic)
- [Microsoft Learn — Foundry SDK overview](https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/sdk-overview)

---

*End of ADR-0018.*
