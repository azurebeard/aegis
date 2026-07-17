# XDR Hub

**Codename:** `aegis` · **Status:** pre-v1, repo currently private; flips public on first release.

A single-tenant, Azure-hosted dashboard over **Microsoft Defender XDR**. It ingests Secure Score, Defender XDR Incidents, and Entra ID risky users on a schedule, surfaces them through a Static Web App + Functions backend, and (optionally) layers an AI plane that produces a Daily Brief, a Weekly Posture narrative, and per-incident analyses.

It is **not** a SaaS, not multi-tenant, and not a SOAR. Each deployment serves one Entra tenant; data stays in the operator's own Azure subscription. **The AI plane is off by default for new envs**; enable explicitly with `AZURE_DEPLOY_AI_AGENTS=true` if you want Foundry agents. See [Opt out of the AI plane](#opt-out-of-the-ai-plane).

## Quickstart

There are three paths in increasing-control order. All produce the same end state.

### Path A — GitHub Codespaces (zero local install)

1. Click the green **Code** button → **Codespaces** → **Create codespace on main**.
2. Wait ~3-5 min for the container to build (`az`, `azd`, `pwsh`, node 22, jq, Graph modules all pre-installed by [`.devcontainer/post-create.sh`](.devcontainer/post-create.sh)).
3. In the Codespaces terminal:

   ```bash
   az login                 # device-code; opens in a browser tab
   azd auth login           # same identity is fine
   bash scripts/install.sh  # the interactive wrapper below
   ```

Free tier = 60h/month; Pro = 90h. A first-deploy session is ~30 min.

### Path B — Interactive installer (local CLI)

```bash
bash scripts/check-prereqs.sh   # one-shot preflight; fails fast with copy-paste fixes
az login
azd auth login
bash scripts/install.sh         # guided prompts for sub / env / location / AI plane
```

### Path C — Explicit (azd-fluent operators)

Pre-requisites:

- Azure subscription with permission to deploy into a new resource group.
- Tenant directory-admin able to register an app + grant Microsoft Graph application roles (one-off; the `azd up` post-provision hook does this interactively).
- The [Azure Developer CLI (`azd`)](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd), `az`, `pwsh`, Node 22, and `jq`.

Verify your machine in one shot:

```bash
bash scripts/check-prereqs.sh
```

It fails fast with copy-paste install commands for anything missing or below the required version. Exit 0 = `azd up` is unblocked.

Then deploy (dev — common case):

```bash
azd env new dev --subscription <subId> --location westeurope
azd up
```

That's it. The `azd up` preprovision hook auto-detects `AZURE_TENANT_ID` (from the `az` session), `AZURE_REGION_SHORT` (defaults to `weu`), and `AZURE_ADMIN_EMAIL` (the deployer's signed-in identity — which means whoever runs `azd up` automatically gets the `admin` App Role assigned by the bootstrap step). Each value is persisted to the azd env on first detection.

The AI plane (Foundry agents — daily brief, weekly posture, incident analysis) is **off by default** for new envs. Enable explicitly with `azd env set AZURE_DEPLOY_AI_AGENTS true && azd provision` whenever you want it on. Flipping back off is also clean — [`scripts/cleanup-ai-plane.ps1`](scripts/cleanup-ai-plane.ps1) runs from the postprovision hook and removes the stale grants + Foundry hub. Tables + blob containers persist across the toggle so a flip back to `true` restores the AI plane without data loss.

For **prod**, the auto-derive is disabled — set the four explicit env vars first to remove the "deployed from the wrong account, seeded the wrong admin" failure mode:

```bash
azd env new prod --subscription <subId> --location westeurope
azd env set AZURE_ADMIN_EMAIL  <operator@email>
azd env set AZURE_TENANT_ID    <entra-tenant-guid>
azd env set AZURE_REGION_SHORT weu
# Optional — external-email case where the mail address doesn't resolve
# on the tenant directory. Pass the authoritative UPN here.
azd env set AZURE_ADMIN_UPN    <operator-upn@onmicrosoft.com>
# Optional — set "true" to deploy the Foundry agents. The AI plane is
# opt-in; default is "false" for new envs. Flip back off later via
# 'azd env set AZURE_DEPLOY_AI_AGENTS false && azd provision' — the
# postprovision cleanup script removes the stale grants + Foundry hub
# automatically.
azd env set AZURE_DEPLOY_AI_AGENTS true
azd up
```

`azd up` provisions the infra (Bicep), runs the Entra app-registration bootstrap (`scripts/bootstrap-entra.ps1` — interactive Graph device-code login on first run), grants the ingest managed identity its Microsoft Graph app roles, seeds the auto-managed KV secrets (recipient-hash pepper, share-link signing key), and deploys the API + Web bundles. The first dashboard URL is printed at the end.

The third KV secret — `ransomware-live-api-key` — is operator-supplied (it comes from <https://www.ransomware.live/my>). Seed it once with `pwsh -File scripts/provision-ransomware-live-api-key.ps1 -Mode Provision` after `azd up` finishes, or via the SPA's "Rotate API key" form once any first version exists.

Subsequent code-only updates: `azd deploy api`, `azd deploy web`. Infra changes: `azd provision`. Full teardown (dev/test): `azd down --purge`.

## Architecture overview

Three logical planes inside a single Azure resource group (`rg-aegis-${AZURE_ENV_NAME}-${region-short}`):

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Dashboard plane  Static Web App  →  Functions API  (read-only MI)   │
├──────────────────────────────────────────────────────────────────────┤
│  Ingest plane     Timer-triggered Functions (ingest MI, narrow Graph │
│                   scopes) → ops Storage tables + audit blob (append, │
│                   hash-chained, immutable in prod)                   │
├──────────────────────────────────────────────────────────────────────┤
│  AI plane         Azure AI Foundry agents (brief / posture /         │
│  (optional)       incidents-analysis) under their own MI; reads      │
│                   ops + audit blob, writes narrative blobs +         │
│                   AgentBudget / AgentHealth / cache rows             │
└──────────────────────────────────────────────────────────────────────┘
```

Each plane uses its own user-assigned managed identity with the narrowest scope it needs (read-only API, table-scoped ingest writer, audit append-only writer, agent reader+narrative-writer). The ingest and AI planes can be deployed independently — see opt-out below.

For the full design — runtime planes, identity model, ingest contracts, AI orchestration — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/INGEST.md`](docs/INGEST.md), and [`docs/AGENTS.md`](docs/AGENTS.md).

## Opt out of the AI plane

Set `AZURE_DEPLOY_AI_AGENTS=false` before `azd provision`. The deploy then:

- Skips the Foundry resource module (no Foundry Hub or Project provisioned).
- Omits the agent-plane app settings on the Function App.
- Skips the agent-MI role assignments on the AI-plane tables / blob containers.
- Refuses to bind the agent managed identity to the Function App (Easy Auth `allowedApplications` stays SWA-only).
- Short-circuits every agent-plane handler registration in the Functions runtime via a single ESM `await import()` gate (pinned by an invariant test — `api/tests/index.handlerRegistry.test.ts`).
- The SPA hides the BriefTile, PostureTile, AgentBudget admin section, UserIdentifierStrategy admin section, the Agent observability page, and the Incident-detail AI tab.

Designed for regulated tenants that cannot allow operator data to flow through Azure OpenAI, or that want to validate the ingest plane before opting into AI. Tables and blob containers for the AI plane are provisioned unconditionally so the toggle is reversible without data loss.

> **Caveat:** Azure's incremental deployment mode does NOT delete resources created on a previous `deployAiAgents=true` deploy when you flip to `false`. The agent-plane RBAC + Foundry Hub persist on the resource group. Operational gates (app settings, MI bindings, handler registrations) all flip correctly so the agent identity has no execution path; the unreachable role assignments are a principle-of-least-privilege observation, not a runnable surface. Full teardown via `azd down --purge`.

## Security posture

### Data handling at a glance

Aegis runs inside **your Azure tenant**. Microsoft Graph / Defender / Entra APIs return data straight to your Function App; **no data leaves your tenant for ingest**.

The optional AI plane (Foundry agents that summarise incidents, write daily briefs, narrate weekly posture) is **off by default**. When you enable it:

- Prompts go to **Azure OpenAI in your Azure region** (West Europe by default; never cross-region).
- Microsoft's **default Azure OpenAI retention applies**: up to 30 days for abuse-detection scanning, with human review only on flagged content. Aegis itself does not add a retention layer.
- **No model training**. **No cross-tenant data**.

What's in the prompt has been minimised by design:

- User identifiers default to **opaque object GUIDs**, not display names.
- **Per-source column whitelists** strip operationally-irrelevant fields (`posturePromptBuilder.ts` etc.).
- Licence context is **service count, not service list**.

**If you can't accept this posture, keep the AI plane off** (the default). The ingest + security dashboard works on its own; nothing reaches Azure OpenAI unless you opt in.

Full technical detail: [`docs/AI-SECURITY-POSTURE.md`](docs/AI-SECURITY-POSTURE.md).

### Other surfaces

- **Coordinated disclosure:** [`SECURITY.md`](SECURITY.md). Use GitHub's private vulnerability reporting on the canonical repo, or `security@azurebeard.co.uk` as backup.

> **Modified Abuse Monitoring note:** Microsoft offers a Limited-Access "Modified Abuse Monitoring" programme for zero-retention Azure OpenAI use. Aegis targets the SMB market and **MAM is gated on Microsoft-managed-customer status (CSAM / dedicated account team)**, which SMB tenants structurally don't have. The SMB-applicable opt-out is "don't enable the AI plane".

## Licence

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

## Contributing

This is an open-source community project under the Microsoft Security MVP programme. The contribution model:

- All contributions are accepted under Apache 2.0 by default (Apache 2.0 §5: inbound equals outbound).
- **No CLA in v1.** If the project attracts significant corporate contributors, a DCO sign-off on commits may be introduced later. A CLA will not be introduced without explicit maintainer approval.
- Public-facing engagement happens on the canonical repo: [github.com/azurebeard/aegis](https://github.com/azurebeard/aegis).

For the design context behind a contribution, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/INGEST.md`](docs/INGEST.md), and [`docs/AGENTS.md`](docs/AGENTS.md).

## Repository layout

| Path | What lives there |
|---|---|
| `infra/` | Bicep modules + the `azd` `main.bicep` entry point. |
| `api/` | Azure Functions v4 + TypeScript (Node 22). Ingest, AI, and dashboard handlers. |
| `web/` | Static Web App — Vite + React 18 + Fluent UI v9 + Recharts. |
| `scripts/` | `bootstrap-entra.ps1` (Entra app-reg + Graph role grant), `verify-audit-chain.mjs`, ingest helpers. |
| `docs/` | Architecture / Ingest / Agents reference docs, AI security posture, customer onboarding runbook. |

## Pointers

- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — runtime planes, identity model, data stores, observability.
- Ingest contracts: [`docs/INGEST.md`](docs/INGEST.md) — per-source cadence, Graph scopes, schemas, audit chain.
- AI plane (optional): [`docs/AGENTS.md`](docs/AGENTS.md) — Foundry topology, model tiering, per-agent contracts.
- Customer onboarding runbook: [`docs/onboarding-runbook.md`](docs/onboarding-runbook.md).
- Live development happens on `main`; deploys are surfaced via `azd deploy <api|web>`. There is no protected staging branch in v1.
- Mission identifier (used in this project's internal change-control): `4391c608` (full GUID: `4391c608-8a41-42cb-b76c-f042ea324c0e`).
