# ADR-0035 — Native Entra authentication migration: retire Easy Auth + KV client secret, adopt MSAL Node + MSAL.js

**Status:** Accepted (subject to Phase E gating items per WS10 verdict 2026-05-08)
**Date:** 2026-05-08
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —
**WS10 verdict:** [`docs/WS10-verdict-2026-05-08-adr-0035-native-entra-auth.md`](./WS10-verdict-2026-05-08-adr-0035-native-entra-auth.md) — Conditional approval. SEC-H-01, SEC-H-02, SEC-M-01..M-04 textual amendments incorporated below; SEC-M-01 IP-restriction Bicep + SEC-M-03 §8a infrastructure-cleanup enumeration are Phase-specific gating items.

---

## Context

Project Aegis ships today with two co-operating identity layers, both leaning on Azure Static Web Apps' built-in authentication:

1. **Browser → SWA (sign-in)** — SWA's built-in OIDC provider against Microsoft Entra. Configured in `web/public/staticwebapp.config.json` and backed by an AAD client secret stored in Key Vault (`aad-client-secret-<env>`) referenced by SWA app settings `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET`. The `bootstrap-entra.ps1` rotates this secret if remaining lifetime < 30 days (ADR-0008 SEC-L-ADR-08-02).
2. **SWA → Function App (backend bridge)** — SWA's linked-backend mechanism acquires a token for the SWA system-assigned managed identity and presents it as a bearer to the Function App, where Easy Auth (`siteAuthSettingsV2`) validates the audience against the SWA-MI app ID and sets the `x-ms-client-principal` header read by all 50+ function handlers via [`api/src/lib/clientPrincipal.ts`](../api/src/lib/clientPrincipal.ts:21).

Roles flow via SWA's `rolesSource` mechanism: SWA POSTs the user's claims to [`/api/auth/roles`](../api/src/functions/authRoles.ts), which extracts App-Role values from any of three claim-type forms (`roles` v2.0, `role` v1.0, WS-Fed long URI — fix landed today in commit `7391874`) and returns the SWA roles `["admin","reader"]` or `["reader"]`.

This topology has shipped well through development but carries two go-live blockers:

- **Confidential-client client secret in Key Vault.** Any client secret is a long-lived credential subject to rotation, leakage, and operational drift. The bootstrap rotation logic (`bootstrap-entra.ps1` lines 473–514) is itself attack surface, and the dual-secret window — old secret kept for 7 days during rotation — is a known design compromise. A managed-identity or public-client flow eliminates this credential entirely.
- **Two auth subsystems to reason about.** SWA built-in auth + Easy Auth have independently versioned configuration, error surfaces (`Bearer realm="..."` 401s vs `403 Unauthenticated` redirects), and recovery procedures (the 2026-05-08 binding-drift incident, HANDOVER §10.44 §4, required `azd hooks run postprovision` to atomically re-bind both layers). Consolidating to a single Microsoft Identity Platform OIDC + JWT validation flow shrinks the surface to one well-documented pattern.

The migration target is **native Microsoft Identity Platform** end-to-end:

- The SPA acquires user tokens directly via **MSAL.js** (auth-code + PKCE; public client; **no client secret**).
- The SPA sends `Authorization: Bearer <user-access-token>` to the API on every request.
- The Function App validates the JWT itself (JWKS + issuer + audience) — Easy Auth is removed.
- Roles travel inside the user's access-token claims (App Roles on the user, surfaced as the `roles` claim on the API audience). The `/api/auth/roles` rolesSource handler is retired alongside SWA's auth provider.

This ADR settles the topology, app-registration layout, token-flow choices, JWT-validation strategy, route-rule changes, and the migration phasing. It does not change any data plane (Tables, ingest, scopes, audit chain) — those are all callers of the principal abstraction, and the abstraction holds.

Out of scope:

- **Multi-tenant federation.** Aegis is single-tenant. The new app registrations are single-tenant in `signInAudience`.
- **Federated credentials / workload identity for the bootstrap script.** Out of scope; the bootstrap continues to authenticate `az` / `Microsoft.Graph` PowerShell as the deployer.
- **Browser SSO across multiple Aegis tenants** — N/A while single-tenant.
- **Conditional Access policy enforcement at the API.** SWA's network-layer policy enforcement is unchanged for the SPA host; CA enforces at Entra sign-in. The API trusts the validated token's `iss`/`aud`/`exp`. Tenant-restriction headers, MS-internal browser features, and CAE are out of scope.
- **Logout-everywhere semantics (single-sign-out).** The migration uses MSAL's standard `logoutRedirect` — Entra-initiated logout that clears the SPA cache and ends the Entra session for that browser. No back-channel session enumeration; out of scope.
- **The `/api/ingest/*` machine-to-machine path.** Ingest endpoints continue to be invoked by the **Timer triggers** running on the Function App's user-assigned ingest MI. They never traverse the user-auth path. The hard-coded admin-only SWA route rule on `PATCH /api/ingest/settings` (browser-invoked) DOES traverse the user-auth path and is in scope.

The concrete decisions to settle:

1. App-registration topology in Entra.
2. Browser token acquisition flow + cache backing store.
3. JWT validation strategy on the Function App.
4. SWA configuration after Easy Auth + built-in OIDC removal.
5. SWA → Function App network path posture (linked-backend proxy vs direct).
6. `clientPrincipal` helper interface preservation.
7. `/api/auth/roles` retirement.
8. Bootstrap-script changes (apps, secrets, KV rotation, role assignments).
9. Phase ordering + landing rules.
10. Roll-back posture.

---

## Decision

### 1. App-registration topology — split SPA + API

Two single-tenant app registrations (replacing the single `app-aegis-<env>-<tenant-short>`). Names follow CAF conventions: `<resource-type>-<workload>-<component>-<env>-<tenant-short>` — `app-` is the CAF abbreviation for an Entra app registration; region is omitted because Entra is a global plane:

| App | `signInAudience` | Platform | Client secret? | Owns App Roles? | Audience for tokens |
|---|---|---|---|---|---|
| `app-aegis-spa-<env>-<tenant-short>` | `AzureADMyOrg` | **SPA** (`spa.redirectUris`) | No | No | — |
| `app-aegis-api-<env>-<tenant-short>` | `AzureADMyOrg` | None (resource-only) | No | **Yes** (admin / reader) | `api://<api-app-id>` |

The SPA has **delegated permission** to call the API — exposed scope `api.access` on the API app, granted as a delegated permission to the SPA app, admin-consented at provision time. App Roles (`admin` / `reader`) are defined on the **API** app and assigned to users via `appRoleAssignments` against the API app's service principal. When the SPA acquires a token for the API audience, Entra issues an access token with `aud=api://<api-app-id>` containing the user's roles in the `roles` claim and the user's object ID in `oid`.

Why split:

- **Audience separation.** A token meant for the API never carries SPA-redirect-URI metadata; a token-replay window from one to the other is closed by `aud`-mismatch.
- **Microsoft Identity Platform best practice.** The MS Learn guidance for SPA + Web API consistently recommends two registrations.
- **Permission boundary.** Delegated scopes between the two apps are discoverable in the Entra portal as a relationship, not buried in claim mappings.
- **Future-proof.** A second client (CLI, IDE plugin, mobile) attaches to the API app without re-shaping permissions on a shared registration.

### 2. Token acquisition + cache

- **Library:** `@azure/msal-browser` (≥3.x) + `@azure/msal-react` (≥2.x). MSAL React is idiomatic for the existing React 18 + TanStack Query frontend (`MsalProvider` wraps the app; hooks are React-first).
- **Flow:** Authorisation Code + PKCE (the only flow `@azure/msal-browser` supports for SPA platform; implicit flow is hard-disabled).
- **Login UX:** `loginRedirect()` — full-page redirect to Entra and back. Popup-mode rejected: triple-block on enterprise-managed browsers + Safari ITP partitioning + iOS in-app browsers.
- **Cache location:** `sessionStorage` (default). `localStorage` rejected — survives browser close, broadens token-theft window via XSS. Aegis does not need cross-tab single-sign-on across browser sessions; sign-in time is sub-second on a returning Entra session.
- **Token-renewal:** silent (`acquireTokenSilent`) on every API call via a fetch wrapper. Falls back to `acquireTokenRedirect` on `InteractionRequiredAuthError` (CAE / consent-required / MFA-step-up). The wrapper is in [`web/src/auth/api.ts`](../web/src/auth/api.ts) — single entry point for all `/api/*` calls. `tokenRenewalOffsetSeconds: 300` is **pinned explicitly** in MSAL config rather than relying on the v3 default (SEC-L-03) — defence against a v4 default change.
- **Audience requested:** `<api-app-id>/api.access` (bare-GUID + scope; v2.0 form). No `User.Read` or other Graph scope on the SPA token; the API never proxies Graph calls on behalf of the user.
- **Negative pins (deliberately disabled):** `storeAuthStateInCookie: false` (Aegis targets Chromium-modern browsers per ADR-0009; legacy IE/Edge cookie-fallback out of scope — SEC-L-01). `nativeBrokerEnabled: false` (Windows Hello / WAM broker out of scope at single-tenant dev scale; revisit at multi-tenant — SEC-L-02).

### 3. JWT validation on the Function App

- **Library:** [`jose`](https://github.com/panva/jose) v5 (industry-standard, audited, no cryptographic primitives in our code). MSAL Node's `ConfidentialClientApplication` is **not** used for inbound validation — `jose` is the right tool.
- **JWKS endpoint:** `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`. Cached in-process via `createRemoteJWKSet` with explicit `cacheMaxAge: 600_000` (10 min) and `cooldownDuration: 30_000` (30 s) — pinned rather than relying on `jose` default behaviour, which has changed between v4 and v5 (SEC-L-05).
- **Validation requirements (all REQUIRED — token rejected if any fail):**
  1. Signature verifies against current JWKS.
  2. `iss === "https://login.microsoftonline.com/<tenant-id>/v2.0"` (literal string, env-supplied).
  3. `aud === <api-app-id>` — the **bare GUID** (v2.0 form), env-supplied. The v1.0 form `api://<api-app-id>` is **explicitly rejected** to force `accessTokenAcceptedVersion: 2` discipline on the API app manifest (SEC-H-01).
  4. `ver === "2.0"` — REQUIRED. Token-version mismatch is a hard reject; defends against a future API-app manifest drift to v1.0 silently changing claim shapes (`scp` vs `roles`, `unique_name` vs `preferred_username`) per RFC 9068 §4.
  5. `exp` is in the future. `nbf` is **REQUIRED** (RFC 9068 §2.2; not "if present") and is in the past.
  6. `tid === <tenant-id>` (defence in depth — redundant against `iss` literal but cheap).
  7. `roles` is an array; values are filtered against `["admin", "reader"]` as today's `/api/auth/roles` does. Admin implies reader.
  - *Phase-C-optional, multi-client follow-up (SEC-L-04):* `azp === <spa-app-id>` pin to close the "valid token issued to a different client in the same tenant" hole. Not required at single-client launch (only the SPA holds `api.access` consent); track for the multi-client expansion.
- **On failure:** return `401 { code: "AuthenticationFailed", message: "<short reason>" }`. Reasons logged with `traceId` for diagnostics, **not** echoed back (avoid claim-shape disclosure).
- **Where it runs:** a single middleware function in [`api/src/lib/authMiddleware.ts`](../api/src/lib/authMiddleware.ts) called at the top of every handler, replacing `readClientPrincipal()`'s callsite. The handler signature is unchanged — see Decision 6.
- **Anonymous routes:** `authMiddleware` runs on **every** handler at Phase E end-state. The middleware exposes a single allow-list constant `ANONYMOUS_ROUTES` in `authMiddleware.ts` purely as a future-proofing escape hatch — **the constant is empty at Phase E end-state and remains empty unless a future change documents the addition under WS10 review** (SEC-M-04).

### 4. SWA configuration changes

[`web/public/staticwebapp.config.json`](../web/public/staticwebapp.config.json) becomes:

- **`auth` block — REMOVED.** No `identityProviders.azureActiveDirectory`. No `rolesSource`. SWA stops being an identity gateway.
- **`routes` — auth annotations removed.** Today: `"/api/admin/*": { "allowedRoles": ["admin"] }`. After: SPA fallback rules + a *no-auth* `/api/*` passthrough. **Role gating is now exclusively enforced at the Function App** by the JWT-claims check inside the handler/middleware. SWA route rules stop using `allowedRoles`.
- **`globalHeaders.Content-Security-Policy` — MODIFIED (SEC-M-02).** The current CSP `connect-src 'self'` and absent `frame-src` will both block MSAL silent-renewal (iframe to `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize?prompt=none`) and `acquireTokenByCode` (POST to `/oauth2/v2.0/token`). Required Phase D delta — bounded, no wildcards, no `'unsafe-inline'` relaxation:
  - `connect-src` extended from `'self'` → `'self' https://login.microsoftonline.com https://login.microsoft.com`.
  - `frame-src` added: `https://login.microsoftonline.com https://login.microsoft.com`.
  - `form-action` already includes `https://login.microsoftonline.com` — retained.
  - `script-src`, `style-src`, `default-src`, `frame-ancestors`, `base-uri` — **unchanged**. No relaxation.
  - Phase D commit MUST include a Vitest assertion on the resulting CSP header value to prevent silent regression.
- **`globalHeaders` — other directives unchanged.** HSTS, X-Frame-Options, X-Content-Type-Options unchanged.
- **App settings on the SWA:** `AAD_CLIENT_ID` + `AAD_CLIENT_SECRET` removed. New: `VITE_AEGIS_TENANT_ID`, `VITE_AEGIS_SPA_CLIENT_ID`, `VITE_AEGIS_API_AUDIENCE` (build-time only — surfaced through `web/.env.production` rather than runtime app-settings, since they are non-secret and burned into the bundle).

### 5. SWA → Function App posture — keep linked-backend proxy, NO Easy Auth

The SPA continues to call relative `/api/*` paths. SWA proxies the request to the Function App on the linked-backend, **without acquiring a backend token** (because Easy Auth is removed; nothing to acquire for). The user's `Authorization: Bearer <token>` header is forwarded by SWA to the Function App as-is. The Function App's `authMiddleware` validates it.

- **Easy Auth on the Function App:** `siteAuthSettingsV2` block in [`infra/modules/functions.bicep`](../infra/modules/functions.bicep:640) is **removed**.
- **Linked-backend `az staticwebapp backends link`:** retained — the SWA still needs to know the Function App URL to proxy to. The `azd hooks run postprovision` step continues to perform this link.
- **SWA-MI Easy Auth audience:** removed — the FA no longer rejects calls based on the calling MI's app ID. Anonymous calls to the FA are **prevented in defence-in-depth** by `siteConfig.ipSecurityRestrictions` allow-list (the JWT validator is the primary control; IP restrictions are the network-layer safety net per NIST SP 800-53 SC-7).
- **Direct-to-FA discovery resistance — DECIDED (SEC-M-01, WS10 verdict 2026-05-08):** option **(a) `siteConfig.ipSecurityRestrictions` allow-list to SWA outbound IPs**. Trade-off summary:

  | Option | Trade-off | Decision |
  |---|---|---|
  | (a) IP restrictions | £0; one Bicep param + one `azd env get` for SWA outbound CIDR; preserves linked-backend proxy and `azd up` model. Residual risk: SWA outbound IPs are shared across SWA tenants on the same scale unit — JWT validator gates the request regardless. | **Selected.** |
  | (b) Private Endpoint | ~£18/mo + VNet + private DNS; breaks `azd deploy` SCM reachability without a self-hosted build agent; FA Premium plan required. | Rejected at single-tenant scale. |
  | (c) Front Door fronting | ~£28/mo + WAF + new TLS cert; duplicates SWA's existing edge. | Rejected — no marginal threat reduction at single-tenant scale. |

  Phase E Bicep deploys `siteConfig.ipSecurityRestrictions` in `infra/modules/functions.bicep` with the SWA outbound IP CIDR list (sourced from `az staticwebapp show --query "outboundIpAddresses"` or the per-region SWA outbound IP ranges) plus the build-agent egress for `azd deploy`. The IP-restriction block carries a `// Re-evaluate on multi-tenant: flip to private endpoint` comment as a re-evaluation trigger; tracked in HANDOVER §6.3.

### 6. `clientPrincipal` helper preserves its interface

[`api/src/lib/clientPrincipal.ts`](../api/src/lib/clientPrincipal.ts:13) exports `ClientPrincipal { identityProvider, userId, userDetails, userRoles[], claims? }`. After migration, `readClientPrincipal(req)` is replaced by `readPrincipal(req)` returning the **same shape** — populated from the JWT validated by `authMiddleware` instead of the `x-ms-client-principal` header.

Mapping:

| Old (Easy Auth) | New (MSAL JWT) |
|---|---|
| `identityProvider` = `"aad"` | `"aad"` (preserved literal) |
| `userId` = body.userId (Entra OID) | `oid` claim (Entra OID — same value) |
| `userDetails` = body.userDetails (UPN/email) | `preferred_username` (UPN/email — same value) |
| `userRoles` = body.userRoles | `roles` claim filtered to `["admin","reader"]` |
| `claims` = body.claims | optional pass-through of the validated claim set |

**No call-site changes** in the 50+ handlers. The helper file changes; its contract does not. Tests pinning principal-derivation behaviour migrate from header-base64-fixture to JWT-fixture (`jose`'s `SignJWT` makes this trivial in a unit test against a local JWKS).

### 7. `/api/auth/roles` retirement

The handler [`api/src/functions/authRoles.ts`](../api/src/functions/authRoles.ts) is **deleted**. No SWA rolesSource caller remains. The 9 regression tests added in commit `7391874` (WS-Fed claim-type fix) are deleted alongside the handler.

App-Role assignments still happen in the Entra portal / `bootstrap-entra.ps1` against the **API app's** service principal — only the path by which roles are surfaced changes (claim in the user's JWT vs. response from the rolesSource endpoint).

### 8. Bootstrap-script changes

[`scripts/bootstrap-entra.ps1`](../scripts/bootstrap-entra.ps1) gains a parallel branch that:

- **Reconciles two app registrations** (SPA + API) instead of one, with idempotent create/update against display-name match. **API app is created first** (it owns the App Roles and the exposed scope); SPA app is created second; SPA → API `requiredResourceAccess` link is the third step. Partial-failure resumption (SEC-I-03): on the next run, both apps reconcile by display-name match; consent grant re-attempts cleanly.
- **Defines App Roles** (`admin`, `reader`) on the **API** app's `appRoles` collection (today they live on the single combined app).
- **Exposes API scope** `api.access` on the API app's `api.oauth2PermissionScopes`.
- **Sets `requestedAccessTokenVersion: 2`** on the API app manifest (`application.api.requestedAccessTokenVersion = 2`) — REQUIRED so Entra emits v2.0 tokens whose `aud` is the bare GUID and whose `ver` claim is `"2.0"`. The Phase C / E `authMiddleware` rejects v1.0 tokens; mis-configuring this would be a deploy-time fail-closed (SEC-H-01).
- **Configures SPA platform redirect URIs**: `https://<swa-hostname>/`, `https://<swa-hostname>/auth/callback`. No Web platform, no client secret.
- **Grants SPA → API delegated permission** (`api.access`) and admin-consents it tenant-wide.
- **Drops** the client-secret rotation block (lines 473–514) entirely.
- **Drops** the KV secret create/set step (`aad-client-secret-<env>`) **and** the `--content-type 'application/x-aegis-aad-client-secret'` set call (line 530).
- **Reconciles admin-user role assignment** against the **API app's** SP rather than the legacy combined app.
- **Continues to grant Graph scopes** to the **ingest** user-assigned MI (unchanged — this path uses MI federation, not the migrating user-auth path).

The script becomes additive: on the first run after migration it creates the two new apps and orphans the old single app (operator deletes manually or a cleanup pass deletes it after a soak window). Idempotent re-runs are no-ops.

### 8a. Infrastructure changes alongside Phase E (SEC-M-03)

The bootstrap-script delta in §8 is necessary but not sufficient. Phase E must additionally clean up the IaC + manifest references to `aad-client-secret-<env>`:

| File | Change | Notes |
|---|---|---|
| `infra/modules/swa.bicep` | Remove `aadClientSecretName` parameter and the `AAD_CLIENT_SECRET` + `AAD_CLIENT_ID` SWA app-settings entries. | Lines 41–85 today. |
| `infra/modules/keyvault.bicep` | **Remove the deployer's Secrets Officer role assignment** that today carries an ABAC condition pinned to `aad-client-secret-<env>` (line 101). Selected sub-option: **(iii) drop the role assignment entirely** until a future secret is required for the vault, then re-apply with a fresh ABAC condition for that secret's name. Sub-options (i) "broaden ABAC" and (ii) "update ABAC to next secret" are explicitly rejected — neither is needed today and (i) undoes the WS10-2026-04-20 hardening. | Re-applying later is a one-Bicep-line change; deferring the role until a use exists is the safest posture. |
| `infra/main.json` | Regenerated by `az bicep build`. | Generated artefact; tracks `.bicep` updates. |
| `scripts/bootstrap-entra.ps1` | Per §8 — drop rotation + create + `--content-type` calls. | Already enumerated in §8 above; cross-listed here so Phase E commit catches it. |

**Why the KV resource itself is retained:** the vault may be needed for future managed-identity-bound secrets unrelated to this migration. The vault stays; only the dead `aad-client-secret-<env>` secret + its ABAC-conditioned role assignment go.

**Re-evaluation trigger:** any future ADR proposing a new KV secret must re-apply a deployer role assignment with an ABAC condition pinned to that secret's name (mirrors WS10 verdict 2026-04-20).

### 9. Phasing

Five sub-phases. Each lands as one commit; each is testable on `dev` independently; phase A is the gating spec-review.

- **Phase A — ADR sign-off + WS10 review of §5 (SWA → FA posture).** This document. Output: WS10 verdict, signed-off topology, named pre-condition for the FA hostname-discovery defence (IP restrictions vs private endpoint vs public-with-validation-only). No code.
- **Phase B — Entra app-reg split + bootstrap branch + KV-secret retirement.** `bootstrap-entra.ps1` reconciles the two new apps; legacy app left in place; client secret left in KV but not rotated; SWA config unchanged (browser still uses the old flow). End state: tenant has two new apps + a still-working old flow + new operator-runnable bootstrap path. No browser/API code changes. Verified by inspecting the new apps in Entra portal.
- **Phase C — Function App `authMiddleware` (dual-mode, with deterministic precedence).** Add the JWT-validation middleware. Auth-mode contract (SEC-H-02 — defends against auth-mode confusion attack):
  1. **`Authorization: Bearer` takes precedence absolutely.** If a Bearer token is present, the JWT path runs and is authoritative. The `x-ms-client-principal` header is **ignored** in this path — no fall-through to the legacy branch on JWT failure (a JWT failure is a 401, not a downgrade).
  2. **Legacy branch is gated by `AEGIS_LEGACY_CLIENT_PRINCIPAL` env var** (default `disabled`). Only when set to `enabled` (Phase C through Phase D end) does the FA accept `x-ms-client-principal` in the absence of a Bearer token; otherwise a request without a Bearer is rejected 401 even if the legacy header is present.
  3. **Phase D end-state asserts `AEGIS_LEGACY_CLIENT_PRINCIPAL=disabled`**; Phase E removes the env-var read entirely.
  4. **Required negative-case unit tests in `api/tests/authMiddleware.test.ts`:**
     - `Authorization: Bearer <invalid>` + `x-ms-client-principal: <forged-admin>` → expect **401** (Bearer-takes-precedence; no fall-through).
     - `x-ms-client-principal: <forged-admin>` only, with `AEGIS_LEGACY_CLIENT_PRINCIPAL=disabled` → expect **401**.
     - `x-ms-client-principal: <legitimate>` only, with `AEGIS_LEGACY_CLIENT_PRINCIPAL=enabled` → expect **200** (legacy path).

  Tests also cover the positive Bearer path with v2.0 valid tokens. Easy Auth still active on FA (defence in depth — strips/replaces the `x-ms-client-principal` header on inbound). End state: API accepts both modes per the precedence policy; existing browser path unaffected during Phase C. ~600 LoC + ~25 tests (legacy branch + new Bearer branch + the three named negative cases).
- **Phase D — Web SPA cuts over to MSAL.** Add MSAL providers, `acquireTokenSilent` fetch wrapper, login/logout buttons, redirect handler. Remove SWA `auth` block + `rolesSource` from `staticwebapp.config.json`. Hard cutover for the browser. Easy Auth still active on FA so the SWA-system-MI path could in theory still call it (it doesn't — SWA stops issuing user-auth requests through the linked backend the moment its `auth` block is removed). End state: browser uses MSAL exclusively; FA accepts JWT-Bearer (Phase C path) only — the dual-mode branch is unused but still resident.
- **Phase E — Cleanup.** Remove Easy Auth from FA Bicep (`siteAuthSettingsV2` block deleted). Delete `/api/auth/roles` handler + its tests. Delete `clientPrincipal.ts` legacy header path (single-mode middleware). Remove `AAD_CLIENT_ID`/`AAD_CLIENT_SECRET` from SWA Bicep. Delete `aad-client-secret-<env>` from KV. Remove the bootstrap rotation block. End state: zero KV client-secret, zero Easy Auth, single auth path. The previously-orphaned legacy combined Entra app may be deleted at this point.

### 10. Rollback posture

- **Phase B → A:** delete the two new app registrations in Entra; revert the bootstrap commit. Five-minute reverse.
- **Phase C → B:** revert the Function App deploy to the prior tag; delete `authMiddleware.ts`.
- **Phase D → C:** revert the SWA deploy + restore `staticwebapp.config.json`. The user's MSAL session evaporates; SWA's built-in flow is back.
- **Phase E → D:** revert the FA deploy + re-apply the SWA Bicep with the legacy app settings. This phase's rollback is the costliest:
  - Re-create the KV secret + run bootstrap to re-grant: ~30 min if the deployer's KV role assignment is still in place.
  - **Per §8a sub-option (iii) the deployer's KV Secrets Officer assignment is dropped in Phase E.** Rollback under this posture additionally requires re-applying the role assignment with a fresh ABAC condition for `aad-client-secret-<env>` — adds ~15 min, plus a Privileged Identity Management activation if PIM is enforced (SEC-L-06). Net rollback time: ~45 min, possibly +PIM approval.
  - Phase E does **not** deploy until Phase D has accumulated **≥ 48 hours** of clean traffic on `dev`. Rationale: single-operator dev tenant; 48 h covers two normal sign-in/expiry cycles plus at least one CAE-driven silent renewal. A longer window carries a `// LEGACY — remove in Phase E` shim in the repo for diminishing safety return.

A failure in any phase that breaks user sign-in is recoverable inside one `azd deploy` — the SWA + FA always sit on the previous good binding while the new one is being built (Bicep is non-destructive on `siteAuthSettingsV2` until the deploy actually applies).

---

## Consequences

### Security posture changes

- **Eliminated:** Long-lived AAD client secret in Key Vault. Removes the bootstrap rotation logic (~40 LoC of scheduled credential management) and the dual-secret window.
- **Eliminated:** Two-layer Easy Auth + SWA-built-in-auth state machine. Single auth path = single failure mode = single recovery procedure.
- **Introduced:** SPA hosts a public client. Token theft via XSS is a category-A risk. Mitigations: strict CSP (already in place — see `globalHeaders` in current `staticwebapp.config.json`); `sessionStorage` (cleared on tab close); short token lifetimes (Entra default 1h); MSAL's PKCE bound to the request; React app already passes its only sink (`html`-tagged template) through escape-encoding.
- **Introduced:** Function App becomes a directly-addressable resource accepting Bearer tokens. Mitigations: `authMiddleware` rejects everything else; per WS10's Phase A verdict, defence-in-depth via IP restrictions or private endpoint.
- **Re-validated:** No change to Conditional Access enforcement at sign-in; CAE token revocation honoured by MSAL's silent-renew (any token rejection triggers `acquireTokenRedirect`, which re-runs CA at Entra).

### What does NOT change

- All ingest paths (Timers → Graph) — ingest MI federation is independent.
- All Tables, audit chain, scopes, retention.
- The 50+ function-handler call sites — the principal abstraction holds.
- The SWA hostname, the FA hostname, DNS, certificates, the dashboard URL.
- The admin-role gate at the network layer (now enforced inside the FA, not the SWA route rule, but the user-visible behaviour is identical: non-admins see 401 on admin endpoints, redirected to dashboard).

### What temporarily diverges (Phase C → Phase E window)

- The FA accepts both header-based and JWT-based auth simultaneously. This is **bounded** to the Phase D and pre-Phase-E window (≥ 48 h soak per §10). During this window any future engineer reading the code must understand the dual-mode shim — the header-based branch is annotated with `// LEGACY — remove in Phase E` to make this explicit.

### Known risks (gating WS10 review)

- **R1: Direct FA addressing.** Without Easy Auth, the FA URL is a public bearer-token-protected endpoint. WS10 to advise: tighten via `siteConfig.ipSecurityRestrictions` (cheap, retains topology), private endpoint (changes networking), or fronting via Front Door (changes DNS). Not blocking the spec — blocking the deploy of Phase E.
- **R2: Token-theft via XSS.** Mitigations listed above; WS10 to advise on whether strict CSP + sessionStorage is sufficient or whether a server-side session pattern (token vault, BFF) is warranted for go-live. Trade-off: BFF adds back Easy-Auth-shaped complexity we're removing.
- **R3: Bootstrap idempotency under partial failure.** If `bootstrap-entra.ps1` creates the SPA app but fails before creating the API app, the next run must reconcile. The script's existing idempotent reconcile pattern (display-name match) extends naturally; tested in Phase B by running the script twice on a clean dev tenant.
- **R4: First-run consent.** The SPA-→API delegated permission requires admin consent tenant-wide. The bootstrap script performs admin consent at provision time; if this fails (insufficient admin scope), users see a consent prompt on first sign-in. Documented in §6.2 of HANDOVER.

### Test posture

- Phase B: bootstrap idempotency (run × 2 on a clean tenant; second run is a no-op).
- Phase C: middleware unit tests (`jose.SignJWT` fixtures for valid / wrong-aud / wrong-iss / expired / missing-roles); dual-mode integration tests (header path + Bearer path both populate the same `ClientPrincipal`).
- Phase D: web-side login flow (Vitest + MSAL test fixtures); fetch-wrapper acquires + retries on `InteractionRequiredAuthError`.
- Phase E: smoke — every existing handler unit test passes against JWT fixtures; one end-to-end sign-in on `dev`.

---

## Cross-references

- **HANDOVER §10.44 §1** — WS-Fed claim-type fix (commit `7391874`) — relevant because the role-claim-type matcher is deleted in Phase E along with `/api/auth/roles`.
- **HANDOVER §10.44 §4** — Easy Auth ↔ SWA-MI binding-drift incident — the migration eliminates this failure mode permanently.
- **HANDOVER §6.3** — backlog item "Native Entra authentication migration (P0)" — this ADR is its design.
- **ADR-0008** — Key Vault & secret-rotation strategy — `aad-client-secret-<env>` is removed from scope by this ADR.
- **ADR-0010** — Ingest MI federation — unchanged; this ADR is user-auth only.
- **ADR-0013 §3** — Same-commit-as-consumer for scope grants — not relevant to this ADR (no new Graph scopes).
