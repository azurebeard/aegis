# ADR-0023 — EntraRisk ingest cadence, incremental query, and schema projection

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Step 6 introduces the **EntraRisk vertical** — the third ingest source after Secure Score (ADR-0011) and Incidents (ADR-0014). The upstream is Microsoft Graph Identity Protection: `GET /v1.0/identityProtection/riskyUsers` ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/riskyuser-list?view=graph-rest-1.0)). The `EntraRisk` Table is already declared in `infra/modules/storage-ops.bicep` per the ADR-0006 table roster; this ADR settles **how** that table is populated.

Scope bound (user-confirmed):

- **`/v1.0/identityProtection/riskyUsers` only.** `/v1.0/identityProtection/riskDetections` is explicitly **deferred to a future pass** — it doubles the shared-bucket throttle budget (see §8) and duplicates most of the per-user posture surface for less user-actionable information.
- **State-based snapshot, not change-over-time.** Each run replaces the per-user row; historical states are NOT retained on the Table (soft-delete rows ARE retained for admin visibility — see §4).
- **UI consumer:** a dashboard tile plus a full `/risky-users` page, both defined in ADR-0024 (API contract).
- **brief-agent consumer:** new allowed source key `EntraRisk`, amendment to ADR-0020 (separate note, not a new ADR).
- **Licence gate:** Entra ID P2 is required; P1/Free tenants get 403 or empty collection (Microsoft-documented inconsistency). Step 6 ships a graceful-degrade empty state as the foundation for the admin-tile-toggle follow-up documented in HANDOVER §6.3.

The step-4 Incidents pattern (ADR-0014) is the template. What differs:

1. **No `/delta` AND no `$orderby`** on `/riskyUsers` — the cursor strategy is similar to incidents but constrained further; page ordering is server-defined.
2. **Shared throttle bucket** with every other Identity Protection endpoint at **1 req/s per tenant** — the existing `graphClient.ts` retry handler assumes `Retry-After` on 429 and **that header is NOT returned** by Identity Protection (live-observed against Microsoft's docs and empirical traces; see `graphClient.ts` change-required in §8).
3. **Row shape fits Table Storage comfortably** — no detail-blob split is needed. The full riskyUser resource is ≤ 2 KB even with the largest observable `riskDetail` / `riskEventTypes` arrays, well inside Azure Table Storage's 64 KB per-property cap.
4. **Evolvable enums** — `riskDetail` in particular is a Microsoft-declared evolvable enumeration; the `Prefer: include-unknown-enum-members` header is required, and the parser must not pin narrow unions.
5. **`isDeleted=true` users persist in the upstream** — they are no longer members of the directory but the Identity Protection history still carries them. Dedup on the user objectId, and do NOT assume the user still resolves in the Entra directory at read time.
6. **`isProcessing=true` rows are written (Option A)** with a `Processing=true` column, not deferred. The read path renders a "recalculating" badge; the alternative (Option B — skip writes until `isProcessing=false`) is lossy because the row may carry the only signal for a user whose evaluation is mid-recalc at every 4h fire.

The concrete choices to settle:

1. **Timer cadence** — how often the handler fires.
2. **Audit source key** — naming consistency across the chain.
3. **Table schema** — which columns land, their types, property-cap considerations.
4. **Dedup + soft-delete semantics** — `InsertOrReplace` per row; `isDeleted` / `isProcessing` retention.
5. **Cursor strategy** — `riskLastUpdatedDateTime` + 2-min overlap; first-run seed; bounded back-seek.
6. **Retention** — env-aware sentinel-0 pattern.
7. **P2 licence gate + graceful degrade** — IngestHealth schema amendment for a new `licence_required` status value.
8. **Throttling + retry** — shared 1 req/s IdP bucket; missing `Retry-After` header; `graphClient.ts` change-required.
9. **Evolvable enums** — `Prefer` header, defensive parser, why `SchemaCoverage` is not the right control here.
10. **Audit line** — ADR-0015 chain extension; new fields; same `eventType`.

## Decision

### 1. Cadence — every 4 hours

**Timer schedule:** `0 0 */4 * * *` (NCRONTAB — fires at 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC).

Rationale:

- **Identity Protection data freshness.** Microsoft documents that **real-time detections surface in ~5–10 minutes** (e.g. anonymous-IP, malicious-IP sign-ins) and **offline detections up to 48h** (leaked-credentials, impossible-travel) ([Microsoft Learn — Identity Protection](https://learn.microsoft.com/en-us/entra/id-protection/overview-identity-protection)). 4h cadence is comfortably inside the real-time window — a risky-user that surfaces at 09:05 UTC is on the dashboard by 12:00 UTC at worst.
- **Shared 1 req/s bucket budget.** Identity Protection throttles at **1 request per second per tenant shared across every IdP endpoint and every app in the tenant** (including `/riskDetections`, `/namedLocations`, `/conditionalAccessPolicies` if those verticals later land — see [Microsoft Learn — throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)). At 4h cadence, the worst-case single run uses the budget for ~1–2 seconds (one query + pagination, ~1–3 pages at single-tenant scale). Other apps in the tenant — including a human admin browsing the portal — share the same bucket. The 4h cadence leaves headroom; a 1h cadence quadruples the collision surface for no data-freshness win worth mentioning given the 48h offline-detection window.
- **1h cadence considered and rejected.** Below the ~5–10 min data-plane freshness; four times the throttle collisions with the portal user and every other IdP consumer in the tenant. No UX win at single-maintainer scale.
- **15-minute cadence considered and rejected.** Incidents (ADR-0014) use 15-min because incidents are action-relevant in the minute; risky users are a posture-style signal (the Entra sign-in-risk CA policy is the action surface, not the dashboard tile). Dashboard refresh on the same cadence as incident workflow would have the brief-agent re-emitting the same risky-user set five times before new data exists.
- **Daily cadence considered and rejected.** Matches Secure Score (ADR-0011) but misses the ~5–10 min real-time detections for most of the working day. Posture tiles should lag by hours, not most of a day.

`runOnStartup = false` (no ingest on cold start). `useMonitor = true` (Functions stores execution state in Storage; the IngestHealth ETag lease remains the singleton guarantee — ADR-0011 §2). The singleton lease window (ADR-0011 §2) is re-used unchanged; the riskyUsers run is materially shorter than the incidents run (no detail-blob writes; smaller payload per entity) so 5 minutes covers the worst-case with margin.

### 2. Source key — `graph.security.riskyUsers`

**Source identifier on every audit line, IngestHealth row, and App Insights event:** `graph.security.riskyUsers`.

Rationale:

- **Naming consistency with ADR-0015 precedent.** ADR-0015 keys chains per `(source, tenantId)`. Existing sources are `graph.security.secureScores` (ADR-0011) and `graph.security.incidents` (ADR-0014); the prefix `graph.security.` is the conventional namespace for Microsoft-Graph-sourced security signals.
- **Not `graph.identityProtection.riskyUsers`.** The `graph.security.` prefix reflects the **classification of the signal** (a security posture signal), not the Graph URL path. The next IdP source (riskDetections, when it lands) will use `graph.security.riskDetections` for the same reason — keeps the verifier's `(source, tenantId)` chain set narrow.
- **Singular `riskyUsers` matches the Graph resource name.** `$top`-expanded `value[]` arrays in the Graph response are arrays of riskyUser; the source key matches the Graph resource plural form rather than a prose "riskUsers" shortening. A future migration that consolidated `riskDetections` into this source is **explicitly not** done — each Graph endpoint is its own chain.

The chain introduction follows ADR-0015 §3a's boundary-marker pattern: the first line for `graph.security.riskyUsers` is an `audit.chain.start` line with `priorLineCount: 0` (new chain, no pre-chain lines), written once by the `scripts/write-audit-chain-boundary.mjs` helper at the same time the Timer is first enabled.

### 3. EntraRisk table schema

Single store per ingested riskyUser. Unlike incidents (ADR-0014 §3), **no detail blob** is required — the Graph riskyUser resource fits Table Storage comfortably. Keeping the schema single-store is the cheaper, simpler shape; the split pattern (ADR-0014 §3.3) is a tool, not a default.

| Field | Source (Graph property) | Type | Notes |
|---|---|---|---|
| `PartitionKey` | `<tenantId>` | string | Per-tenant partition; single-tenant v1. Note: ADR-0006 originally named `RowKey = <detectionId>` on the assumption EntraRisk would populate from `/riskDetections`. This ADR pins RK = user objectId because `/riskyUsers` is the chosen source (riskDetections deferred — §Context); the ADR-0006 entry is amended in spirit by this decision. No breaking change to ADR-0006's shape — the table name, partition strategy, and classification rules are unchanged. |
| `RowKey` | `riskyUser.id` | string | Graph's stable user objectId (GUID-shaped). Dedup key. Subject to the same regex rules as ADR-0014 §3.2 — `^[A-Za-z0-9._-]{1,128}$` — reject-not-truncate on violation. |
| `UserPrincipalName` | `riskyUser.userPrincipalName` | string | May be stale if `isDeleted=true` — the user no longer resolves in the directory but Identity Protection retains the last known UPN. |
| `UserDisplayName` | `riskyUser.userDisplayName` | string | Same staleness caveat as UPN; rendered with the plain-text-only rule (ADR-0012 §5 / ADR-0016 §6). |
| `RiskLevel` | `riskyUser.riskLevel` | string | Enum-validated on read only. Values: `low`, `medium`, `high`, `hidden`, `none`, `unknownFutureValue`. |
| `RiskState` | `riskyUser.riskState` | string | Enum-validated on read only. Values: `none`, `confirmedSafe`, `remediated`, `dismissed`, `atRisk`, `confirmedCompromised`, `unknownFutureValue`. |
| `RiskDetail` | `riskyUser.riskDetail` | string | **Evolvable enum** — see §9. Stored as-is; parser emits `"unknown"` on unrecognised values; full raw value retained in the row for downstream upgrades. |
| `RiskLastUpdatedDateTime` | `riskyUser.riskLastUpdatedDateTime` | ISO8601 UTC | The cursor field (§5). Also the list-sort key in ADR-0024. |
| `IsDeleted` | `riskyUser.isDeleted` | bool | Soft-delete flag. **Row is NOT purged when `true`** — see §4. |
| `Processing` | `riskyUser.isProcessing` | bool | `true` when Identity Protection is mid-recalculation; the read path renders a "recalculating" badge. Written per Option A — §4. |
| `IngestedAt` | handler clock (ISO8601 UTC) | ISO8601 UTC | Distinct from `RiskLastUpdatedDateTime` so drift between Graph's computation and our ingest is visible. |
| `IngestRunId` | GUID | string | Correlates to the audit line and App Insights operation ID. |

**Write mode:** `InsertOrReplace`. A re-fetch with an updated `riskLastUpdatedDateTime`, or `riskState` transition (`atRisk` → `remediated`), overwrites the row. No history preserved on the Table — the brief-agent and the dashboard surface the current state; historical state-transition audit lives in Entra's own logs at `security.microsoft.com`.

**Not on the Table row** (dropped at the ingest boundary):

- `@odata.type`, `@odata.context` — OData envelope cruft.
- `history[]` — Identity Protection's own state-transition history. Available on `/riskyUsers/{id}/history` via a separate endpoint; out of v1 scope because the UI does not render history in step 6. Adding it later is additive and does not break this ADR.
- Any field NOT in the table above. The ingest parser is a **positive-match extractor**, not a deny-list — matching ADR-0020 §1's prompt-builder precedent. A Microsoft-side schema addition therefore cannot silently reach the Table; the parser MUST be amended (and this ADR re-reviewed) to land a new column.

**Property-cap considerations.** The largest observable riskyUser payload in the wild is ~2 KB including every field; no single property exceeds ~256 bytes. The 64 KB per-property Table Storage cap (ADR-0006 amendment / HANDOVER §6.2 pitfall 14) is not in play. No JSON-array-as-string columns are needed on this row, unlike the `controlScores` / `customTagsJson` / `systemTagsJson` patterns in ADRs 0011/0014.

**No truncation heuristics.** Unlike `incident.displayName` (ADR-0014 §3.2) which is truncated to 256 chars, `UserPrincipalName` and `UserDisplayName` have their own natural bounds (UPN ≤ 320 chars per RFC 5321; display name ≤ 256 chars per Entra directory schema). Validated on read: a value beyond the natural bound is logged and written as-is, no silent truncation — consistent with ADR-0014's reject-not-truncate posture.

### 4. Dedup + soft-delete semantics

Three layers:

1. **Server-side idempotent key:** `(tenantId, userObjectId)` as `(PartitionKey, RowKey)`. Graph's riskyUser `id` is stable for the lifetime of the user — even `isDeleted=true` users retain their original `id` (and Identity Protection does NOT re-issue it if the user is later re-created in the directory with a different objectId).
2. **`InsertOrReplace` write mode:** no merge semantics; the whole row is authoritative. A re-fetch with an updated `riskLastUpdatedDateTime` or `riskState` transition overwrites the row. There is no "previous version" on the Table; Entra's own audit history is the source of truth for state-transition forensics.
3. **2-minute cursor overlap** (§5): deliberately causes duplicate reads across the overlap window; `InsertOrReplace` handles them without side-effects.

**Soft-delete retention — `isDeleted=true` rows are kept, NOT purged.**

A user who was risky, then was deleted from the directory (or had their Identity Protection record soft-deleted), still carries posture signal. Common real-world cases:

- A compromised account that an admin deleted in response; the `confirmedCompromised` state is still the canonical record.
- A contractor account that was offboarded while holding a `medium` risk level; auditing needs the record months later.
- A synced account that was deleted in on-premises AD; the cloud record lingers.

The read handler (ADR-0024) **filters `IsDeleted=true` rows out by default** with an **admin opt-in** (`includeDeleted=true` query parameter). The table retains them; retention alone (§6) eventually trims. This matches the "admin visibility" theme in HANDOVER §6.3.

**`isProcessing=true` rows are written (Option A).**

When Identity Protection is mid-recalculation, `isProcessing=true` and other fields (`riskLevel`, `riskState`) may be stale. Two options considered:

- **Option A (chosen):** Write the row with `Processing=true`. The read handler renders a "recalculating" badge on the tile and surfaces the stale values with a "may be recalculating" caption on the user's row in the list.
- **Option B (rejected):** Skip the write; re-fetch the user on the next 4h fire. Lossy because a user whose evaluation is `isProcessing=true` on every 4h fire (rare but possible during a large re-baseline event) would never be visible on the dashboard. The "recalculating" badge is strictly more informative than "no row at all".

The read path decides how to render. Ingest does NOT inspect `isProcessing` to branch the write. This keeps the handler simple and the Table Storage the authoritative record of "what the upstream said at observation time".

**Re-appearance after soft-delete.** A user whose row is soft-deleted in our Table (via retention trim — §6), then re-appears in Graph's `/riskyUsers` response (e.g. retention window was shorter than the user's idle period), is written fresh via `InsertOrReplace`. The row's `IngestedAt` is the fresh value; `RiskLastUpdatedDateTime` is whatever Graph reports (which may legitimately pre-date retention — don't second-guess Graph's timestamps).

### 5. Cursor strategy — `riskLastUpdatedDateTime` + 2-minute overlap

`/v1.0/identityProtection/riskyUsers` does not expose a `/delta` endpoint (verified against Microsoft's docs on 2026-04-19 — [Microsoft Learn — riskyUser list](https://learn.microsoft.com/en-us/graph/api/riskyuser-list?view=graph-rest-1.0)). It also does **NOT** support `$orderby`, `$count`, `$search`, or `$expand`. `$filter` is supported on `riskLevel`, `riskState`, `riskLastUpdatedDateTime`, `isDeleted` only.

**Incremental query:**

```http
GET /v1.0/identityProtection/riskyUsers
  ?$filter=riskLastUpdatedDateTime ge {cursor-2min}
  &$top=500
```

- **`$top=500`** is the **maximum** Microsoft accepts. Larger values are clamped server-side; smaller values produce more pages with more shared-bucket throttle traffic.
- **Pagination via `@odata.nextLink`** — follow until exhausted.
- **No `$orderby`** — the handler does NOT assume insertion order. Ordering on the read path (ADR-0024) is done client-side on `riskLastUpdatedDateTime`; the ingest treats the server's returned sequence as a set, not a list.
- **Filter-qualified enum syntax** — when a specific `riskLevel` or `riskState` is needed, the idiomatic Graph form is `$filter=riskLevel eq microsoft.graph.riskLevel'medium'` (fully-qualified enum). v1 of the ingest does NOT filter on enums server-side; a full scan with `riskLastUpdatedDateTime ge {cursor}` is small enough that post-filtering client-side is equivalent and simpler.

**Cursor persistence.** The IngestHealth row for `graph.security.riskyUsers` gains a `LastCursor` column (reusing ADR-0014 §2 precedent — no schema change; same column already exists on rows for `graph.security.incidents`):

| Column | Type | Value |
|---|---|---|
| `LastCursor` | String (ISO8601 UTC) | The maximum `riskLastUpdatedDateTime` observed on the last successful run, minus the 2-minute safety overlap. On first run (absent), seed at `now - 24h` to populate the dashboard with ~1 day of history. |

**Safety overlap — 2 minutes, matches ADR-0014 §2.** Identity Protection's timestamp semantics are not publicly documented with a skew guarantee; the 2-minute overlap is an inherited v1 estimate. If the incidents-chain's `IncidentsCursorSkewDetected` analogue fires for riskyUsers (see observability in §10), the overlap is widened to 5 minutes and an amendment row is added to this ADR.

**Pagination.** Each run follows `@odata.nextLink` until exhausted. The cursor is advanced only after the entire run completes successfully; a partial failure leaves `LastCursor` unchanged so the next fire re-reads from the same point (idempotent overwrites handle duplicates — §4).

**First-run seed.** `now - 24h` — same as incidents. 4h cadence means the dashboard populates within 24h of deploy even if Identity Protection has no active risk activity; operators see a "healthy / no_data" state rather than "empty until a risk fires".

**Bounded back-seek.** A corrupted-or-attacker-rewound cursor is bounded by ADR-0014 §2's same two-gate pattern:

1. **On write (end of run).** The cursor to be written must be `<= now + 5 minutes`. If computed `cursorAfter > now + 5 minutes`, the cursor write is **rejected**: IngestHealth is not advanced, `EntraRiskCursorRejected` App Insights event emits, the run classifies `status = "error"`, consecutive-failure counter increments, and the tile health badge degrades. Silent-suppression-of-security-signal primitive is closed the same way as incidents.
2. **On read (start of run).** If `IngestHealth.LastCursor > now + 1 hour`, the handler treats it as corrupt: clamps the effective cursor to `now - 24 hours` for **this run only**, emits `EntraRiskCursorCorrupt` with the read value, and does NOT persist a new cursor at end of run. Recovery requires a human acknowledgement (runbook in `docs/HANDOVER.md` §6.2); the handler holds the clamp until the operator resets the row explicitly.

**Additional bound — retention-capped back-seek.** On a legitimate cursor rewind (admin endpoint, ADR-0024 §Admin), the back-seek window is **capped at `retentionDays` for the environment** (§6 — 180d prod / 14d dev). Beyond that, rows would be overwritten fresh but their `RiskLastUpdatedDateTime` might pre-date retention's trim horizon, causing immediate re-deletion on the next retention pass. The cap surfaces a 400 `bad_request` on admin-endpoint calls that request a larger window, preventing the "I rewound further than retention and saw nothing" foot-gun.

**No delta-link support.** Not available upstream. If Microsoft ever introduces `/v1.0/identityProtection/riskyUsers/delta`, this ADR is superseded by an amendment; the delta-link primitive is strictly stronger than cursor-on-timestamp.

### 6. Retention — env-aware sentinel-0 pattern

**Rows: 180 days in prod; 14 days in dev.** Matches the incidents (ADR-0014 §5) pattern but **no detail blob** means there's no lifecycle-management policy to configure on a container — retention lives entirely at the Table layer.

- **Prod retention:** after each successful run, delete rows with `RiskLastUpdatedDateTime < now - 180 days` in batches of 100 (Table batch limit). In steady state this deletes zero rows; on the day a user's last risk event ages past 180 days it deletes one row per ageing event.
- **Dev retention:** identical shape, `retentionDays = 14`. Keeps the dev table cheap and `azd down --force --purge`-able.
- **`retentionDays` is a Bicep parameter** with env-aware default (`isProd ? 180 : 14`). Forks can raise prod retention without touching code.

**Why this ADR does NOT need a lifecycle-only-deletes invariant.** ADR-0014 §3.3 specifies that detail-blob deletion flows exclusively through Azure Storage lifecycle policies, not the MI. That rule exists because the ingest MI holds `Storage Blob Data Contributor` (which includes delete) but must not exercise the delete path — the lifecycle policy is the single deleter.

EntraRisk has no blobs. The ingest MI's `Storage Table Data Contributor` on the `EntraRisk` table already includes `DeleteEntity`; the retention trimmer exercises it legitimately. No invariant, no compensating control needed.

**Trim-at-write, same pattern as SecureScore / Incidents.** After each successful run, a scoped query deletes ageing rows. Observable in the same audit line (`retentionRowsDeleted` — §10).

**Exceeding retention does NOT delete anything upstream.** This is a projection cache. An admin looking for a risky-user older than 180 days goes to the Entra portal directly — Identity Protection retains 90 days of detections and indefinitely-long user state ([Microsoft Learn — Identity Protection retention](https://learn.microsoft.com/en-us/entra/id-protection/overview-identity-protection)).

### 7. P2 licence gate + graceful degrade

**Entra ID P2 is required** for `/v1.0/identityProtection/riskyUsers`. P1 and Free tenants get either:

- **HTTP 403** with a descriptive error, OR
- **HTTP 200 with an empty `value: []` collection** (Microsoft-observed inconsistency across tenants — [Microsoft Learn — Identity Protection licensing](https://learn.microsoft.com/en-us/entra/id-protection/overview-identity-protection)).

The handler MUST handle both. Detection:

1. **403 path.** Error-body parser extracts `error.code`; if code matches `/licence|license|upgrade/i` (case-insensitive), the run classifies `status = "licence_required"` (new value — see schema amendment below). The raw Graph body is logged (redacted of tokens) to App Insights for first-time-setup diagnostics.
2. **Empty-200 path.** A 200-response with `value: []` is ambiguous: it could mean "no risky users" on a P2 tenant or "P1/Free tenant". The handler emits a **licence-probe** on the **first-ever run** for the tenant (when `IngestHealth.LastSuccessAt` is null) by inspecting the tenant's enabled service plans directly (WS10 SEC-M-ADR-23-01 resolution). Issue `GET /v1.0/organization?$select=assignedPlans` — the response carries an `assignedPlans` array enumerating every tenant-enabled service plan with its `servicePlanId` GUID and `capabilityStatus` state. The handler scans for the Entra ID P2 service-plan GUID **`eec0eb4f-6444-4f95-aba0-50c24d67f998`** (`AAD_PREMIUM_P2`); if it is present AND `capabilityStatus:"Enabled"`, the empty collection is treated as "no activity" and the run classifies `status = "no_data"`. If the P2 plan is absent or disabled, the run classifies `status = "licence_required"`. The `/organization` endpoint lives in the directory-read bucket (not the IdP throttle bucket), so the probe does NOT consume the 1 req/s IdP budget and is safe to run on every licence-ambiguous empty-200. Fallback: if `/organization` itself 403s (the deployed ingest MI has only `IdentityRiskyUser.Read.All` — `Organization.Read.All` is added alongside; see §11 Graph app-role additions), the handler classifies `status = "error"` with `error.kind = "license_probe_failed"` and does NOT mark the tenant `licence_required` on an inconclusive probe (defence-in-depth against false-positive P2 downgrades). The earlier `$metadata#identityProtection/riskyUsers` fragment-based probe was rejected: RFC 3986 §3.5 strips URL fragments before resource resolution server-side, so the fragment could not disambiguate the empty-200 case.

Only the **first-ever run** probes licence; subsequent runs trust the persisted `Status` on the IngestHealth row (WS10 SEC-M-ADR-23-02 — the authoritative column name is `Status` per ADR-0011 §5a, not `LastStatus`). An admin can force a re-probe by re-invoking the admin endpoint (ADR-0024 §Admin) with the explicit re-probe semantics: the admin POST unconditionally runs a fresh licence probe regardless of the existing `Status` value, overwriting `licence_required` if P2 is now present.

**Sticky-state rule** (WS10 SEC-M-ADR-23-03 resolution). `Status = "licence_required"` is a **sticky value** that bypasses ADR-0011 §5a's `ConsecutiveFailureCount`-derived status transition. Once set, the next Timer fire short-circuits with no Graph call, no cursor advance, no audit line, and no `Status` change — the derivation rule `Status = f(ConsecutiveFailureCount)` that produces `healthy | degrading | failing` is gated behind `Status != "licence_required"`. Only the admin POST `/api/admin/entra-risk/run` can lift the sticky state (by running a fresh probe that may or may not restore it). Rationale: without stickiness, the next no-data Timer fire on a P1 tenant would otherwise see `ConsecutiveFailureCount == 0` and derive `Status = "healthy"`, destroying the graceful-degrade UX in exactly the tenant configuration where it matters most.

**IngestHealth schema amendment — new `Status` value `licence_required`.**

ADR-0011 §5a defined the `Status` column as `"healthy" | "degrading" | "failing"`. This ADR **amends ADR-0011** to add:

| Value | Meaning | Behaviour |
|---|---|---|
| `licence_required` | Tenant lacks the upstream licence (Entra P2 for this source) | Tile renders "P2 required — upgrade to enable" empty state. No consecutive-failure counter increment (this is expected, not a failure). `ConsecutiveFailureCount` resets to 0. Subsequent runs do not re-probe until operator action. |

The amendment is additive per ADR-0006's additive-only schema-migration rule and per ADR-0011's own precedent. No breaking change to existing consumers: readers that don't recognise `licence_required` can treat it as an opaque non-healthy value; the dashboard is updated to render the specific empty state.

**This amendment is within ADR-0023's scope** because the new value is introduced by this vertical; other verticals can reuse the value when they land (e.g. `/v1.0/security/incidents` needs Defender XDR licensing). A future consolidated "IngestHealth status taxonomy" ADR can formalise the full set; v1 adds values additively per-vertical.

**Graceful degrade UX.** The tile on a P1 tenant shows:

```text
Entra Risk
──────────────────────────
  Entra ID P2 required

  Upgrade to unlock sign-in
  risk detections and risky
  user surfacing.

  [ Learn more → ]
```

The `Learn more` link goes to Microsoft's Identity Protection licensing page. No data is shown; no cursor is advanced; no audit line is written beyond the first licence-probe run (which writes `status: licence_required` on the audit chain).

**Foundation for admin-tile-toggle (HANDOVER §6.3).** The step-6.1 follow-up adds a `TenantCapabilities` table and a `/admin` page with per-tile toggles. This ADR's `licence_required` status is the capability-detection signal that page will consume: `TenantCapabilities[entraRisk] = "licence_required"` is derived directly from `IngestHealth[graph.security.riskyUsers].Status`. Step 6 ships the underlying signal; step 6.1 adds the UI.

### 8. Throttling + retry — shared IdP bucket, no Retry-After, graphClient.ts change-required

**Shared bucket.** Identity Protection throttles at **1 request per second per tenant** (not per app, not per endpoint) — [Microsoft Learn — throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits). The bucket is shared across:

- Every IdP endpoint: `/riskyUsers`, `/riskDetections`, `/namedLocations`, `/conditionalAccessPolicies`, sign-in risk events.
- Every application in the tenant — including the Entra admin centre portal, other deployed apps, and Microsoft Graph Explorer sessions.

**Coordinate-not-parallelise invariant.** The handler MUST NOT parallelise the pagination walk (e.g. fan out `@odata.nextLink` fetches). Each page fetch is issued **sequentially**, with at least **one full second between requests** (wall-clock bounded by the 1 req/s bucket with a safety margin). At single-tenant scale with ≤ 3 pages per run, this adds ≤ 3 seconds to wall-clock; no meaningful cost.

**Retry-After header is NOT returned on 429 from Identity Protection.** This is a **live-observed Microsoft behaviour** and a documented pitfall of the IdP endpoints: unlike most Graph surfaces, IdP throttling returns 429 with an empty `Retry-After`. The existing `api/src/lib/graphClient.ts` retry handler assumes the header is present; its fallback on a missing header is a single 2-second delay which, under sustained throttle, is insufficient.

**`graphClient.ts` change-required — exponential-backoff fallback keyed on endpoint prefix.**

The shared library MUST be extended with an endpoint-prefix-keyed fallback:

```typescript
// api/src/lib/graphClient.ts (pseudo-code — the real implementation lives in step-6 code pass)
const IDP_ENDPOINT_PREFIXES = [
  "/v1.0/identityProtection/",
  "/v1.0/riskDetections",           // beta-era alias, defensive
  "/v1.0/namedLocations",
];

function isIdpEndpoint(url: string): boolean {
  return IDP_ENDPOINT_PREFIXES.some(p => url.includes(p));
}

function computeRetryDelay(
  url: string,
  attempt: number,
  retryAfterHeader: string | null,
): number {
  if (retryAfterHeader) {
    // honour + clamp per ADR-0011 §5
    return clamp(parseInt(retryAfterHeader, 10) * 1000, 0, 30_000);
  }
  if (isIdpEndpoint(url)) {
    // exponential backoff with full jitter, base 2s, max 30s
    const base = Math.min(2_000 * 2 ** (attempt - 1), 30_000);
    return base * Math.random();
  }
  // existing behaviour for non-IdP endpoints — 2s default
  return 2_000;
}
```

- **Base 2s, max 30s, full-jitter exponential** — matches ADR-0011 §5 backoff math for non-IdP endpoints. The only difference is the `retryAfterHeader`-absent branch invokes the exponential computation instead of the 2s default.
- **3-attempt budget unchanged** — per ADR-0011 §5. A run that exhausts 3 attempts classifies `status = "error"`, does not advance cursor, increments `ConsecutiveFailureCount`.
- **Observability.** On every retry, an `EntraRiskIngestRetry` event is emitted with `attempt`, `delayMs`, `statusCode`, `retryAfterHeader: null`, `isIdpEndpoint: true`, so App Insights can tell the fallback path apart from the honoured-header path.
- **Unit test required.** A new `api/tests/graphClientRetryIdp.test.ts` asserts: (a) a 429 on `/v1.0/identityProtection/riskyUsers` with no `Retry-After` triggers exponential delay; (b) delays land in `[2s × 2^(n-1)]` bounded at 30s; (c) a non-IdP 429 without `Retry-After` falls through to the existing 2s default. These assertions are the ADR's bound on the lib change.

**Coordination with other IdP consumers in the tenant.** The handler CANNOT detect competing apps in the tenant bucket; if a human admin is actively using the portal during a scheduled run, throttling will surface. The exponential-backoff fallback gives the handler up to `2 + 4 + 8 = 14` seconds of retry accommodation; beyond that, the run fails cleanly and the next 4h fire retries from the same cursor. At single-maintainer scale this is a rare, self-correcting event.

**No pre-emptive throttle hedging.** The handler does not sleep before the first request "just in case" — it starts immediately and relies on retry. Pre-emptive sleeping would double run-time for no win when the bucket is uncongested (the common case).

### 9. Evolvable enums — `Prefer` header, defensive parser, why `SchemaCoverage` is not the right control

Microsoft declares `riskDetail` as an **evolvable enumeration** ([Microsoft Learn — evolvable enums best practice](https://learn.microsoft.com/en-us/graph/best-practices-concept#handling-future-members-in-evolvable-enumerations)). Values can be added in future Graph releases; the `Prefer: include-unknown-enum-members` request header **opts in** to receiving future values as-is rather than having Graph coerce them to `unknownFutureValue`.

**Required request header on every `/riskyUsers` call:**

```http
Prefer: include-unknown-enum-members
```

**Defensive parser.** The ingest parser **does NOT pin narrow unions** on enum fields. Concretely:

- **`riskLevel`** — a typed enum in the parser narrows to the documented 6 values; an unexpected value is logged via `EntraRiskUnknownEnum` event and stored as-is (no coercion to a placeholder). The UI renders unknowns as a neutral grey badge labelled `unknown` with the raw value in a tooltip.
- **`riskState`** — same treatment; 7 documented values plus `unknownFutureValue`.
- **`riskDetail`** — **explicitly loosely-typed.** The parser accepts any string, validates it against a maintained whitelist of known values (imported from `api/src/lib/riskDetailEnum.ts`), and emits `EntraRiskUnknownEnum` with the raw value on unknowns. No placeholder coercion; the row stores the raw string. The UI's label lookup falls back to a prettified version of the raw value when a known label is absent.

**Why `SchemaCoverage` (ADR-0011 §8 test-strategy / ADR-0014 §test-strategy) is NOT the right control here.** `SchemaCoverage` is a code-side unit test that asserts every known field is mapped. It assumes a **closed** schema. Evolvable enums are by definition **open** — the next Graph release can add a value without any code change on our side, and a test that asserted "every riskDetail value we expect is handled" would immediately lag behind Microsoft.

Instead, the control for evolvable enums is **observability**:

- Every unknown enum value emits `EntraRiskUnknownEnum` with the raw value + field name + count seen in this run.
- An App Insights alert fires on 5+ unique unknown values in a 24h window, bringing the addition to the maintainer's attention for a reviewed PR that extends the whitelist.
- The whitelist lives in `api/src/lib/riskDetailEnum.ts` with a dated comment at the top per WS10 quarterly-review convention (ADR-0020 §4's denylist pattern adapted — it's the same observability-over-enumeration discipline).

The whitelist is NOT defensive security (`riskDetail` values are Microsoft-authored strings, not adversary-influenceable), but the defensive parser still applies: any string-valued field interpolated into the prompt-builder path (ADR-0020 §4(b)) has the markdown-escape rule applied by the builder itself, regardless of whether the value is an "expected enum" or an "unknown enum".

**No `beta` surface exposure.** The `beta` endpoint exposes `/riskyUsers` without the `identityProtection/` prefix — **do NOT use it**. The v1.0 URL is hardcoded in the handler with a comment calling out the beta drift:

```typescript
// Hardcoded v1.0: beta also exposes /riskyUsers without the identityProtection/ prefix.
// Using beta in v1 is an ADR-breaking change; keep this path stable.
const RISKY_USERS_URL = "https://graph.microsoft.com/v1.0/identityProtection/riskyUsers";
```

### 10. Audit line — ADR-0015 chain extension, same eventType, new fields

Per-run audit line written to the `audit` container at path `audit/graph.security.riskyUsers/yyyy/mm/dd/ingest.ndjson`. One NDJSON line per run. Schema: same `eventType: "ingest.run"` as ADR-0014 §6, with source-specific fields added:

```json
{
  "schemaVersion": 2,
  "eventType": "ingest.run",
  "source": "graph.security.riskyUsers",
  "seq": 1,
  "runId": "3f7d…",
  "tenantId": "764279e8-…",
  "startedAt": "2026-04-19T00:00:00.000Z",
  "endedAt":   "2026-04-19T00:00:03.421Z",
  "status": "success",
  "cursorBefore": "2026-04-18T20:00:00.000Z",
  "cursorAfter":  "2026-04-18T23:58:00.000Z",
  "pagesFetched": 1,
  "riskyUsersIngested": 12,
  "riskyUsersSkipped": 0,
  "riskyUsersProcessing": 2,
  "licenceState": "present",
  "retentionRowsDeleted": 0,
  "graphAttempts": 1,
  "callerPrincipalMiClientId": "…",
  "prevLineSha256": "a3f6…",
  "lineSha256":     "7c29…"
}
```

**New fields** (source-specific, not on the incidents/SecureScore audit line):

| Field | Type | Notes |
|---|---|---|
| `riskyUsersIngested` | number | Rows written this run (one per user upserted). |
| `riskyUsersSkipped` | number | Users rejected at the ingest boundary (ID validation per §3's regex; or a parser-side exception). |
| `riskyUsersProcessing` | number | Users whose `isProcessing=true` was written (Option A — §4). Informational; non-zero indicates Identity Protection is mid-recalc for some users at this fire. |
| `licenceState` | enum: `present` \| `licence_required` \| `unknown` | Captured from the run's licence-probe result (or carried forward from the row's last-known state on non-first runs). `unknown` is used only on the pre-probe boundary line. |

**Same `eventType: "ingest.run"` as incidents / SecureScore.** ADR-0015 §4 keys chains per `(source, tenantId)`, not per `(source, tenantId, eventType)`. A verifier walking the `graph.security.riskyUsers` chain can reconstruct the full run history without branching on eventType.

**Chain-start boundary.** The first line in this chain is an `audit.chain.start` marker per ADR-0015 §3a, with `priorLineCount: 0` (new chain; no pre-chain `schemaVersion: 1` lines because the source is brand-new).

**App Insights custom events** (per-run event shape matches ADR-0011 §6 / ADR-0014 §6):

- **`EntraRiskIngestRun`** — one per Timer or manual fire, with every property from the audit line above plus `durationMs`, `graphCallCount`, `httpStatusFinal`, `error.kind`, `error.message`.
- **`EntraRiskIngestRetry`** — one per retry attempt (§8), with `attempt`, `delayMs`, `statusCode`, `retryAfterHeader: null | string`, `isIdpEndpoint: true`.
- **`EntraRiskIngestHealthChange`** — on transition between `healthy` / `degrading` / `failing` / `licence_required`.
- **`EntraRiskCursorRejected`** — §5 cursor-write-gate.
- **`EntraRiskCursorCorrupt`** — §5 cursor-read-clamp.
- **`EntraRiskUnknownEnum`** — §9 evolvable-enum observability.
- **`EntraRiskLicenceProbe`** — emitted on the first-ever run per tenant and on any subsequent manual re-probe, with the probe result.

**Log level convention** inherits ADR-0011 §6: `Information` on success / `no_data` / `licence_required`; `Warning` on retried-but-succeeded; `Error` on failed.

### 11. Graph app-role additions — prerequisites for the step-6 infra pass

The ingest MI (introduced in ADR-0010, step 3) must carry two Graph application roles before the first Timer fire — both granted by `scripts/bootstrap-entra.ps1` during `azd provision` postprovision hook, in the same JSON-driven loop that grants `SecurityIncident.Read.All` in step 4:

| Role | Graph app-role ID | Purpose | Consumed by |
|---|---|---|---|
| `IdentityRiskyUser.Read.All` | `dc5007c0-2d7d-4c42-879c-2dab87571379` | Read `/v1.0/identityProtection/riskyUsers` + `/riskyUsers/{id}/history` | Every Timer fire + admin manual-trigger |
| `Organization.Read.All` | `498476ce-e0fe-48b0-b801-37ba7e2685c6` | Read `/v1.0/organization?$select=assignedPlans` for the P2 licence probe (§7 empty-200 path) | First-ever run per tenant + admin-triggered re-probe |

The Graph SP `appId` is the well-known `00000003-0000-0000-c000-000000000000`. Both grants are tenant-scoped to the deployer's tenant (ADR-0008 / ADR-0017 §6.1 single-tenant posture).

**Order-of-operations invariant.** Bicep's storage-ops.bicep per-table Contributor on `EntraRisk` for the ingest MI (step-6 infra pass) can land before the Graph grant without breaking anything — the table simply stays empty until the first successful Graph call. But the bootstrap-entra.ps1 grant SHOULD run before the first Timer fire or the first 15-min-post-provision run will 403 and increment `ConsecutiveFailureCount`. Mitigation: ADR-0011 §5 already bounds that at 3 consecutive failures before the tile flips to `failing`, and the existing IMDS-token cache-flush runbook (HANDOVER §6.2 pitfall 21) applies identically — a second `az functionapp restart` post-grant clears the stale token.

## Consequences

### Positive

- **Pattern consistency.** The step-4 Incidents handler template transposes 1:1 for the Table-layer handler shape. The detail-blob divergence (absent) simplifies the code path.
- **Table-only storage** avoids two-writes-per-row overhead. Payload fits comfortably; no `ControlScores`-style amendment drama.
- **Graceful P2 degradation.** A P1 tenant gets a clear "upgrade to unlock" tile rather than silent empty state or confusing 403 logs.
- **Evolvable-enum posture is right-sized.** Observability-over-enumeration matches Microsoft's best-practice guidance; the parser does not go stale on Graph updates.
- **`graphClient.ts` hardening** extends a shared lib — the exponential-backoff fallback is reusable for the next IdP vertical (riskDetections, CAPolicies) and for any Graph surface that doesn't emit `Retry-After`.
- **Coordinate-not-parallelise** invariant is tight. At the 1 req/s shared bucket, parallel fetches would cause self-inflicted throttling and degrade the admin portal UX for any human signed into the tenant.

### Negative / trade-offs

- **4h cadence lags real-time detections by up to 4h.** A compromised-credentials event surfaced by Identity Protection at 09:05 UTC does not hit the dashboard until 12:00 UTC. Acceptable because the dashboard is a posture tile, not an alerting surface; the CA sign-in-risk policy is the real-time guard.
- **`graphClient.ts` change.** Touching a shared lib requires its own test coverage (step-6 code pass) and a regression risk on incidents / SecureScore. Mitigated by the endpoint-prefix keyed branch — non-IdP endpoints are unchanged.
- **Soft-deleted row accumulation.** `isDeleted=true` rows are retained until retention trims them (180d prod). A tenant with high offboarding volume accumulates ghosts; at 100 offboardings/year the row count is <100 and invisible at read.
- **`isProcessing=true` visibility.** Operators may see a "recalculating" badge on a user whose evaluation is mid-recalc for more than one run in a row. Documented in the ADR; the tile copy makes the "may be stale" message explicit.
- **Licence-probe cost.** The first-ever run issues 2-3 Graph calls instead of 1 to disambiguate the empty-collection case. Negligible at per-tenant-lifetime scale.

### Neutral

- **Additive IngestHealth amendment.** The `licence_required` status value evolves ADR-0011 §5a without breaking any existing consumer — readers that don't recognise the value treat it as "non-healthy" until updated.
- **ADR-0006 RowKey annotation.** `EntraRisk.RowKey = <userObjectId>` diverges from the ADR-0006 roster comment (`<detectionId>`). Acceptable — ADR-0006's roster is a catalogue entry, not a schema lock; the actual schema is defined here.
- **No detail blob** — the ADR-0014 §3.3 RBAC extension (blob reader on `incidents-detail`) does NOT need a mirror for EntraRisk. The api-reader MI's existing Table Reader on the ops account already covers read.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Include `/v1.0/identityProtection/riskDetections`** as a sibling source now | Doubles the throttle-bucket budget (both endpoints share the 1 req/s bucket); duplicates most of the risky-user posture surface for less user-actionable detail (detections are per-event, users are per-identity). Deferred as an explicit follow-up. |
| **1h cadence** | Quadruples shared-bucket collisions with portal / other apps for no UX win above the ~5–10 min real-time-detection window and far below the 48h offline-detection window. 4h is the middle sweet spot. |
| **15-min cadence (match incidents)** | Incidents are action-relevant per-minute; risky users are posture. The brief-agent would re-emit the same risky-user set five times before new data exists; operator fatigue for no signal. |
| **Skip writes on `isProcessing=true` (Option B)** | Lossy — a user whose evaluation is `isProcessing=true` at every 4h fire would never appear. The "recalculating" badge is strictly more informative than "no row at all". |
| **Purge-on-absence** (delete rows for users NOT in the Graph response) | Fails the `isDeleted=true` case: the user is absent from a `$filter=isDeleted eq false` query but still carries posture signal. Dedup on `id` + InsertOrReplace preserves the full state surface without a dangerous per-run sweep. |
| **Store full riskyUser response as a JSON column** | Collapses columns into a single opaque property; breaks filterability in ADR-0024 (can't `$filter=RiskLevel eq 'high'` on a JSON string). Columnar is strictly better at <2 KB payload size. |
| **Detail blob for full JSON** | Unnecessary — payload fits. Two-writes-per-row overhead for no benefit. If riskyUsers ever grows a 10 KB `history[]` field, revisit. |
| **Real-time change notifications** (Graph subscription on `/riskyUsers`) | Subscriptions on `/riskyUsers` are not GA at 1.0 as of 2026-04-19. Would force beta surfaces and add a public webhook receiver; disproportionate for v1. Tracked as polish-step optimisation. |
| **Delta-link via the `users` endpoint** (inferring risk from user `riskLevel` property on `/users`) | `/users` exposes a `riskLevel` property but it does NOT include `riskState`, `riskDetail`, or `riskLastUpdatedDateTime` — the posture surface is materially thinner. Not a substitute. |
| **Pin `riskDetail` as a narrow enum** | Goes stale on every Graph release that adds a value; contradicts Microsoft's evolvable-enum guidance. Observability-over-enumeration is the documented best practice. |

## Related

- `PROJECT_BRIEF.md` §3 — Architecture decisions (read-only integrations; Table Storage)
- `PROJECT_BRIEF.md` §4 — Data and memory model (ops store; audit log)
- `PROJECT_BRIEF.md` §5 — Deterministic first, LLM last (ingest has no LLM)
- `PROJECT_BRIEF.md` §8 — Integrations (Microsoft Graph — Entra; risk detections listed)
- `PROJECT_BRIEF.md` §11 — Observability (App Insights custom events)
- `PROJECT_BRIEF.md` §13 — MVP scope (Entra risk tile as a v1 dashboard surface)
- `PROJECT_BRIEF.md` §15 — Build order (step 6 — Entra risk vertical)
- ADR-0006 — Data stores (`EntraRisk` table already declared; this ADR defines the schema)
- ADR-0010 — Graph permissions model (ingest MI identity inherited; `IdentityRiskyUser.Read.All` app-role added by the step-6 code pass — Graph app-role id `dc5007c0-2d7d-4c42-879c-2dab87571379` on Graph SP `appId=00000003-0000-0000-c000-000000000000`)
- ADR-0011 — Ingestion schedule, idempotency, retry (template reused; this ADR amends §5a with new `Status` value `licence_required`)
- ADR-0014 — Incidents cadence + schema (immediate predecessor; structure mirrored)
- ADR-0015 — Audit hash-chain (new per-source chain key `graph.security.riskyUsers`; no schema change)
- ADR-0020 — brief-agent contract (this ADR's Table rows feed the `EntraRisk` source key per the ADR-0020 amendment note)
- ADR-0024 (pending) — EntraRisk API contract (consumer of this ADR's stores)
- [Microsoft Learn — riskyUser resource](https://learn.microsoft.com/en-us/graph/api/resources/riskyuser?view=graph-rest-1.0)
- [Microsoft Learn — List riskyUsers](https://learn.microsoft.com/en-us/graph/api/riskyuser-list?view=graph-rest-1.0)
- [Microsoft Learn — Get riskyUser](https://learn.microsoft.com/en-us/graph/api/riskyuser-get?view=graph-rest-1.0)
- [Microsoft Learn — riskDetail enum](https://learn.microsoft.com/en-us/graph/api/resources/riskdetail?view=graph-rest-1.0)
- [Microsoft Learn — throttling guidance](https://learn.microsoft.com/en-us/graph/throttling)
- [Microsoft Learn — Identity Protection throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)
- [Microsoft Learn — Identity Protection overview + licensing](https://learn.microsoft.com/en-us/entra/id-protection/overview-identity-protection)
- [Microsoft Learn — evolvable enumerations best practice](https://learn.microsoft.com/en-us/graph/best-practices-concept#handling-future-members-in-evolvable-enumerations)

---

*End of ADR-0023.*
