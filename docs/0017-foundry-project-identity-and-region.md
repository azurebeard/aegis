# ADR-0017 — Azure AI Foundry project: identity, region, and connection model

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Build-order step 5 (`PROJECT_BRIEF.md §15`) is the **agent layer**: the first point at which XDR Hub performs LLM work. The locked architecture (`PROJECT_BRIEF.md §3`) mandates **Azure AI Foundry Agent Service** — multi-agent orchestrator + role-specialised agents, deployed in the user's own tenant. Step 5's scope is a single specialist (`brief-agent`) behind an orchestrator; step 7 adds more specialists.

This ADR locks the **foundational Foundry project shape** — the things every subsequent step-5 (and step-7) decision depends on:

1. **Resource layout** — Hub vs Project, one-to-one or many-to-one, which resource group.
2. **Region** — where the Foundry resources live, given the ops stores are in `westeurope` and a data-residency boundary must not be silently crossed.
3. **Model availability** — confirm the small-model tier the orchestrator defaults to is deployable in that region. (Exact model SKU choice is ADR-0018's scope; this ADR only confirms regional availability of the **class** of model we need.)
4. **Identity** — which managed identity invokes Foundry, how it authenticates, and what RBAC role it holds.
5. **Connection model** — which SDK and auth flow the Function App uses, REST fallback if the SDK is insufficient.
6. **Network posture** — private endpoints on/off per env, matching the existing pattern.
7. **Tenant pinning** — explicit single-tenant restriction; no cross-tenant invocations.

Research completed 2026-04-19 against [Microsoft Learn model-region-support](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/model-region-support?view=foundry-classic), the [Foundry SDK overview](https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/sdk-overview), and the [`@azure/ai-projects` npm registry entry](https://registry.npmjs.org/@azure/ai-projects/latest). Findings are cited inline below.

## Decision

### 1. Resource layout — one Hub + one Project per environment

Each `aegis` environment (dev / test / prod) gets **one AI Foundry Hub + one AI Project** inside the existing `rg-aegis-<env>-<region>` resource group. No shared Hub across envs.

```text
rg-aegis-dev-weu/
├── aif-aegis-hub-dev-weu        # AI Foundry Hub  (workspace kind=Hub)
└── aif-aegis-proj-dev-weu       # AI Foundry Project (workspace kind=Project)
```

The names extend ADR-0001's `aif-aegis-<env>-<region>` row additively — Hub and Project are siblings rather than a single resource, so they take the same `aif-` prefix with an extra `-hub` / `-proj` discriminator. ADR-0001's naming row is NOT superseded; this is the refinement for the two-resource case that the original row did not anticipate (WS10 SEC-L-ADR-17-01 resolution).

Rationale:

- **Env isolation mirrors the rest of the stack.** KV, storage, MIs and the Function App are all env-scoped; Foundry not being env-scoped would break teardown (`azd down --force --purge` expects env-scoped resources) and make dev-only model experiments risk prod state.
- **One Project per env is sufficient.** Step 5 has one orchestrator + one specialist; step 7 adds three more specialists, still inside a single project (the Project is the *container* for agents, threads, and connections; it's not a per-agent scope).
- **Hub per env over shared Hub.** A shared Hub would reduce some admin overhead but couples dev experiments to prod's compute quota and RBAC; the cost of a dev-env Hub at idle is negligible (the Hub itself has no compute).

### 2. Region — West Europe for dev; env-configurable for prod

Dev sits in **`westeurope`**. Prod inherits the same region parameter that already drives the ops stores; if a deployer chooses a different prod region (e.g. `uksouth` to match an existing SWA plane), the Foundry project follows the ops stores, not the web plane, to avoid cross-region data egress on every agent call.

**Regional constraint on the model tier.** Confirmed against the 2026-04-15 Foundry Agent Service model-region matrix: West Europe supports `gpt-4o-mini`, `gpt-4.1-mini`, and `gpt-4.1-nano` under the Global Standard deployment tier — i.e. the "cheapest capable small model" class is available. West Europe does NOT carry `gpt-5` / `gpt-5-mini` / `gpt-5-nano`; those are `swedencentral`, `eastus2`, `uksouth` only. This ADR explicitly scopes the orchestrator to small-model capabilities available in West Europe; if a future agent vertical needs gpt-5-class reasoning, that's an ADR to re-evaluate region (ADR-0018 picks the specific SKU).

Source: [`learn.microsoft.com/azure/ai-foundry/agents/concepts/model-region-support`](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/model-region-support?view=foundry-classic).

**Data-residency rule — enforced at both the Bicep plane and the runtime plane (WS10 SEC-M-ADR-17-01 resolution).** Foundry's region is the ground truth for where LLM inference happens and where agent-thread transcripts land. A runtime-only enforcement would leave a window between `azd up` succeeding with a mis-parameterised region and the first orchestrator fire surfacing the mismatch — during that window an admin manual-trigger could ship operational data out of the deployer's data-residency boundary. Defence-in-depth is required:

1. **Bicep compile-time assertion** in `infra/modules/ai-foundry.bicep`: the module takes `opsLocation` (passed from the root `main.bicep`) and the Foundry resources pin `location: opsLocation` directly. An explicit `assert` expression (Bicep 0.31+ supports `assert` statements in subscription-scope modules) rejects any caller that attempts to override the region per-module:

   ```bicep
   @description('Foundry resources MUST sit in the same region as the ops storage account. WS10 SEC-M-ADR-17-01.')
   param location string = opsLocation
   var _regionParity = location == opsLocation
   assert regionParity: _regionParity == true
   ```

   If `assert` is unavailable on the target Bicep CLI version, fall back to a `var` + an `if (!_regionParity) {}` pattern that synthesises a reserved-resource-name collision, producing a deterministic pre-deploy failure with a named error message. The `assert` path is preferred; deployment tooling surfaces the named failure before any ARM operation fires.

2. **Runtime `ConfigError`** at orchestrator boot (the previous sole gate; now defence-in-depth): the handler compares `FOUNDRY_REGION` (injected by Bicep) with the ops-store endpoint's region and throws if they differ.

The Bicep assertion is the load-bearing gate. The runtime check is the belt-and-braces cover for the degenerate case where someone manually edits app settings on a deployed Function App without re-running `azd up`.

### 3. Identity — a fourth user-assigned managed identity

A new user-assigned MI is provisioned alongside the existing three (api-reader, ingest, audit):

- Name: `id-aegis-agent-<env>-<region>` — ADR-0001 naming.
- Principal type: `ServicePrincipal` (implicit on user-assigned MI).
- Bound to the Function App alongside the existing three (`userAssignedIdentities` property).

RBAC at provisioning time:

| Scope | Role | Why |
|---|---|---|
| `aiproj-aegis-<env>-<region>` | **Azure AI Developer** | Minimum role to create threads, invoke agents, and consume deployments inside the project. `AzureML Data Scientist` is broader and not needed; `Cognitive Services User` on the underlying AI Services account is implied through the project linkage. |
| `staegisopsdevweu` Tables service | Storage Table Data **Reader** | Reads SecureScore + Incidents rows to build the prompt context. |
| `staegisopsdevweu` Tables scoped to `BriefCache` (step 5 will add) | Storage Table Data **Contributor** | Writes the cache row per (tenantId, yyyy-mm-dd). Scope is the individual table, not the service — same pattern as ingest MI's per-table Contributor on `SecureScore` / `IngestHealth` / `Incidents` (ADR-0011 §5a / ADR-0014 §3.3). |
| `staegisopsdevweu` blob container `daily-briefs` (step 5 will add) | Storage Blob Data **Contributor** | Writes the per-day brief body. Container-scoped, not account-scoped. |
| `staegisopsdevweu` blob container `incidents-detail` | Storage Blob Data **Reader** | Agent may expand into per-incident detail when the orchestrator judges the brief context benefits from it. Read-only. |

**No write scopes on the audit container directly.** The agent orchestrator calls into the existing audit-writer shim, which authenticates as the **audit MI**. This preserves the single-writer invariant that keeps ADR-0015's hash chain coherent (multiple writer identities on the same chain creates a race condition the chain can't distinguish from tampering).

**No Graph / Defender / Sentinel scopes on the agent MI.** The agent never calls Microsoft APIs outside Foundry; all upstream data is already in the ops store by the time the agent runs. This is load-bearing for the "deterministic first, LLM last" principle (§brief 5) and for cost control: an agent that can call Graph can make expensive repeat calls inside a reasoning loop.

### 4. Connection model — `@azure/ai-projects` with DefaultAzureCredential

- **SDK:** `@azure/ai-projects` (current GA, `^2.1.0` at time of ADR, `engines.node >= 20.0.0`) — verified via `registry.npmjs.org/@azure/ai-projects/latest` 2026-04-19.
- **Entry:** `const client = new AIProjectClient(endpoint, new DefaultAzureCredential({ managedIdentityClientId: config.agentMiClientId }))`.
- **Agent invocation:** `client.agents.threads.create() → threads.messages.create() → threads.runs.create() → runs.get() → runs.poll()`.
- **Endpoint shape:** `https://<hub-account-name>.services.ai.azure.com/api/projects/<project-name>`. Hardcoded the same way `GRAPH_BASE_URL` is — Bicep emits it into an app setting `FOUNDRY_PROJECT_ENDPOINT` at provisioning.

**REST fallback (documented, not preferred).** If the SDK blocks for any reason (version conflict on a Flex Consumption runtime, non-Node future language offload), the REST shape is:

```http
GET  https://<acct>.services.ai.azure.com/api/projects/<proj>/assistants?api-version=2025-05-01
POST https://<acct>.services.ai.azure.com/api/projects/<proj>/threads
POST https://<acct>.services.ai.azure.com/api/projects/<proj>/threads/{id}/messages
POST https://<acct>.services.ai.azure.com/api/projects/<proj>/threads/{id}/runs
```

Auth header: `Authorization: Bearer <token>`. Token scope: `https://ai.azure.com/.default`. Use the same `DefaultAzureCredential.getToken()` pattern that `graphClient.ts` uses today.

### 5. Network posture

Same env-aware pattern as KV and the storage accounts (ADR-0001 hardening tier):

| Control | `dev` / `test` | `prod` |
|---|---|---|
| Private endpoint on AI Services account | Off | On (when `privateEndpointsEnabled: true`) |
| Shared-key auth on AI Services account | Disabled | Disabled |
| Firewall allow-list | Public (no allow-list) | Function App subnet only |

`publicNetworkAccess` is `Enabled` in dev and `Disabled` in prod when private endpoints are on. This is Bicep-parameterised and inherits the existing `privateEndpointsEnabled` switch.

### 6. Tenant pinning

- The Foundry project's Entra tenant is **pinned to the deployer's tenant** — implicit by virtue of being deployed into it, but reinforced in two places:
  - The agent MI's scope: only this tenant's Entra can issue tokens for it.
  - The orchestrator's boot-time check: compares `subscription().tenantId` (from Bicep) with the tenantId on the MI token at first Foundry call; mismatch → `ConfigError` at handler init, surfaces as 503 on the read endpoint and a failed Timer fire.
- **No cross-tenant agent invocation.** The Foundry project does not authorise identities outside the deployer's tenant. This closes the "shared XDR Hub instance across tenants" misuse — the deployment pattern is strictly single-tenant per ADR-0008.

#### 6.1 Foundry-internal cross-tenant surfaces — default-deny posture (WS10 SEC-M-ADR-17-02 resolution)

The tenant pin on the identity plane (above) is necessary but not sufficient. Azure AI Foundry exposes at least three internal surfaces whose defaults can, if ever relaxed by a future Microsoft feature or an operator misconfiguration, broaden the tenant boundary without the MI-level check noticing. Each is defaulted-off here, named, and given an explicit reopen trigger:

1. **AI Services account `allowedTenants` / `networkAcls.tenantGuid`.** Some AI Services account preview features permit listing additional Entra tenants whose principals may issue tokens for the account. Bicep sets `properties.networkAcls.defaultAction: 'Deny'` and leaves `allowedTenants` unset (implicit: `[subscription().tenantId]` only). **Reopen trigger:** an ADR that explicitly re-evaluates single-tenancy (i.e. at the point MSP multi-tenancy is introduced — ADR to be written when that scope lands).

2. **Foundry thread + assistant sharing.** Foundry threads carry `ownership` metadata; assistants are project-scoped today. If Microsoft later introduces cross-project or cross-tenant thread-sharing (a pattern that exists in analogous services for collaboration scenarios), the current project defaults suffice because the agent MI is scoped to this project only — but an operator clicking "share" from the Foundry portal would bypass that. Bicep sets `properties.hbiWorkspace: true` on both Hub and Project (treats workspace as holding HBI data, which disables the UX-level share affordances). **Reopen trigger:** documented change in Foundry platform behaviour (Microsoft-side) OR an operator requirement to export threads (ADR-to-be-written).

3. **Federated model deployments.** Some Foundry deployment SKUs (`DataZoneStandard`, `GlobalStandard`) permit inference to route across a federation of model hosts that may include regions outside the Hub's own region. Bicep pins each model deployment's `sku: 'Standard'` — the strictly regional tier — and explicitly forbids `GlobalStandard` / `DataZoneStandard` / `GlobalProvisionedManaged` via an Azure Policy deny rule (see §Decision.8). **Reopen trigger:** an ADR that re-evaluates data-residency trade-offs for a model SKU that only ships on Global (today: gpt-5 class; §Consequences already tracks this).

These three defaults are stated in the ADR rather than silently relied on at the Bicep layer because a future `azd up` that inherits a new Foundry default cannot silently undo a data-residency decision without also editing this ADR.

### 7. Lifecycle — idempotent provisioning + teardown

- Bicep's `resource` block for the Hub + Project uses `existing` semantics on re-run (`RG-scope; name-based`), so `azd up` is idempotent.
- The AI Services account has resource lock + purge-protection in `prod` only; dev stays tear-downable (`azd down --force --purge`).
- Model deployments (the actual `gpt-4.1-mini` inference endpoint) are children of the AI Services account; they live as long as the account. Re-running `azd up` does not duplicate deployments.

### 8. Azure-plane cost + policy controls (WS10 SEC-M-ADR-17-03 resolution)

ADR-0019 will land the orchestrator's per-agent per-day token budget, enforced in code. That budget is load-bearing on the LLM-token plane but cannot bound the Azure-billing plane: a runaway that bypasses the orchestrator (compromised agent MI calling the model endpoint directly, mis-configured out-of-band deployment, or a future agent vertical forgetting to route through the orchestrator) still bills to the subscription. This ADR therefore pre-commits three Azure-plane controls that land **in the step-5 Phase 2 infra pass**, before the first Foundry deployment goes live:

1. **Subscription-scope cost budget** via `Microsoft.CostManagement/budgets`. Dev default £25/month (matching `PROJECT_BRIEF.md §11` target), prod default £100/month (env-configurable). Thresholds: 50% → informational email to `AZURE_ADMIN_EMAIL`, 80% → warning email, 100% → warning email + automatic disable of the Foundry Hub's model deployments via a scheduled Logic App action. The 100% action is soft (disable, not delete — preserves the Project for post-incident inspection) and is opt-in via a Bicep parameter `autoDisableOnBudgetBreach: bool` so a prod deployer can opt out if their runbook prefers a different action.

2. **RG-scope Azure Policy deny** on model-deployment creation outside the approved SKU set. Policy name: `aegis-foundry-model-sku-allowlist`, scope: the `rg-aegis-<env>-<region>` resource group, effect: `Deny` on `Microsoft.CognitiveServices/accounts/deployments` where `properties.sku.name` is not in `['Standard']`. This denies `GlobalStandard` / `DataZoneStandard` / `GlobalProvisionedManaged` deployments (see §Decision.6.1 point 3 for the data-residency reason) and also denies out-of-band deployment creation from the Foundry portal — the only deployment path is the Bicep module, which the policy allows.

3. **App Insights alert on `AgentRun` token-consumption anomaly**. The `runBriefAgent` orchestrator (ADR-0019) emits a custom event per run including `tokensIn` / `tokensOut`. An alert rule fires when the rolling 1-hour sum of `tokensIn + tokensOut` exceeds 3× the configured per-day budget (i.e. burning a day's budget in an hour). This catches two failure modes: prompt-injection-induced reasoning loops that bypass the in-orchestrator budget via concurrent runs, and any future agent vertical that regresses on budget enforcement.

All three controls are **pre-committed here** — not deferred to a follow-on ADR — because each closes a failure mode the in-code budget cannot bound alone. The exact budget amounts (£25/month dev, £100/month prod) are defaults in Bicep params; a deployer tunes them via `azd env set AZURE_FOUNDRY_BUDGET_GBP=<value>`.

## Consequences

### Positive

- **Single-tenant + data-residency-safe by construction.** A deploy into West Europe's RG cannot inadvertently route inference through a different region.
- **Identity pattern consistent with ingest/audit/api-reader.** A fourth MI with narrow, explicit RBAC — the same shape WS10 has already approved three times.
- **SDK is GA and Node-22 compatible.** No beta-surface dependency; REST fallback is documented if a future constraint forces us off the SDK.
- **Model deployable where our data lives.** West Europe has the small-model class we need; no gpt-5 today, which is fine for step 5's brief-generation workload.
- **Cost control is structural.** Agent MI cannot call anything outside Foundry; prompt-injection-induced runaway loops are bounded by the Foundry token budget (enforced in ADR-0019), not by external API blast radius.

### Negative / trade-offs

- **gpt-5 class reasoning is not available in West Europe** as of 2026-04-15. If step 5 (`brief-agent`) or step 7 (`posture-agent`, `incidents-agent`, `stack-agent`) need reasoning capabilities that only gpt-5 provides, the region decision is re-evaluated (likely `swedencentral`). ADR-0018 will pick the specific small-model SKU and benchmark; if its benchmark comes back insufficient, ADR-0017 is amended.
- **Three env-scoped Foundry Hubs** (dev, test, prod) add a small management overhead vs one shared Hub. Accepted for teardown parity.
- **Agent MI cannot read incidents-detail** if the ingest retention trim has run — by design, the agent reads a lossy view of history. The summary row on the `Incidents` Table carries the user-actionable fields; if a specific incident is beyond the lifecycle-trim window, the brief-agent cites the summary only. This mirrors ADR-0014 §5's retention contract and ADR-0016 §1.3's detail-blob-missing classification.

### Neutral

- **PAYG pricing in West Europe.** Not found in scriptable form as of 2026-04-19; Azure OpenAI's pricing page is not machine-readable (rendered via JS + blocked to scrapers). The ADR assumes "pennies per day at single-user scale" per the `PROJECT_BRIEF.md §11` <£25/mo budget and defers exact cost calibration to the first live week (tracked follow-up in `STEP5-PLAN.md §7`).
- **Subscription-per-region TPM defaults.** Also not found in scriptable form; must be read out of the Foundry portal's "Operate → Quota" pane before step 5 live-verify. Tracked as a pre-deploy check (not a blocker for this ADR).
- **Flex Consumption + long-running agent runs.** No Microsoft-published known issues as of 2026-04-19, but `brief-agent` runs that exceed the Flex Consumption idle timeout would need checkpointing. Deferred to ADR-0019 (orchestrator pattern), which owns run-timeout behaviour.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Shared Hub across envs, per-env Projects** | Couples dev experiments to prod's quota + RBAC; teardown story gets noisy (must delete Project without touching shared Hub). Cost saving is <£1/mo, not worth it. |
| **Host Foundry in `swedencentral` for gpt-5 availability** | Data-residency crossing — ops stores in `westeurope`, inference + threads in `swedencentral`. ADR-0017 explicitly forbids the silent cross-region case. Step 5 doesn't need gpt-5; a future ADR can migrate Foundry to `swedencentral` AND migrate ops stores to match. |
| **Separate agent app-reg + client secret** | KV + MI is the locked pattern (brief §9). Adding a client secret for agent auth reintroduces the secret-rotation surface that MI-direct eliminated (ADR-0010 rationale). |
| **Use the existing api-reader MI for agent invocation** | Least privilege violation: the agent needs write scopes on `daily-briefs` and `BriefCache`; api-reader is read-only by design. Adding write scopes to api-reader breaks that invariant for the dashboard read path. |
| **Single `id-aegis-mi-<env>-<region>` for everything** | Reviewed and rejected at step 1 (three MIs: api-reader, ingest, audit). Same logic applies at step 5: distinct MIs give WS10 a clear RBAC audit surface and shrink the compromise blast radius. |
| **Foundry REST only, no SDK** | The SDK is GA and Node-22 compatible; REST adds a maintenance surface (auth refresh, streaming SSE for runs, JSON schema reinvention) for no benefit. REST is documented as a fallback only. |

## Related

- `PROJECT_BRIEF.md §3` — Architecture (Foundry Agent Service locked)
- `PROJECT_BRIEF.md §5` — Deterministic first, LLM last (bounds cost + blast radius)
- `PROJECT_BRIEF.md §7` — Agent roster (step 5 scope: orchestrator + `brief-agent` only)
- `PROJECT_BRIEF.md §9` — Security posture (MI-everywhere, no secrets)
- ADR-0001 — Naming + env-aware hardening tier (inherited here)
- ADR-0005 — Foundry Agent Service decision (this ADR is the implementation locking)
- ADR-0008 — App-registration split deferral (strengthened by step 5's MI-only surface)
- ADR-0010 — MI-direct Graph pattern (same `DefaultAzureCredential` shape)
- ADR-0011 — IngestHealth ETag lease (step 5's BriefCache table reuses the lease pattern)
- ADR-0015 — Audit hash chain (step 5's `eventType: agent.run` lines extend without schema bump)
- ADR-0018 (pending) — Model tiering + default SKU
- ADR-0019 (pending) — Orchestrator pattern + token budget enforcement
- ADR-0020 (pending) — `brief-agent` contract
- ADR-0021 (pending) — Agent audit-log extension
- ADR-0022 (pending) — Daily-brief caching + read contract

---

*End of ADR-0017.*
