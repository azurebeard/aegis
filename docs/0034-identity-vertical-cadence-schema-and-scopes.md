# ADR-0034 — Identity & sign-in observability vertical: cadence, schemas, scopes

**Status:** Accepted
**Date:** 2026-05-01
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Step 8 introduces the **Identity & sign-in observability vertical** — four related ingest sources sharing the Microsoft Entra (Azure AD) data plane, layered on the existing identity surface (ADR-0023's EntraRisk vertical). The four items, all surfaced together on 2026-05-01:

1. **Sign-in log ingest with operator-declared geo-fence** — alert when an authentication originates outside the configured operating area (e.g. `["GB"]`). Source: `GET /v1.0/auditLogs/signIns`. Cross-references each sign-in's `location.countryOrRegion` (Microsoft's geo-IP enrichment) against an operator allowlist.
2. **User dormancy report** — surface accounts that have not signed in for >N days (default 30, configurable). Source: `GET /v1.0/users?$select=id,displayName,signInActivity,accountEnabled` daily walk.
3. **Conditional Access policy state ingest** — capture the CA policy set hourly, detect drift (policies disabled, gaps in MFA), surface per-policy state. Source: `GET /v1.0/identity/conditionalAccess/policies` plus optional `signIns?$filter=conditionalAccessStatus eq 'failure'` for the failure trend.
4. **Identity page (`/identities`)** — UI aggregation surface that combines the dormancy data (Phase B) with an enumeration of agent identities, service principals, and managed identities. Source for SP enumeration: `GET /v1.0/servicePrincipals`. Read-only roll-up; no separate ingest.

Scope bound (user-confirmed):

- **Read-only across all four items** — write paths on CA policies, user properties, sign-in flagging are explicitly excluded by PROJECT_BRIEF §1 and ADR-0013 §3 deny-list. The `*.ReadWrite.*` deny-list regex catches the relevant write scopes; this ADR does not relax it.
- **No PIM / privileged-identity-management surface.** Microsoft Graph's `roleManagement` namespace is its own vertical with separate licensing implications; explicitly out of scope here.
- **No `/riskDetections` ingest** — ADR-0023 §Context defers that as a future pass; this ADR does not change that posture. The geo-fence sign-in surface is operationally adjacent but uses a different Graph endpoint and a different signal model (rule-based vs ML-based).
- **No cross-tenant guest enumeration as a separate concern.** Guests appear in `/users` and `/signIns` like any other principal; the dormancy + geo-fence surfaces apply uniformly. A future "External users" facet could land on the identity page without re-engineering the ingest.
- **Operator-visible only.** None of these four sources feed the AI plane. Brief / posture / incidents-analysis agents do not see sign-in records, dormancy state, CA policy text, or service-principal grants. Brief-agent's existing source allowlist (ADR-0020 §Decision §3) is not extended by this ADR.
- **Agent identity surfacing is forward-compat.** Microsoft's "agent identity" sub-type on service principals is not yet GA at the time of writing (2026-05-01). The Phase E identity page enumerates `/servicePrincipals` and tags rows by `servicePrincipalType` — once Microsoft surfaces an `"agent"` value on that property, the page renders it as a distinct facet without a code change. No speculative parsing of un-shipped fields.

The phasing is settled below; each phase ships independently behind an admin-settings toggle. Phases B–E follow ADR-0013 §3's "scope grant in the same commit as the consumer" policy — this ADR pre-declares the four catalogue entries but does not itself grant any scope.

The concrete decisions to settle:

1. **Per-source cadence** — how often each timer fires.
2. **Per-source audit chain key** — naming consistency with ADR-0015.
3. **Per-source Table schema + retention.**
4. **TenantSettings rows added** — geo-fence policy, dormancy threshold.
5. **Graph scope catalogue extension** — four new scopes, each grants per-phase.
6. **Licence gate posture** — sticky `licence_required` for sources requiring Entra ID P1 (mirrors ADR-0023 §7).
7. **Cross-source dependencies** — what Phase C reads from Phase B, what Phase E reads from B+C+D.
8. **Phase ordering + landing rules.**
9. **Privacy posture** — what fields are operator-visible, what's filtered, retention bounds.
10. **What is NOT decided here.**

## Decision

### 1. Per-source cadences

| Source | Cadence | Cron | Rationale |
|---|---|---|---|
| `graph.auditLogs.signIns` (Phase C) | 15 min | `0 */15 * * * *` | Sign-in events are operationally time-sensitive — a geo-fence breach should surface within the same operator window as Incidents (ADR-0014). The shared 1 req/s Identity-Protection bucket does NOT apply (`/auditLogs/signIns` is on the Reporting throttle bucket, separate budget — see [Microsoft Learn — Graph throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)). |
| `graph.users.dormancy` (Phase B) | Daily | `0 30 1 * * *` | `signInActivity` updates infrequently (Microsoft propagates sign-in events to the property within minutes but typical dormancy windows are 30+ days — daily resolution matches the operator question). 01:30 UTC chosen to land before the SecureScore 03:00 fire so `/admin/diagnostics` shows a complete daily picture. |
| `graph.identity.conditionalAccess.policies` (Phase D) | Hourly | `0 0 * * * *` | CA policies change rarely — hourly catches drift fast enough for the "policy disabled by accident, never re-enabled" failure mode without burning unnecessary Graph calls. The policy resource is small (typical tenants have 5–20 policies) so the per-call cost is negligible. |

All timers: `runOnStartup: false`, `useMonitor: true`. Singleton lease via IngestHealth ETag (ADR-0011 §2 pattern).

15-minute, daily, hourly considered and rejected for each item — the rejected alternatives mirror the ADR-0023 §1 reasoning. In particular, **15-min cadence on dormancy is rejected** because the `signInActivity` property doesn't update fast enough to make sub-daily resolution useful; **daily cadence on sign-ins is rejected** because a geo-fence breach surfacing 24h late defeats the operator value.

### 2. Per-source audit chain keys

| Source | Audit chain key | Rationale |
|---|---|---|
| Phase B — User dormancy | `graph.users.dormancy` | `graph.users.*` is a new namespace under the existing `graph.*` convention; differentiates this from `graph.security.riskyUsers` (ADR-0023) which is also user-shaped but Identity-Protection-classified. |
| Phase C — Sign-in logs | `graph.auditLogs.signIns` | Matches the Graph URL path. `auditLogs.*` is a new namespace; future expansion to `graph.auditLogs.directoryAudits` for Phase F (out of scope here) would be a sibling. |
| Phase D — Conditional Access policies | `graph.identity.conditionalAccess.policies` | `graph.identity.*` is a new namespace; matches the Graph URL segment. The trailing `.policies` allows for `graph.identity.conditionalAccess.namedLocations` to land later as a sibling without renaming. |
| Phase E — Service principals (read-only enum) | NONE | The identity page is a roll-up over existing tables (UserDormancy + a fresh `/servicePrincipals` snapshot fetched on read); no audit chain key, no separate IngestHealth row. The Graph call happens behind an admin-only read endpoint with `cache-control: private, max-age=300` per the ADR-0016 read-pattern. |

Each Phase B/C/D source gets its own boundary marker (ADR-0015 §3a) at first-Timer-enable using `scripts/write-audit-chain-boundary.mjs`.

### 3. Table schemas

#### 3.1 UserDormancy (Phase B)

| Field | Source | Type | Notes |
|---|---|---|---|
| `PartitionKey` | `<tenantId>` | string | Per-tenant. |
| `RowKey` | `user.id` | string | Stable user objectId; ADR-0014 §3.2 regex `^[A-Za-z0-9._-]{1,128}$`, reject-not-truncate. |
| `UserPrincipalName` | `user.userPrincipalName` | string | Plain-text rendered (ADR-0012 §5). |
| `DisplayName` | `user.displayName` | string | Plain-text rendered (ADR-0012 §5). |
| `AccountEnabled` | `user.accountEnabled` | bool | Used for `includeDisabledAccounts` filter at read time. |
| `LastInteractiveSignIn` | `user.signInActivity.lastSignInDateTime` | ISO8601 UTC \| null | Null when the user has never had an interactive sign-in OR when the tenant lacks Entra ID P1 (Microsoft returns `null` either way — disambiguation via the IngestHealth `licence_required` sticky status — §6). |
| `LastNonInteractiveSignIn` | `user.signInActivity.lastNonInteractiveSignInDateTime` | ISO8601 UTC \| null | Same. |
| `LastSuccessfulSignIn` | `user.signInActivity.lastSuccessfulSignInDateTime` | ISO8601 UTC \| null | Newer property; falls back to interactive when null. |
| `IngestedAt` | handler clock | ISO8601 UTC | |
| `IngestRunId` | GUID | string | Correlates to the audit line. |

**Retention:** snapshot replace per run. Rows for users no longer in the tenant directory are removed via `delete-not-found` reconciliation at the end of each run (the dormancy report is a state snapshot, not a change history — historical sign-in trails are out of scope here).

**Property cap:** comfortably under 64 KB per row even for users with multi-segment UPNs.

**Computed at read time, not stored:** `IsDormant` is derived per-row at read time using the operator-configured `dormancy-policy.thresholdDays`. Storing the boolean would mean every threshold change triggers a re-ingest; the read-time computation is cheap and the threshold is the variant.

#### 3.2 SignIns (Phase C)

| Field | Source | Type | Notes |
|---|---|---|---|
| `PartitionKey` | `<tenantId>` | string | Per-tenant. |
| `RowKey` | `signIn.id` | string | Stable Graph identifier (UUID-shaped); ADR-0014 §3.2 regex applies. |
| `CreatedDateTime` | `signIn.createdDateTime` | ISO8601 UTC | Cursor field (§5 cursor strategy mirrors ADR-0014). |
| `UserId` | `signIn.userId` | string | Cross-reference key into UserDormancy when present. |
| `UserDisplayName` | `signIn.userDisplayName` | string | Plain-text rendered. |
| `UserPrincipalName` | `signIn.userPrincipalName` | string | Plain-text rendered. |
| `AppDisplayName` | `signIn.appDisplayName` | string | Which Microsoft / 1P / 3P app the principal authenticated to. |
| `IpAddress` | `signIn.ipAddress` | string | Operator-visible. **Not** sent to AI plane. |
| `Country` | `signIn.location.countryOrRegion` | string | Two-letter ISO country code. May be empty when Microsoft's geo-IP couldn't enrich. |
| `City` | `signIn.location.city` | string | Best-effort city; rendered as supplementary detail. |
| `State` | `signIn.location.state` | string | State / region; supplementary. |
| `Status` | `signIn.status.errorCode` (0 means success) + `failureReason` | object | JSON.stringify'd; bounded to 2 KB. |
| `ConditionalAccessStatus` | `signIn.conditionalAccessStatus` | string | `success` \| `failure` \| `notApplied` \| `unknownFutureValue`. Used for the CA-failure trend on the diagnostics page. |
| `OutOfArea` | computed at ingest | bool | `true` when `Country` is non-empty and not in the operator's `geo-fence.allowedCountries` allowlist. Stored to make the dashboard tile a partition-scan aggregate without re-computing per read. |
| `IngestedAt` | handler clock | ISO8601 UTC | |
| `IngestRunId` | GUID | string | |

**Retention:** **30 days** default (env-aware sentinel-0 pattern: prod default 30, dev default 7). Sign-in history is operationally bounded — older breaches surface from other sources (audit logs, riskDetections) and the storage cost of retaining 90+ days of sign-ins is non-trivial at multi-tenant scale.

**Cursor strategy:** mirrors ADR-0014 §2 — `createdDateTime gt {cursor}` with 2-min overlap, `$orderby=createdDateTime asc`, paged via `@odata.nextLink`. Cursor sanity bounds same as ADR-0014.

**OutOfArea recomputation on policy change:** when an admin changes `geo-fence.allowedCountries`, the existing rows' `OutOfArea` flag is re-computed by a one-shot reconciliation in `patchSettings.ts` (similar to the kev-baseline bulk-acknowledge orchestrator at `kevBaseline.ts`). 30-day worth of rows × single-tenant volume is bounded enough for an inline reconciliation; multi-tenant deployment would need an async path.

#### 3.3 ConditionalAccessPolicies (Phase D)

| Field | Source | Type | Notes |
|---|---|---|---|
| `PartitionKey` | `<tenantId>` | string | Per-tenant. |
| `RowKey` | `policy.id` | string | Stable Graph identifier; regex applies. |
| `DisplayName` | `policy.displayName` | string | Plain-text rendered. |
| `State` | `policy.state` | string | `enabled` \| `disabled` \| `enabledForReportingButNotEnforced`. |
| `CreatedDateTime` | `policy.createdDateTime` | ISO8601 UTC | |
| `ModifiedDateTime` | `policy.modifiedDateTime` | ISO8601 UTC | Drift-detection field. |
| `Conditions` | `policy.conditions` | string | JCS-canonicalised JSON, bounded at 16 KB (CA conditions can include long IP lists). Used for diff detection. |
| `GrantControls` | `policy.grantControls` | string | JCS-canonicalised JSON. Renders the human-readable summary ("MFA required", "compliant device required"). |
| `SessionControls` | `policy.sessionControls` | string \| null | Null on most policies; bounded at 4 KB when present. |
| `IngestedAt` | handler clock | ISO8601 UTC | |
| `IngestRunId` | GUID | string | |

**Retention:** snapshot replace per run, same as UserDormancy. Policy change history is captured in the audit chain via `ca.policy.changed` lines (see §10) — the table holds current state only.

**Diff detection:** at the end of each ingest run, compare `(State, ModifiedDateTime, hash(Conditions), hash(GrantControls), hash(SessionControls))` against the prior snapshot. When any tuple differs, append an audit line `eventType: "ca.policy.changed"` with `{ policyId, displayName, before: {...}, after: {...} }`. The diff is computed on the canonicalised JSON to avoid spurious churn from key-ordering differences.

### 4. TenantSettings rows

Two new rows, both written via the existing `patchSettings.ts` PATCH endpoint (admin-only, 30/day rate-limited per ADR-0025).

#### 4.1 `geo-fence` (Phase C)

```json
{
  "RowKey": "geo-fence",
  "AllowedCountries": ["GB"],
  "AllowedIpRanges": [],
  "UnknownLocationPolicy": "alert",
  "Enabled": true
}
```

- `AllowedCountries`: array of ISO 3166-1 alpha-2 codes. Operator-edited via `/admin?section=geo-fence` (Phase C UI). Capped at 50 entries (a tenant operating in 50+ countries probably needs a richer model than a flat allowlist).
- `AllowedIpRanges`: optional array of CIDR strings; bypasses the country check when the source IP matches (covers the "VPN concentrator in country X but employees in country Y" case). Capped at 100 entries; CIDR validated server-side.
- `UnknownLocationPolicy`: `"alert"` (treat empty `Country` as out-of-area) or `"ignore"` (treat as in-area). Default `"alert"`.
- `Enabled`: false short-circuits the ingest's `OutOfArea` computation (always `false`); operator can disable the geo-fence surface without removing the tile from the visibility list.

When `geo-fence` is absent, the ingest defaults to `Enabled: false` (no out-of-area calls until the operator opts in).

#### 4.2 `dormancy-policy` (Phase B)

```json
{
  "RowKey": "dormancy-policy",
  "ThresholdDays": 30,
  "IncludeDisabledAccounts": false,
  "ExcludeServiceAccountSuffixes": ["@svc."]
}
```

- `ThresholdDays`: integer in `[7, 365]`. Default 30. Read-time-computed `IsDormant` flag uses this value; storage shape is unchanged across threshold edits.
- `IncludeDisabledAccounts`: when false (default), disabled accounts are excluded from the dormancy tile count (they're already unreachable). Inclusion is sometimes requested for audit/compliance scope.
- `ExcludeServiceAccountSuffixes`: array of UPN-suffix patterns to filter out. Default `["@svc."]` covers the common convention. Capped at 20 entries.

Both rows share the existing `patchSettings.ts` schema validation pattern (see ADR-0025 §9.5). All values are length-capped + control-char-stripped at write time.

### 5. Graph scope catalogue extension

This ADR pre-declares **four new scopes**. Per ADR-0013 §3, the bootstrap script entry for each scope lands in the **same commit** as its consuming code path, not in this ADR. The rationale + deny-list confirmation is settled here so each phase's WS10 review can name-check the catalogue decision rather than re-arguing it.

| Scope | Phase | Consumer | Licence gate |
|---|---|---|---|
| `User.Read.All` | B | `runUserDormancyIngest.ts` (`GET /v1.0/users?$select=id,displayName,signInActivity,accountEnabled`) | Required for the `/v1.0/users` collection itself. |
| `AuditLog.Read.All` | **B + C** (amended 2026-05-08) | Phase B: `runUserDormancyIngest.ts` — the `signInActivity` property requires this scope IN ADDITION to `User.Read.All` per [Microsoft Graph signInActivity docs](https://learn.microsoft.com/en-us/graph/api/resources/signinactivity). Without it, the entire `/users?$select=…,signInActivity` query 403s with `Authentication_MSGraphPermissionMissing`. Phase C: `runSignInsIngest.ts` (`GET /v1.0/auditLogs/signIns`). Same scope serves both consumers. **Original v1 of this ADR (2026-05-01) had this scope pencilled in for Phase C only — production incident on 2026-05-08 surfaced the Phase B dependency: 6 days of failed Timer fires (every 01:30 UTC since 2026-05-02) returning `kind=4xx`. Fix: pulled the scope grant forward to Phase 8B; Phase 8C will reuse the existing assignment.** | Licence dimension: `signInActivity` requires Entra ID P1+ at the tenant level; without P1 the property returns `null` for every row even with both scopes granted. The orchestrator's `isLicenceRequiredBatch` heuristic (every observed row has all three signInActivity fields null AND `rows.length > 0`) detects this case and sticky-sets `IngestHealth.Status = "licence_required"`. |
| `Policy.Read.All` | D | `runConditionalAccessIngest.ts` (`GET /v1.0/identity/conditionalAccess/policies`) | The endpoint works on Free, but conditional-access **policies** themselves require P1+ to create / enforce. Tenants without CA policies in place return an empty `value: []` — IngestHealth stays `healthy` with `LastRowsWritten: 0` (no licence_required signal needed; empty is a legitimate state). |
| `Application.Read.All` | E | `getServicePrincipals.ts` (read-only on-demand) | No licence requirement. |

**Deny-list cross-check:** none of the four scopes match the `*.ReadWrite.*` regex in `bootstrap-entra.ps1:202`. The deny pattern catches `User.ReadWrite.All` / `AuditLog.ReadWrite.All` / `Policy.ReadWrite.All` / `Application.ReadWrite.All` (all four in the deny pattern's general form `^[A-Z][a-zA-Z]+\.ReadWrite\.(All|OwnedBy)$`); the **Read** variants pass cleanly.

**Catalogue growth note** to be added to ADR-0013 §3 in the Phase A commit (this commit): list the four new scope entries with their Phase numbers + this ADR as the deciding reference.

### 6. Licence gate posture (mirrors ADR-0023 §7)

Phases B and C ship with sticky-`licence_required` IngestHealth state on tenants without Entra ID P1. The pattern is identical to ADR-0023:

- First run with `signInActivity` all null (B) or 403 from `/auditLogs/signIns` (C) sets `IngestHealth.Status = "licence_required"` and skips subsequent runs until an operator re-probes via the admin "Run now" button.
- Auto-hide UI: the dashboard tile renders an empty-state explaining the P1 requirement (matches ADR-0023's empty-state wording for riskyUsers).
- Re-probe on admin-trigger only: timer-fired runs short-circuit on `Status === "licence_required"`; admin runs always re-probe. Ensures operators who upgrade tenant licensing can clear the sticky state without waiting for a code redeploy.

Phase D does NOT use the licence-required pattern — `/conditionalAccess/policies` returns 200 + empty `value` on Free tenants, which is a legitimate "no policies configured" state, not a licence absence. The dashboard renders "No CA policies configured — recommend enabling at least an admin-MFA policy" as the empty-state.

### 7. Cross-source dependencies + Phase E identity-page IA

- **Phase B (UserDormancy) → Phase E (identity page)**: identity page reads UserDormancy as the human-identity facet.
- **Phase C (SignIns) → Phase E**: the identity drilldown for a user surfaces the last 30 days of that user's sign-ins (filtered by `UserId` partition scan).
- **Phase E adds `/servicePrincipals` enumeration** at read time (no separate ingest, no separate Table). The endpoint is `getServicePrincipals.ts` returning `{ servicePrincipals: [...], retrievedAt }`. Cached 5 minutes via `cache-control: private, max-age=300`.
- **Phase D (CA policies) is independent** of B/C/E. The CA section on the diagnostics page (already shipped) gets a "policy state" sub-section once Phase D lands.

The identity page's IA, settled here so Phase E doesn't re-litigate it:

```text
/identities
├── Tab "Humans"      ← UserDormancy roll-up (count, sortable table, last-sign-in age)
├── Tab "Agents"      ← Service principals filtered by `servicePrincipalType === "Application"` AND
│                       a future `agentSubtype` field surfaces on the SP object (Microsoft schema TBC)
├── Tab "Service principals" ← all other SPs (Application type, no agentSubtype)
└── Tab "Managed identities"  ← SPs filtered by `servicePrincipalType === "ManagedIdentity"`
```

Each row links to the user/SP detail drawer (existing component pattern; ADR-0016 §3 detail-drawer model). The detail drawer for a human links into Phase C's sign-in history.

### 8. Phase ordering + landing rules

The phase order from §Context is settled:

1. **Phase A — this ADR + ADR-0013 §3 catalogue note.** No code, no bootstrap edit, no Bicep edit. Lays the design ground.
2. **Phase B — Dormancy.** Adds `User.Read.All` AND `AuditLog.Read.All` to bootstrap in the same commit as `runUserDormancyIngest.ts` (the latter pulled forward from Phase C — see §5 for the rationale; `signInActivity` property reads require both scopes per Microsoft Graph docs). Adds `UserDormancy` table to `storage-ops.bicep` per the ADR-0006 table-roster convention. Ships dashboard tile + drilldown.
3. **Phase C — Sign-ins.** `AuditLog.Read.All` already granted in Phase B; reuses the existing assignment. Adds `SignIns` table. Ships the geo-fence admin section + dashboard tile + drilldown.
4. **Phase D — Conditional Access.** Adds `Policy.Read.All`. Adds `ConditionalAccessPolicies` table. Ships the CA section on the diagnostics page (not a top-level dashboard tile in v1; CA is a posture signal, not a workflow surface).
5. **Phase E — Identity page.** Adds `Application.Read.All`. New `/identities` page. No new Tables (reads UserDormancy + on-demand SP enumeration).

Each phase is independently shippable behind its own admin-settings tile-visibility toggle (ADR-0025 Phase 1+2 pattern). Phases ship in order **B → C → D → E**, but each is self-contained — a partial landing (e.g. B + C, defer D + E) leaves the codebase in a coherent state.

WS10 review per phase, mandatory. ADR + bootstrap edits in Phase A get their own WS10 verdict; each subsequent phase gets its own.

### 9. Privacy + plain-text-only invariant

- ADR-0012 §5 plain-text-only on Microsoft-authored prose extends to all four sources verbatim. `displayName` / `appDisplayName` / `userDisplayName` / `City` / `State` / `Country` / `policy.displayName` are all rendered through React's text-node escape OR (in the HTML report renderer) the `html\`` tagged template's auto-escape.
- **No agent-plane consumption.** None of the four sources are added to the brief-agent / posture-agent / incidents-analysis-agent allowed-source lists. The existing 4-layer prompt-injection defence (ADR-0020 §Decision §6) does not need to absorb sign-in / dormancy / CA prose. This is a deliberate scope boundary — the AI plane stays narrow.
- **Operator-visible only — split posture, READS reader-or-admin / WRITES + RUNS admin-only.** *(Amended 2026-05-10 — original v1 prose stated "admin-role-gated at three layers"; the implementation across Phases 8B / 8C / 8D / 8E + the Phase 8D dashboard tile + notifications-bell wiring shipped a split posture per operator decision. The amendment records the as-shipped reality + reasoning so the prose-vs-code divergence does not re-litigate per phase.)*
  - **Reader-or-admin read endpoints.** `/api/user-dormancy/{summary,list}`, `/api/sign-ins/{summary,list}`, `/api/conditional-access/{summary,policies}`, `/api/identities/service-principals`. Gated by `readClientPrincipal` only (any authenticated principal passes); no `principal.userRoles.includes("admin")` check. Aligns with the rest of the project's reader posture (RiskyUsers, Incidents, SecureScore et al.) where read = visibility, admin = mutation.
  - **Admin-only writes + runs.** `/api/ingest/user-dormancy/run`, `/api/ingest/sign-ins/run`, `/api/ingest/conditional-access/run`, `PATCH /api/settings` for `geo-fence` / `dormancy-policy` rows. Gated server-side via `principal.userRoles.includes("admin")` → 403. SEC-H-INGEST-AUTH-MIGRATION (HANDOVER §10.48) closed the post-Phase-D2 gap where the SWA route gate was retired without server-side enforcement.
  - **Three-layer compensating control on writes.** Server-side admin role check (`runConditionalAccessIngest.ts` etc.); per-table-scoped Storage Table Data Contributor on the ingest MI; AUDIT_MI write-path entirely separate from api-reader MI. Reader principals cannot reach mutation paths even via direct FA URL (FA-side JWT validation per ADR-0035 enforces).
  - **Why split, not full admin.** Operator decision (single-tenant v1, internally-held tenant invitation list): readers in this tenant are trusted SOC operators not adversaries. CA policy bodies, sign-in metadata, dormant-account UPNs are operationally useful for SOC visibility. Multi-tenant + external-reader scenarios will revisit at the relevant ADR boundary.
- **IP addresses.** SignIn rows carry `IpAddress` (operator-visible). The HTML report renderer at `reportHtml.ts` does NOT render IP addresses in any envelope section — operators see them only in the live SPA, never in a captured snapshot or downloaded HTML report. This avoids inadvertent residual-data exposure on board-pack output.
- **Retention bounds:** SignIns 30d default, others snapshot-replace. The audit chain retains the diff-detection lines indefinitely (180d prod / 14d dev per the existing ADR-0011 §6 retention policy on the audit blob).

### 10. Audit chain extension

ADR-0015 §5 audit-line schema extension for the new sources:

- **`graph.users.dormancy`** — line shape mirrors `graph.security.riskyUsers`: `eventType: "ingest.run"`, `rowsWritten`, `rowsDeleted` (the delete-not-found reconciliation count). New optional field: `dormantCount` (rolled-up at the end of ingest for at-a-glance reading in `verify-audit-chain.mjs`).
- **`graph.auditLogs.signIns`** — line shape mirrors `graph.security.incidents`. New optional field: `outOfAreaCount` (count of rows where `OutOfArea = true` in this run).
- **`graph.identity.conditionalAccess.policies`** — additionally emits `eventType: "ca.policy.changed"` lines on diff detection (see §3.3). The line shape mirrors the ingest.run shape with extra `policyId`, `before`, `after` fields. The line is **chained on the same `(source, tenantId)` chain** as the ingest.run lines — preserves the per-source forward-only invariant.

All chain extensions use the same `lineSha256` computation (ADR-0015 §5), the same `seq` allocation under IngestHealth ETag lease, and the same `prevLineSha256` resolution via `auditChain.ts`.

### 11. What is NOT decided here

- **Bootstrap script's per-phase scope grant lines** — added in each phase's commit, not this ADR. The catalogue note in ADR-0013 §3 (this commit) records the four new entries; the actual `$RequiredGraphScopes` array edit is per-phase.
- **Bicep table additions** — `UserDormancy`, `SignIns`, `ConditionalAccessPolicies` table declarations land in the respective phase's `storage-ops.bicep` change. Per-table-scoped Contributor (ingest MI) + Reader (api-reader MI) RBAC follows the existing ADR-0006 pattern, no new pattern needed.
- **API contract per phase** — list / detail / summary endpoints are settled in the phase-level WS10 verdict, not pre-decided here.
- **UI rendering details** — tile shapes, drilldown table column choices, drawer markup. Each phase's UI lands with WS10 review for the rendering surface.
- **`/auditLogs/signIns` Reporting API throttle deep-dive** — covered at Phase C implementation time. The shared 1 req/s Identity-Protection bucket does NOT apply here (Reporting bucket is separate); the 15-min cadence at single-tenant scale is well inside the Reporting throttle envelope.
- **Sign-in risk scoring vs geo-fence** — the riskyUsers vertical (ADR-0023) catches Microsoft's ML-classified risky sign-ins; this ADR's geo-fence catches the operator-defined-allowlist failure mode that Microsoft's ML doesn't classify. The two surfaces are complementary, not overlapping. Geo-fenced sign-ins do NOT feed back into the riskyUser risk score (Microsoft-managed; out of operator hands).
- **Multi-tenant deployment.** v1 is single-tenant; the partition-scan reconciliation patterns in §3 + §4 don't scale to thousands of tenants. Multi-tenant adds an async-job pattern + per-tenant queue. ADR for that lands when the multi-tenant decision lands.

## Consequences

### Positive

- **Operator-visible identity surface.** The dashboard gains a coherent identity story — dormant accounts, geo-fence breaches, CA policy state, agent identities — all on the same admin-only surface.
- **Zero AI-plane churn.** The brief / posture / incidents-analysis agents are unchanged. The 4-layer prompt-injection defence stays narrow.
- **Catalogue growth is bounded.** Four new scopes (User.Read.All, AuditLog.Read.All, Policy.Read.All, Application.Read.All) each named in this ADR, each with a single named consumer. ADR-0013 §3 deny-list re-validation runs once per phase commit; no scope sprawl.
- **Reuses existing patterns.** Sticky `licence_required` (ADR-0023 §7), per-table RBAC (ADR-0006), audit chain (ADR-0015), tile-visibility toggle (ADR-0025), admin-only handler gate (ADR-0024 §1.1). No novel infrastructure.
- **Phasing is independent.** B / C / D / E each ships behind a tile-visibility toggle. A partial landing (e.g. B + C) is a coherent product surface.

### Negative / trade-offs

- **Storage growth on SignIns.** 30d × ~daily sign-in volume × per-tenant. Single-tenant dev is bounded (~thousands of rows). Multi-tenant scaling needs revisiting; flagged in §11.
- **Phase E waits on Microsoft schema.** The agent-identity tab on `/identities` renders a degraded "agent-identity field not yet available on this tenant" state until Microsoft surfaces the relevant property on `/servicePrincipals`. Operators with multiple Copilot Studio agents will see them lumped into "Service principals" in the interim.
- **CA policy diff detection is canonicalised-JSON-based.** A non-functional CA policy edit (e.g. whitespace-only change in a rule's display name) won't trigger a diff line. Acceptable — the operator-relevant changes are state-flips and condition-set changes, both of which canonicalise to detectable diffs.
- **Cross-tenant sign-ins.** Guest user sign-ins from outside the tenant's home country are flagged by the geo-fence. Operators with significant guest activity will need to either (a) add the relevant guest countries to `AllowedCountries`, (b) add the guest IP ranges to `AllowedIpRanges`, or (c) accept the noise. No code change can disambiguate "legitimate guest from country X" vs "compromised account from country X".

### Neutral

- **Identity vertical scope.** This ADR captures the v1 surface; future expansion (PIM, /riskDetections, named locations, directory audit logs) lands as separate ADRs that name-check this one.
- **Agent-identity GA timing.** Phase E ships the IA without Microsoft's agent-identity field; once Microsoft GA's the schema, a forward-compat code path picks it up without an ADR amendment.

---

## References

- **ADR-0006** — Table roster + classification rules (extended by §3.1, §3.2, §3.3 below).
- **ADR-0011** — IngestHealth ETag-lease semantics (re-used unchanged).
- **ADR-0012 §5** — Plain-text-only rendering of Microsoft-authored prose.
- **ADR-0013 §3** — Scope-catalogue growth policy (extended in this commit).
- **ADR-0014** — Cursor-paged ingest pattern (re-used by Phase C).
- **ADR-0015** — Audit chain hash semantics (extended by §10).
- **ADR-0016** — Read endpoint contract (re-used per phase).
- **ADR-0023** — EntraRisk vertical (sticky `licence_required` pattern re-used by §6).
- **ADR-0025** — TenantSettings + admin settings page (re-used by §4).
- **Microsoft Learn — Graph throttling limits.** https://learn.microsoft.com/en-us/graph/throttling-limits
- **Microsoft Learn — `/users` `signInActivity` property.** https://learn.microsoft.com/en-us/graph/api/resources/signinactivity
- **Microsoft Learn — `/auditLogs/signIns`.** https://learn.microsoft.com/en-us/graph/api/signin-list
- **Microsoft Learn — `/identity/conditionalAccess/policies`.** https://learn.microsoft.com/en-us/graph/api/resources/conditionalaccesspolicy
- **Microsoft Learn — `/servicePrincipals`.** https://learn.microsoft.com/en-us/graph/api/serviceprincipal-list
