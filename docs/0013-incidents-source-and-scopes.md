# ADR-0013 — Incidents ingest source and Graph scopes

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Build-order step 4 (brief §15) is the **second vertical**: Microsoft Defender XDR **Incidents** ingestion. Step 3 (Secure Score, ADRs 0010–0012) proved the MI-direct-Graph + Timer + `SecureScore` Table + `IngestHealth` ETag-lease + audit-NDJSON pattern. Step 4 reuses that pattern wholesale; what this ADR fixes is the **choice of upstream source** and the **Graph scopes added** to enable it.

The candidate sources for Defender XDR incident data in 2026-04:

| Candidate | Endpoint | Auth model | Notes |
|---|---|---|---|
| Microsoft Graph `/security/incidents` | `GET /v1.0/security/incidents` | MI-direct (application permission) | Canonical Defender XDR roll-up: each incident includes `alerts[]` via `$expand=alerts`. v1.0 GA. `SecurityIncident.Read.All` permission. |
| Microsoft Graph `/security/alerts_v2` | `GET /v1.0/security/alerts_v2` | MI-direct | Alert-level only; no built-in incident correlation. `SecurityAlert.Read.All`. |
| Microsoft Defender XDR API | `POST /api/incidents/{id}/update`, `GET /api/incidents` | **App-reg + client secret** (MI not supported on this surface as of 2026-04) | Richest schema historically; some fields exposed here but not on Graph. Requires a service app reg and would force the `svc` split deferred in ADR-0008. |
| Microsoft Sentinel `/providers/Microsoft.SecurityInsights/incidents` | ARM management-plane | MI (with `Microsoft.SecurityInsights/incidents/read` RBAC) | Sentinel-only; only useful if the tenant has Sentinel, which is not a v1 assumption for XDR Hub. |

The decision must also fix the Graph scopes added to the ingest MI's service principal (ADR-0010's `Grant-GraphAppRolesToMi`), so ADR-0010 does not need amending on every vertical — it has a scope-list that grows additively.

## Decision

### 1. Source — Microsoft Graph `/security/incidents`

**`GET /v1.0/security/incidents`** with **`$expand=alerts`** is the source of truth for the Incidents vertical. Alerts-only queries (`/security/alerts_v2`) may be added later for specialist views but do not ingest a second store in step 4.

Rationale:

- **Incident-level is the right granularity for this tile.** Defender XDR's own UI groups alerts into incidents; surfacing the same grouping keeps the dashboard's mental model aligned with the maintainer's existing workflow in `security.microsoft.com`.
- **MI-direct auth preserved.** `/security/incidents` with application permissions works via Managed Identity — we stay on the ADR-0010 MI-direct model. No need to open the `svc` app-reg split deferred in ADR-0008.
- **Schema is richer than `/alerts_v2` for the UI shape we want.** Incident-level fields (`classification`, `determination`, `priorityScore`, `assignedTo`, `resolvingComment`, `incidentWebUrl`) are exactly what the list and detail views will render; alerts-only would require us to re-aggregate client-side.
- **Defender XDR API's richer fields are out of v1 scope.** The small number of fields that exist only on the Defender XDR REST API (a handful of evidence-level enrichments) do not justify the auth-model and operational cost of a separate app registration.

### 2. Graph scopes added by step 4

**One** application permission granted to the ingest MI via the existing `bootstrap-entra.ps1 -RequiredGraphScopes` mechanism (ADR-0010 §4):

| App role (value) | Resource | Purpose |
|---|---|---|
| `SecurityIncident.Read.All` | Microsoft Graph (`00000003-0000-0000-c000-000000000000`) | Primary — list and get incidents with `$expand=alerts`. Consumed by the step-4 Timer ingest handler and the three read endpoints (ADR-0016). |

`SecurityAlert.Read.All` is **NOT** granted by step 4. It is added by the alerts-vertical ADR when that vertical lands, not speculatively here. Ditto every other scope ADR-0010 §2 tracks as "explicitly out of scope": each becomes part of `$RequiredGraphScopes` only in the same commit that introduces its consuming code path.

The bootstrap script's idempotent grant + drift-detection loop handles the addition automatically on the next `azd up`: existing `SecurityEvents.Read.All` is observed as `ALREADY_GRANTED`; the new `SecurityIncident.Read.All` is granted; the Function App is restarted to invalidate the IMDS token cache (ADR-0010 §Consequences).

**No change to ADR-0010 §Decision.** This ADR does not supersede or amend ADR-0010's identity-surface decision; it only adds one scope to the list that ADR-0010 explicitly anticipated growing additively.

### 3. Scope-catalogue growth policy

This ADR establishes the policy that every future vertical inherits:

- **Speculative grants are rejected.** A Graph (or other Microsoft API) scope is added to `bootstrap-entra.ps1`'s default `$RequiredGraphScopes` in the **same commit** that introduces the code path which consumes it. A grant without a consumer is a least-privilege violation (CIS Control 6.4) — the fact that a future commit will add the consumer does not change the present-day capability exposure on a compromised MI.
- **No "convenience" aggregations.** Adding multiple scopes in one bootstrap cycle to save an operator's time is not a sufficient justification to grant scopes that don't have a consumer yet. The bootstrap script's grant phase is idempotent and cheap to re-run; one cycle per vertical is the correct cadence.
- **The drift-detection loop enforces the floor, not the ceiling.** `Grant-GraphAppRolesToMi` warns when an assignment exists on the MI SP that is not in `$RequiredGraphScopes`. That warning is the operator's signal to prune, not a prompt to re-add the scope to the catalogue.
- **Deny-list on `*.ReadWrite.*`.** The bootstrap script carries a hard-coded deny-list of scopes that must **never** appear in `$RequiredGraphScopes`, regardless of what a commit tries to add: `SecurityIncident.ReadWrite.All`, `SecurityAlert.ReadWrite.All`, `SecurityEvents.ReadWrite.All`, `SecurityActions.ReadWrite.All`, and any other `Microsoft.Graph` scope whose value contains `ReadWrite` on the Security resource namespace. A deny-listed scope causes the bootstrap run to fail with a structured error, not a warning. Write scopes on Defender/Security APIs violate the v1 read-only stance (brief §1) and require an ADR that explicitly reopens the read-only decision before the deny-list entry can be removed.
- **Revisiting is an ADR event.** A speculative grant that turns out to be genuinely required for a cross-vertical concern (e.g. a scope needed by two verticals at the same time) is added by a dedicated **scope-catalogue ADR** that names the consumers, not by inlining the addition into the ADR of either vertical.
- **Per-property permission checks (SEC-INFO-PHASE8B-SCOPE-01).** Graph endpoint permissions are not always uniform across all properties of a resource. A scope sufficient for the parent resource may be insufficient for a specific `$select` or `$filter` field on that resource. **Every** `$select` and `$filter` property used by a new consumer must be cross-checked against its Microsoft Learn permissions table before the ADR ships, not only the endpoint-level permission. Document the per-property requirement in the consumer ADR's scope section when it differs from the parent endpoint.
  *Origin:* ADR-0034 v1 declared `User.Read.All` for the `/users` endpoint, which is sufficient for the resource but **not** for the `signInActivity` property — that property requires `AuditLog.Read.All`. The gap surfaced as a 403 only at the first Phase 8B Timer fire, after the scope catalogue had already shipped. `AuditLog.Read.All` was pulled forward from Phase 8C to 8B on commit `00a5d5b` to close the gap. See `docs/WS10-verdict-2026-05-08-phase-8b-auditlog-scope-pull-forward.md`.

This policy is the canonical reference for every subsequent step-N ADR; future ADRs may name-check it rather than restating it.

#### Catalogue extensions on record (chronological)

| Scope | Added | Consumer | Reference |
|---|---|---|---|
| `SecurityEvents.Read.All` | Step 3 | `runSecureScoreIngest.ts` | ADR-0010 |
| `SecurityIncident.Read.All` | Step 4 | `runIncidentsIngest.ts` | ADR-0013 (this ADR) |
| `IdentityRiskyUser.Read.All` | Step 6 | `runEntraRiskIngest.ts` | ADR-0023 |
| `Organization.Read.All` | Step 6 | `runEntraRiskIngest.ts` (P2 licence probe) | ADR-0023 §7 |

**Pre-declared by ADR-0034 — Step 8 Identity vertical (will land per-phase, not bundled):**

| Scope | Phase | Consumer (lands in same commit) | Reference |
|---|---|---|---|
| `User.Read.All` | 8B | `runUserDormancyIngest.ts` | ADR-0034 §5 |
| `AuditLog.Read.All` | 8B + 8C | `runUserDormancyIngest.ts` (signInActivity property) AND `runSignInsIngest.ts`. Pre-declared in ADR-0034 §5 v1 for 8C only; pulled forward to 8B on 2026-05-08 after the production incident — see ADR-0034 §5 amendment table for context. | ADR-0034 §5 (amended 2026-05-08) |
| `Policy.Read.All` | 8D | `runConditionalAccessIngest.ts` | ADR-0034 §5 |
| `Application.Read.All` | 8E | `getServicePrincipals.ts` (read-only on-demand enum) | ADR-0034 §5 |

The pre-declaration means Phases B–E's WS10 reviews can name-check ADR-0034's scope-catalogue decision rather than re-arguing the four new scopes from scratch. Each scope's bootstrap-script grant still lands in the **same commit** as its consumer per the same-commit invariant above; the ADR-0034 pre-declaration does NOT relax that rule. The deny-list regex at `bootstrap-entra.ps1:202` already rejects the `*.ReadWrite.*` variant of all four scopes — no deny-list edit is needed; the pre-declaration is design-only.

### 4. What is NOT decided here

- **Cadence, pagination, schema projection, retention** — ADR-0014.
- **Audit log hash-chain** — ADR-0015 (the deferred ADR-0011 §7 follow-up that must land before step-4 code writes to the audit blob).
- **List and detail API contract** — ADR-0016.
- **Sentinel / Defender XDR-API incident fields** — deferred until a specific field becomes load-bearing for a tile or workflow that cannot be served by the v1.0 Graph schema, **and** the cost of opening the `svc` app-reg split (ADR-0008 reopen condition) is justified by the value of the field. Without both conditions, the Graph incident resource is the canonical shape.

## Consequences

### Positive

- **Zero identity-model churn.** The ingest MI that was provisioned for step 3 gains two more Graph app-role assignments; the code path (`DefaultAzureCredential` with `INGEST_MI_CLIENT_ID`) is unchanged.
- **No new secret material.** Client secret lifecycle stays bounded to the Easy Auth app-reg (ADR-0008).
- **UI mental model matches Defender.** Users coming from `security.microsoft.com` see the same grouping and the same severity/classification/determination values.
- **Permission scope catalogue stays shallow.** Two Graph app roles total on the ingest MI after step 4: `SecurityEvents.Read.All` (from step 3) and `SecurityIncident.Read.All` (this step). Each is explicitly declared in source (`bootstrap-entra.ps1` default), has a code-path consumer, and is bounded by the drift-detection loop. The scope-catalogue growth policy (§3) ensures this stays true for future verticals.

### Negative / trade-offs

- **No delta-query support.** `/security/incidents` does not expose a `/delta` endpoint at v1.0 as of 2026-04. Incremental polling via `$filter=lastUpdateDateTime gt {cursor}` is the substitute (ADR-0014). Semantically equivalent at step-4 scale but requires a cursor on the `IngestHealth` row and a modest amount of tolerance for clock skew (discussed in ADR-0014 §Dedup).
- **Incident-level loses some alert-only fidelity.** Alerts that are not yet correlated into an incident (rare, transient) are not surfaced by this vertical. A later alerts-vertical can cover that; for step 4 the gap is acceptable.
- **Retained `SecurityAlert.Read.All` is not used by step 4's handler.** We grant it now to avoid a second bootstrap cycle when the alerts-vertical lands; the drift-detection loop will warn if it's later removed, and an admin can prune via `bootstrap-entra.ps1 -RevokeGraphGrants` if policy forbids unused scopes in dev.

### Neutral

- **Priority-score field (`priorityScore`, 0–100) is present on incidents.** We persist it (ADR-0014 §Schema) so a future "top N priorities" tile is a read-side project, not a re-ingest.
- **`redirectIncidentId` carries a merge-target ID** when incidents are grouped. ADR-0016's detail drawer should follow the redirect; the list view should hide status=`redirected` rows by default.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Microsoft Graph `/security/alerts_v2`** as the primary source | Loses incident-level grouping; forces client-side correlation. Reconsidered only if the incidents endpoint proves inadequate for a specific use case. |
| **Microsoft Defender XDR API** (`/api/incidents`) | MI auth not supported as of 2026-04 — would force the `svc` app-reg split deferred in ADR-0008. The richer-schema benefit is marginal for the step-4 UX. |
| **Microsoft Sentinel incidents** (management plane) | Tenant-scope coupling to Sentinel not compatible with brief §1 ("deployable into your own tenant" — Sentinel not assumed). |
| **Beta Graph endpoints** (`/beta/security/incidents`) | v1.0 is GA and schema-stable; beta adds no field we need for step 4. |
| **Grant `SecurityIncident.ReadWrite.All` to allow comment/status updates** from XDR Hub | Read-only for v1 per brief §1 ("no writes, no remediation"). Write scopes violate the principle and ADR-0010 §Decision ("read-only everywhere"). Reopenable when Tier 2 approval-executing is in scope (brief §6). |

## Related

- `PROJECT_BRIEF.md` §8 — Integrations (Graph Security named as primary source)
- `PROJECT_BRIEF.md` §10 — Deployment (consent flow for Graph scopes)
- ADR-0007 — Easy Auth configuration (separate app-reg for OIDC)
- ADR-0008 — Entra app registration strategy (the `svc` split deferral this ADR preserves)
- ADR-0010 — Graph permissions model (this ADR extends the scope catalogue, does not supersede)
- ADR-0011 — Ingestion schedule, idempotency, retry (pattern reused by ADR-0014)
- ADR-0014 — Incidents ingest cadence + schema (consumer of this decision)
- ADR-0015 — Audit log hash-chain (lands before step-4 code writes to audit)
- ADR-0016 — Incidents list + detail API contract (consumer of the store ADR-0014 defines)
- Microsoft Learn — [List incidents](https://learn.microsoft.com/graph/api/security-list-incidents)
- Microsoft Learn — [incident resource](https://learn.microsoft.com/graph/api/resources/security-incident)

---

*End of ADR-0013.*
