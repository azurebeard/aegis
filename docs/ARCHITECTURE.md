# Architecture

Project Aegis is a single-tenant Azure-hosted dashboard for Microsoft Defender XDR. The codename `aegis` is the workload token used across IaC, telemetry, and code; the user-facing product name is **XDR Hub**. This document describes the runtime shape, identity model, and storage topology of a deployment.

See [`INGEST.md`](./INGEST.md) for per-source ingestion contracts, retry semantics, and Graph scope catalogue. See [`AGENTS.md`](./AGENTS.md) for the agent topology, prompt-injection defences, and token-budget enforcement.

## 1. System overview

A deployment is one Azure resource group containing three logical planes:

| Plane | Purpose | Trigger surface |
|---|---|---|
| **Dashboard** | React SPA + HTTP API serving precomputed posture data to authenticated operators. | Browser → SWA → Function App (HTTP). |
| **Ingest** | Timer-triggered Functions pulling from Microsoft Graph, Defender, ransomware.live, and CISA KEV into the operational store. | Azure Functions Timer triggers. |
| **AI (optional)** | Foundry Agent Service project hosting role-specialised LLM agents that summarise the data the dashboard already holds. | Orchestrator invoked from the API; specialists invoke API-backed tools. |

The planes share a resource group and an ops storage account but run under separate user-assigned managed identities so a compromise in one plane cannot read or write outside its scope. The AI plane is optional — a deployment without a Foundry project still serves the full deterministic dashboard.

```text
                ┌───────────────────────────────────────────────────────────┐
                │  rg-aegis-<env>-<region>                                  │
                │                                                           │
   Browser ──▶  │  Static Web App ──▶ Function App (HTTP)                   │
   (MSAL.js)   │  (stapp-aegis-…)    (func-aegis-api-…)                     │
                │                       │      │                            │
                │                       │      ├──▶ Ops Tables              │
                │                       │      │    (staegisops…)           │
                │                       │      ├──▶ Audit blob (WORM)       │
                │                       │      │    (staegisaudit…)         │
                │                       │      └──▶ Key Vault (per-secret)  │
                │                       │           (kv-aegis-…)            │
                │                       │                                   │
                │                       └──▶ Foundry orchestrator           │
                │                            (aif-aegis-…)                  │
                │                                                           │
                │  Timer triggers ──▶ Microsoft Graph, Defender,            │
                │  (ingest MI)        ransomware.live, CISA KEV             │
                │                       │                                   │
                │                       └──▶ Ops Tables + Audit blob        │
                │                                                           │
                │  App Insights (appi-aegis-…) + Log Analytics              │
                └───────────────────────────────────────────────────────────┘
```

## 2. Hosting

| Concern | Choice |
|---|---|
| API runtime | Node 22 LTS, TypeScript, Azure Functions v4 programming model. |
| API hosting | Azure Functions Flex Consumption plan, one plan per region. |
| Scale-to-zero | Always-ready instances default `0`; max instances default `100`. Both parameterised in Bicep. |
| SPA hosting | Azure Static Web Apps (Standard tier), serving the Vite build output. |
| IaC | Bicep under `infra/`. Deployed with `azd up`. |
| Region | West Europe is the primary v1 target. Bicep fails fast if the selected region does not support Flex Consumption. |

Polyglot Function Apps (e.g. .NET for KQL-heavy Sentinel work, Python for ML pipelines) are permitted on the same plan shape but are not present in v1. Any second runtime ships under a dedicated Function App following the `func-aegis-<purpose>-<env>-<region>` naming pattern.

### Resource naming

Naming follows the Cloud Adoption Framework convention with `aegis` as the workload token. Bicep exposes `param workload string = 'aegis'` in `main.bicep` so a forker can rename the entire deployment by changing one parameter.

| Resource | Pattern | Example |
|---|---|---|
| Resource group | `rg-aegis-<env>-<region>` | `rg-aegis-prod-weu` |
| Function App (API) | `func-aegis-api-<env>-<region>` | `func-aegis-api-prod-weu` |
| Static Web App | `stapp-aegis-<env>-<region>` | `stapp-aegis-prod-weu` |
| Storage (ops) | `staegisops<env><region>` | `staegisopsprodweu` |
| Storage (audit, WORM) | `staegisaudit<env><region>` | `staegisauditprodweu` |
| Key Vault | `kv-aegis-<env>-<region>` | `kv-aegis-prod-weu` |
| App Insights | `appi-aegis-<env>-<region>` | `appi-aegis-prod-weu` |
| Log Analytics | `log-aegis-<env>-<region>` | `log-aegis-prod-weu` |
| Managed identity | `id-aegis-<purpose>-<env>-<region>` | `id-aegis-ingest-prod-weu` |
| Foundry project | `aif-aegis-<env>-<region>` | `aif-aegis-prod-weu` |

Storage account names drop hyphens and the workload prefix to fit the 24-character lowercase-alphanumeric limit. `<env>` is one of `dev`, `test`, `prod`; `<region>` is the Azure short code (`weu`, `uks`, `eus2`, …).

## 3. Identity model

### Browser and API authentication

Aegis uses **Microsoft Identity Platform** end-to-end. The SPA acquires user access tokens directly via **MSAL.js** (auth-code + PKCE, public client, `sessionStorage` cache) and sends them as `Authorization: Bearer` headers to the API. The Function App validates each JWT in-process using the [`jose`](https://github.com/panva/jose) library against the tenant's JWKS endpoint. There is no client secret in the user-auth path.

Validation requires, for every request:

- Signature verifies against the cached JWKS for the tenant.
- `iss` matches the tenant's v2.0 issuer (`https://login.microsoftonline.com/<tenant-id>/v2.0`).
- `aud` matches the API app's bare GUID (v1.0 audience form rejected).
- `ver` is `"2.0"`.
- `exp` is in the future; `nbf` is required and in the past.
- `tid` matches the configured tenant.
- `roles` is an array filtered to the App Roles below.

A request failing any check returns `401`. The validator middleware runs on every handler; the `ANONYMOUS_ROUTES` allow-list is empty in the shipped configuration.

### Entra topology

Two app registrations per deployment:

| App | Purpose | Secret? | Owns App Roles |
|---|---|---|---|
| `app-aegis-spa-<env>-<tenant>` | SPA platform; redirect URIs only. | None. | No. |
| `app-aegis-api-<env>-<tenant>` | API resource; exposes `api.access` scope; manifest pinned to `accessTokenAcceptedVersion: 2`. | None. | **Yes** (`admin`, `reader`). |

The SPA holds a delegated permission on the API's `api.access` scope, admin-consented at provision time. App Role assignments target the API app's service principal.

**Role semantics:** `admin` implies `reader`. Admin gates every state-changing endpoint (ingest run-now, settings PATCH, snapshot capture, share-link issue) at the handler layer. Reader is the minimum role required for any `/api/*` call other than the JWKS-free health probe.

### Managed identities

Each plane runs under a dedicated user-assigned managed identity. No identity holds rights it does not need for its handler set.

| Identity | Used by | Storage scopes | Key Vault scopes | Graph scopes |
|---|---|---|---|---|
| `id-aegis-api-<env>-<region>` | HTTP read handlers on the API Function App. | `Storage Table Data Reader` on the ops storage account; `Contributor` on `ApprovalDecisions`, `ManualTasks`. | `report-share-signing-key` (Secrets User, per-secret ABAC). | None. |
| `id-aegis-ingest-<env>-<region>` | Timer-triggered ingestion handlers and admin-write paths (`patchSettings`, snapshot capture). | `Contributor` on the per-source tables it writes (`SecureScore`, `Incidents`, `EntraRisk`, `IngestHealth`, `ReportSnapshots`, …). | None. | Per-source app roles granted directly to the MI's service principal — see `INGEST.md` for the full catalogue. |
| `id-aegis-audit-<env>-<region>` | Audit-writer code path only. | `Storage Blob Data Contributor` scoped to the `audit` container on the audit storage account. | None. | None. |
| `id-aegis-mailsender-<env>-<region>` | Report email send path (Graph `Mail.Send`). | None. | `recipient-hash-pepper` (Secrets User, per-secret ABAC). | `Mail.Send` (single mailbox). |
| `id-aegis-agent-<env>-<region>` | Foundry Agent Service inference. | `Storage Table Data Reader` on agent-readable tables. | None. | None. |

Per-secret ABAC v2 conditions on every Key Vault role assignment — no identity has unscoped `Key Vault Secrets User`. Audit and ops sit in **two separate storage accounts** so the audit MI cannot reach operational data, and vice versa.

## 4. Data stores

### Operational state — Azure Table Storage

One ops storage account `staegisops<env><region>`. One table per domain. `PartitionKey` is `tenantId` for tenant-scoped data; row keys are documented per table in `infra/modules/storage.bicep`.

| Table | Purpose |
|---|---|
| `SecureScore` | Tenant Secure Score snapshots (Graph + Defender for Cloud sources). |
| `Incidents` | Defender XDR incidents and alerts. |
| `EntraRisk` | Entra ID risk detections and risky users. |
| `CAPolicies` | Conditional Access policy snapshots and coverage analysis. |
| `StackItems` | User-declared technology-stack items. |
| `KEVMatches` | Tech-stack ↔ CISA KEV correlation results. |
| `Ransomware` | ransomware.live victim and group records. |
| `ApprovalDecisions` | Tier-2 approval and rejection records (user-writable). |
| `ManualTasks` | Tier-3 user-authored tasks and notes (user-writable). |
| `AgentRuns` | Per-agent invocation metadata (tokens, duration, correlation). |
| `AgentBudget` | Per-tenant per-day token budget rows with ETag lease. |
| `IngestHealth` | Per-source ingest health, last success, audit-chain head. Ingest-written, API-read, never user-writable. |
| `TenantSettings` | Operator-tunable policy rows. Includes admin-scoped dynamic-RowKey families (`report-email-config`, `report-email-send:<msgId>`, …). |
| `ReportSnapshots` | Versioned report-period captures (see §7). |
| `RateLimitCounters` | Reserved for the durable counter migration triggered when single-instance rate limits no longer hold (see §5). |

Every row carries `CreatedUtc`, `UpdatedUtc`, and an integer `SchemaVersion`. Migrations are additive; renaming or re-typing a partition or row key requires writing to a new table and a cutover window.

### Audit log — append-blob with WORM

One audit storage account `staegisaudit<env><region>`. One container `audit`. Daily append blobs, one per source:

- Path: `audit/<source>/<yyyy>/<mm>/<dd>/<filename>.ndjson` where `<filename>` is `ingest.ndjson`, `agent-run.ndjson`, or `report.ndjson` depending on the source family.
- Format: newline-delimited JSON, one event per line.
- **Blob type: append blob.** Append-only writes are admitted under the locked retention policy; delete and overwrite are blocked.
- **Immutability:** time-based retention policy, default 365 days, locked at container creation by Bicep. Never unlocked in normal operation. Legal-hold capability retained for incident response.
- **Writer:** only the `id-aegis-audit-<env>-<region>` MI, scoped to the `audit` container.

Test environments use a shorter retention parameter and an unlocked policy; prod is hard-coded to lock at create.

### Secrets — Key Vault

One Key Vault per deployment. The vault holds only operator-supplied secrets that cannot be eliminated by identity federation:

| Secret | Consumer | Purpose |
|---|---|---|
| `recipient-hash-pepper` | `id-aegis-mailsender-…` | 256-bit pepper for the salted recipient hash on email-send audit lines. Defends the audit blob against offline rainbow-table attacks on board distribution lists. |
| `report-share-signing-key` | `id-aegis-api-…` (issuer and verifier) | HMAC key signing anonymous share-link tokens served by `GET /api/reports/share/{token}`. The KV grant on this secret is the security boundary for share-link forgery. |
| `ransomware-live-api-key` | `id-aegis-ingest-…` | Outbound API key for the ransomware.live threat-intel feed. No MI option upstream. |

Every secret has its own per-secret ABAC v2 role assignment. The deployer's `Secrets Officer` grant carries an ABAC condition pinned to the named secret allowlist. No broad `Key Vault Secrets User` assignment exists on any identity.

### Foundry threads

Per-session agent memory uses Foundry Agent Service threads natively. There is no custom conversation store. Thread IDs correlate to user sessions via the `correlationId` field on each audit line.

## 5. Rate limiting

`api/src/lib/rateLimit.ts` exposes a centralised limiter abstraction with one configured instance per protected endpoint. Each instance defines a window, a ceiling, and a key shape:

| Limiter family | Scope | Key | Default ceiling |
|---|---|---|---|
| Read endpoints (trend, summary, list, detail) | Per-principal | Entra `oid` | 60–120 / minute |
| Admin run-now endpoints (ingest, capture) | Per-tenant | `tenantId` | 30 / day |
| Admin settings PATCH | Per-tenant | `tenantId` | 30 / day |
| Report email send | Per-tenant | `tenantId` | 10 / day |
| Daily Brief manual run | Per-tenant | `tenantId` | Enforced via `AgentBudget` row with ETag lease (durable). |

In-process limiters are sized for single-instance Flex Consumption; the operator-stated ceiling is the per-instance ceiling. A documented set of triggers (multi-tenant deployment, sustained Flex scale-out with 429-plateau, compliance ask, multiplier-driven incident) gates migration to a durable `RateLimitCounters` table or, on escalation, Azure Cache for Redis. The migration target reuses the ETag-lease counter pattern already proven on `AgentBudget` and `IngestHealth`.

Limiters are defence-in-depth. The authoritative controls are the JWT App Role gate, the Flex concurrency cap, and per-source Graph budgets.

## 6. Audit chain

Every ingest run, agent run, snapshot capture, settings change, and report-email send writes a structured NDJSON line to the audit blob. Lines carry a forward hash-chain that binds each line to its predecessor:

| Field | Type | Purpose |
|---|---|---|
| `seq` | int | Monotonic per `(source, tenantId)`. Gap detection. |
| `prevLineSha256` | hex SHA-256 | `lineSha256` of the previous line in the same chain. |
| `lineSha256` | hex SHA-256 | SHA-256 over the JCS-canonicalised (RFC 8785) line with `lineSha256` omitted. |

Each `(source, tenantId)` pair is an independent chain. The first line in a chain (the genesis line, or `audit.chain.start` boundary marker on migration) sets `prevLineSha256` to the project-salted sentinel `SHA256("aegis:audit-chain:v2:<source>:<tenantId>:genesis")` — distinct from a zero buffer so a writer bug that emits sixty-four zeros is rejected rather than treated as genesis.

Canonicalisation uses the vetted [`json-canonicalize`](https://www.npmjs.com/package/json-canonicalize) library; hand-rolled replacement is gated on RFC 8785 official test-vector parity, a 10⁶-input fuzz comparison against the prior implementation, and security review.

`IngestHealth` carries the chain head (`LastAuditSeq`, `LastLineSha256`) for each source under the same ETag lease that admits ingest writes. Writers commit the health row first and append the audit line second; an audit-write failure leaves a detectable gap that the next successful run repairs via a one-off `ingest.audit.repair` line whose `prevLineSha256` matches the on-disk last line. Automatic chain re-genesis is forbidden.

A standalone verifier (`scripts/verify-audit-chain.mjs`, Node 22) walks a `(source, tenantId)` chain over a date window and reports any mismatch: bad `lineSha256`, mismatched `prevLineSha256`, or non-contiguous `seq`. The verifier has no service-side dependency beyond audit-blob read access.

## 7. Reports and snapshots

A `/reports` SPA route renders the current period's posture as a single scrollable, print-friendly page assembled from the live dashboard queries. Admins capture a period as a durable snapshot:

- **Envelope.** Versioned JSON object containing `periodKey` (ISO week / month / quarter), `periodCadence`, `periodStart`/`periodEnd`, `capturedAt`/`capturedBy`, and a `sections` map of `secureScore`, `incidents`, `entraRisk`, `brief`, `posture`, `ingestHealth`. Section shapes are the existing wire types verbatim — the snapshot is a cache of the dashboard's source data, not a parallel schema.
- **Storage.** `ReportSnapshots` table on the ops storage account, partitioned by `tenantId`, row-keyed `<periodKey>_<capturedAt>`. Envelope is gzip + base64 inside the row; pre-compression size recorded for telemetry. Per-period version count enforced (default 3, floor 3); age-based trim parameterised (default seven years, floor 30 days).
- **Re-capture semantics.** Each capture writes a new versioned row. Latest-version-wins on the default read; specific versions addressable by `?version=N` or `?capturedAt=…`. Trim emits its own `audit.report.trim` lines.
- **Audit chain.** Each capture emits one `audit.report.capture` line on the `report.snapshot` chain (`report.ndjson` filename).
- **Share-link delivery.** Admins issue a signed share-link token (`HMAC` over `{periodKey, version, expiry}` with the `report-share-signing-key` secret). `GET /api/reports/share/{token}` is anonymous — the token is the auth. KV unavailability fails soft on issue and read by default; an opt-in env flag enables hard-fail once the secret is confirmed provisioned.
- **Email delivery.** Admin-triggered POST `/api/reports/snapshots/{periodKey}/email` invokes Graph `Mail.Send` via the mailSender MI. Recipient list lives in `TenantSettings.report-email-config`; external recipients are deny-by-default. Each send emits a `report.email.intent` line (pre-send) and a `report.email.sent` or `report.email.failed` line (post-Graph). Intent lines carry `recipientHashSaltedV2 = SHA256(pepper:tenantId:canonical-recipients)` where `pepper` is the KV-held `recipient-hash-pepper` — defeats offline rainbow-table attack on audit-blob leaks.

## 8. Frontend

| Concern | Choice |
|---|---|
| Framework | React 18 + TypeScript 5.x (strict). |
| Build | Vite. |
| Routing | React Router v6 (`createBrowserRouter`). |
| Server state | TanStack Query v5. |
| Components | Fluent UI v9 (`@fluentui/react-components`). |
| Charts | Recharts. |
| Auth | MSAL.js (`@azure/msal-browser` ≥ 3, `@azure/msal-react` ≥ 2). |
| Testing | Vitest + React Testing Library; Playwright for one end-to-end auth-and-navigation smoke. |
| Lint | ESLint with `@typescript-eslint`, `react`, `react-hooks`, `jsx-a11y`, `@tanstack/query`. |

The SPA never calls Microsoft Graph directly; every API call is a `fetch` against the Function App with `Authorization: Bearer` from MSAL. A single `web/src/auth/api.ts` wrapper centralises silent token acquisition and falls back to `acquireTokenRedirect` on `InteractionRequiredAuthError`.

Static Web Apps `globalHeaders` configure HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a tight `Permissions-Policy`, and a `Content-Security-Policy` that pins `script-src 'self'` and `frame-ancestors 'none'`, extending only `connect-src` and `frame-src` to `login.microsoftonline.com` for MSAL silent renewal. The CSP value is asserted in a Vitest test to prevent silent regression.

Defence-in-depth at the network layer: the Function App's `siteConfig.ipSecurityRestrictions` allow-lists the SWA outbound CIDR set plus the deploy-agent egress. JWT validation remains the authoritative control.

## 9. Observability

| Surface | Service |
|---|---|
| Custom events and traces | Application Insights (`appi-aegis-<env>-<region>`). |
| Logs | Log Analytics workspace (`log-aegis-<env>-<region>`). |
| Distributed tracing | OpenTelemetry SDK with OTLP exporters into App Insights. |

Every emitted log carries `service.namespace = aegis` and an OpenTelemetry `service.name` from the per-component cloud role set (`aegis-web`, `aegis-api`, `aegis-ingest`, `aegis-orchestrator`, `aegis-posture`, `aegis-incidents`, `aegis-stack`, `aegis-brief`).

The codebase emits a structured `AIEVENT.*` custom-event family for operational signals — `AIEVENT.AuditWriteFailed`, `AIEVENT.AuditChainRepairWritten`, `AIEVENT.TenantSettingsChange`, `AIEVENT.report.email.sent`, `AIEVENT.report.email.pepper.fallback`, and the per-vertical retry and budget events. Each event carries the `correlationId`, the calling MI's client ID, and the source identifier. Alert rules on `AuditWriteFailed` and `AIEVENT.report.email.failed` ship in the Bicep observability module.

Per-agent invocations also emit App Insights custom events with prompt and completion token counts, duration, thread ID, and tool-calls-made; the dashboard cost tile aggregates these.

## 10. Repository structure

| Directory | Contents |
|---|---|
| `api/` | Node 22 TypeScript Functions: HTTP handlers, Timer-triggered ingest, shared libs (`auditChain.ts`, `rateLimit.ts`, `authMiddleware.ts`, `tables.ts`). |
| `web/` | React 18 + Vite SPA, MSAL integration, Fluent UI features, Playwright smoke test. |
| `agents/` | Per-agent system prompts, tool schemas, regression fixtures (`/agents/<name>/prompts/`, `tools.json`, `tests/`). |
| `infra/` | Bicep IaC. `main.bicep` carries `param workload string = 'aegis'`; modules under `infra/modules/` (`functions.bicep`, `swa.bicep`, `storage.bicep`, `keyvault.bicep`, `identities.bicep`, `observability.bicep`). |
| `scripts/` | Operator tooling: `bootstrap-entra.ps1` (app-reg reconciliation), `verify-audit-chain.mjs`, `provision-recipient-hash-pepper.ps1`, `write-audit-chain-boundary.mjs`. |
| `docs/` | This document, `INGEST.md`, `AGENTS.md`, deployment runbook, security notes. |

Forkers retarget a deployment by changing the `workload` parameter in `main.bicep` and the matching display-name in the Entra bootstrap script; no other identifier is hard-coded.
