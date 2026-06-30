# ADR-0008 — Entra app registration strategy

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

The Easy Auth configuration in ADR-0007 depends on an Entra ID app registration in the deployer's tenant. The app registration encapsulates:

- The `clientId` and client secret used by SWA to drive OIDC with the Entra v2.0 endpoint.
- Redirect URIs for SWA's auth callback.
- **App Roles** (`reader`, `admin`) that drive the XDR Hub authorisation model.
- Future Graph and Defender API permissions (step 4+) — intentionally **not** granted in v1.

Two axes of decision: (a) **how many** app registrations, and (b) **how** they are provisioned. Both need to be answered before the SWA Bicep module lands, because SWA binds to a `clientId` and a secret via app settings, and the Bicep has no value to bind to until an app registration exists.

### Why Bicep cannot fully own this

Entra app registrations are created in Microsoft Graph, not in Azure Resource Manager. Bicep has a preview `Microsoft.Graph` extension that can create them, but:

- It is still preview — breaking changes between minor versions are expected.
- Creating a client secret through the extension is awkward and the secret rotation story is weak.
- App Role definition and assignment through the extension is incomplete.

For a community OSS deployment where the deployer is the only person running `azd up`, a deterministic **PowerShell 7 + Microsoft.Graph PowerShell SDK** bootstrap is both simpler and more auditable than the preview ARM extension.

## Decision

### Number of app registrations

**One app registration for v1,** named `app-aegis-<env>-<tenant-short>`. This registration handles:

- Easy Auth OIDC on the SPA (ADR-0007).
- App Roles `reader` and `admin` that govern SPA access.
- Future Graph / Defender API permissions **are not added in v1**.

Re-evaluation trigger (must open a superseding or sibling ADR when this fires):

1. **Graph or Defender scopes land.** Step 4+ ingestion Functions will need application permissions (Graph `SecurityEvents.Read.All`, Defender `AdvancedHunting.Read.All`, etc.). These are **not** granted to the Easy Auth app registration. A separate app registration — `app-aegis-svc-<env>-<tenant-short>` — is created at that point. The separation keeps user-consented scopes distinct from application-consented scopes and follows the principle that an app-reg's audit log should show only its own permission grants.

### Provisioning mechanism

**PowerShell 7 + Microsoft.Graph PowerShell SDK bootstrap script:** `scripts/bootstrap-entra.ps1`.

The script is **deterministic and idempotent** — safe to run repeatedly. It performs:

1. **Authenticate to Microsoft Graph** using the deployer's identity (`Connect-MgGraph -Scopes "Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All","Directory.ReadWrite.All"`). Interactive device-code flow by default; supports `-UseDeviceCode` for CI contexts later.
2. **Idempotent create-or-update** of the app registration by display name `app-aegis-<env>-<tenant-short>`.
3. Ensure the two **App Roles** (`reader`, `admin`) exist with stable GUIDs generated deterministically from the app display name (so re-runs do not change IDs).
4. **Redirect URI** configuration for the SWA hostname: `https://<swa-hostname>/.auth/login/aad/callback`. SWA hostname is passed as a parameter.
   - **Front-channel logout URL:** `https://<swa-hostname>/.auth/logout/complete` registered on the app registration so that Entra-initiated logout from another tenant application invalidates the XDR Hub session (ADR-0007 Logout flow).
5. **Client secret** creation (or rotation if an existing secret has less than 30 days remaining lifetime). New secret stored immediately in **Key Vault** under `aad-client-secret-<env>` via the deployer's Key Vault Data Officer role.
6. **Service principal** creation in the tenant (if not present).
7. **Role assignment** of the `admin` role to the user identified by `-AdminEmail`. The specific user's object ID is resolved via Graph before assignment.
8. **Summary output** — app ID, tenant ID, which KV secret holds the client secret, current role assignments. No secret value is printed to stdout.

The script exits non-zero on any failure and writes a structured log to stderr.

### azd integration

The SWA Bicep module references the client secret via a Key Vault reference in app settings:

```text
@Microsoft.KeyVault(SecretUri=https://kv-aegis-<env>-<region>.vault.azure.net/secrets/aad-client-secret-<env>)
```

The Entra bootstrap script is invoked by `azd` as a **preprovision hook** (not postprovision): the Key Vault must exist first (step 1 foundations) but the app registration and the secret must exist before the SWA is created so the reference resolves. Sequence:

1. `azd provision` step 1 (RG + KV + observability + identities) — already complete.
2. `azd up` with step-2 Bicep triggers `preprovision` hook → `scripts/bootstrap-entra.ps1 -Env dev -AdminEmail ... -SwaHostname ...`.

   *Problem:* the SWA hostname is not known before the SWA is created. Solution: **two-phase deploy.** Phase 1 creates the SWA with a placeholder redirect URI, captures the hostname. Phase 2 re-runs the Entra script with the real hostname (handled by a `postprovision` hook that re-invokes the script to patch the redirect URI only when the SWA hostname has changed). The script is idempotent; this is safe.

3. SWA reads `AAD_CLIENT_ID` and `AAD_CLIENT_SECRET` from Key Vault via MI.

### Separation of concerns — deployer vs service principal permissions

- **The script's Graph permissions are the deployer's delegated permissions** (not the app reg's). The script uses the deployer's token to create and manage the app reg. It does not grant the SWA or any Function any Graph permission in v1.
- **The SWA's only tenant relationship is OIDC.** No Graph, no Defender, no Entra admin scopes.
- **No admin consent prompt** is required in v1 because the user-consented scopes are `openid profile email User.Read` (the last is the Graph default for Sign in and read user profile — user-consentable).

### Rotation and teardown

- **Client secret rotation:** re-run the bootstrap script; it replaces a secret that has less than 30 days remaining lifetime and updates the KV secret in place (new version). Calendar event or scheduled Function added in a later pass to trigger this automatically.
- **Teardown:** a companion `scripts/teardown-entra.ps1` removes the app registration and its service principal. Called from `azd down` via a hook in non-prod. In prod, teardown is deliberately manual.

## Consequences

### Positive

- **Deterministic, auditable provisioning** — the script is code, versioned in the repo, reviewable and re-runnable.
- **Secrets never appear in Bicep.** The KV reference pattern means the Bicep deployment has no knowledge of the client secret's value.
- **Single app-reg simplicity** — v1 has one OIDC identity to manage, one set of redirect URIs, one set of App Roles. Splitting later is an additive change, not a migration.
- **App Role discipline from day one** — `reader` / `admin` in Entra, mapped server-side to SWA roles (ADR-0007). Groups drop in later without code change.

### Negative / trade-offs

- **PowerShell + Graph SDK as a hard prereq** — deployers need PowerShell 7 and the Microsoft.Graph module installed. Documented in `docs/deployment.md`. Acceptable for a technical-audience tool (brief §2).
- **Interactive login on first `azd up`.** `Connect-MgGraph` prompts for device-code or browser login. Not automatable in classic CI without a workload-identity federation setup; v1 does not require that. Follow-up ADR if CI-driven deploys become a requirement.
- **Two-phase deploy** for the redirect URI is a minor choreography cost. Documented clearly in the script and the deployment docs.

### Neutral

- Switching to the `Microsoft.Graph` Bicep extension later is additive and gated on extension GA — the script interface becomes a deprecation target if and when that happens. No v1 decision needed.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Manual app-reg in the portal** | Not reproducible, not versioned, not auditable. Rejected for a reproducible deploy. |
| **Bicep `Microsoft.Graph` extension** | Preview; breaking changes between minor versions; weak client-secret and App Role tooling. Revisited when GA. |
| **Terraform `azuread` provider** | Would introduce Terraform alongside Bicep — duplicates the IaC toolchain for one concern. Rejected against ADR-0004 et al, which standardise on Bicep. |
| **Two app registrations in v1** (Easy Auth + service) | Premature split. No Graph/Defender scopes yet. Split is wired as a re-evaluation trigger above so it happens when it is needed, not before. |
| **Client certificate instead of client secret** | Stronger auth for the SWA, but the cert lifecycle adds complexity that a client secret with KV-managed rotation does not. Reopenable if secret rotation proves onerous. |

## Related

- `PROJECT_BRIEF.md` §3 — Architecture decisions (Auth row)
- `PROJECT_BRIEF.md` §9 — Security posture
- `PROJECT_BRIEF.md` §10 — Deployment and versioning (Entra app registrations via script that prints the consent URL)
- ADR-0001 — Codename and repo identity (app-reg display name)
- ADR-0007 — Easy Auth configuration (companion decision; consumes the `clientId` and the secret KV reference)
- ADR-0009 — Frontend stack (specifies how the SPA consumes role information)
