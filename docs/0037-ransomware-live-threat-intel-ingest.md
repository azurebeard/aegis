# ADR-0037 — Ransomware.live PRO threat-intel ingest

**Status:** Proposed
**Date:** 2026-06-25
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Aegis ingests internal posture signal (Microsoft Secure Score / Defender XDR Incidents / Entra Risk / Sign-Ins / Conditional Access / Defender for Cloud Secure Score / KEV) but currently has **no external threat-intel surface** that contextualises that posture against the active ransomware landscape. Operators reading the dashboard see "you have N risky users" without an answer to "are the groups currently active in your sector likely to weaponise this".

[Ransomware.live](https://www.ransomware.live/) provides an authenticated REST API ([api-pro.ransomware.live](https://api-pro.ransomware.live)) tracking ransomware-group victim disclosures (leak-site posts), press coverage of cyberattacks, IOCs, ransom notes, YARA rules, and SEC Form 8-K filings. The operator (ben@azurebeard.co.uk) holds a free PRO key (500K req/month per key — generous for the polling cadences below). Full API reference captured at [`docs/references/ransomware-live-api-pro.md`](references/ransomware-live-api-pro.md).

The natural integration shape is **a new ingest source** that fetches victim disclosures + press filtered by the customer's country + sector, persists per-tenant rows in a new `RansomwareIntel` Table, and surfaces a dashboard tile + drilldown showing recent victims, active groups, and the customer's exposure context. This sits alongside the existing posture verticals — it does NOT replace or duplicate any of them.

Scope bounds:

- **Read-only external API.** No write-back to ransomware.live; one outbound request per ingest cadence; rate-limit budget bounded by ADR §6 (well within the 500K/month per-key cap).
- **Country + sector filter at the API.** The `/victims/` endpoint accepts `country` + `sector` filters at request time so we don't pull the global feed and filter client-side. Each tenant's relevant cadence is one (country, sector) tuple; multi-region tenants stay v2.
- **Public threat-intel only.** No customer-side data leaves the tenant — the request payload is `(country, sector)` strings only. No tenant ID, no email, no IP. The ransomware.live operator sees aggregate query patterns at most.
- **No agent-plane consumption (default).** Score data does NOT enter the brief / posture / incidents-analysis prompt context BY DEFAULT. A future ADR may opt-in a single agent (most likely posture-agent) to consume the intel surface as adversarial input, with the same four-layer prompt-injection defence as `brief-agent` per ADR-0020 §4. Until then, treat this as a posture surface, not narrative input.
- **No PII surface in the response.** Victim names are organisations (companies, hospitals, public sector). Group names are public threat-actor identifiers (LockBit, Conti, BlackBasta, etc.). Press is HudsonRock-enriched but bounded to organisations + URLs. Operator review confirmed at scoping.
- **Single API key in v1.** Stored as a KV secret named `ransomware-live-api-key`, same pattern as the recipient-hash-pepper + report-share-signing-key (per-secret ABAC, MI Reader on the consuming MI). Operator-rotated; bootstrap-entra.ps1 verifies presence at provision time.
- **Plain-text-only invariant.** The HTML rendered in tiles / drilldown drops any HTML/Markdown that surfaces from upstream — the API returns text fields (group names, victim names, sector strings) that have varied content discipline at source. All rendered text is `escapeHtml()`-wrapped at the React component layer, mirroring the existing ADR-0020 §5 invariant.

The decisions to settle:

1. **Ingest cadence.** How frequently do we poll, and which endpoints?
2. **Storage schema.** What rows do we persist and at what granularity?
3. **RBAC + identity.** Which MI consumes the API + KV secret, and which existing MI surface does it parallel?
4. **Dashboard surface.** Single tile? Multiple tiles? A new dedicated page?
5. **AI-plane boundary.** Is this surface eligible for posture-agent consumption, or strictly UI-only?
6. **Failure modes.** API down / rate-limited / key invalid — what's the tile state? What audit-chain key?
7. **Retention.** How long do we keep ingested rows; is this a snapshot-replace or append-with-retention table?

---

## Decision

### 1. Ingest cadence + endpoints

Two complementary fetches, both run by a single 1-hour Timer at `0 0 * * * *` UTC:

| Endpoint | Filter | Purpose | Rate-limit impact |
|---|---|---|---|
| `GET /victims/?country={CC}&year={YYYY}&month={MM}` | Country = tenant operator setting; year + month = current UTC | Per-month rolling victim feed for the operator's country (sector unset — it's filtered client-side post-fetch because most SMB tenants want broader visibility than their own sector) | ~720 req/month (1/hr × 24h × 30d) per tenant |
| `GET /press/all?country={CC}&year={YYYY}&month={MM}` | Same | Press coverage for context — disambiguates "this was a real-world incident", not just "appeared on a leak site" | ~720 req/month per tenant |

Combined ~1,440 req/month per tenant. The 500K/month per-key budget supports ~347 tenants concurrently on this cadence — comfortable buffer.

**Why hourly, not 15-min:** the underlying signal is human-curated leak-site monitoring. Ransomware.live's own dashboard updates roughly every 30-60 minutes. Polling more often than the source data refreshes wastes both budget + Function execution time.

**Why per-month, not per-week:** the API has no `?week=` filter; week filtering would require pulling the full month and slicing client-side. Per-month requests + client-side date sorting gives the same dashboard UX with one round-trip.

### 2. Storage schema

Single Table `RansomwareIntel` with two RowKey families distinguished by prefix:

| RowKey pattern | Source | Fields |
|---|---|---|
| `victim.<id>` where `<id>` = base64(post_title@group_name) | `/victims/` | `Victim` (organisation name), `Group` (e.g. "lockbit3"), `AttackDate` (ISO), `DiscoveredDate` (ISO), `Country` (ISO 3166-1 alpha-2), `Sector`, `Activity` (free text from feed), `Website`, `Permalink`, `IngestedAt` |
| `press.<sha256(url)>` | `/press/all` | `Title`, `Url`, `PublishedAt`, `Source`, `Country`, `Summary` (HudsonRock-enriched), `IngestedAt` |

PartitionKey = `tenantId` (mirrors the existing per-tenant pattern from `Incidents` / `EntraRisk` / `SignIns`).

**Why one table, not two:** the consumer (dashboard tile + drilldown) blends victim + press rows in chronological order for "what's happened in your country this week?". Two tables would force the SPA to do a cross-table merge. One table with a RowKey prefix keeps the query single-partition + sorted-by-row-key cheap.

**Why per-month-aware deduplication:** the same victim/press row may appear in multiple monthly fetches if the source is post-dated. RowKey is content-derived (base64 of stable identifiers, sha256 of URL) so upserts naturally dedupe. `IngestedAt` is mutated on every fetch — supports a "still active in feed" signal without growing the row.

### 3. Identity + RBAC

New dedicated MI `id-aegis-threatintel-<env>-<region>` (mirrors the `arm-ingest` MI split pattern from ADR-0036 v1.2). Bounds:

- **Table-scoped Contributor** on `RansomwareIntel` + `IngestHealth` (writes its own freshness row). No other table scopes.
- **Key Vault Secrets User** (ABAC-scoped) on the single `ransomware-live-api-key` secret. Same per-secret ABAC pattern as the recipient-hash-pepper + report-share-signing-key per SEC-L-L12-04.
- **No Graph scopes.** This MI never touches the Microsoft Graph deny-list surface.
- **No subscription-scope role.** Defender-for-Cloud-style ARM access is not relevant.

Separation rationale: the existing `ingest` MI is Graph-only; the existing `arm-ingest` MI is Defender-for-Cloud-only; the existing `agent` MI is Foundry-only; the existing `host` MI is Function-host-only; the existing `api-reader` MI is the read-path identity. None of them naturally extends to a third-party HTTP API with a long-lived shared API key — that's a different trust boundary.

### 4. Dashboard surface

**One tile, one drilldown.** Avoid creating a "ransomware page" that's separate from the security narrative; integrate it.

- **Tile** on the main dashboard (`/`): hero count = "victims in your country this period", secondary line = "N press articles", trend arrow vs prior period. Same `<RefreshNowButton>` pattern as the other ingest tiles. Tile title: "Ransomware activity ({country code})".
- **Drilldown** at `/ransomware`: split-list view — left column victims (sortable by group, attack date, sector), right column press (sortable by date, source). Each row links out to the source permalink in a new tab with `rel="noopener noreferrer"`.
- **Admin section** at `/admin → Ransomware intel`: country selector, sector filter (optional — feeds the post-fetch client-side filter), refresh-cadence display, "configure API key" link to the operator runbook.
- **`/admin/diagnostics`**: extend with a `threat-intel` source tile (7th source after secureScore / incidents / entraRisk / signIns / conditionalAccessPolicies / azureSecureScores / userDormancy / kev).

No tile-visibility toggle in v1 — the tile is auto-hidden when the operator hasn't set `ransomware-live-api-key` in KV (sticky `not_configured` state on `IngestHealth`).

### 5. AI-plane boundary

**v1: no agent consumption.** Threat-intel rows do NOT enter the brief / posture / incidents-analysis prompt context.

**v2 forward-track (separate ADR):** posture-agent MAY consume the intel surface as adversarial input. Gate criteria for v2 ADR:

1. Operator request for narrative context ("how does my posture look relative to active groups in my sector?").
2. WS10 review of the ADR-0020 §4 four-layer prompt-injection defence applied to ransomware.live response payloads (which contain group-controlled strings on the leak-site — adversarial-input class data).
3. Source-fabrication guard (`sourcesUsed[]` whitelist check) extended to cover the new source.

Until then: posture-agent's prompt builder explicitly excludes the new Table from its source list.

### 6. Failure modes + audit chain

New audit-chain source: `external.ransomware.live` (ADR-0015 pattern).

| Failure | IngestHealth status | Tile state | Audit-line event |
|---|---|---|---|
| KV secret unavailable | `not_configured` (sticky) | Tile hidden | `ingest.run.skipped` (reason: `secret_unavailable`) |
| API returns 401 / 403 | `auth_failed` | "Authentication failed — check the API key" | `ingest.run.error` (reason: `auth_failed`) |
| API returns 429 | `rate_limited` | "Throttled — next attempt in N minutes" | `ingest.run.error` (reason: `rate_limited`); next-attempt scheduled exponential backoff capped at 4h |
| API 5xx / network error | `transient_error` | "Temporarily unavailable" | `ingest.run.error` (reason: `upstream_error`); transient-error counter incremented; circuit opens after 5 consecutive failures (1h cool-down) |
| Response schema unexpected | `schema_drift` | "Upstream schema changed — operator review required" | `ingest.run.error` (reason: `schema_drift`); details captured for operator triage |
| Empty response (legitimate zero-victim month) | `healthy` | "0 victims this period" | `ingest.run.success` (count = 0) |

Circuit-breaker semantics mirror `runAgent.ts` (ADR-0019 §6) — `closed | open | half_open` with exponential backoff, half-open trial probe after cool-down. The mirror is intentional: external API consumers + LLM consumers face similar transient-failure shapes.

### 7. Retention

**90 days, lifecycle-managed.** Per-row `IngestedAt` is the cutoff anchor; rows older than `retentionDays` (env-aware sentinel-0: 14d dev / 90d prod) are deleted on each successful ingest run (mirrors the ADR-0011 §6 pattern).

90 days is enough to:

- Compare current vs prior period at the tile-level (28d / 30d / 60d windows).
- Catch a post-dated victim disclosure (sometimes leak-site posts predate the announcement by weeks).
- Drop rows that have aged out of the upstream API's monthly query window (which only ever returns the queried month).

Audit-chain rows (NDJSON in audit blob) have their own lifecycle policy (ADR-0006) — that surface is unaffected.

---

## Audit chain extension

Extends ADR-0015 with a new chain key:

- `external.ransomware.live` — covers all `/victims/` + `/press/all` fetches on a single chain so a single `verify-audit-chain --source external.ransomware.live --tenant <id>` walk verifies end-to-end. `runId` per ingest run; one `ingest.run.{success,error,skipped}` line per Timer fire.

No new line schema needed — the existing v2 schema (ADR-0015) carries everything (`source`, `runId`, `tenantId`, `prevLineSha256`, `lineSha256`, `eventType`, `status`, `error.kind`, `count`).

`scripts/verify-audit-chain.mjs:filenameForSource` extended to map `external.ransomware.live` → `ingest.ndjson` (same file as the other ingest sources — single ingest chain file).

---

## Privacy + plain-text-only invariant

- **No customer data leaves the tenant.** Outbound request payload is `(country: string, year: number, month: string)` only. The operator's API key authenticates the request (`X-API-KEY` header); no identifying claims are added.
- **No tracking-pixel exposure.** Response payloads are JSON; the SPA tile + drilldown rendering does not embed any third-party resource. Permalink links to the source go via `<a target="_blank" rel="noopener noreferrer">` — opens a new tab without exposing the SPA's referrer or sharing window state.
- **No PII in storage.** Confirmed at scoping — the API returns organisation names + threat-actor identifiers + URLs + free-text "activity" fields. No personal data. Counted as "general business risk" data under UK GDPR Art. 6(1)(f) legitimate interest balancing test.
- **Plain-text-only rendering.** All response fields rendered in the SPA flow through React's default text-escape — no `dangerouslySetInnerHTML` on any field. If a future API change emits HTML/Markdown in a field, it's surfaced as escaped text, not rendered. Mirrors the ADR-0020 §5 invariant for agent output.

---

## Bicep + infra deliverables

- **New identity** in `infra/modules/identities.bicep`: `id-aegis-threatintel-<env>-<region>`. Outputs `threatIntelMiPrincipalId / threatIntelMiClientId`.
- **`infra/modules/storage-ops.bicep`** extensions: new table `RansomwareIntel`; new role-assignment block: `threatIntel` MI gets Storage Table Data Contributor on `RansomwareIntel` + `IngestHealth`; `api-reader` MI gets Storage Table Data Reader on `RansomwareIntel` (read-path access from the dashboard).
- **`infra/modules/keyvault.bicep`** extensions: `threatIntel` MI principal ID threaded through; new per-secret ABAC role assignment on the `ransomware-live-api-key` secret (Key Vault Secrets User scoped to single secret name via ABAC condition — mirrors SEC-L-L12-04 pattern).
- **`infra/modules/functions.bicep`** extensions: `threatIntel` MI bound to the Function App; new app settings `THREAT_INTEL_RANSOMWARE_LIVE_KV_SECRET_NAME` (default `ransomware-live-api-key`), `THREAT_INTEL_TIMER_CRON` (default `0 0 * * * *`), `THREAT_INTEL_RETENTION_DAYS` (env-aware sentinel-0 default).
- **`infra/main.bicep`** extensions: top-level `ransomwareLiveSecretName` parameter (single source of truth for the secret name, threaded to KV + functions); top-level `threatIntelRetentionDays` parameter (mirror of `incidentsRetentionDays` pattern).
- **`scripts/provision-ransomware-live-api-key.ps1`**: new operator script mirroring `provision-recipient-hash-pepper.ps1` — prompts for the API key, writes it to KV, restarts the FA. Postprovision hook does NOT auto-call this script (the operator must supply the key out-of-band); the runbook documents the call.

---

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/ingest/ransomware-intel/run` | admin (Bearer JWT, `admin` role) | Manual trigger — same 30/day per-tenant rate limit as other admin-run endpoints |
| `GET` | `/api/ransomware-intel/summary` | reader | Tile data: counts + trend |
| `GET` | `/api/ransomware-intel/list` | reader | Drilldown: sortable + filterable list |

Read endpoints follow the existing `cache-control: no-store` policy from the 2026-06-25 cache-control sweep.

---

## Out of scope (v1)

- **Multi-subscription / multi-country tenants.** Single (country, sector?) tuple per tenant in v1; multi-region operators get one of the listed countries until v2.
- **IOC ingest.** `/iocs/{group}` is not consumed in v1. Future work: per-group IOC enrichment as a posture-page widget, gated by operator request (the IOC volumes are large and the dashboard value-per-byte is uncertain).
- **YARA rule ingest.** `/yara` not consumed. Aegis doesn't run a YARA engine; surfacing rules without a matching engine is operator confusion.
- **Negotiation chat ingest.** `/negotiations` not consumed. Surfacing leaked chat logs in a customer dashboard would create an awkward "are we training people on extortion tactics" narrative. Stay clear.
- **8-K filing ingest.** `/8k` not consumed in v1. Future work: cross-reference with the operator's customer list ("did one of your customers report a cyberattack to the SEC this quarter?"). Deferred — requires an additional customer-list table that's a separate scope conversation.
- **Multi-key tenant pooling.** Single shared API key across all tenants in v1. Per-tenant keys deferred (would change the KV secret-name pattern + the per-secret ABAC scope; not justified by current volume).
- **AI-plane consumption.** Deferred to a separate ADR with the gate criteria above. Posture-agent's prompt builder explicitly excludes the new Table in v1.

---

## Consequences

### Positive

- **First external threat-intel surface in the product.** Differentiates Aegis from "M365 posture dashboards" by contextualising the customer's posture against the live ransomware landscape.
- **Bounded scope.** Single API, single Table, single MI, single tile, single drilldown. No cross-cutting refactors. Roughly mirrors the SignIns vertical in surface area.
- **Bounded budget.** ~1,440 req/month per tenant fits well under the 500K/month key cap.
- **No new agent-plane surface in v1.** Defers the prompt-injection adversarial-input review until the operator opts in.

### Negative / cost

- **Operator-side ops burden.** API key generation + KV secret seeding is an operator-side step (mirrors the recipient-hash-pepper UX). Documented in the operator runbook.
- **Upstream availability dependency.** Tile state degrades to "temporarily unavailable" if ransomware.live is down. Circuit-breaker bounds the recovery polling; the rest of the dashboard is unaffected.
- **Free-API trust posture.** Ransomware.live is a community service. SLA isn't contractual; the data is best-effort. Documented in the runbook so operators don't treat the tile as alertable in the same way as Defender XDR.
- **Sector filter is post-fetch.** The `/victims/?sector=` server-side filter is dropped in v1 because most SMB tenants want broader visibility than their own sector. Acceptable bandwidth hit; revisit if a tenant explicitly wants sector-only filtering.

### Risk-accepted

- **Adversarial-controlled strings in storage.** Free-text fields like `Activity` come from leak-site posts; threat actors author them. The plain-text-only rendering invariant + React's default text escape neutralise XSS at the rendering layer. SQL-injection class attacks are not applicable (no SQL). Code review (WS10) at PR time confirms no `dangerouslySetInnerHTML` callsite on these fields.

---

## Alternatives considered

1. **No external threat-intel surface (status quo).** Rejected: operator-requested context gap.
2. **Hosted-feed ingest (e.g., Recorded Future, Mandiant).** Rejected for v1: paid + enterprise-tier APIs with contractual minimums. Inappropriate fit for an open-source SMB-focused product. Revisit when a customer requests a specific commercial feed.
3. **CISA KEV-style global table (cross-tenant).** Rejected: KEV is genuinely tenant-agnostic (CVE → severity) and globally relevant. Ransomware activity is country + sector-bounded — per-tenant filtering is the natural shape.
4. **Pull global `/victims/recent` + filter in the FA.** Rejected: 100-row cap on recent endpoints + extra Function CPU + duplicates ingested. Server-side filter at the API is cheaper.
5. **Eager AI-plane consumption from v1.** Rejected: requires concurrent WS10 review of the ADR-0020 §4 four-layer defence applied to adversarial-input from leak-site strings. Worth its own ADR to do properly.

---

## References

- Ransomware.live PRO API guidance — [`docs/references/ransomware-live-api-pro.md`](references/ransomware-live-api-pro.md) (in-project; pulled from the operator's session notes)
- Ransomware.live homepage — <https://www.ransomware.live/>
- Swagger 2.0 spec — `https://api-pro.ransomware.live/swagger.json`
- ADR-0011 — Ingestion schedule, idempotency, retry (the cadence/retention pattern this ADR mirrors)
- ADR-0013 — Incidents source + scopes (the Microsoft Graph deny-list policy this ADR does NOT extend)
- ADR-0015 — Audit log hash-chain (the `external.ransomware.live` chain key extension)
- ADR-0020 — Brief agent contract (the adversarial-input pattern for the v2 AI-plane review)
- ADR-0036 — Defender for Cloud Secure Score ingest (the per-data-plane MI split pattern this ADR mirrors)
- SEC-L-L12-04 — Per-secret KV ABAC (the pattern the `ransomware-live-api-key` secret follows)
