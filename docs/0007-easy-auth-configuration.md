# ADR-0007 — Easy Auth configuration

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

XDR Hub is a single-tenant deployment in the user's own Azure subscription (brief §1, §3). It has a React SPA on Azure Static Web Apps (per ADR-0004 adjacent) backed by Azure Functions (per ADR-0002, ADR-0004), and must require authentication for every user-facing and API surface. The brief (§3, §9) commits to "Easy Auth → Entra ID (no custom auth code)" and to restricting access to the deployer's tenant by default, with an allowlist for specific users or groups.

"Easy Auth" is the common name for the App Service / Static Web Apps built-in authentication feature (formerly EasyAuth). On Static Web Apps, it is exposed as **Static Web Apps Authentication** and Static Web Apps routes authentication through `/.auth/*` endpoints, sets a session cookie, and injects an `X-MS-CLIENT-PRINCIPAL` header into requests that reach the linked backend. This ADR fixes the configuration choices for v1 so that Bicep, `staticwebapp.config.json`, and the Entra app-registration bootstrap script (ADR-0008) all agree on:

- Which identity provider is configured and with what scope.
- How users are authorised (authentication ≠ authorisation).
- How role information propagates from Entra into the SPA and from the SPA into the Function backend.
- Which routes require which roles.

## Decision

### Platform and plan

- **Azure Static Web Apps, Standard tier.** Free tier does not support custom auth role mappings, `allowedApplications` constraints, or Managed Functions tied to the SWA with private endpoints (needed in step 3+). Standard is ~£8/mo and is adopted for all environments including `dev`.
- Authentication is the SWA built-in Entra ID provider (Microsoft identity platform v2.0 endpoint). **No MSAL in the browser** — the SPA calls `/.auth/login/aad`, `/.auth/logout`, and reads `/.auth/me` for the current user; MSAL is not installed client-side in v1.

### Identity provider

- **Entra ID only.** No GitHub, Google, Twitter, or other providers. `staticwebapp.config.json` sets `auth.identityProviders.azureActiveDirectory` and removes any default providers.
- **openIdIssuer:** `https://login.microsoftonline.com/<deployer-tenant-id>/v2.0` — single-tenant issuer endpoint. Hard-binds the SWA to one tenant. No common or organizations endpoints are used.
- **clientIdSettingName / clientSecretSettingName:** point at the SWA app settings `AAD_CLIENT_ID` and `AAD_CLIENT_SECRET`; actual values come from Key Vault references (Bicep) or are injected at provision time by the Entra bootstrap script (ADR-0008).

### Tenant restriction

The brief §9 requires "restrict to the deployer's tenant by default". Enforced at three layers:

1. **openIdIssuer** scoped to the deployer's tenant ID (above).
2. **`allowedApplications`** restriction in `staticwebapp.config.json`: only the specific Entra app registration's client ID (ADR-0008) is accepted. Prevents a user from authenticating through a different app in the same tenant.
3. **`loginParameters`** include `scope=openid profile email` only — no Graph scopes, so a successful login returns an ID token with no wider access. Graph / Defender scopes land in step 4+ behind a separate app registration (per ADR-0008's re-evaluation trigger).

### Authorisation model

Authentication via Entra proves identity. **Authorisation** — whether an authenticated user can use the app — is governed by role assignment:

- **App Role assignment is required.** The Entra app registration (ADR-0008) declares two App Roles: `reader` and `admin`. A user who authenticates but has no App Role assignment is rejected by SWA's route rules (below).
- **Seed user:** the Entra bootstrap script assigns the `admin` role to the user identified by `AZURE_ADMIN_EMAIL` at provision time. This is the sole user able to log in on first deploy.
- **Group assignments come later:** in dev this pass, future passes will add Entra security groups as principals (portal or script). The App Roles and the `requestedAccessTokenVersion: 2` configuration support group-based assignment without ADR change.

### Role propagation

- SWA's Easy Auth extracts App Roles from the Entra ID token's `roles` claim and maps them into the SWA per-request **roles** set via a custom-role role mapping in `staticwebapp.config.json`:

  ```json
  "auth": {
    "rolesSource": "/api/auth/roles",
    ...
  }
  ```

  The `rolesSource` endpoint is a **Function** that reads `X-MS-CLIENT-PRINCIPAL`, validates the issuer, extracts `roles`, and returns `["reader"]` or `["reader","admin"]`. This gives us server-side control over role mapping without baking Entra's role names into `staticwebapp.config.json`.
- The backend `X-MS-CLIENT-PRINCIPAL` header carries the user's identity **and** the SWA-computed roles. Every Function that serves authenticated traffic validates this header (see ADR-0005 tool-call authorisation separation — the Function, not the caller, enforces authz).

### Route and API restrictions

`staticwebapp.config.json` defines:

| Route | Allowed roles | Behaviour |
|---|---|---|
| `/api/*` (all backend routes) | `authenticated,reader` | Anonymous gets 401; non-reader users get 403. |
| `/api/auth/roles` | `authenticated` | Special — the roles-source endpoint. Anonymous logged-in users hit this before roles are assigned. |
| `/api/admin/*` | `admin` | Reserved for step-5+ administrative endpoints. |
| `/` and all SPA routes | `anonymous` | SPA renders login prompt; client calls `/.auth/me` to determine state. |
| `/.auth/*` | SWA-managed | Not configurable. |

A global `responseOverrides` block maps 401 to a 302 redirect to `/.auth/login/aad?post_login_redirect_uri=/` for HTML requests, preserving SPA UX.

### Session and cookie policy

- SWA Easy Auth sets a session cookie, `HttpOnly`, `Secure`, `SameSite=Lax`. No code change required; SWA defaults are acceptable.
- Session lifetime follows Entra ID token lifetime (default 1 hour access token, 90 day refresh token, no change).
- **No client-side token storage**. The SPA never sees an access token or ID token; it sees `/.auth/me` JSON only.

### Logout flow

- The SPA "Sign out" action navigates to `/.auth/logout?post_logout_redirect_uri=/`.
- The Entra app registration (ADR-0008) declares a **front-channel logout URL** of `https://<swa-hostname>/.auth/logout/complete` so that Entra-initiated logout from another tenant application invalidates the XDR Hub session.
- **Single-sign-out is not enforced in v1.** Signing out of XDR Hub terminates the local SWA session only; the user's Entra tenant session is unaffected. Rationale: XDR Hub users typically also use Defender, Entra, and other tenant tools in the same browser; terminating the tenant-wide session on every logout is disruptive. A superseding ADR reopens this if a compliance requirement changes.

### Role-source cache

- The `/api/auth/roles` Function caches the resolved role set per-user in Table Storage (partition key `user`, row key `<entra-object-id>`).
- **Maximum cache TTL: 5 minutes.** Implementations MUST NOT exceed this. A role revocation in Entra propagates to the authorisation decision within at most 5 minutes after the change.
- Cache invalidation triggers: the user's explicit logout, SWA session renewal, and any write to `ApprovalDecisions` by that user (so newly-granted capabilities are reflected immediately in the user's own session).
- Cache misses fall through to the App Role lookup against the Entra app registration's role-assignment listing via the role-source Function's Managed Identity (Graph scope: `RoleManagement.Read.Directory`).

### Backend protection (SWA ↔ Function App linked-backend)

The linked Function App is at a public hostname (`func-aegis-api-<env>-<region>.azurewebsites.net`). The `X-MS-CLIENT-PRINCIPAL` header injected by SWA is base64-encoded JSON and is **not cryptographically signed**, so it is trivially forgeable on a direct call to the Function App. Without explicit protection, every authentication and authorisation control in this ADR is bypassable.

**v1 backend protection pattern:** Function App Easy Auth with `allowedClientApplications` restricted to SWA's system-assigned managed identity.

- The SWA's system-assigned MI is created at SWA provisioning time and is bound to the Function App via `az staticwebapp backends link` (or equivalent Bicep output wiring).
- The Function App runs App Service Authentication (Easy Auth) with the Entra ID identity provider. Token validation is enabled; unauthenticated requests are rejected with 401.
- `allowedClientApplications` on the Function App's Easy Auth config lists **only** the SWA MI's app ID. Any other Entra-issued token is rejected.
- SWA, when proxying `/api/*`, includes its MI-issued token in the `Authorization: Bearer` header. The Function App's Easy Auth validates that token and only then accepts the request.
- Direct internet traffic to the Function App without a valid SWA-MI token returns 401, making the `X-MS-CLIENT-PRINCIPAL` header unreachable.

This is implemented in `infra/modules/functions.bicep` at creation — not configured post-deploy. The Bicep module is the single source of truth for the protection posture.

**Reopen trigger:** if a workload later requires the Function App to be reachable from a non-SWA caller (for example a scheduled job running outside the SWA/Functions boundary), this subsection reopens — options are a second Function App with different auth, or a move to the VNet-private-endpoint pattern described as the alternative below.

**Alternative (not default in v1):** Function App behind a private endpoint with SWA VNet integration. Stronger posture; adds ~£20/month for private DNS zones and links. Tracked as a reopen option under WS10 SEC-M-05 (private-endpoint default-off policy).

## Consequences

### Positive

- **No custom auth code** in web or api — SWA Easy Auth owns the callback, the cookie, and the session.
- **Single-tenant hard-binding** via `openIdIssuer` + `allowedApplications` makes cross-tenant access infeasible by configuration, not by hope.
- **Server-authored role mapping** via the `/api/auth/roles` endpoint keeps Entra role names and SWA role names decoupled — a future rename in Entra does not require a SWA redeploy.
- **App Role assignment required** means authentication-alone does not grant access; a compromised tenant user cannot log into XDR Hub unless explicitly assigned a role.
- **No MSAL in the browser** reduces the client attack surface: no tokens stored in localStorage, no opportunity for XSS to exfiltrate them.

### Negative / trade-offs

- **SWA Standard cost** (~£8/mo per environment) is material against the < £25/mo target but is accepted as the price of real auth controls.
- **Easy Auth cookie session** means the SPA has no access token to call Graph or Defender APIs directly. This is the intended design (brief §5: deterministic first, LLM last; signals are pulled by scheduled Functions, not by the dashboard). If the dashboard ever needs live user-delegated calls, this trade-off reopens.
- **Role-source Function** is a new authenticated endpoint that gets hit on every new session. Must be fast and cache-friendly; implementation sets a short-lived per-user cache in Table Storage.

### Neutral

- `allowedApplications` is a SWA configuration option and is not preview. It is the supported way to restrict which client app may authenticate against this SWA.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| MSAL React in the SPA, bearer tokens to Functions | Adds browser token storage, complicates logout, duplicates what SWA Easy Auth already does correctly. Rejected for attack-surface reduction. |
| Multi-tenant app registration with `tenantId` allowlist in app code | Mixes authentication and authorisation responsibilities; single-tenant issuer is a stronger, simpler control. |
| GitHub as auth provider (simpler setup) | Brief §3 commits to Entra ID; Entra is the canonical identity for a Microsoft Security tool. |
| Anonymous access to non-sensitive tiles | A security-tool dashboard has no "non-sensitive" state. All surfaces require authentication. |
| SWA Free tier | No custom auth role mappings, no `allowedApplications`, no private-endpoint path. Free is a non-starter given the requirements. |

## Related

- `PROJECT_BRIEF.md` §3 — Architecture decisions (Auth row)
- `PROJECT_BRIEF.md` §6 — Autonomy model (Tier 2 Approvals path requires authentication)
- `PROJECT_BRIEF.md` §9 — Security posture (tenant restriction, allowlist, MI for Azure resources)
- `PROJECT_BRIEF.md` §13 — MVP scope (Easy Auth + Entra, tenant-restricted)
- ADR-0001 — Codename and repo identity (SWA and app-reg naming)
- ADR-0002 — API runtime language (Functions are the role-source and authorisation-enforcement layer)
- ADR-0005 — Agent orchestration (tool-call authorisation separation applies equally to SPA → Function calls; same principle, different layer)
- ADR-0008 — Entra app registration strategy (companion decision)
- ADR-0009 — Frontend stack (specifies how the SPA consumes `/.auth/me`)
