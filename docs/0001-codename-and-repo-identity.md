# ADR-0001 — Codename and repo identity

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

The project has a user-facing product name, **XDR Hub**, which will appear in the UI, documentation, marketing copy, and README. For engineering purposes we also need a short, stable **codename** that acts as the canonical identifier across:

- GitHub repository name
- Azure resource naming (resource group, Function Apps, Storage, Key Vault, etc.)
- Application Insights cloud role names
- Bicep module parameters and outputs
- CI/CD pipeline identifiers
- Log correlation and observability tags

A codename distinct from the product name has three advantages:

1. **Marketing flexibility.** If "XDR Hub" ever rebrands, no identifiers in IaC, telemetry, or code need to change.
2. **Azure naming limits.** Storage Accounts are capped at 24 lowercase alphanumeric characters. A short token keeps resource names within limits when combined with environment and region suffixes.
3. **Uniqueness.** "XDR Hub" is descriptive and likely to collide with other projects or Microsoft product names; a codename can be chosen deliberately to avoid clashes.

## Decision

### Codename

```text
aegis
```

Lowercase, four letters, no abbreviation. Derived from the shield of Zeus/Athena in Greek mythology — conventionally used to signify defence and protection. No conflict with Microsoft product names or well-known OSS projects at the time of writing.

### Repository

- GitHub repository name: `project-aegis`. The `project-` prefix lives on the repository only; all code, Azure resource names, Bicep parameters, and observability identifiers use the bare codename `aegis` as defined below. The prefix aids discoverability in the maintainer's GitHub org listing and avoids collision with existing generic `aegis`-named repositories on GitHub.

- Default branch: `main`
- Licence: Apache 2.0 (see ADR-0003)
- Visibility: private during build; flipped to public before the v1 public release. Before the flip, `/LICENSE` and `/NOTICE` (per ADR-0003) must be in place and a `/SECURITY.md` coordinated-disclosure contact must be published.

### Azure resource naming convention

Based on the Microsoft Cloud Adoption Framework naming recommendations, with `aegis` as the workload token.

| Resource | Pattern | Example |
|---|---|---|
| Resource Group | `rg-aegis-<env>-<region>` | `rg-aegis-prod-uks` |
| Function App | `func-aegis-<purpose>-<env>-<region>` | `func-aegis-api-prod-uks` |
| Static Web App | `stapp-aegis-<env>-<region>` | `stapp-aegis-prod-uks` |
| Storage Account (ops) | `staegisops<env><region>` | `staegisopsproduks` |
| Storage Account (audit, WORM) | `staegisaudit<env><region>` | `staegisauditproduks` |
| Key Vault | `kv-aegis-<env>-<region>` | `kv-aegis-prod-uks` |
| App Insights | `appi-aegis-<env>-<region>` | `appi-aegis-prod-uks` |
| Log Analytics Workspace | `log-aegis-<env>-<region>` | `log-aegis-prod-uks` |
| Managed Identity | `id-aegis-<purpose>-<env>-<region>` | `id-aegis-api-prod-uks` |
| AI Foundry project | `aif-aegis-<env>-<region>` | `aif-aegis-prod-uks` |
| App Service Plan (if used) | `asp-aegis-<env>-<region>` | `asp-aegis-prod-uks` |

**Notes on the convention:**

- Storage Accounts disallow hyphens and uppercase and have a 24-character hard limit; the flattened form is used only for Storage.
- Key Vault names must be globally unique and are limited to 24 characters; `kv-aegis-prod-uks` is 17 characters, leaving headroom if a deployer needs to suffix for uniqueness.
- `<env>` values: `dev`, `test`, `prod`. No other values in v1.
- `<region>` values: Azure short codes, e.g. `uks` (UK South), `eus2` (East US 2), `weu` (West Europe). Default for UK deployers: `uks`.
- Where a resource must be globally unique and a collision occurs, the deployer may add a short numeric or alpha suffix (e.g., `staegisopsproduks02`). Bicep should detect and handle this via a `uniqueString()` fallback.

### Observability identifiers

- Application Insights `cloud_RoleName` values per component: `aegis-web`, `aegis-api`, `aegis-ingest`, `aegis-orchestrator`, `aegis-posture`, `aegis-incidents`, `aegis-stack`, `aegis-brief`.
- Structured log property `service.namespace` = `aegis` on every emitted log and custom event.
- OpenTelemetry `service.name` follows the `cloud_RoleName` values above.

### Bicep parameter and output naming

- Workload token exposed as a `param workload string = 'aegis'` in `main.bicep` — **not** hard-coded in every module.
- Every module accepts `workload`, `environment`, `region` as parameters and composes names deterministically.
- This allows a forker to rename the entire deployment by changing a single parameter.

## Consequences

### Positive

- Consistent, predictable naming from the first commit across IaC, code, and observability.
- Short workload token keeps all Azure resource names within hard character limits even at the most-constrained resources (Storage, Key Vault).
- Codename decoupling means rebranding the product is a docs-and-UI change, not a refactor.
- Forkers can rename the whole deployment by changing one Bicep parameter.

### Negative / trade-offs

- Two names to explain in user-facing documentation ("XDR Hub is the product; `aegis` is the codename used in code and Azure resource names"). Addressed in `README.md §1` and `PROJECT_BRIEF.md §1`.
- Greek-myth naming is mildly overused in the security space; accepted as low-risk given the codename is internal-facing rather than marketed.

### Neutral

- The codename does not appear in any user-facing UI text. Users see "XDR Hub" in the dashboard, docs, and installer. They will see `aegis` in the Azure portal when inspecting resources — this is intentional and acceptable for a technical audience.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| `beacon` | Overlap with multiple observability and IoT projects; generic. |
| `watchtower` | Clash with the Docker Watchtower project; longer token reduces Azure name headroom. |
| `sentinel` | Direct clash with Microsoft Sentinel — confusing in Azure resource lists. |
| No codename (use `xdrhub` as the workload token) | Couples all IaC, telemetry, and code identifiers to the product name; any rebrand triggers a full refactor. |

## Related

- `PROJECT_BRIEF.md` §3 — Architecture decisions (locked for v1)
- `PROJECT_BRIEF.md` §12 — Repository layout
- `PROJECT_BRIEF.md` §17 — NOTICE file (verbatim)
- ADR-0002 — API runtime language (naming applies to Function Apps)
- ADR-0004 — Hosting plan (naming applies to the plan resource)
- ADR-0005 — Agent orchestration (cloud role names for agents)
- ADR-0006 — Data stores (naming applies to Storage Accounts)

---

## Template guidance for subsequent ADRs

Pattern-match this file when writing ADRs 0002 through 0006 and any future ADRs. Keep these conventions:

- **Filename:** `NNNN-kebab-case-title.md`, four-digit zero-padded sequence.
- **Required sections:** Status, Date, Deciders, Context, Decision, Consequences.
- **Optional sections (include where they add value):** Alternatives considered, Related, Supersedes/Superseded by.
- **Status values:** `Proposed` | `Accepted` | `Deprecated` | `Superseded by ADR-NNNN`.
- **Tone:** Direct, decision-first. State the decision plainly in the Decision section before explaining rationale. Avoid hedging language in Accepted ADRs.
- **Length target:** 300–800 lines of Markdown is healthy. Shorter if the decision is genuinely simple; longer only if the trade-off analysis demands it.
- **Don't re-explain the project.** Link back to `PROJECT_BRIEF.md` for context already captured there.
- **Append-only after acceptance.** To change an accepted ADR, write a new one that supersedes it; never rewrite history.
