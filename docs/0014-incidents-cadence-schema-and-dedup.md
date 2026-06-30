# ADR-0014 — Incidents ingest cadence, incremental query, and schema projection

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0013 fixes Microsoft Graph `/security/incidents` as the upstream source for the step-4 Incidents vertical. This ADR fixes **how often** to poll, **how** to poll incrementally (in the absence of a Graph `delta` endpoint), **what to persist where**, and **how duplicates are detected across runs**.

Step 3 (Secure Score) settled the ingest template: Timer trigger, IngestHealth ETag lease, audit NDJSON with `seq`. Incidents reuse the whole template. What changes is that (a) the cadence is higher than daily — incidents are timely — and (b) the payload is far larger and more varied than a Secure Score snapshot, so a blind copy of the `SecureScore`-style all-in-Table pattern would hit Azure Table Storage's 64 KB per-property cap (the `ControlScores` lesson from ADR-0006's amendment).

The concrete choices to settle:

1. **Timer cadence** — how often the handler fires.
2. **Incremental query strategy** — `/security/incidents` has no `delta` endpoint; a cursor-based `$filter` approach is needed.
3. **Schema projection** — which fields land on a Table row, which land in a detail blob, and why the split is necessary.
4. **Dedup and idempotency** — the same Graph incident may be returned on multiple runs as its `lastUpdateDateTime` ticks; writes must be idempotent.
5. **Retention** — how far back to keep rows and blobs; how dev environments stay cheap and purgable.

## Decision

### 1. Cadence — every 15 minutes

**Timer schedule:** `0 */15 * * * *` (NCRONTAB — fires at :00, :15, :30, :45 of each hour, UTC).

Rationale:

- **Incidents are action-relevant** — a maintainer checking the dashboard at 09:20 should see something that happened at 09:10, not wait until tomorrow.
- **15 minutes bounds Graph quota cost** — at single-tenant idle with zero new activity, each run returns `value: []` in a single request. Active hours with 1-5 new/updated incidents return inside a single page. Cost remains negligible.
- **5-minute cadence considered and rejected** — too tight for a background dashboard; the marginal freshness does not justify 3× the Graph calls and 3× the scale-up events on Flex Consumption.
- **No jitter window on step 4** — unlike the step-3 daily 03:00 UTC timer (where jitter avoided thundering-herd against Microsoft at exactly 03:00), 15-minute intervals distributed across tenants are already uncorrelated. Simpler CRON expression; no functional downside.

`runOnStartup = false` (no ingest on cold start). `useMonitor = true` (Functions stores execution state in Storage; ETag lease on IngestHealth remains the real singleton guarantee — ADR-0011 §2).

### 2. Incremental query — cursor on `lastUpdateDateTime`

`/security/incidents` does not expose a `/delta` endpoint at v1.0 (verified against the Graph docs on 2026-04-18). The equivalent incremental pattern uses `$filter` + `$orderby`:

```http
GET /v1.0/security/incidents
  ?$filter=lastUpdateDateTime gt {lastCursor}
  &$orderby=lastUpdateDateTime asc
  &$expand=alerts
  &$top=50
```

**Cursor persistence.** A new column is added to the IngestHealth row for this source:

| Column | Type | Value |
|---|---|---|
| `LastCursor` | String (ISO8601 UTC) | The maximum `lastUpdateDateTime` observed on the last successful run, minus a 2-minute safety overlap for clock skew. On first run (absent), start at `now - 24h` to seed the dashboard with ~1 day of history. |

**Pagination.** Each run follows `@odata.nextLink` until exhausted. The cursor is advanced only after the entire run completes successfully; a partial failure leaves `LastCursor` unchanged so the next fire re-reads from the same point (idempotent overwrites handle duplicates — §4).

**Safety overlap — 2 minutes, v1 estimate, widenable.** The cursor is rewound 2 minutes from the observed max before being written. This tolerates:

- Graph-side clock skew between the service that stamps `lastUpdateDateTime` and our cursor comparison.
- Late-arriving events with backdated timestamps (rare but possible when Graph aggregates from sub-services).

**Microsoft does not publish a specific skew tolerance for `lastUpdateDateTime` on `/security/incidents`.** The 2-minute value is a v1 estimate. Commitment: the first month of live telemetry is reviewed; if any `IncidentsCursorSkewDetected` event fires (see below), the overlap is widened to 5 minutes and an amendment row is added to this ADR. The overlap produces predictable duplicate reads across the window, which `InsertOrReplace` on the same `(tenantId, incidentId)` key handles at zero cost.

**Skew-detection rule.** The handler emits an App Insights custom event `IncidentsCursorSkewDetected` when both conditions hold in the same run:

1. The run's first page returns an incident whose `lastUpdateDateTime < cursorBefore - overlapMs` (i.e. outside the deliberately-permitted overlap window); AND
2. The same incident's `RowKey` is not present in the `Incidents` Table (i.e. the system has never seen it).

That signature uniquely identifies a missed-window event — distinguishable from the routine duplicate-read pattern that the overlap produces by design. The event properties include `incidentId`, `incidentLastUpdateDateTime`, `cursorBefore`, `overlapMs`, and a `severity` hint so App Insights alerting can target it.

**Backfill mechanism — admin endpoint.** If skew detection ever fires, or if an operator needs to recover from a deliberate cursor rewind (ADR-0014 §Cursor sanity bounds, below), a dedicated admin endpoint `POST /api/ingest/incidents/backfill` mirrors the Secure Score backfill (ADR-0011 §3 aside — specified and implemented in step 4 since incidents are more likely to need it). Request body: `{from: ISO8601, to: ISO8601}` with a 30-day upper bound on the window. Execution: a one-shot run that issues the same `$filter=lastUpdateDateTime gt {from} and lastUpdateDateTime lt {to}&$orderby=lastUpdateDateTime asc&$expand=alerts` query, writes incidents as a normal run would, and emits a distinct `IncidentsBackfillRun` audit line (separate from `IncidentsIngestRun` so the audit trail distinguishes historical backfill from forward ingest). The `IngestHealth.LastCursor` is **not** modified by a backfill run — it remains the forward cursor.

**Cursor sanity bounds — integrity against writer-side bugs and compromised ingest MI.**

The cursor is operator-trustable within a narrow window but must be bounded to prevent a silent-suppression-of-security-signal primitive: a future-dated cursor written by either a writer-side bug (clock read from a wrong source) or a compromised ingest MI would cause every subsequent `$filter=lastUpdateDateTime gt {cursor}` query to return empty, indistinguishable from "no new incidents" which is the routine idle case. Two checks at the code boundary:

1. **On write (end of run).** The cursor to be written must be `<= now + 5 minutes` (the same allowance as the safety overlap in the reverse direction). If the computed `cursorAfter > now + 5 minutes`, the cursor write is **rejected**: the `IngestHealth` row is not advanced for this run, a structured event `IncidentsCursorRejected` is emitted with the rejected value, and the run is classified `status = "error"` so the consecutive-failure counter increments and the health badge degrades.
2. **On read (start of run).** If `IngestHealth.LastCursor > now + 1 hour`, the handler treats it as corrupt: it clamps the effective cursor to `now - 24 hours` for **this run only**, emits `IncidentsCursorCorrupt` with the read value, and does **not** persist a new cursor at end of run. Recovery requires a human acknowledgement (the runbook step is documented in `docs/HANDOVER.md` §6.2); the handler holds the clamp until the operator resets the row explicitly.

The rejection + clamp rules are preferred over silent acceptance because a stuck cursor is a worse failure mode than a re-read window.

### 3. Schema projection — Table row + detail blob

Two stores per ingested incident:

#### 3.1 `Incidents` Table row — queryable summary

Store the fields the list-view and tile need to filter, sort, and render. Everything else goes in the detail blob.

| Field | Source | Notes |
|---|---|---|
| `PartitionKey` | `<tenantId>` | Per-tenant partition; single-tenant v1 |
| `RowKey` | `<incidentId>` | Graph's string ID; stable key for dedup + detail-blob path |
| `Status` | `incident.status` | `active` / `resolved` / `inProgress` / `redirected` / `awaitingAction` |
| `Severity` | `incident.severity` | `unknown` / `informational` / `low` / `medium` / `high` |
| `Classification` | `incident.classification` | enum |
| `Determination` | `incident.determination` | enum |
| `PriorityScore` | `incident.priorityScore` (may be null) | Int 0-100 or -1 for null (Table Storage cannot null-type a number) |
| `DisplayName` | `incident.displayName`, truncated to 256 chars | Truncation marker appended if cut |
| `AssignedTo` | `incident.assignedTo` (may be null) | |
| `CreatedDateTime` | `incident.createdDateTime` | |
| `LastUpdateDateTime` | `incident.lastUpdateDateTime` | |
| `AlertCount` | `alerts?.length ?? 0` | Derived at ingest time |
| `HasRedirect` | `incident.redirectIncidentId != null` | Bool; list-view defaults to filtering redirected incidents out |
| `RedirectIncidentId` | `incident.redirectIncidentId` (may be null) | |
| `IncidentWebUrl` | `incident.incidentWebUrl` | Deep-link to Defender portal |
| `CustomTagsJson` | JSON-serialised `string[]`, cap at 4 KB | Full-text search out of v1 scope; cap prevents accidental growth |
| `SystemTagsJson` | JSON-serialised `string[]`, cap at 4 KB | |
| `DetailBlobPath` | `incidents/<yyyy>/<mm>/<dd>/<incidentId>.json` | Cached shape — the API layer constructs the same path at read time, so this is a hint, not authoritative |
| `IngestedAt` | handler clock (ISO8601 UTC) | |
| `IngestRunId` | GUID | Correlates to the audit line |

**Write mode:** `InsertOrReplace`. An incident re-fetched with an updated `lastUpdateDateTime` replaces the row; history is preserved in the detail blob (§3.2).

**Not on the Table row:** `description`, `summary`, `resolvingComment`, `lastModifiedBy`, `comments`, `alerts[]`, `alerts[].evidence[]`. Each of these can individually exceed the 64 KB per-property cap; `alerts[].evidence[]` is the routine culprit because Defender emits deep structured evidence (process trees, file hashes, device inventory) for every alert.

#### 3.2 `incidents-detail` blob — full JSON source of truth

One blob per ingested version of an incident:

```text
incidents-detail/<yyyy>/<mm>/<dd>/<incidentId>.json
```

Where `<yyyy>/<mm>/<dd>` is the UTC date component of `ingestedAt`. The blob body is the full Graph response for that incident (`$expand=alerts` inlined), verbatim, pretty-printed JSON. Content-type `application/json; charset=utf-8`. No compression at the blob layer; gzip happens at HTTP if the reader negotiates it.

**Overwrite policy.** A re-ingest on the same UTC day writes the same blob path — overwriting the earlier version of the day. This is the "latest version wins per day" convention, matching `InsertOrReplace` on the Table row. For audit purposes, the append-blob audit log (ADR-0015) records every run and every `incidentId` touched, so the history of *what was written and when* is independent of the detail-blob's own overwrite history.

**Path sanitisation — length bound and reject-not-truncate.** `incidentId` from Graph is a stable string. Microsoft's `microsoft.graph.security.incident` resource type documents `id` as an unbounded `String`; empirically the observed IDs are `≤ 64 characters` (short numeric `"29"` or opaque-style `"abc…"` forms). The path-builder enforces:

1. **Regex:** `^[A-Za-z0-9._-]{1,128}$`. The 128-character upper bound is derived from the observed envelope of ≤ 64 chars with a 2× tolerance margin. An `incidentId` that exceeds 128 characters or contains any character outside the class is **rejected** at the ingest boundary — not truncated, not sanitised. Rejection semantics: the row is not written, the blob is not written, an `IncidentsIdRejected` App Insights event is emitted with the (truncated-for-log) first 32 characters of the ID plus its total length, and the run classifies this incident as skipped (counts toward `incidentsSkipped` in the run's audit line but not `incidentsIngested`). The ingest run continues with subsequent incidents. A single rejected ID is a Graph contract change and warrants human attention, not silent accommodation.

2. **Forbidden substrings (belt-and-braces):** the handler additionally rejects IDs containing `..`, `/`, `\`, NUL, BOM (U+FEFF), any control character in U+0000–U+001F, and the `[` or `]` characters. These are already excluded by the regex above but are called out explicitly because the test fixtures assert each case, and because future regex edits should not erode the rejection of these substrings.

3. **ADR-0016 mirror.** The API path-parameter regex on `/api/incidents/{id}` is the same `^[A-Za-z0-9._-]{1,128}$`. This prevents an attacker from asking the API for an ID that the ingest layer rejected: both surfaces return 400 / not-found consistently.

The character class + reject-not-truncate policy closes three adjacent concerns: path traversal (`..` and `/`), blob-name collision (truncation would silently produce a colliding path for two IDs differing only at character 129+), and forensic-evidence loss (a rejected ID surfaces loudly rather than being silently downgraded).

**Container.** New container `incidents-detail` on the **ops** storage account (not audit — detail blobs are operational state, not tamper-evidence). Env-aware retention policy identical to the ops storage account's other containers (no WORM in dev; same `Standard_LRS` as `SecureScore`). **Blob versioning + change feed** are enabled on the container (see §5 for the retention interaction): versioning retains a 7-day soft-delete window on any overwrite or delete, and change feed provides a forensic trail of every blob-level action. These are compensating controls for the ingest MI's `Storage Blob Data Contributor` role (see §7 below), which grants delete capability the handler code never exercises but the role's RBAC surface cannot avoid.

### 3.3 RBAC — ingest MI on `incidents-detail`

The ingest MI writes to the `incidents-detail` container. Azure Storage has no built-in role that grants *write without delete* on blob containers (`Storage Blob Data Writer` does not exist; `Storage Blob Data Owner` is broader still). The narrowest practical choice is:

- **`Storage Blob Data Contributor`** scoped to the `incidents-detail` container (not the account).

This role includes `blobs/write`, `blobs/read`, and `blobs/delete`. The `delete` capability is **not exercised by any handler code path**. Instead:

- **Lifecycle management handles all deletion.** The retention rule (§5) is implemented as an Azure Storage lifecycle-management policy on the container; lifecycle policies execute under Azure Storage's own service identity, not the MI. The ingest MI does not call delete in any code.
- **Versioning + change feed are the compensating signals.** An unauthorised delete (e.g. a compromised MI) is recoverable via the 7-day soft-delete window and observable via change feed. The audit log's `detailBlobsWritten: N` count (ADR-0011 §7 / ADR-0015 §1 schema extension) is compared against `incidentsIngested: N`: any run with `detailBlobsWritten < incidentsIngested` surfaces a writer-side anomaly. A drop in detail-blob count without a corresponding drop in ingest count is a strong signal of out-of-band delete.
- **Lifecycle-only-deletes invariant.** Stated explicitly for future reviewers: *"The ingest MI does not delete detail blobs in any code path. Deletion is performed exclusively by the Azure Storage lifecycle management policy configured in `infra/modules/storage-ops.bicep`. Any future code path that calls `BlockBlobClient.delete` or `ContainerClient.deleteBlob` against this container breaks the integrity-of-write model and requires an ADR that reopens this paragraph."*

#### 3.3 Why split

Azure Table Storage caps any single property at 64 KB (UTF-16 → 32K characters). An `alerts[]` array for a multi-stage incident routinely exceeds this. ADR-0006's amendment (step 3's `ControlScores` descriptions dropped) established the precedent that oversized payloads move off-Table. For incidents, the split is load-bearing from the first incident — we do not experiment with truncation and discover the limit live as step 3 did.

The cost of the split:

- Two writes per incident (Table row + blob) instead of one.
- Read path must decide: summary from Table, detail from blob, or both. ADR-0016 specifies the API surface.

The benefit of the split:

- No per-field truncation heuristics.
- Full JSON round-trippable for admins who need it (export, re-analysis).
- Retention policy per-store, separately tunable (rows retained longer if cheaper; blobs trimmed aggressively if storage becomes a concern).

### 4. Dedup and idempotency

Three layers:

1. **Server-side idempotent key:** `(tenantId, incidentId)` as `(PartitionKey, RowKey)`. Graph's `incident.id` is stable for the lifetime of the incident — even `redirected` incidents keep their `id` and carry `redirectIncidentId` as a pointer.
2. **`InsertOrReplace` write mode:** no merge semantics; the whole row is authoritative. A re-fetch with an updated `lastUpdateDateTime` overwrites the row. The previous-version is implicit in the audit log (ADR-0015), not on the Table.
3. **2-minute cursor overlap:** deliberately causes duplicate reads in a narrow window; `InsertOrReplace` handles them without side-effects. The alternative (strict cursor equality) would risk missing late-arriving `lastUpdateDateTime` timestamps.

**Detail-blob idempotency:** the blob path includes the UTC date and the incidentId, so multiple reads of the same incident on the same UTC day overwrite one blob. Multiple reads across UTC day boundaries produce multiple blobs (one per day-of-last-read), which is the desired history. The detail blob is never a source of truth for "was this incident updated at time X?" — the Table row's `LastUpdateDateTime` is the canonical reference.

### 5. Retention

**Both stores: 180 days in prod; configurable per-env; dev defaults to 14 days.**

- **`Incidents` Table rows:** trim-at-write, same pattern as `SecureScore` (ADR-0011 §4). After each successful run, rows with `LastUpdateDateTime < now - retentionDays` are deleted in batches of 100. Retention in dev ≤ 14 days means a simple `azd down --force --purge` will see <100 rows to tear down.
- **`incidents-detail` blobs:** Azure Storage lifecycle management policy on the container:
  - Prod: `Delete after 180 days from modification` (soft, not WORM — detail is operational, not audit).
  - Dev / test: `Delete after 14 days from modification` — keeps the dev container cheap and purge-able. An `azd down --force --purge` on dev tears the whole storage account down anyway; the lifecycle policy is defence-in-depth.

`retentionDays` is a Bicep parameter with env-aware default (`isProd ? 180 : 14`) so forks can raise the prod window without touching code.

**Exceeding retention does not delete anything from upstream Defender** — this is a projection cache, not a system of record. If a maintainer needs an incident older than 180 days they go to `security.microsoft.com` directly.

### 6. Observability (inherits ADR-0011 §6)

Per-run App Insights custom event `IncidentsIngestRun` with the properties listed in ADR-0011 §6, plus:

| Property | Type | Notes |
|---|---|---|
| `source` | string | `"graph.security.incidents"` |
| `cursorBefore` | string (ISO8601) | `IngestHealth.LastCursor` at start of run |
| `cursorAfter` | string (ISO8601) | Cursor at end of run (empty on error — unchanged) |
| `pagesFetched` | number | Count of `@odata.nextLink` follows |
| `incidentsIngested` | number | Rows written in this run (one row per ingested incident) |
| `detailBlobsWritten` | number | Blobs written in this run. Expected equal to `incidentsIngested`; any gap is a writer-side anomaly that the audit-chain verifier surfaces. |
| `incidentsSkipped` | number | Incidents rejected at the ingest boundary (ID validation, per §3.2 `IncidentsIdRejected`) |
| `alertsIngested` | number | Sum of `alerts.length` across incidents in this run |

App Insights retains 30 days by default; the workspace-based LAW has its own retention (ADR-0001, 30 days in dev).

## Consequences

### Positive

- **Pattern consistency:** the step-3 handler template transposes 1:1. IngestHealth ETag lease, audit NDJSON, retry policy, rate limit on the read endpoints — unchanged.
- **Table row stays small and fast** for list/tile queries; detail blob is a single GET when a user clicks into an incident.
- **Retention tunable per-env without a code change.** Dev stays cheap to rebuild.
- **Cursor + overlap + `InsertOrReplace`** gives idempotent incremental ingestion without needing a real Graph delta endpoint.

### Negative / trade-offs

- **Two-writes-per-incident.** Table row + blob. Azure Storage latency is low; at single-tenant scale this is invisible.
- **Cursor drift on clock skew.** The 2-minute overlap is a trade-off between duplicate reads and missed events. If a pathological skew exceeds 2 minutes, the first few runs after the skew event will miss events; observability (`incidentsIngested` metric going unexpectedly low) surfaces the case. Revisit if it happens in practice.
- **`CustomTagsJson` / `SystemTagsJson` cap at 4 KB.** Tenants with very large tag lists would see truncation; none expected at v1 scale, but flagged so it's not a surprise.

### Neutral

- **The 2-minute overlap's duplicate reads** produce a slightly higher `graphAttempts` metric than strict-cursor would. Not a cost concern; surfaces as occasional `ALREADY_KNOWN` log lines.
- **Blob storage class** is `Standard_LRS` matching the ops account. Infrequent-access tier is not used in v1; the 180-day prod retention keeps blobs in the hot tier throughout their life, which is the cheaper choice for our access pattern (admins reading the detail drawer on demand).

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Hourly cadence** | Too slow for action-relevant incidents; 4× the dashboard freshness gap with no cost saving worth mentioning. |
| **5-minute cadence** | 3× Graph calls and Function scale-ups with no meaningful UX win at single-maintainer scale. |
| **Real `/delta` via `/beta/security/incidents/delta`** (does not exist at 1.0; beta surface only) | Beta is not stable; v1.0 cursor-on-`lastUpdateDateTime` is functionally equivalent and stays on GA surface. |
| **All-in-Table with truncated `description` / `alerts`** | Known to fail on first multi-alert incident (64 KB cap hit on `alerts[]`). The step-3 `ControlScores` lesson applies directly. |
| **Detail blob on the audit account** | Operational state doesn't belong on the tamper-evidence account; retention policies are different; access patterns are different. Two accounts stays two accounts. |
| **Detail blob keyed on `(incidentId, lastUpdateDateTime)` to preserve every version** | Unbounded growth; admins with 1000 incidents × 20 updates per year = 20,000 blobs that almost no one ever opens. "Latest version per UTC day" is the right granularity for a dashboard; the audit log carries the per-run history of writes. |
| **Change notifications (webhooks) instead of polling** | Requires a public webhook endpoint, subscription lifecycle, and encrypted payload handling — disproportionate for v1. Tracked as a polish-step optimisation. |

## Related

- `PROJECT_BRIEF.md` §4 — Data and memory model (two stores; retention tunable)
- `PROJECT_BRIEF.md` §5 — Deterministic first, LLM last (ingest has no LLM)
- `PROJECT_BRIEF.md` §8 — Integrations (Graph as canonical source)
- ADR-0006 — Data stores (`Incidents` table already declared; this ADR consumes it)
- ADR-0010 — Graph permissions model (ingest MI identity inherited)
- ADR-0011 — Ingestion schedule, idempotency, retry (template reused)
- ADR-0013 — Incidents source + scopes (upstream decision)
- ADR-0015 — Audit hash-chain (lands before this ADR's code writes to the audit blob)
- ADR-0016 — Incidents list + detail API contract (consumer of this ADR's stores)

---

*End of ADR-0014.*
