# ADR-0004 — Hosting plan for Azure Functions

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

The XDR Hub API layer (per ADR-0002) and every scheduled ingestion Function run on Azure Functions. The hosting plan must satisfy several simultaneous constraints:

- **Scale to zero** so an idle tenant pays effectively nothing for the API surface between user sessions. This is directly load-bearing against the brief's **< £25/month per single-user tenant** cost target (§11).
- **Cold-start fast enough** that a dashboard-backed API is usable — cold starts of tens of seconds per tile are not acceptable for the UX profile in §13.
- **Support the TypeScript runtime** (per ADR-0002) without platform-specific caveats, and support the plausible polyglot runtimes (.NET, Python) on the same plan shape.
- **Support Managed Identity, VNet integration, Key Vault references, and App Insights** end-to-end, so the security-posture decisions in brief §9 are implementable without compromising on identity or network controls.
- **Fit `azd up` deployment UX** — the plan must be fully expressible in Bicep and deployable via `azd` with no manual portal steps.

## Decision

### Plan

**Azure Functions Flex Consumption plan.** One plan per region; all v1 Function Apps are hosted on it unless a specific polyglot ADR justifies a separate plan shape (for example, moving a long-running or burst-compute workload to Azure Container Apps Jobs).

### Configuration defaults

- **Always-ready instances:** `0` for v1. Raisable via Bicep parameter if cold-start latency becomes a user-visible problem. Any non-zero default requires an update to this ADR and a line item in `/docs/costs.md`.
- **Maximum instances:** `100` default; overridable via Bicep parameter. Cost-conscious deployers may reduce this.
- **Memory per instance:** `2048 MB` default for the primary API; `512 MB` for ingestion Functions unless a specific workload profile demands more. Both values are parameterised.
- **Runtime:** Node 22 LTS for the primary API (see ADR-0002 for the rationale and the Node 24 upgrade path); polyglot Function Apps pick a supported runtime per their own ADR.
- **VNet integration:** on when private endpoints are enabled (brief §9); off by default to preserve the < £25/month target for casual deployers.
- **Identity:** system-assigned Managed Identity on every Function App; user-assigned Managed Identity used where it reduces cross-resource access-control complexity (for example, a dedicated identity for the audit-writer path per ADR-0006).

### What this plan is NOT used for

- **Long-running or burst-compute workloads.** If a workload needs > 10 minutes per invocation or heavy parallelism with tight cost control, it moves to Azure Container Apps Jobs under a polyglot ADR.
- **Always-on services.** Not applicable in v1; any always-on requirement triggers a superseding ADR.

### Naming

Per ADR-0001:

- Plan resource: `asp-aegis-<env>-<region>`. The CAF `asp-` prefix is retained despite "App Service Plan" being a partial misnomer for Flex Consumption, so that naming stays consistent with CAF tooling and IaC templates shared across the estate.
- Function Apps on the plan: `func-aegis-<purpose>-<env>-<region>`.

### Region and availability handling

- Flex Consumption availability is checked at scaffold time. Bicep must fail fast with a clear error if the target region does not yet support Flex Consumption rather than silently falling back.
- Supported regions are documented in `/docs/deployment.md` and updated on each release. Deployers in unsupported regions must pick a nearby supported region or wait — a fallback to classic Consumption is not offered because it would split the cost and cold-start profile across deployments.

## Consequences

### Positive

- **Scale-to-zero** preserves the cost target for single-user tenants and is genuinely zero between invocations.
- **Cold-start profile** is materially better than classic Consumption, making a dashboard-driven API viable without paying for always-on workers.
- **VNet integration is native** (unlike classic Consumption), so the private-endpoint posture in brief §9 is available without switching plan family.
- **Uniform plan shape across polyglot Function Apps** keeps IaC, operations, and observability uniform across runtimes.

### Negative / trade-offs

- **Regional availability is not universal.** Flex Consumption is available in most but not all Azure regions. Deployers in unsupported regions must pick a nearby region.
- **Feature parity with classic Consumption is not 100%.** Specific triggers or extensions that are missing from Flex must be checked at scaffold time; migrations between plans are Bicep-level changes, not zero-downtime.
- **Per-invocation cost model** is predictable for v1 usage patterns but could surprise a deployer who drives unexpectedly heavy agent load. Mitigated by the per-agent daily token budget (brief §11, ADR-0005) and the dashboard cost tile.

### Neutral

- The decision is reversible per Function App. A workload that outgrows Flex Consumption's constraints can be moved to Premium or Container Apps under a superseding ADR without affecting the rest of the deployment.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| Consumption (classic) | Slower cold starts, weaker VNet integration, and on an EOL trajectory. Flex Consumption is the direct successor and preferred for new deployments. |
| Premium plan | Always-on instances and pre-warmed workers break scale-to-zero and blow the < £25/month target. Overkill for single-user tenants. |
| Dedicated App Service Plan | No scale-to-zero. Predictable cost but strictly worse than Flex Consumption for the v1 workload profile. |
| Azure Container Apps (for the primary API) | More infrastructure surface to maintain (image builds, registries) and higher operator burden for a community deployer. Remains the target for long-running or heavy-compute offload jobs under polyglot ADRs. |
| AKS | Operationally disproportionate for v1. Not revisited unless the project grows past single-tenant hosting. |

## Related

- `PROJECT_BRIEF.md` §3 — Architecture decisions (Hosting plan row)
- `PROJECT_BRIEF.md` §9 — Security posture (VNet / private-endpoint interaction with the plan)
- `PROJECT_BRIEF.md` §10 — Deployment and versioning (`azd up` experience)
- `PROJECT_BRIEF.md` §11 — Observability and cost controls (< £25/month target)
- ADR-0001 — Codename and repo identity (naming for the plan and every Function App hosted on it)
- ADR-0002 — API runtime language (TypeScript as the primary runtime on this plan; polyglot policy shares the plan shape)
- ADR-0005 — Agent orchestration (orchestration glue runs on Functions hosted by this plan)
