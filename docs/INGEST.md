# INGEST

How the Aegis ingest plane gets data into the dashboard, audits each run, and degrades gracefully when a tenant lacks an upstream licence.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for cross-cutting concerns (identity model, storage layout, route patterns), and [`AGENTS.md`](AGENTS.md) for the agents that consume the rows this plane produces.

---

## 1. Ingest plane overview

Every external signal Aegis surfaces lands through the same shape: a timer-triggered Azure Function reads upstream (Microsoft Graph, ARM, or a public feed), writes a deterministic projection into Azure Table Storage on the **ops** storage account, and appends one NDJSON line per run to the **audit** blob container. The dashboard reads only from the ops tables — never directly from upstream — so render-time latency is bounded by Azure Storage and the page never blocks on Graph.

```text
                          ┌───────────────────────┐
                          │  Upstream sources     │
                          │  - Microsoft Graph    │
                          │  - ARM (management)   │
                          │  - CISA KEV feed      │
                          │  - Ransomware.live    │
                          └──────────┬────────────┘
                                     │  per-source MI, narrow scope
                                     │  DefaultAzureCredential → bearer
                                     ▼
        ┌───────────────────────────────────────────────────────┐
        │  Timer-triggered Functions (Flex Consumption)         │
        │                                                       │
        │   runSecureScoreIngest      runIncidentsIngest        │
        │   runEntraRiskIngest        runSignInsIngest          │
        │   runUserDormancyIngest     runCaPoliciesIngest       │
        │   runAzureSecureScore       runKevIngest              │
        │   runThreatIntelIngest                                │
        └──────────┬────────────────────────────┬───────────────┘
                   │ writes                     │ appends
                   ▼                            ▼
        ┌──────────────────────┐      ┌──────────────────────┐
        │  ops Storage         │      │  audit Storage       │
        │  Tables              │      │  (WORM in prod)      │
        │  + incidents-detail  │      │  ingest.run.ndjson   │
        │  blobs               │      │  hash-chained        │
        └──────────┬───────────┘      └──────────┬───────────┘
                   │                             │
                   │ api-reader MI               │ verifier
                   ▼                             ▼
        ┌──────────────────────┐      ┌──────────────────────┐
        │  HTTP read API       │      │  verify-audit-chain  │
        │  /api/* endpoints    │      │  script (offline)    │
        └──────────┬───────────┘      └──────────────────────┘
                   ▼
        ┌──────────────────────┐
        │  SPA (Static Web App)│
        └──────────────────────┘
```

Identities are per-source and narrowly scoped:

- **`ingest`** MI carries Microsoft Graph application permissions (one role per vertical, additive).
- **`armIngest`** MI carries subscription-scope `Security Reader` for ARM; holds no Graph permissions.
- **`threatIntel`** MI holds table-scoped Contributor on `RansomwareIntel` plus per-secret Key Vault Secrets User on the API key; holds no Graph and no ARM permissions.
- **`api-reader`** MI is the only identity HTTP handlers run under; it holds Table Reader on ops, Blob Reader on `incidents-detail`, and nothing else.

Cross-data-plane blast radius is bounded by identity separation: a compromise of one MI does not grant access to another plane's data.

---

## 2. Shared patterns

Every ingest Function follows the same template. Source-specific details (cadence, schema, scope) are listed in section 3; this section is the contract every section 3 entry inherits.

| Concern | Pattern |
|---|---|
| Trigger | NCRONTAB Timer, `runOnStartup: false`, `useMonitor: true`. Cadence per source. |
| Singleton | ETag lease on the source's `IngestHealth` row prevents concurrent runs across scale-out instances. Lease window 5 minutes (auto-renewed at 60 s while the handler runs). |
| Auth | `DefaultAzureCredential` → MI token. Audience is `https://graph.microsoft.com/.default`, `https://management.azure.com/.default`, or a per-source key from Key Vault. No client secrets. |
| Idempotency | `InsertOrReplace` on a deterministic `(PartitionKey, RowKey)`. RowKey is the upstream stable identifier (snapshot date, incident ID, user objectId, CVE ID, etc.). |
| Retry policy | 3 attempts. Full-jitter exponential backoff, base 2 s, max 30 s. Retryable on 408/429/500/502/503/504 and network errors. Non-retry on 400/401/403. |
| Throttle handling | `Retry-After` honoured and clamped at `min(header, remainingLease − 5 s, 30 s)`. Identity Protection endpoints do **not** emit `Retry-After`; the shared Graph client falls back to full-jitter exponential backoff keyed on endpoint prefix. |
| Incremental query | Per-source. `$filter` cursor on `lastUpdateDateTime` / `riskLastUpdatedDateTime` / `createdDateTime` with a 2-minute safety overlap where the upstream lacks a `delta` endpoint; daily snapshot for sources where the upstream computes daily. |
| Cursor sanity | Cursor write rejected if `cursorAfter > now + 5 min`; cursor read clamped to `now − 24 h` if the stored value is `> now + 1 h`. Closes the silent-suppression-of-security-signal primitive. |
| Retention | Trim-at-write, env-aware default (`isProd ? 180 : 14` days for time-series sources; per-source caps documented in section 3). Lifecycle policies for detail blobs. |
| Audit emission | Exactly one `ingest.run` NDJSON line per run, appended under `audit/<source>/yyyy/mm/dd/ingest.ndjson`. Forward hash chain per `(source, tenantId)`. |
| Observability | App Insights `<Source>IngestRun` custom event per run; `<Source>IngestRetry` per retry; `<Source>IngestHealthChange` on status transition. |
| Health flag | `IngestHealth` row per `(tenantId, source)` carries `Status`, `LastSuccessAt`, `LastFailureAt`, `ConsecutiveFailureCount`, `LastCursor`, `LastAuditSeq`, `LastLineSha256`. Three consecutive failures flip the tile to `failing`. |

### Manual trigger

Every ingest source has an admin-only HTTP sibling at `POST /api/ingest/<source>/run` (or `/api/admin/<source>/run` for newer sources). Same code path as the Timer; rate-limited at 30/day per tenant. The Timer is the source of truth; manual triggers exist for first-deploy bootstrapping, post-rebaseline refresh, and licence re-probe.

### Read-only stance

A hard deny-list in `bootstrap-entra.ps1` rejects any Graph scope whose value contains `ReadWrite` on the Security or Identity-Protection namespaces. Write paths against upstream APIs are out of scope across the ingest plane; tiles never call upstream at render time.

---

## 3. Per-source ingest

### 3.1 Microsoft Secure Score

Microsoft 365 / Entra ID control-score snapshot.

| Field | Value |
|---|---|
| Source | `graph.security.secureScores` |
| Endpoint | `GET https://graph.microsoft.com/v1.0/security/secureScores?$top=1` |
| Cadence | Daily at 03:00 UTC ± 5-minute deterministic jitter |
| MI | `ingest` |
| Graph permission | `SecurityEvents.Read.All` |
| Storage | Table `SecureScore` on the ops account |
| Idempotency key | `PartitionKey = "snapshot"`, `RowKey = yyyy-MM-dd` (UTC date of Graph's `createdDateTime`) |
| Retention | 400 snapshots (~13 months); trim-at-write |
| Notable constraints | Microsoft recomputes Secure Score daily; polling more often returns duplicates. A backfill endpoint loads up to 90 days on first deploy. Empty-result runs emit `status: no_data` and write no row. |

**Read API:**

- `GET /api/secure-score/latest` — latest snapshot plus health pass-through. Server-computed `percentage` (1 d.p.) prevents per-client drift. `Cache-Control: private, max-age=30`.
- `GET /api/secure-score/trend?days=<n>` — up to 400 days for the sparkline; `Cache-Control: private, max-age=1800`. `days` validated as integer in `[1, 400]` (out-of-range returns `400 bad_request`, no implicit clamping).

---

### 3.2 Defender for Cloud Secure Score

Azure resource posture score (separate from the M365 score above).

| Field | Value |
|---|---|
| Source | `arm.defenderForCloud.secureScores` |
| Endpoint | `GET https://management.azure.com/subscriptions/{id}/providers/Microsoft.Security/secureScores?api-version=2020-01-01` |
| Cadence | Daily at 02:30 UTC |
| MI | `armIngest` (separate from the Graph `ingest` MI) |
| Authorisation | Built-in Azure role **`Security Reader`** (`39bc4728-0917-49c7-9d2c-d95423bc2eb4`) at subscription scope |
| Storage | Table `AzureSecureScores` on the ops account |
| Idempotency key | `PartitionKey = <tenantId>`, `RowKey = <subscriptionId>_<yyyy-MM-dd>` |
| Retention | 90 days; trim-at-write |
| Notable constraints | Single subscription in v1 (sourced from `AZURE_SUBSCRIPTION_ID`). ARM token audience is `https://management.azure.com/.default`. Per-control breakdown (`secureScoreControls`) is not ingested in v1. |

**Read API:** `GET /api/azure-secure-score/latest` and `/trend?days=<n>` — same shape as Microsoft Secure Score, distinguished by tile title.

---

### 3.3 Defender XDR Incidents

Incident-level roll-up from Microsoft Defender XDR via Graph.

| Field | Value |
|---|---|
| Source | `graph.security.incidents` |
| Endpoint | `GET https://graph.microsoft.com/v1.0/security/incidents?$filter=lastUpdateDateTime gt {cursor}&$orderby=lastUpdateDateTime asc&$expand=alerts&$top=50` |
| Cadence | Every 15 minutes |
| MI | `ingest` |
| Graph permission | `SecurityIncident.Read.All` |
| Storage | Table `Incidents` + blob container `incidents-detail` on the ops account |
| Idempotency key | `PartitionKey = <tenantId>`, `RowKey = <incidentId>` |
| Retention | 180 days prod / 14 days dev for rows; same window for detail blobs via Azure Storage lifecycle management |
| Notable constraints | No `delta` endpoint on v1.0; cursor on `lastUpdateDateTime` with 2-minute safety overlap. The full Graph response per incident (including `alerts[].evidence[]`) lands in a detail blob at `incidents-detail/<yyyy>/<mm>/<dd>/<incidentId>.json` because `alerts[]` routinely exceeds Azure Table's 64 KB per-property cap. Incident IDs must match `^[A-Za-z0-9._-]{1,128}$`; non-matching IDs are rejected, not truncated. |

**Row vs blob split:** the Table row carries the filter/sort/render summary (status, severity, classification, priority, displayName truncated to 256, dates, alert count, web URL). The detail blob is the verbatim Graph response. Both stores are populated in the same handler; an audit-line counter (`detailBlobsWritten` vs `incidentsIngested`) catches writer-side anomalies. Detail-blob deletion flows exclusively through the lifecycle-management policy; the ingest MI never calls delete.

**Read API:**

- `GET /api/incidents/summary` — counts by severity / status / classification plus most-recent incident.
- `GET /api/incidents?<filters>&cursor=<opaque>` — paginated list with opaque cursors carrying a JCS-canonicalised filter fingerprint (`severity`, `status`, `classification`, `since`, `includeRedirected`, `limit`).
- `GET /api/incidents/{id}` — merges Table row with the most recent detail blob. Returns a `detailBlobMissingClassification` of `lifecycle-trim` / `lookup-failure` / `unexplained` when the blob is absent so the UI can distinguish expected ageing from an integrity anomaly.

---

### 3.4 Entra ID risky users

Identity Protection signal; gated on Entra ID P2.

| Field | Value |
|---|---|
| Source | `graph.security.riskyUsers` |
| Endpoint | `GET https://graph.microsoft.com/v1.0/identityProtection/riskyUsers?$filter=riskLastUpdatedDateTime ge {cursor}&$top=500` |
| Cadence | Every 4 hours |
| MI | `ingest` |
| Graph permissions | `IdentityRiskyUser.Read.All` (data), `Organization.Read.All` (P2 licence probe via `assignedPlans`) |
| Storage | Table `EntraRisk` on the ops account |
| Idempotency key | `PartitionKey = <tenantId>`, `RowKey = <userObjectId>` |
| Retention | 180 days prod / 14 days dev; trim-at-write |
| Notable constraints | Single store — payload fits comfortably under Azure Table's per-property cap. The 1 req/s per-tenant Identity Protection bucket is shared across every IdP endpoint and every app in the tenant; the handler issues sequential page fetches with at least one wall-clock second between requests. 429 responses do **not** carry `Retry-After`; the Graph client falls back to full-jitter exponential backoff for IdP-prefixed URLs. `Prefer: include-unknown-enum-members` is set so future Microsoft enum additions surface as observability (`EntraRiskUnknownEnum` events) rather than silent narrowing. `isDeleted=true` rows are kept; `isProcessing=true` rows are written with a `Processing` column so the UI can render a "recalculating" badge. |

**Licence-gate handling:** see section 6.

**Read API:**

- `GET /api/risky-users/summary` — counts by `riskLevel` / `riskState` plus most-recent user and health pass-through (including `licence_required`).
- `GET /api/risky-users/list?<filters>&cursor=<opaque>` — paginated list. Filters: `riskLevel`, `riskState`, `includeDeleted`, `includeRemediated`. `includeDeleted` defaults to `false` (admin opt-in).

The list endpoint is named explicitly (`/list`, not `/`) so a future `/{id}` endpoint cannot collide with `/summary` via Functions route precedence.

---

### 3.5 Identity & sign-in observability

Four related Entra surfaces sharing the identity-vertical pattern. Each phase ships independently behind an admin toggle.

| Source | Phase | Endpoint | Cadence | Graph permission |
|---|---|---|---|---|
| `graph.users.dormancy` | B | `GET /v1.0/users?$select=id,displayName,userPrincipalName,accountEnabled,signInActivity` | Daily, 01:30 UTC | `User.Read.All` + `AuditLog.Read.All` (the `signInActivity` property requires `AuditLog.Read.All` even though the parent `/users` endpoint does not — verified per-property against Microsoft Learn before the scope shipped) |
| `graph.auditLogs.signIns` | C | `GET /v1.0/auditLogs/signIns?$filter=createdDateTime gt {cursor}&$orderby=createdDateTime asc` | Every 15 minutes | `AuditLog.Read.All` |
| `graph.identity.conditionalAccess.policies` | D | `GET /v1.0/identity/conditionalAccess/policies` | Hourly | `Policy.Read.All` |
| (read-only roll-up — no ingest) | E | `GET /v1.0/servicePrincipals` | On-demand admin read | `Application.Read.All` |

**Storage:**

- **`UserDormancy`** — `PartitionKey = <tenantId>`, `RowKey = <userObjectId>`. Snapshot-replace per run; users no longer in the directory are deleted via end-of-run `delete-not-found` reconciliation. `IsDormant` is computed at read time from the operator-configured `dormancy-policy.thresholdDays` so threshold changes do not require re-ingest.
- **`SignIns`** — `PartitionKey = <tenantId>`, `RowKey = <signInId>`. Cursor on `createdDateTime` with the 2-minute overlap pattern. The handler stores `OutOfArea` as a precomputed bool against the operator's `geo-fence.allowedCountries` allowlist. When an admin changes the allowlist, a one-shot reconciliation recomputes `OutOfArea` across existing rows. Retention 30 days prod / 7 days dev — sign-in volume makes longer windows expensive at scale.
- **`ConditionalAccessPolicies`** — `PartitionKey = <tenantId>`, `RowKey = <policyId>`. Snapshot-replace per run; `Conditions`, `GrantControls`, `SessionControls` are stored JCS-canonicalised so diff detection across runs emits `ca.policy.changed` audit lines when state, modification date, or any hashed condition changes.

**Notable constraints:**

- `/auditLogs/signIns` lives on the Reporting throttle bucket — distinct from the IdP 1 req/s bucket — so it does not contend with the EntraRisk ingest.
- `signInActivity` returns `null` on tenants without Entra ID P1; the IngestHealth `licence_required` sticky status (section 6) disambiguates "never signed in" from "no licence".
- `User.Read.All` is sufficient for the `/users` resource but **not** for the `signInActivity` property. Each `$select` / `$filter` property used by an ingest consumer is cross-checked against Microsoft Learn's per-property permissions table before the scope ships.

---

### 3.6 Stack inventory

Operator-declared software and hardware inventory. The spine for KEV cross-reference. No external API.

| Field | Value |
|---|---|
| Source | n/a (operator-curated) |
| Endpoint | n/a |
| Cadence | n/a — driven by admin CRUD |
| MI | `ingest` writes via `patchSettings.ts`-style admin handlers; `api-reader` reads |
| Storage | Table `StackItems` on the ops account |
| Idempotency key | `PartitionKey = <tenantId>`, `RowKey = <UUID v4>` (stable across version edits) |
| Retention | None — operator-managed; per-tenant cap 100 rows |
| Notable constraints | `(vendor, product)` are stored verbatim as the operator typed them. A bundled `stackCatalog.json` (~200 curated pairs) provides datalist typeahead but does not enforce a hard allowlist. A non-canonical chip warns the operator that KEV matching may not find a free-form entry. Changes emit `StackItemChange` App Insights events (operator config, not on the hash-chained audit blob). |

Row schema: `vendor` / `product` (≤ 64 chars each, case-preserved), `category` enum (`os` \| `application` \| `network-device` \| `library` \| `service` \| `other`), `environment` enum (`production` \| `staging` \| `development` \| `unknown`), optional `version` (≤ 32), `notes` (≤ 256), `tags[]` (≤ 5 × ≤ 24 chars), plus system-managed `addedAt` / `addedBy` / `updatedAt` / `updatedBy`.

**Read API:**

- `GET /api/stack/catalog` — bundled `stackCatalog.json`; cached `private, max-age=3600`.
- `GET /api/stack/items` — list (≤ 100 rows; no pagination at v1). Merges KEV matches and suppression status in a single response.
- `POST` / `PATCH` / `DELETE /api/stack/items[/{id}]` — admin-only mutations.

---

### 3.7 CISA KEV catalogue

The CISA Known Exploited Vulnerabilities catalogue, cross-referenced against the operator's stack inventory.

| Field | Value |
|---|---|
| Source | `cisa.kev` |
| Endpoint | `GET https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json` (override via `KEV_FEED_URL` for sovereign-cloud or fixture-driven tests) |
| Cadence | Daily at 02:00 UTC |
| MI | `ingest` |
| Authorisation | None — public feed, HTTPS-only |
| Storage | Table `KEV` on the ops account — single global partition (`PartitionKey = "kev"`); identical across tenants, no per-tenant duplication |
| Idempotency key | `PartitionKey = "kev"`, `RowKey = <cveID>` (validated against `^CVE-\d{4}-\d{4,7}$`) |
| Retention | None — `Removed = true` rows are kept indefinitely as a forensic record |
| Notable constraints | 50 MB response-body cap; per-field truncation caps (vendor/product ≤ 256, name ≤ 512, prose ≤ 4096). Read-time match against `StackItems` is case-insensitive `(vendor, product)` equality plus the bidirectional contiguous-token product matcher. A CVE missing from the most recent feed gets `Removed = true` rather than being deleted — CISA reversals are upserted back to `Removed = false`. |

**Stack-cross-reference shape:** the match is computed inline in `GET /api/stack/items`. Per match the response carries the CVE ID, due date, required action, ransomware-campaign flag, and the effective match status from `KevSuppressions` (see section 5).

**Read API:**

- `GET /api/kev/summary` — counts by status, distinct matched items, `dueThisWeek`.
- `PATCH` / `DELETE /api/kev/suppressions/{stackItemId}/{cveID}` — admin-only workflow transitions.

---

### 3.8 Ransomware.live PRO

External threat-intel feed; victim disclosures and press coverage filtered by the operator's country.

| Field | Value |
|---|---|
| Source | `external.ransomware.live` |
| Endpoints | `GET https://api-pro.ransomware.live/victims/?country={CC}&year={YYYY}&month={MM}` and `GET https://api-pro.ransomware.live/press/all?country={CC}&year={YYYY}&month={MM}` |
| Cadence | Hourly at minute 0 |
| MI | `threatIntel` (dedicated; holds no Graph and no ARM permissions) |
| Authorisation | API key in header `X-API-KEY`; key stored as Key Vault secret `ransomware-live-api-key` with per-secret ABAC scoping |
| Storage | Table `RansomwareIntel` on the ops account |
| Idempotency key | `PartitionKey = <tenantId>`; `RowKey = "victim.<base64(post_title@group_name)>"` or `"press.<sha256(url)>"` |
| Retention | 90 days prod / 14 days dev; trim-at-write |
| Notable constraints | Outbound request payload is `(country, year, month)` only — no tenant identifier, no customer data leaves the tenant. The 500K req/month per-key budget bounds ~347 tenants at this cadence. Circuit-breaker mirrors the agent runtime: `closed` / `open` / `half_open` with exponential backoff capped at 4 hours; trip threshold is 5 consecutive failures. **Key rotation** is operator-driven via the SPA admin page (or `provision-ransomware-live-api-key.ps1`) — the next ingest run picks up the new secret value via the standard Key Vault reference resolution; no Function App restart required. |

**AI-plane boundary:** v1 does **not** expose this surface to any agent. The brief / posture / incidents-analysis prompt builders explicitly exclude `RansomwareIntel`. A future revision may opt-in posture-agent under the existing prompt-injection defence and `sourcesUsed[]` whitelist; until then the rows are UI-only.

**Read API:**

- `GET /api/ransomware-intel/summary` — tile counts and trend arrow vs prior period.
- `GET /api/ransomware-intel/list` — drilldown list, sortable by group, attack date, sector, press date.

The tile auto-hides when the operator has not supplied the API key (IngestHealth status `not_configured`).

---

## 4. Audit chain

Every ingest run appends exactly one NDJSON line to the audit blob at `audit/<source>/yyyy/mm/dd/ingest.ndjson` on the audit storage account. In prod the container is WORM-protected with an immutability policy.

Each line carries a forward SHA-256 chain:

- `prevLineSha256` — the `lineSha256` of the immediately preceding line on the same `(source, tenantId)` chain.
- `lineSha256` — SHA-256 of this line's canonical form (JCS-canonicalised, with the `lineSha256` field itself excluded from the hash input).

The first line on any chain is a `audit.chain.start` boundary marker written by `scripts/write-audit-chain-boundary.mjs` when the source is first enabled. Its `prevLineSha256` is a deployment-derived genesis sentinel; subsequent lines hash forward.

A `seq` counter (monotonic per `(source, tenantId)`) is incremented atomically against the `IngestHealth` row's ETag and detects gaps that the hash chain alone could not surface (e.g. a missing append from a writer crash).

**Common audit line shape (v2):**

```json
{
  "schemaVersion": 2,
  "eventType": "ingest.run",
  "source": "graph.security.incidents",
  "seq": 1453,
  "runId": "3f7d…",
  "tenantId": "764279e8-…",
  "startedAt": "2026-04-18T19:45:00.000Z",
  "endedAt":   "2026-04-18T19:45:03.421Z",
  "status": "success",
  "cursorBefore": "2026-04-18T19:28:00.000Z",
  "cursorAfter":  "2026-04-18T19:43:00.000Z",
  "incidentsIngested": 3,
  "detailBlobsWritten": 3,
  "graphAttempts": 1,
  "callerPrincipalMiClientId": "<mi-client-id>",
  "prevLineSha256": "a3f6…",
  "lineSha256":     "7c29…"
}
```

Source-specific counters extend the base shape: `riskyUsersIngested` / `licenceState` on `graph.security.riskyUsers`; `addedThisRun` / `removedThisRun` / `catalogVersion` on `cisa.kev`; `outOfAreaCount` on `graph.auditLogs.signIns`.

**Verifier.** `scripts/verify-audit-chain.mjs` walks the chain for a given `(source, tenantId)`, recomputes each line's `lineSha256` from its canonical form, asserts `prevLineSha256` matches the preceding line's `lineSha256`, and asserts `seq` is monotonic with no gaps. The verifier reads `IngestHealth.LastAuditSeq` and `LastLineSha256` for the chain head; it does not require live Graph access.

```bash
node scripts/verify-audit-chain.mjs \
  --source graph.security.incidents \
  --tenant 764279e8-66e9-49b4-901f-a7592435ae1d
```

---

## 5. KEV match workflow

Each `(stackItem, cveID)` match has an effective status from a small fixed set, defaulting to `open` when no row exists in the `KevSuppressions` table.

| Status | Meaning |
|---|---|
| `open` | Operator has not decided yet; appears in the default queue. |
| `acknowledged` | Operator is aware and deferring; remains in the queue with a badge. |
| `risk_accepted` | Operator has accepted the risk; appears only on the explicit cohort filter. |
| `remediated` | Operator has patched or mitigated; appears only on the explicit cohort filter. |
| `not_applicable` | Operator confirms the match is wrong (e.g. wrong version); appears only on the explicit cohort filter. |

**Storage:** `KevSuppressions` table, `PartitionKey = <tenantId>`, `RowKey = <stackItemId>_<cveID>`. Optional `ExpiresAt` reverts the effective status to `open` at read time without touching storage; physical deletion of expired rows is deferred.

**Read merging:** the match is computed inline in `GET /api/stack/items` — three reads per call (StackItems + KEV + KevSuppressions) — and the response carries the effective status, notes, expiry, and audit fields per match.

**Baseline mode.** Two modes are supported for the initial state of suppressions on a freshly-deployed tenant:

- **`historic`** (default) — every existing KEV match starts at `open`; the operator works the full backlog.
- **`from-deploy`** — every match that existed at deploy time is pre-acknowledged in a one-shot reconciliation; only matches added by KEV after the deploy date land in the `open` queue.

The mode is captured in the `kev-baseline` TenantSettings row and applied by the `kevBaseline.ts` orchestrator. The choice is single-shot per deploy; switching modes later is an operator-explicit action.

**Audit.** Each PATCH emits an `AIEVENT KevSuppressionChange` carrying `from`, `to`, `principal`, `stackItemId`, `cveID`, and optional `expiresAt`. This is operator-config audit (App Insights custom events), not the hash-chained audit blob — consistent with `TenantSettingsChange` and `StackItemChange`.

---

## 6. Licence-gated graceful degrade

Some upstream sources require a specific tenant licence. When the tenant lacks the licence the ingest skips, the tile renders an explicit upgrade prompt, and no false data is surfaced.

| Source | Required licence | Detection |
|---|---|---|
| `graph.security.riskyUsers` | Entra ID P2 | First run probes via `GET /v1.0/organization?$select=assignedPlans`; presence of plan GUID `eec0eb4f-6444-4f95-aba0-50c24d67f998` (`AAD_PREMIUM_P2`) with `capabilityStatus: "Enabled"` confirms P2. A 403 with `error.code` matching `/licence\|license\|upgrade/i` also classifies the run as `licence_required`. |
| `graph.users.dormancy` | Entra ID P1 (for `signInActivity`) | `signInActivity = null` for every user is ambiguous; the same `assignedPlans` probe disambiguates from "no one has signed in". |

**`IngestHealth.Status` values** extend the base `healthy` / `degrading` / `failing` taxonomy with:

| Value | Meaning | Behaviour |
|---|---|---|
| `licence_required` | Tenant lacks the upstream licence. | Tile renders an "upgrade to enable" empty state. No `ConsecutiveFailureCount` increment. **Sticky** — the `Status = f(ConsecutiveFailureCount)` derivation is gated behind `Status != "licence_required"`, so the next no-data Timer fire on a P1 tenant does not re-derive `Status = "healthy"`. Lift only via an admin re-probe. |
| `no_data` | Probe confirms the licence is present; the upstream simply has nothing to return. | Tile renders a neutral "no activity" empty state. |
| `not_configured` | Source-specific precondition missing (e.g. Ransomware.live API key not provisioned). | Tile auto-hides. |

**Ingest behaviour under `licence_required`:** the handler short-circuits with no upstream call, no cursor advance, no audit line beyond the licence-probe-result line itself. App Insights records `EntraRiskLicenceProbe` (or the equivalent per source) so the gate transition is observable.

**Read API behaviour:** summary endpoints pass `health.status` through verbatim, including `licence_required`. The SPA's empty-state component branches on the value:

```text
Entra Risk
──────────────────────────
  Entra ID P2 required

  Upgrade to unlock sign-in
  risk detections and risky
  user surfacing.

  [ Learn more → ]
```

**Re-probe.** Subsequent Timer fires trust the sticky `Status`; only the admin manual-trigger endpoint forces a fresh probe. This prevents both noisy daily 403 logs and the silent recovery problem where a stuck "healthy" classification would mask a genuine licence regression.

---

## Cross-references

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — identity model, storage layout, route patterns, deployment topology.
- [`AGENTS.md`](AGENTS.md) — agent consumers of the data this plane produces, including the source allowlist and prompt-injection defence.
- `scripts/verify-audit-chain.mjs` — offline verifier for the audit hash chain.
- `scripts/write-audit-chain-boundary.mjs` — chain boundary-marker writer for a new ingest source.
- `infra/modules/storage-ops.bicep` — Table definitions and per-table RBAC.
- `infra/modules/identities.bicep` — managed-identity definitions and per-source scoping.
