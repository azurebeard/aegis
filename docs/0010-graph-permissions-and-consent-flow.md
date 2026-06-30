# ADR-0010 — Graph permissions model and consent flow

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Build-order step 3 (brief §15) introduces the first vertical: Secure Score ingestion. This is the first XDR Hub subsystem that calls a Microsoft-first-party API (Microsoft Graph) on a schedule, app-only, with no user in the loop. Every subsequent vertical (incidents, Entra risk, CA coverage, tech-stack/KEV correlation) follows the same shape, so the identity and consent model settled here sets the template for everything that follows.

ADR-0008 explicitly anticipated this moment:

> **Re-evaluation trigger:** Graph or Defender scopes land. Step 4+ ingestion Functions will need application permissions […]. A separate app registration — `app-aegis-svc-<env>-<tenant-short>` — is created at that point.

The decision point is now. The axes to resolve are:

1. **Which identity surface carries the application permission?** Three realistic options:
   - **(a)** A new service-only app registration (`app-aegis-svc-<env>`) with a federated-credential trust to the `id-aegis-ingest-dev-weu` user-assigned managed identity; the Function acquires a token via client-assertion.
   - **(b)** A new service-only app registration with a client secret stored in Key Vault and fetched by the Function.
   - **(c)** Direct Microsoft Graph application permissions on the `id-aegis-ingest-dev-weu` user-assigned MI's service principal — no new app registration required.
2. **Which scopes, granted for step 3?** The minimum to satisfy Secure Score is `SecurityEvents.Read.All`. Later verticals will add incrementally; this ADR fixes the pattern, not the full scope list.
3. **How is admin consent granted, documented, and made idempotent?** The consent path is different for options (a)/(b) (tenant admin consent on the app registration) vs (c) (app-role assignment to the MI's SP via Graph POST).
4. **How is the grant provisioned reproducibly?** Bicep cannot express Graph app-role assignments directly (the `Microsoft.Graph` Bicep extension is still preview, per ADR-0008). The bootstrap script (`scripts/bootstrap-entra.ps1`) is the existing reproducible entry point and is the natural place to put this.

Step 3 is also where the deterministic-first / LLM-last principle (brief §5) first applies to a live integration: the ingestion Function **must not** put an LLM on the ingest path. This is scope-relevant because ingestion scopes fuel the dashboard, not an agent; agent scopes will come in a later ADR.

## Decision

### 1. Identity surface — Managed Identity direct

**Option (c).** The `id-aegis-ingest-dev-weu` user-assigned managed identity is granted Microsoft Graph application permissions directly, via `POST /v1.0/servicePrincipals/{miObjectId}/appRoleAssignments` against the Microsoft Graph first-party service principal (`appId 00000003-0000-0000-c000-000000000000`).

**No new app registration is created for step 3.** The `app-aegis-svc-<env>` split anticipated in ADR-0008 is **deferred** and re-evaluated only if and when:

- A downstream API is reached that does not support Managed Identity token acquisition (Defender XDR API's `/api/advancedhunting/run` is one documented case — if that is the access path chosen later);
- The tenant owner demands separation of audit trails at the app-reg level beyond what per-MI service-principal audit provides;
- A Microsoft Graph permission is required that cannot be granted to a managed identity's SP (none known at this time for the v1 scope list).

A new ADR (superseding or siblinging this one) is written at that re-evaluation. For step 3, the MI-direct model is canonical.

### Why MI-direct

- **One fewer secret to rotate.** No client secret, no federated-credential trust choreography, no app-reg lifecycle separate from the MI lifecycle. The bootstrap script already owns MI role assignments on KV and Storage; a Graph app-role assignment to a dedicated ingest MI stays within the same reproducible surface rather than forcing a parallel app-reg lifecycle.
- **Per-MI audit trail.** Every Graph call from the ingest path is attributable in Entra sign-in logs to the MI's service-principal object ID. The "apps can only see their own audit" argument that motivated the `svc` split in ADR-0008 is met by MI isolation: `id-aegis-audit-dev-weu` and `id-aegis-ingest-dev-weu` are already separate SPs with separate audit.
- **Tokens stay in-process.** The Azure Identity SDK (`@azure/identity`) acquires MI tokens from the IMDS-equivalent endpoint on Flex Consumption; no network call to an external IdP, no secret to leak into logs.
- **Upgrade path preserved.** Switching to an `app-aegis-svc-<env>` app reg later is additive — the bootstrap script gains a branch, the Function's `credential` object changes from `ManagedIdentityCredential` to `ClientAssertionCredential` or equivalent, Bicep stays the same.

### 2. Scope list for step 3

The **only** Microsoft Graph application permission granted in step 3:

| App role | Resource | Role ID | Display name |
|---|---|---|---|
| `SecurityEvents.Read.All` | Microsoft Graph (`00000003-0000-0000-c000-000000000000`) | `bf394140-e372-4bf9-a898-299cfc7564e5` | Read your organization's security events |

No other scope is requested by this ADR. Every future vertical that needs a new scope authors its own ADR (or amends a "scope catalogue" ADR written when the third vertical lands, to avoid ADR sprawl).

**Scopes explicitly out of scope for step 3 (tracked for later):**

- `SecurityAlert.Read.All` (incidents vertical, step 4)
- `IdentityRiskyUser.Read.All`, `IdentityRiskEvent.Read.All` (Entra risk vertical)
- `Policy.Read.All` (CA coverage vertical)
- `ThreatIndicators.Read.All` (tech-stack/KEV correlation — if used)
- Defender XDR / Advanced Hunting scopes (`AdvancedHunting.Read.All` on the Microsoft Threat Protection resource — deferred until that vertical is specified)

### 3. Consent flow

Direct app-role assignment to a managed identity's service principal **does not surface a user-facing admin consent prompt.** The `POST /servicePrincipals/{id}/appRoleAssignments` call is itself the consent action, performed by a caller with the `AppRoleAssignment.ReadWrite.All` delegated permission (the deployer already holds this via the bootstrap script's existing scope list — see ADR-0008 §Provisioning mechanism step 1).

Operationally this means:

- **First-run deployer** already performs a device-code login to Graph with the required scopes. The existing scope list in `bootstrap-entra.ps1` (`Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `Directory.ReadWrite.All`) is **sufficient** — no new delegated scope required.
- **The deployer must be a Privileged Role Administrator, Global Administrator, or Application Administrator in the tenant** to perform the app-role assignment (inherited from the existing bootstrap assumptions).
- **No consent URL is printed** — the grant is complete at script exit. This is a deliberate simplification vs ADR-0008's passing mention of a consent-URL step in `PROJECT_BRIEF.md §10`: for v1 with MI-direct, the URL is not needed. If option (a)/(b) is ever adopted, a consent-URL printer returns to the script per brief §10.

#### Deployer-side privilege — session minimisation and role separation

The Graph scopes the bootstrap session holds are **tenant-wide**, not scoped to XDR Hub's resources. `AppRoleAssignment.ReadWrite.All` in particular permits the signed-in principal to grant *any* application permission to *any* service principal in the tenant. Holding this scope in a long-lived session is a privilege concentration that an adversary with session-hijack or token-theft capability can exploit beyond XDR Hub's blast radius.

The following controls apply to every bootstrap run and are enforced in `scripts/bootstrap-entra.ps1`:

1. **Run from a dedicated administrative account.** The bootstrap session must be started from an **Application Administrator** account (or Privileged Role Administrator if the tenant posture requires it) that is **not** the deployer's day-to-day account. Application Administrator is sufficient for everything the script does — Global Administrator is unnecessary over-privilege. The `docs/deployment.md` prerequisites call this out explicitly.
2. **Minimise session lifetime.** The script issues `Disconnect-MgGraph` in a `finally` block at the end of every run (success or failure), so the elevated delegated tokens do not linger in the runner's PowerShell token cache beyond the provisioning window.
3. **No interactive fall-through.** The script does not leave an interactive Graph session open for the operator to "finish up" manually; any additional operations require a separate `Connect-MgGraph` invocation from the operator.
4. **No token persistence.** `Connect-MgGraph` is called with `-NoWelcome` and the default in-memory token cache only. The script never writes Graph tokens to disk.

These controls do not *remove* the privilege required to perform the grant — they scope it to the provisioning window. Session minimisation is the right control here; further tightening (e.g. privileged-access workstation requirements) is a deployer-side policy decision, documented as an operational recommendation in `docs/deployment.md` rather than enforced by this ADR.

### 4. Provisioning — bootstrap script extension

`scripts/bootstrap-entra.ps1` is extended with a new idempotent phase:

```text
Phase: Grant-GraphAppRolesToMi
  For each ($scope in $RequiredGraphScopes) { … }
```

The script:

1. Resolves the Microsoft Graph service principal (`appId 00000003-0000-0000-c000-000000000000`) via `Get-MgServicePrincipal -Filter "appId eq '…'"` — cached for the run.
2. For each scope in `$RequiredGraphScopes` (currently just `SecurityEvents.Read.All`):
   a. Look up the `appRole.Id` on the Graph SP matching the scope's `value`.
   b. `Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $mi.Id` — check whether the grant exists already (keyed by `AppRoleId` + `ResourceId`).
   c. If absent, `New-MgServicePrincipalAppRoleAssignment` with `PrincipalId = $mi.Id`, `ResourceId = $graphSp.Id`, `AppRoleId = $appRole.Id`.
3. Writes a one-line summary per scope to stdout: `GRANTED SecurityEvents.Read.All to id-aegis-ingest-dev-weu` or `ALREADY_GRANTED …`.

The scope list is a script parameter with a default locked in the script (`$RequiredGraphScopes = @('SecurityEvents.Read.All')`). Step 4+ amends the default in the same commit that introduces the dependent code.

**Revocation:** `scripts/bootstrap-entra.ps1 -RevokeGraphGrants` removes every app-role assignment it previously made (matched by `PrincipalId` + `ResourceId = GraphSp.Id`). Non-destructive on reruns; used by the teardown flow and for emergency scope-roll-back.

**Idempotency and safety:**

- **Pre-check before assign** prevents duplicate assignments (Graph returns 403 if you try to re-assign; the script treats the "already exists" case as success).
- **Scope set drift detection:** on each run the script compares the effective assignment list to `$RequiredGraphScopes`; any assignment on the MI SP that is **not** in the declared list is reported as a warning (but not removed unless `-RevokeGraphGrants` is explicitly set). This is a drift-detection gate, not a destructive default.
- **No secret material involved** at any step.

### 5. Token acquisition inside the Function App

The ingest Function acquires Graph tokens via `DefaultAzureCredential` from `@azure/identity`:

```typescript
import { DefaultAzureCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';

const credential = new DefaultAzureCredential({
  managedIdentityClientId: process.env.INGEST_MI_CLIENT_ID,
});
const authProvider = new TokenCredentialAuthenticationProvider(credential, {
  scopes: ['https://graph.microsoft.com/.default'],
});
const graph = Client.initWithMiddleware({ authProvider });
```

- **`managedIdentityClientId`** is set in Function App settings by Bicep to the client ID of `id-aegis-ingest-dev-weu` — selects the right MI on a Function App that may have multiple MIs bound.
- **`scope = .default`** for app-only token: the Graph endpoint returns a token with whatever app roles are already assigned to the MI, which is exactly the ADR-approved list.
- **No other scopes are requested** — a `scope` mismatch would fail closed at token acquisition rather than at API call time.
- **Token caching** is handled by the SDK. Per the Microsoft documentation, MI token caches can take significant time to refresh after an app-role change — this is a known friction point, documented in §Consequences.

### 6. Environment variables owned by this ADR

Added to the Function App configuration by Bicep:

| Name | Value | Notes |
|---|---|---|
| `INGEST_MI_CLIENT_ID` | `<id-aegis-ingest-<env>-<region> clientId>` | Ingest Timer handlers — MI that carries the Graph app role |
| `API_READER_MI_CLIENT_ID` | `<id-aegis-api-<env>-<region> clientId>` | HTTP read handlers — not used for Graph (no Graph app role on this MI) |
| `GRAPH_BASE_URL` | `https://graph.microsoft.com/v1.0` | Overridable for sovereign clouds (`az.environment().graphEndpoint`) |
| `GRAPH_API_TIMEOUT_MS` | `30000` | Enforced at the HTTP client layer — see ADR-0011 retry policy |

`GRAPH_BASE_URL` is composed in Bicep from `az.environment().graphEndpoint` so sovereign-cloud deployers pick up the right endpoint without code change — matches the pattern already adopted for `openIdIssuer` in ADR-0007.

## Consequences

### Positive

- **Per-purpose identity boundary.** The ingest MI is the *only* Function App identity that carries the Graph app role; the api-reader MI, audit MI, and SWA system MI do not. A compromised HTTP handler cannot pivot to Graph because its runtime credential has no Graph scope. This is a real defence-in-depth dividend that the MI-direct model delivers for free.
- **One identity, one audit trail, one rotation story for Graph calls.** The ingest MI's SP is the sole caller in Entra sign-in logs for Graph ingest traffic.
- **No client secret in play for Graph calls.** The client secret in KV (`aad-client-secret-dev`) continues to serve only the user-facing Easy Auth path — its blast radius is limited to OIDC.
- **Consent is administrative, not user-facing.** The bootstrap script is already admin-run; the grant happens atomically with the other admin-only setup.
- **ADR-0008's re-evaluation trigger is deferred, not violated.** The original trigger (Graph/Defender scopes landing) fires; the decision made now is that direct MI grants satisfy the security intent without the app-reg split. A later finding may supersede this — documented as such.
- **Forkers benefit from a simpler consent story:** no admin consent URL to navigate, no enterprise-application-level review step that requires portal access.

### Negative / trade-offs

- **MI token cache-lag after grant changes — the race cannot be closed from the deployer's session.** Microsoft documents that MI tokens can take "significant time" — in practice up to several hours — to reflect app-role changes after assignment. Crucially, a token-acquisition smoke test executed from the *deployer's* Graph session verifies only that **the grant exists in Graph**; it does **not** warm the **Function App's** IMDS-backed MI token cache. A 60-second sleep in the bootstrap script is not a mitigation — it is at best a placebo. The honest closure of the race is:

  1. **Deterministic fix — restart the Function App after the grant phase.** `scripts/bootstrap-entra.ps1` issues `az functionapp restart --name <func-app> --resource-group <rg>` after `Grant-GraphAppRolesToMi` completes. A cold start invalidates the IMDS token cache on the Function App instance(s); the next Timer fire acquires a fresh token that reflects the new role. This is operationally cleanest, is idempotent, and closes the race without timing assumptions.
  2. **Fallback — the first Timer fire on a fresh deploy is an expected-401/403 event.** ADR-0011 §5 ("Explicit non-retry conditions") classifies 401/403 as terminal-no-retry and writes a structured error; the second-day Timer fire recovers. Operators may force recovery via `POST /api/ingest/secure-score/run` (ADR-0011 §1) **after** waiting at least 30 minutes for cache propagation. This fallback applies when the restart in (1) cannot be performed (e.g. maintenance-window constraints).

  The bootstrap script applies fix (1) by default. Flagged explicitly in §Operational pitfalls of `HANDOVER.md` step 3 with the cross-reference to ADR-0011 §5 so the retry-policy reader knows the first-deploy 401 is a known and accepted state when the restart has been skipped.
- **No admin-consent record at the app-reg level.** If a tenant auditor expects to see a "granted-to-app-reg" trail for every scope, the per-MI-SP trail is a new shape to get used to. Documented in `docs/security.md` under "How XDR Hub grants scopes" (to be written as part of step 3).
- **If the `svc` split becomes necessary later, this ADR's decision has to unwind MI grants** during the transition (the SP grants are not migrated to the new app reg — they are separate identities). The revocation path exists in the script specifically so this is one command, not manual portal work.
- **Microsoft.Graph SDK on Node.** An additional runtime dependency in `/api` (`@microsoft/microsoft-graph-client`, `@azure/identity`), but both are Microsoft-maintained, SBOM-friendly, and already implicit in most Azure-Functions-on-Node deployments. Added to `api/package.json` in step 3.

### Neutral

- **Scope catalogue centralisation.** This ADR lists one scope and names the pattern. The third vertical will need a consolidated scope catalogue ADR so that `$RequiredGraphScopes` does not become a scattered source of truth; at that point, this ADR becomes the anchor the catalogue references.
- **Defender XDR API is not ruled out.** If a later vertical needs an API that does not support MI, a split app reg appears at that moment — not because of an architectural objection but because the target API forces it. That decision is outside the current scope.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **(a) New `app-aegis-svc-<env>` app reg + federated credential to MI + client assertion** | Three moving parts where one suffices. Federated credentials are powerful but needed when no MI-direct path exists; here one does. |
| **(b) New `app-aegis-svc-<env>` app reg + client secret in KV** | Reintroduces a secret lifecycle that MI-direct eliminates. The client-secret rotation pattern already exists for OIDC; duplicating it for Graph is avoidable. |
| **Reuse the Easy Auth app reg (`app-aegis-dev-…`) with application permissions** | Mixes user-consented and application-consented scopes on the same app reg — the specific anti-pattern ADR-0008's re-evaluation trigger was designed to prevent. Rejected on audit-trail grounds. |
| **Beta Graph endpoints (`/beta/security/secureScores`)** | v1.0 Secure Score is GA and schema-stable. Using beta would couple ingestion to a preview surface with no upside. |
| **Granting `SecurityEvents.ReadWrite.All`** | XDR Hub is read-only (brief §1). Write scopes violate the principle without any v1 use case. |
| **Per-scope separate MIs** (one MI per Graph scope) | Premature granularity; would multiply MI bindings on the Function App with no defence-in-depth gain at single-maintainer scale. The MI-per-purpose model (audit vs api vs future ingest) is the right axis, not MI-per-scope. |

## Related

- `PROJECT_BRIEF.md` §5 — Deterministic first, LLM last (scope decisions are deterministic — ingest has no LLM)
- `PROJECT_BRIEF.md` §8 — Integrations (Graph Security API named as primary source)
- `PROJECT_BRIEF.md` §9 — Security posture (Managed Identity everywhere)
- `PROJECT_BRIEF.md` §10 — Deployment and versioning (consent-URL pattern — **superseded for MI-direct scopes by this ADR**)
- ADR-0007 — Easy Auth configuration (Easy Auth app reg explicitly bounded to OIDC)
- ADR-0008 — Entra app registration strategy (this ADR resolves the re-evaluation trigger)
- ADR-0011 — Ingestion schedule, idempotency, retry (consumes the scope granted here)
- ADR-0012 — Dashboard tile contract for Secure Score (consumes the ingest output)
- Microsoft Learn — [Assign a managed identity to an app role](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/how-to-assign-app-role-managed-identity)
- Microsoft Learn — [List secureScores](https://learn.microsoft.com/graph/api/security-list-securescores)

---

## Amendments

| Date | Author | Change | Driven by |
|---|---|---|---|
| 2026-04-18 | Ben Thomas | `GRAPH_BASE_URL` hardcoded to `https://graph.microsoft.com/v1.0` in `infra/modules/functions.bicep`. Earlier attempt used `${az.environment().graph}v1.0` on the premise that `az.environment().graph` returned Microsoft Graph for sovereign-cloud portability. It does not — Bicep's `environment()` schema exposes `graph` as the **legacy Azure AD Graph** endpoint (`https://graph.windows.net/`) only. The two are distinct services and the Bicep schema does not expose Microsoft Graph as a separate property. Pointing `@azure/identity` + `@microsoft/microsoft-graph-client` at AAD Graph produces `Request_DataContractVersionMissing` 400 at the first call. Sovereign-cloud deployers (US Government, China 21Vianet) must override this as a deployment parameter until Bicep exposes `microsoftGraph`. | Live deploy 2026-04-18: ingest handler failed `400 {"odata.error":{"code":"Request_DataContractVersionMissing"}}` — surfaced cleanly as JSON on the Run-now response (audit + health commit path verified as a by-product). |
| 2026-04-18 | Ben Thomas | Bootstrap-and-restart path validated live. First deploy surfaced SEC-M-STEP3-INFRA-01 (summary JSON must emit before any post-restart throw) — fix shipped in the same PR as the step-3 code pass and verified via `functionAppRestartStatus` field on the postprovision hook's captured JSON. | WS10 step-3 infra verdict. |

---

*End of ADR-0010.*
