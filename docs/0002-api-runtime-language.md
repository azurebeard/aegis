# ADR-0002 — API runtime language

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

The XDR Hub API layer runs on Azure Functions (per ADR-0004) and fulfils three roles: it exposes data from the operational store to the React SPA, it runs scheduled ingestion against Microsoft Graph / Defender / Sentinel APIs, and it provides the orchestration glue that invokes Foundry agents (per ADR-0005) and records their outputs. A single primary language must be chosen for the main Function App, with a clear, gated policy for when — and how — to split workloads into a second or third runtime.

All major Functions runtimes are first-class on the Flex Consumption plan (per ADR-0004) and all can be driven by Bicep and `azd`. The axes that actually differentiate them for this project are:

- Shared types with the React SPA (the SPA is TypeScript by brief §3).
- Quality of the canonical SDK for each target system: Microsoft Graph, Defender XDR, Sentinel / Log Analytics (KQL), Intune Graph.
- Contributor onboarding cost, given the project's intended community-contributor profile.
- Ergonomics for typed, JSON-heavy request/response flows versus data / ML workloads.

The brief (§3, §14 item 5) already commits to TypeScript primary and explicitly permits polyglot with each offload justified in its own ADR. This ADR ratifies that commitment and defines the polyglot policy the build depends on.

## Decision

### Primary runtime

**TypeScript on Node 22 LTS**, Azure Functions v4 programming model. Node 22 carries LTS coverage through 2027-04-30; Node 20 LTS reaches End-of-Life on 2026-04-30 and is therefore unsuitable as a v1 runtime commitment. An upgrade to Node 24 LTS is permitted once Azure Functions v4 support for Node 24 is confirmed GA — treat that as a configuration change, not a superseding ADR.

- A single Function App named `func-aegis-api-<env>-<region>` hosts the primary HTTP API and any Timer-triggered ingestion Functions that have not been offloaded to a polyglot app.
- Shared request/response types live in a workspace package consumed by both `api/` and `web/` (brief §12 monorepo). Schema definitions for the operational store (per ADR-0006) are the source of truth; API types are derived from or aligned with them.
- Dependency discipline: the API bundles its Azure SDK, Graph SDK, and Defender client behind a small internal client-utility layer so retry, auth, and correlation concerns are implemented once.

### Polyglot policy

A second or third runtime is permitted as a **separate Function App or Azure Container Apps Job**, each documented by its own ADR that justifies the offload. Justifications must fall into one of:

1. **SDK ergonomics.** The canonical SDK for a target system is materially better in another language — the anticipated first case is KQL-heavy Sentinel work via the .NET SDK.
2. **Ecosystem fit.** A task is genuinely ML- or data-pipeline-shaped and benefits from the Python ecosystem.
3. **Performance.** A measurable cost or latency win that a TypeScript implementation cannot realistically reach.

Every polyglot ADR must name: the specific workload being offloaded, the runtime chosen, the hosting target (dedicated Function App vs Container Apps Job), the owner of the code path, and the observability conventions the offload will implement (structured logs, correlation IDs, audit writes).

### What stays TypeScript regardless

- The HTTP API surface consumed by the SPA.
- The orchestration glue around Foundry agent invocations.
- Request validation, authorisation enforcement, audit-log writes.
- Any Function whose only job is read-from-ops-store / write-to-ops-store.

Moving any of the above to another runtime requires superseding this ADR, not a fresh polyglot ADR.

### Naming and observability across runtimes

- Polyglot Function Apps follow the ADR-0001 naming convention: `func-aegis-<purpose>-<env>-<region>` with a distinct `<purpose>` token (e.g. `func-aegis-kql-prod-uks` for a .NET Sentinel workload, `func-aegis-ml-prod-uks` for a Python data task).
- Each polyglot app gets its own App Insights `cloud_RoleName` under the `aegis-*` namespace.
- Structured logs everywhere carry `service.namespace = aegis` and the correlation ID propagated from the originating HTTP request or scheduled run.

## Consequences

### Positive

- **One language across web and API** reduces context-switching cost and lets shared type definitions catch contract drift at compile time rather than at runtime.
- **Fast onboarding** for the expected community-contributor profile (React/Node-literate security engineers and MVPs).
- **Explicit gate against casual polyglot sprawl** — every new runtime requires a named ADR and a defensible reason, which is a stronger control than convention alone.
- **Flex Consumption compatibility** is uniform across TypeScript and the plausible polyglot runtimes, so the hosting-plan decision in ADR-0004 does not constrain language choice.

### Negative / trade-offs

- The .NET SDK for Kusto / Sentinel is richer than the TypeScript one. KQL-heavy Sentinel work will likely trigger an offload ADR earlier than other domains; this is anticipated rather than a surprise.
- Pure-TypeScript implementations of Graph / Defender client code are idiomatic but verbose around retry and auth plumbing; the shared client-utility layer is load-bearing and must be invested in early.
- TypeScript tooling (bundling, tree-shaking, Node version compatibility) needs active maintenance to keep cold-start size reasonable on Flex Consumption.

### Neutral

- The decision is reversible on a per-workload basis. A workload that proves a better fit in another runtime moves via a polyglot ADR without rewriting the rest of the API.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| .NET (C#) as primary | Stronger Kusto / Sentinel SDK but heavier contributor-onboarding cost for a community OSS project; Graph / Defender TypeScript SDKs are sufficient for the majority of v1 workloads. Offload path covers the KQL-heavy case cleanly. |
| Python as primary | Weaker for typed, SDK-heavy HTTP APIs than TypeScript. Reserved for ML / data tasks via the polyglot policy. |
| Multi-language from day one | Splits ownership, multiplies CI / CD surface, fragments the shared client and observability utility layers before the project has enough scale to justify the overhead. |
| Single-language zealotry (TypeScript only, no polyglot ever) | Forces poor-fit implementations of KQL or ML tasks in TypeScript to avoid a second runtime. The polyglot-with-ADR gate is a better trade-off than a blanket ban. |

## Related

- `PROJECT_BRIEF.md` §3 — Architecture decisions (API runtime row)
- `PROJECT_BRIEF.md` §12 — Repository layout (`api/`, optional `api-py/`, `api-net/`)
- `PROJECT_BRIEF.md` §14 item 5 — Open decision: when to introduce a polyglot Function App
- `PROJECT_BRIEF.md` §16 — Coding and docs conventions (input validation, structured logging, audit writes apply across runtimes)
- ADR-0001 — Codename and repo identity (naming applies to all Function Apps, primary and polyglot)
- ADR-0004 — Hosting plan (Flex Consumption features available to every runtime chosen)
- ADR-0005 — Agent orchestration (orchestration glue is in-scope for the primary TypeScript runtime)
- ADR-0006 — Data stores (schema is the source of truth for shared API types)
