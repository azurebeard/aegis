# ADR-0011 — Ingestion schedule, idempotency, and retry policy

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Build-order step 3 introduces XDR Hub's first scheduled ingestion job: pull the Microsoft Secure Score snapshot on a cadence and land it in Table Storage so the dashboard reads from a deterministic local store, never from Graph at render time (brief §5, the deterministic-first / LLM-last principle).

Every subsequent vertical in v1 (incidents, Entra risk detections, CA policy coverage, tech-stack / KEV correlation) will take this same shape. The concrete decisions about cadence, idempotency, retry, and observability set the template for every ingestion Function that follows. Getting this right once is cheaper than patching four variants later.

The decisions to settle:

1. **Trigger type and cadence** — what time, how often, how to prevent overlap.
2. **Dedup key scheme** — partition/row-key shape in Table Storage such that re-runs within a day are idempotent.
3. **Retention** — how far back the snapshot history goes, and what trims it.
4. **Retry and failure policy** — what to do on 429, 5xx, network errors, partial writes.
5. **Observability** — what every run emits, so the dashboard can show freshness and the maintainer can diagnose silent failures.
6. **Audit log pattern** — exactly one append-blob event per run, at what level of granularity.

The Graph Secure Score API's own cadence is the first constraint: Microsoft Graph **updates Secure Score approximately once per day.** Pulling more often gets the same snapshot back repeatedly; pulling less often loses history density for the trend chart. This ADR fixes the rules such that a naive re-run is safe, a 429 does not cascade into a panic, and the dashboard always has an answer to "when was this data last refreshed".

## Decision

### 1. Trigger and cadence

**Timer-triggered Azure Function, daily at 03:00 UTC, with a 5-minute jitter window.**

```text
CRON_EXPRESSION = "0 {0-4} 3 * * *"   # NCRONTAB — 6 fields including seconds
```

Rationale for each knob:

- **Daily.** Secure Score updates ~daily; anything more frequent pulls duplicate data and wastes Graph quota.
- **03:00 UTC.** Off-peak for every major region the tool is expected to run in. Secure Score's daily recomputation typically completes before 03:00 UTC (empirically — documented caveat below).
- **Random 0–4 minute offset.** The offset is computed deterministically at deploy time from `hash(tenantId + functionAppName)` so it is stable per environment but different between tenants, so two forks of XDR Hub do not all hit Graph at exactly 03:00 UTC.

The Timer trigger is configured with `runOnStartup = false` (no ingest on cold start) and `useMonitor = true` (Functions stores execution state in Storage to prevent overlap across scale-out — see §Singleton below).

**Manual-trigger companion.** An HTTP-triggered sibling Function (`POST /api/ingest/secure-score/run`) with `authLevel = anonymous` **and** gated by the SWA `admin` role at the route layer (`staticwebapp.config.json` entry) lets the admin force a run without waiting for the next Timer fire. Identical code path; shares the audit log. This is the operational escape-hatch when Microsoft has re-baselined the Secure Score — which happens — and the admin wants an immediate refresh.

### 2. Singleton — preventing overlap

Flex Consumption scales horizontally; two instances could otherwise fire the Timer concurrently on a scale-out event. Azure Functions provides two layers of defence used together:

- **Timer `useMonitor = true`** — built-in distributed lock via Storage.
- **`[Singleton]` equivalent for the handler** — in the v4 programming model, the handler file exports a function wrapped in a lock helper that takes a `leaseBlob` in `staegisopsdevweu/locks/secure-score-ingest.lock`.

**Lease-window sizing.** The lease must **always exceed** the worst-case run time so a legitimately slow run never drops the lease mid-flight. The relation:

```text
leaseWindow ≥ (connectTimeout + readTimeout + maxBackoff + retryAfterClamp) × maxAttempts + safetyMargin
             = (10 s + 30 s + 30 s + 30 s) × 3 + 10 s
             = 310 s (~5 min)
```

The implementation sets the lease to **5 minutes** (auto-renewed on a 60 s keepalive while the handler runs, so a crashed handler releases the lease within 60 s; a healthy but slow handler holds it for the full 5 min if needed). This supersedes the earlier 60-second-lease shorthand — a 60 s lease is too short under the retry budget specified in §5 below.

**Result:** at most one ingest execution per tenant across the Function App's instance set, regardless of scale. Documented pitfall: `useMonitor` alone is not sufficient if someone later turns off the Timer and calls the HTTP-trigger twice quickly — the blob lease is the real guarantee.

### 3. Dedup key and table schema

Each Secure Score snapshot is identified by Microsoft Graph as `<tenantId>_<yyyy-MM-dd>`. The ingest stores the snapshot in the **`SecureScore`** table (declared in ADR-0006) with:

| Field | Value | Notes |
|---|---|---|
| `PartitionKey` | `"snapshot"` | Single partition — scan range queries are tiny and per-day cardinality is 1 |
| `RowKey` | `yyyy-MM-dd` (UTC date of Graph's `createdDateTime`) | Lexicographic ordering matches chronological ordering, enables `rowKey ge 'yyyy-MM-dd'` range queries for trend |
| `GraphId` | `<tenantId>_<yyyy-MM-dd>` | Original Graph `id` preserved for traceability |
| `CreatedDateTime` | ISO8601 UTC from Graph | |
| `CurrentScore` | number | |
| `MaxScore` | number | |
| `ActiveUserCount` | number | |
| `LicensedUserCount` | number | |
| `EnabledServices` | JSON array (serialised) | |
| `AverageComparativeScores` | JSON array (serialised) | |
| `ControlScores` | JSON array (serialised) | |
| `IngestedAt` | ISO8601 UTC timestamp of this write | Separate from `CreatedDateTime` so drift between Graph's computation and our ingest is visible |
| `IngestRunId` | GUID | Correlates to the audit log entry and App Insights operation ID |

**Write mode:** `InsertOrReplace` (not `InsertOrMerge`). A re-ingest on the same day is expected to produce the same row; a re-ingest after Microsoft re-baselines the score legitimately overwrites. No merge semantics are desired — the whole row is authoritative.

**No sparse snapshots.** If Graph returns zero results (the tenant has no Secure Score yet — a new tenant before first nightly compute), the Function writes no row, logs a structured event, and emits an audit entry with outcome `no_data`. It does not write a placeholder.

**No multi-day backfill in step 3.** Graph returns up to 90 days of daily snapshots on a single `/security/secureScores?$top=90` call. The Timer handler stores only the **latest** snapshot per run. A `/api/ingest/secure-score/backfill` admin endpoint (also gated on `admin` role) performs the 90-day backfill on initial deploy and is otherwise idle. Specified here so the code shape is clear; implementation in step 3 code pass.

### 4. Retention

**Cap: 400 snapshots (~13 months).** Enough for year-over-year trend comparison; caps ops-store growth to <1 MB for Secure Score alone.

**Enforcement: trim at write.** After each successful `InsertOrReplace`, the Function queries `SecureScore` with `PartitionKey eq 'snapshot'` ordered descending by `RowKey`, and deletes any row beyond the 400th. Batched `DeleteEntity` calls in groups of 100 (Table batch limit).

Rationale for trim-at-write over a separate retention sweep job:

- **No second scheduled Function to manage.** Retention logic lives alongside the thing it enforces.
- **Bounded work per run.** In steady state, trim-at-write deletes zero rows; on the day of the 401st snapshot it deletes one row.
- **Observable in the same audit event.** The audit log captures `retentionRowsDeleted`, surfacing drift if the cap is ever re-tuned.

**Retention policy is a constant, not a parameter.** Changing the cap is a code change and therefore a reviewed PR; not an operator footgun.

This addresses the ADR-0006 Medium tracker ("Ops-store retention policy not yet defined") for the Secure Score table specifically. Other tables adopt the same pattern when they land; a future ADR may centralise the cap per-table catalogue.

### 5. Retry, timeout, and failure policy

**Per-request HTTP behaviour** (enforced in the Graph client wrapper):

| Concern | Setting | Notes |
|---|---|---|
| Connect timeout | 10 s | |
| Read timeout | 30 s (env var `GRAPH_API_TIMEOUT_MS`) | |
| Retry attempts | 3 | Beyond the 3rd failure the run is declared failed |
| Retryable statuses | 408, 429, 500, 502, 503, 504, network errors | |
| Backoff | Full-jitter exponential: `min(base * 2^(n-1), maxDelay) * random(0, 1)` with `base = 2 s`, `maxDelay = 30 s` | |
| `Retry-After` honoured | Yes, **clamped** — if Graph returns a `Retry-After` header on 429/503, sleep for `min(retryAfterSeconds, remainingLeaseSeconds − 5 s, 30 s)` before the next attempt. See §Retry-After clamp below. | |

**`Retry-After` clamp — rationale and behaviour:** `Retry-After` is semantically advisory (RFC 9110 §10.2.3) and a misbehaving or adversarial Graph response can legally set it to any value — a 1-hour, 1-day, or larger delay would stall the handler past the singleton lease (§2) and the Flex Consumption execution-time limit, crashing the run with no audit entry. The handler is bounded, not Graph: the clamp applies `min(retryAfterSeconds, remainingLeaseSeconds − 5 s, 30 s)`. If the clamp reduces the delay below the header's value, a `SecureScoreIngestRetry` event is emitted with `retryAfterHeader = <original>`, `retryAfterClamped = true`, and `retryAfterApplied = <clamped>` so the clamp is observable in App Insights. This does **not** exempt the attempt from the 3-attempt budget — if Graph genuinely needs more time than the clamp, the run exhausts retries, the audit entry is written, and the next Timer fire (or manual trigger) re-attempts.

**Run-level failure policy:**

- A single run that exhausts retries logs `status = "error"`, writes a structured audit entry with the last response headers (redacted of tokens), and **does not delete any existing rows**. The previous day's snapshot remains the dashboard's latest until the next successful run.
- **Three consecutive failed runs** flip a per-tenant, per-source health row in a dedicated **`IngestHealth`** table (introduced by this ADR as an additive extension to ADR-0006 — see §5a below). The dashboard surfaces this as a degraded-state badge on the Secure Score tile (see ADR-0012) rather than showing stale data silently.
- The flag clears on the next successful run.

### 5a. `IngestHealth` table — additive extension to ADR-0006

The ingest-health signal is a new class of operational state: it is **written only by ingest Functions**, **read only by dashboard API endpoints and status pages**, and **never user-editable**. Co-locating it in `StackItems` (ADR-0006's user-declared tech-stack-items table) would conflate two distinct access-control domains — a user who gains write access to their own tech stack could otherwise silence a degraded-state badge. Separating the table enforces data-classification separation (CIS Control 3.3) and keeps per-table RBAC coherent.

New table, declared in the same Bicep module as the other ops tables (`infra/modules/storage-ops.bicep`):

| Field | Value | Notes |
|---|---|---|
| Table name | `IngestHealth` | |
| `PartitionKey` | `<tenantId>` (GUID string) | Single-tenant deployment in v1; partition on tenant anyway for forward-compatibility |
| `RowKey` | `<source>` — e.g. `"graph.security.secureScores"` | One row per ingest source |
| `Status` | `"healthy"` \| `"degrading"` \| `"failing"` | Derived from `ConsecutiveFailureCount` |
| `LastSuccessAt` | ISO8601 UTC | Updated on each successful run |
| `LastFailureAt` | ISO8601 UTC \| null | Updated on each failed run |
| `ConsecutiveFailureCount` | number | Incremented per failure; reset to 0 on success |
| `LastRunId` | GUID | Correlates to the audit entry and App Insights operation ID |
| `UpdatedAt` | ISO8601 UTC | Row-level concurrency token (optimistic concurrency on write) |

Write access: a **dedicated ingest MI** (`id-aegis-ingest-<env>-<region>`) that is the identity under which Timer-triggered ingest handlers run and that also carries the Graph application permission from ADR-0010. Read access: the api-reader MI (HTTP handlers). **Not writable from any end-user code path.** Identity-level separation — the ingest MI is not used by any HTTP handler and the api-reader MI is not used by any Timer handler — is the primary enforcement; code-level discipline within `/api/src/` (the API layer's table client never names `IngestHealth` in a write) is the secondary layer. Azure Table Storage does not support per-table Contributor scoping without ABAC conditions (noted in ADR-0006 §Access control); this is an accepted v1 trade-off.

This is additive per ADR-0006's "additive-only schema migration" rule. If a consolidated ops-store catalogue ADR is written later, this table rolls into it as its first entry.

ADR-0012 §3 (badges) reads `Status` and `ConsecutiveFailureCount` via the `/api/secure-score/latest` endpoint, which queries this table alongside the `SecureScore` table.

**No automatic alerting beyond the dashboard in v1.** Email/webhook alerting is a step 10 ("Polish") concern per brief §15 build order.

**Explicit non-retry conditions.** Some responses are terminal and should not be retried:

- `401 / 403` — token problem; retrying will not help until the grant is fixed. Fail fast, log structured error including the MI client ID (not the token) so the maintainer can check the app-role assignment.
- `400` — malformed request; our bug, not Graph's — fix in code. Retrying papers over the defect.

### 6. Observability — every run emits

Per-run App Insights custom event `SecureScoreIngestRun` with the following properties (standardising the shape every future ingest Function will emit):

| Property | Type | Example |
|---|---|---|
| `runId` | string (GUID) | correlates to `IngestRunId` on the written row |
| `source` | string | `"graph.security.secureScores"` |
| `tenantId` | string | |
| `status` | enum | `"success"` \| `"no_data"` \| `"error"` |
| `durationMs` | number | wall-clock for the whole handler |
| `graphCallCount` | number | usually 1; higher after retries |
| `graphAttempts` | number | 1–3; >1 indicates retried |
| `rowsWritten` | number | 0 or 1 |
| `retentionRowsDeleted` | number | |
| `httpStatusFinal` | number | Graph's final response status |
| `error.kind` | string \| null | e.g. `"timeout"`, `"throttle"`, `"4xx"`, `"5xx"` |
| `error.message` | string \| null | sanitised; no tokens, no PII |

Two more custom events:

- `SecureScoreIngestRetry` — one per retry attempt, with `attempt`, `delayMs`, `statusCode`, `retryAfterHeader`.
- `SecureScoreIngestHealthChange` — when the tenant-level health flag transitions between `healthy` / `degrading` / `failing`.

**Log level convention:** `Information` for success and `no_data`; `Warning` for retried-but-succeeded runs; `Error` for failed runs.

### 7. Audit log pattern

One append-blob entry per run to the `audit` container (`staegisauditdevweu/audit`) — path `audit/secure-score/yyyy/mm/dd/ingest.ndjson`. One NDJSON line per run. Schema (initial version of the common ingest-audit shape):

```json
{
  "schemaVersion": 1,
  "eventType": "ingest.run",
  "source": "graph.security.secureScores",
  "seq": 142,
  "runId": "3f7d…",
  "tenantId": "764279e8-…",
  "startedAt": "2026-04-19T03:02:17.413Z",
  "endedAt":   "2026-04-19T03:02:18.902Z",
  "status": "success",
  "rowsWritten": 1,
  "retentionRowsDeleted": 0,
  "graphAttempts": 1,
  "snapshotDate": "2026-04-18",
  "currentScore": 412.0,
  "maxScore": 697.0,
  "callerPrincipalMiClientId": "<mi-client-id>"
}
```

- **NDJSON, not full-object JSON** — supports append without re-writing the blob; fits the WORM-in-prod pattern (prod only: append-only blob with immutability policy per ADR-0006).
- **`seq`** is a monotonically increasing integer per `(source, tenantId)` read from a dedicated tracking row in the `IngestHealth` table (`LastAuditSeq` column, incremented atomically per write using the row's ETag for optimistic concurrency). `seq` exists so that a verifier walking the audit log can detect gaps (e.g. a missing append due to writer crash) or re-ordering that container-level WORM does not prevent. Gaps between consecutive `seq` values surface as a post-run integrity check rather than silent loss.
- **Hash-chain deferred.** A per-line hash-chain (`prevLineSha256` + `lineSha256`) that cryptographically binds each line to its predecessor is the stronger control and is the intended endpoint. It is **deferred to a follow-up "audit-log integrity" ADR** that lands when the second ingest source is introduced (i.e. before the audit blob becomes a multi-writer concern across sources). The `seq` field added now is forward-compatible with the hash-chain — when the chain lands, `seq` remains monotonic within source and the hash binds across it.
- **`callerPrincipalMiClientId`** lets the audit trail distinguish the ingest MI from any other identity that might one day write to the same prefix.
- **No raw Graph payload in the audit** — stored only in the ops Table (ephemeral) and App Insights. Audit is the tamper-resistant record that something happened, not a mirror of the data.

The `IngestHealth` row (§5a) adds one column for this purpose:

| Field | Value | Notes |
|---|---|---|
| `LastAuditSeq` | number | Last `seq` successfully written for this `(tenantId, source)`. Incremented atomically. |

### 8. Test strategy (named here so the code pass builds to it)

- **Unit:** parser for the Graph `secureScore` response → Table entity. Edge cases: empty `controlScores`, missing `averageComparativeScores`, non-UTC `createdDateTime`, score > max (treated as bug in Graph, logged but written).
- **Unit:** retention trimmer given N existing rows for N ∈ {0, 1, 400, 401, 500}.
- **Integration (mocked):** Graph returns 200 / 429 / 500 / 500 / 200 sequence — assert three retries, final success, one row written, two `SecureScoreIngestRetry` events.
- **Integration (mocked):** Graph returns three consecutive 429s — assert run fails, no row overwritten, health flag increments.
- **Smoke (deployed):** manual POST to `/api/ingest/secure-score/run`, assert row appears within 30s, audit NDJSON line appears within 60s.

Tests use Vitest (already wired in `/api`). Graph is mocked via `undici` mock-agent; Table Storage is mocked via `@azure/data-tables` in-memory test double (or Azurite where a higher-fidelity test is justified).

## Consequences

### Positive

- **Idempotent by construction.** Re-running the Timer manually (or the HTTP companion) on the same UTC day produces zero net change.
- **Bounded failure modes.** A broken Graph run does not silently stale the dashboard; the degraded badge is visible by the third failed day.
- **One shape for every future ingest.** The `ingest.run` audit schema, the App Insights event names, the health-flag table key — all designed so ADR-0011b (or whatever amends this) is a diff, not a rewrite.
- **Graph quota friendly.** One call per day per tenant; retries capped at three. At maintainer scale this is invisible cost.
- **Off-peak fire, deterministic jitter.** Tenant A and tenant B deployed from the same fork do not collide on the minute.

### Negative / trade-offs

- **Single partition key (`"snapshot"`).** At 400-row steady state this is not a hotspot; for Azure Table Storage with a single tenant's ingestion, partition-based scale-out is irrelevant. If a future vertical ever lands in the same table the partitioning scheme is revisited — but step 3 Secure Score has a dedicated table (per ADR-0006), so not applicable here.
- **Backfill is a separate code path.** The `/api/ingest/secure-score/backfill` admin Function has to duplicate some of the parser logic. Addressed by sharing a `parseSnapshot()` helper between the two handlers.
- **Retention at-write adds one Table query + up to one batch-delete per run.** Measured overhead: <200 ms at 400 rows. Acceptable.
- **Health flag is per-source, not aggregated.** The UI has to decide how to render multiple simultaneous failing sources when later verticals land. Deferred to ADR-0012 et seq.

### Neutral

- **Manual-trigger HTTP path is admin-gated at the SWA layer only.** Defence-in-depth could add a second gate at the Function itself (`authLevel = function`-plus-key); v1 relies on ADR-0007's backend-protection chain, which is already proven live.
- **Microsoft can change Secure Score update cadence.** A future real-time API (`/security/secureScores` push or subscription) would supersede the Timer model — not a concern for v1.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **6-hour ingestion** | Graph recomputes daily; four runs produce three duplicate writes. Cost without benefit. |
| **Webhook subscription** to Graph changes | No Graph subscription exists for `secureScores` at v1.0 as of 2026-04. Would force beta endpoints. |
| **Durable Functions orchestrator** for ingest | Overkill for a single-step job. Reconsider when the ingest fan-outs (e.g. per-control subquery) arrive. |
| **`InsertOrMerge` instead of `InsertOrReplace`** | Merge leaves stale fields in place if Graph's schema shrinks. Row-replace is cleaner and the partial-write risk is low (all-or-nothing per call). |
| **Snapshot history in blob storage instead of Table** | Blob is cheaper at scale but Table's range-query on RowKey is the exact access pattern the dashboard needs. Table wins at <<1 MB scale. |
| **Keep unlimited history** | Grows unbounded (ADR-0006 Medium tracker). 400 snapshots cap is a conservative default; lift via PR if a trend chart ever needs >13 months. |
| **`singleton` at the entire Function App level** | Would serialise all ingests, not just one kind. Per-handler lease is correct granularity. |

## Related

- `PROJECT_BRIEF.md` §4 — Data and memory model (Table Storage for ops, append-blob for audit)
- `PROJECT_BRIEF.md` §5 — Deterministic first, LLM last (ingest Function never invokes a model)
- `PROJECT_BRIEF.md` §11 — Observability and cost controls (App Insights custom events)
- `PROJECT_BRIEF.md` §15 — Build order (step 3 Secure Score is the first vertical)
- ADR-0004 — Hosting plan (Flex Consumption implications for singleton and scale-out)
- ADR-0006 — Data stores (SecureScore table, audit blob WORM pattern)
- ADR-0010 — Graph permissions model and consent flow (scope consumed by this ADR)
- ADR-0012 — Dashboard tile contract for Secure Score (consumer of the Table rows)

---

*End of ADR-0011.*
