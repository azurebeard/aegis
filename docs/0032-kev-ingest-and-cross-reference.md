# ADR-0032 — CISA KEV ingest + stack cross-reference

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0031 Phase A landed the operator-curated stack inventory — the spine.
Phase B converts the spine into actionable signal: cross-reference each
registered `(vendor, product)` against CISA's [Known Exploited
Vulnerabilities (KEV) catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog),
the authoritative public list of CVEs with confirmed in-the-wild
exploitation. KEV is an unauthenticated public JSON feed (~1100 entries
today, append-mostly), refreshed by CISA as new exploitations are confirmed.

The user-facing outcome:

- Each stack item with a KEV-matched product gets a `KEV` chip on its row
  in `/stack` — click → CVE-ID, dueDate, requiredAction, ransomware-campaign
  flag.
- New `KevTile` on the dashboard: *"47 KEV matches across 23 items · 5 due
  this week"*. Drives operators to the highest-priority remediation work.

Concerns this ADR settles:

1. **Feed source + refresh cadence.**
2. **Storage shape** — per-tenant or global table; row layout.
3. **Match strategy** — read-time vs materialised.
4. **Stale-CVE handling** — KEV occasionally removes entries.
5. **Audit-chain integration.**
6. **RBAC.**
7. **Failure modes** — feed unavailable, schema drift, malformed CVEs.

## Decision

### 1. Feed source + cadence

**Source:** `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`
(stable URL since 2021, HTTPS-only, ~1.5 MB today).

**Cadence:** daily Timer trigger at **02:00 UTC** — runs an hour ahead of
the SecureScore 03:00 timer to spread Function App load. CISA updates KEV
on weekdays during US business hours (~14:00-22:00 UTC), so an early-UTC
fire catches the prior day's additions. Override via Bicep param
`kevTimerCron`.

**Manual run:** admin-triggered POST `/api/ingest/kev/run`. Same rate-
limiter precedent as the other admin-run endpoints (30/day per tenant).

**Override:** `KEV_FEED_URL` env var (`infra/modules/functions.bicep`)
defaults to the canonical CISA URL but admits a sovereign-cloud or
test-fixture override at deploy time.

### 2. Storage — single global table

KEV is a public catalog, identical across tenants. No per-tenant
duplication.

**Table:** `KEV` (new, added to `tableNames` after `ReportSnapshots`).

| Column | Type | Notes |
|---|---|---|
| `PartitionKey` | string | Always `"kev"` (single global partition). |
| `RowKey` | string | `cveID`, e.g. `"CVE-2024-12345"`. |
| `VendorProject` | string | KEV's `vendorProject` field. |
| `Product` | string | KEV's `product` field. |
| `VulnerabilityName` | string | KEV's `vulnerabilityName`. |
| `DateAdded` | string | ISO date. |
| `ShortDescription` | string | KEV's `shortDescription`. |
| `RequiredAction` | string | KEV's `requiredAction`. |
| `DueDate` | string | ISO date. |
| `KnownRansomwareCampaignUse` | string | `"Known"` \| `"Unknown"`. |
| `Notes` | string | KEV's `notes` (often empty). |
| `CwesJson` | string | JSON array of CWE IDs (e.g. `["CWE-89"]`). |
| `IngestedAt` | string | ISO datetime — when first seen by Aegis. |
| `LastSeenAt` | string | ISO datetime — refreshed each ingest run. |
| `Removed` | bool | `true` when the CVE was missing from the most recent feed. |
| `IngestRunId` | string | UUID of the ingest run that last touched the row. |

The single global partition keeps ingest writes fast (no per-tenant fan-out),
and the read-time match (§3) joins this catalog against per-tenant
StackItems on the fly.

**Manifest row** lives on `IngestHealth[kev]` — same pattern as Secure Score
ingest. Carries `LastAuditSeq`, `LastLineSha256`, and `Status`. The audit
chain advances under the same lease semantics as every other ingest.

### 3. Match strategy — read-time

The match is computed inline in `GET /api/stack/items`:

1. Read StackItems for the tenant (cap 100 rows, ADR-0031 §6).
2. Read the KEV catalog (single partition, ~1100 rows).
3. For each stack item, walk the KEV list and find matches by **case-
   insensitive `(vendor, product)` equality** on `vendorProject` + `product`.
4. Return each item with `kevMatches: CveMatch[]` — empty array when none.

At v1 scale that's ~110K string comparisons per request — sub-millisecond
in JavaScript.

**Why read-time, not materialised:**

- Single source of truth — no sync drift between catalog and materialised matches.
- Stack-item edits show up immediately — no recompute job.
- Cost grows linearly; revisit when `#StackItems × #CVEs > 5_000_000`
  (~50 stack items × 100K CVEs, or 5K × 1K, etc.). The 100-item cap on
  StackItems makes the LHS bounded.

**Exact-match only (Phase B).** Operators see the `non-canonical` chip
on stack items whose `(vendor, product)` doesn't match the bundled
catalog (ADR-0031 §2); for KEV-match purposes they're treated identically
— exact-match wins, anything else gets no chip. **Fuzzy / token-overlap
matching is Phase B+ ADR-0032 follow-up** when the catalog mismatch rate
becomes a real operator complaint.

### 4. Stale-CVE handling

CISA's policy is that KEV entries are durable — additions only. In
practice, removals are rare but do happen (e.g. an entry was added in
error). On every ingest run:

- For each CVE in the feed → upsert the row, advance `LastSeenAt`.
- For each row whose `LastSeenAt < currentRun.startedAt` → set
  `Removed = true` (don't delete).

`Removed = true` rows are excluded from match computation but kept on
disk indefinitely as a forensic record (*"this product was on KEV when
we deployed Aegis"*). v1 has no retention trim — KEV is small enough
that 10+ years of additions stays under a few MB.

A row that re-appears in a future feed (e.g. CISA reverses a removal)
is upserted with `Removed = false` — the on-disk row remembers the
history via `LastSeenAt`.

### 5. Audit-chain integration

KEV is an ingest source, identical chain semantics to SecureScore /
Incidents / EntraRisk:

- `eventType: "ingest.run"`
- `source: "cisa.kev"`
- Filename: `ingest.ndjson` (the default branch in
  `auditFilenameForSource`; KEV is not agent / report).
- Per-line fields: `runId`, `startedAt`, `endedAt`, `status`,
  `rowsWritten` (total CVEs in the catalog), `addedThisRun`,
  `removedThisRun`, `catalogVersion`, `httpStatusFinal`, `graphAttempts`
  (label retained for parity even though KEV isn't Graph; counts the
  HTTP attempts to CISA).
- Lease: `IngestHealth[<tenantId>][cisa.kev]` — per-tenant audit chain
  even though the catalog itself is global. Each tenant's audit blob
  records its own ingest events. The catalog write is shared but the
  forensic record is per-tenant.

### 6. RBAC

Per-table-scoped, mirrors the StackItems / ReportSnapshots / TenantSettings
precedents:

- **Ingest MI:** `Storage Table Data Contributor` on `KEV` — Timer + admin
  run write the catalog rows.
- **Api-reader MI:** `Storage Table Data Reader` on `KEV` — read for the
  match join in `getStackItems` + the summary endpoint.
- **Agent MI:** nothing in v1. Phase B+ may widen for a "KEV-aware
  posture-agent" prompt if operator demand surfaces; gated on a fresh
  ADR.

### 7. Failure modes + defences

**Feed unavailable** (CISA outage, DNS, network):

- 30s HTTP timeout, max 3 retries with exponential backoff (matches the
  Graph-fetcher pattern).
- On terminal failure: `IngestHealth[cisa.kev]` flips to `degrading` /
  `failing` (existing 3-strike rule). Audit line records `status=error`
  - `error.kind=network`. The catalog rows in Table Storage remain at
  their last-good state — operators continue to see yesterday's KEV
  matches until the next successful run.

**Schema drift** (CISA changes the feed format):

- Parser is defensive: each top-level field is checked, missing fields
  default to empty / null. `vulnerabilities` array existence is required;
  if absent the run fails-loud with `error.kind=schema_invalid`.
- Per-CVE: missing `cveID` skips the entry with a `context.warn` log line
  - AIEVENT `KevSchemaWarning`. Other missing fields default to empty
  string.

**Catalog size attack** (hypothetical CISA compromise / MITM with stripped
TLS):

- Hard cap: 50 MB on the response body — well above current ~1.5 MB and
  any plausible KEV growth horizon. Anything larger fails with
  `error.kind=size_exceeded`.
- Per-CVE field caps applied at parse time (mirroring the StackItems
  validation): vendor/product ≤ 256 chars, name ≤ 512, description /
  required-action / notes ≤ 4096 chars. Truncation is silent + logged via
  AIEVENT `KevFieldTruncated`.

**Hostile content in feed** (CISA-side typo / injection):

- All strings rendered through React text on the SPA — escape-by-default.
- `cveID` validated against `^CVE-\d{4}-\d{4,7}$` regex; non-matching IDs
  are rejected at parse time.

## Consequences

### Positive

- **Spine pays off immediately.** ADR-0031 Phase A's stack inventory
  becomes "list of products with active exploit pressure" for any tenant
  that registers their stack.
- **No new MI, no new Graph scopes, no admin re-consent.** KEV is public.
- **Reuses every existing pattern** — Timer + IngestHealth lease + audit
  chain + per-table RBAC + manual admin-run. Implementation is mechanical.
- **Forward-compatible.** Phase B+ fuzzy matching, NVD CVE detail lookup,
  vendor advisory cross-reference, all extend without breaking the wire
  shape.

### Negative

- **Read-time match adds RTT cost** — every `GET /api/stack/items` does
  the join. Bounded at v1 scale; revisit if the cost matrix grows.
- **Single-partition global catalog** — Table Storage's per-partition
  throttle is ~2000 ops/s. KEV ingest writes ~1100 rows in one run; well
  under the limit. Concurrent admin manual runs from different tenants
  collide on the same partition; the per-tenant lease serialises within
  a tenant, but two tenants running simultaneously could see throttle
  responses on a particularly bad day. v1 accepts the risk; Phase B+ can
  introduce a write-coalesce step if it materialises.
- **No per-version match.** A stack item's `version` field is not used
  in the match — *"Tomcat any version"* is the granularity. KEV does
  carry affected-version ranges in the `notes` field as free text (not
  structured); precise version-range matching needs Phase C with NVD's
  CPE dictionary.

### Neutral

- **`Removed = true` rows sit forever** on disk. At ~1KB per row × low-
  thousand removals over a decade, this is a few MB — operationally invisible.
- **Bundled catalog ≠ KEV.** ADR-0031's `stackCatalog.ts` covers operator-
  facing typeahead suggestions; KEV's `vendorProject` strings are CISA's
  taxonomy. The two overlap heavily but aren't identical (e.g. KEV uses
  *"Microsoft"* while the bundled catalog also has *"Microsoft Corporation"*
  for some entries). The match logic is case-insensitive equality on the
  string the operator typed vs KEV's; a future canonicalisation pass
  could improve hit rate.

## Out of scope (Phase B+ / Phase C)

- Fuzzy / token-overlap matching for the catalog mismatch case.
- NVD CVE detail lookup + per-version CPE matching.
- Vendor advisory cross-reference (Microsoft MSRC, Cisco PSIRT, etc.).
- Materialised match table (revisit when read-time cost matters).
- KEV-aware agent prompt (would need agent MI Reader on `KEV`).
- Per-CVE remediation tracking (workflow: "started", "in progress",
  "remediated") — current design surfaces KEV state, doesn't track
  operator action against it.
- KEV alerting (email / webhook on new matches added) — gated on the
  outbound-integration ADR.

## Trigger to revisit

- Read-time match cost crosses a noticeable RTT on `GET /api/stack/items`
  → materialised match table.
- Operator complains about non-canonical stack items not matching obvious
  KEV entries → fuzzy-match pass.
- KEV catalog grows > 10K entries → revisit single-partition throttle assumptions.
- First customer asks for per-version matching → Phase C (NVD CPE).

---

**References:**

- ADR-0011 — ingestion schedule / idempotency / retry (lease + audit chain semantics).
- ADR-0014 — incidents ingest (cursor / retention precedent for upsert+sweep).
- ADR-0031 — stack inventory Phase A (the spine; this ADR's joining surface).
- HANDOVER §6.2 §17 — Functions v4 route literal-vs-parameter precedence
  (the new `/api/ingest/kev/*` endpoint mounts under the existing
  admin-only `/api/ingest/*` SWA rule).
