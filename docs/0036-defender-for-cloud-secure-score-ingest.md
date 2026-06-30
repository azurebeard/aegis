# ADR-0036 — Microsoft Defender for Cloud Secure Score ingest

**Status:** Accepted
**Date:** 2026-05-10
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Aegis already ingests **Microsoft Secure Score** (`/v1.0/security/secureScores`, ADR-0011 / ADR-0012) — a tenant-wide score covering M365 + Entra ID controls (Identity, Apps, Data, Device pillars). This score does NOT cover Azure resource posture: VM patch hygiene, storage encryption settings, network exposure, IAM on Azure resources, KV soft-delete, etc. That second posture surface is **Microsoft Defender for Cloud Secure Score** (formerly Azure Security Center), exposed via a different data plane (ARM, not Microsoft Graph) and a different API:

- `GET https://management.azure.com/subscriptions/{id}/providers/Microsoft.Security/secureScores?api-version=2020-01-01`
- `GET https://management.azure.com/subscriptions/{id}/providers/Microsoft.Security/secureScoreControls?api-version=2020-01-01`

Operator request (HANDOVER §10.55-or-thereabouts): surface this as a separate tile + ingest source so a single dashboard shows both posture surfaces side-by-side, disambiguated by the tile titles "Microsoft Secure Score" (M365/Entra) and "Defender for Cloud Secure Score" (Azure resources).

Scope bound:

- **Read-only.** No write paths on Defender for Cloud recommendations. ARM RBAC `Security Reader` is the only subscription-scope role granted (v1.1+; was `Reader` in v1; see §5); Aegis cannot dismiss or remediate findings via the API.
- **Dedicated ARM-only identity.** v1.2 splits the ARM data-plane MI off from the shared Graph `ingest` MI onto a new `armIngest` MI (`id-aegis-arm-ingest-<env>-<region>`). The ARM identity has subscription-scope `Security Reader` + table-scoped Contributor on `AzureSecureScores` + `IngestHealth`. It has NO Graph permissions and NO other table scopes; the Graph `ingest` MI has NO subscription-scope role and NO `AzureSecureScores` access. Bounds cross-data-plane blast radius — a compromise of one MI does not grant access to the other plane.
- **Single data-plane addition.** The Microsoft Graph deny-list (ADR-0013 §3) is unchanged — this ADR adds an ARM-API consumer, not a Graph one. The ARM API has its own permission model (Azure RBAC subscription-scoped); the Graph deny-list does not apply.
- **Single subscription in v1.** The arm-ingest MI gets `Security Reader` on ONE subscription (the one the FA itself is deployed to, sourced from `AZURE_SUBSCRIPTION_ID`). Multi-subscription operator-managed lists are deferred to a v2 phase once a customer asks.
- **No agent-plane consumption.** Score data does NOT enter the brief / posture / incidents-analysis prompt context. Posture-shaped, not narrative-shaped.
- **No PII surface.** Scores are aggregate numbers; control names are Microsoft-published strings. Neither is PII.

The decisions to settle:

1. **Auth model** — how the ingest MI authenticates to ARM.
2. **Cadence** — Timer schedule.
3. **Table schema + retention.**
4. **TenantSettings row added.**
5. **RBAC grant** — Bicep change.
6. **Ingest-source identifier + audit chain key.**
7. **UI surfaces** — tile + admin section + reports HTML.
8. **Phase ordering.**

---

## Decision

### 1. Auth model

The ingest MI already exists (ADR-0010 §4 — `id-aegis-ingest-<env>-<region>`) and holds Microsoft Graph app-role assignments for the verticals shipped to date. ARM is a separate audience: tokens are acquired against `https://management.azure.com/.default` rather than `https://graph.microsoft.com/.default`. The MI's `DefaultAzureCredential` flow handles audience selection at runtime — a SECOND `armClient.ts` library mirrors `graphClient.ts` shape but passes the ARM scope to `credential.getToken(...)`.

Authorisation is via Azure RBAC:

- New role assignment in Bicep — `Microsoft.Authorization/roleAssignments@2022-04-01` at **subscription scope**, principalId = **armIngest MI** (v1.2), roleDefinitionId = built-in **Security Reader** (`39bc4728-0917-49c7-9d2c-d95423bc2eb4`). See §5 history for the v1→v1.1→v1.2 evolution.
- `Security Reader`'s `Microsoft.Security/*/read` covers `secureScores` + `secureScoreControls`; its `Microsoft.Resources/subscriptions/read` covers the SubscriptionName resolution path.
- Subscription-scope (not management-group-scope) keeps the blast radius bounded; multi-sub support in v2 either widens scope or assigns Security Reader on each tracked subscription separately.

### 2. Cadence

**Daily Timer at 02:30 UTC** (`30 30 2 * * *` NCRONTAB). Reasons:

- Defender for Cloud's secure-score recomputation is daily (Microsoft does not document a faster cadence; field observation: scores stabilise overnight after policy enforcement runs).
- 02:30 sits between the **02:00 KEV ingest** and the **03:00 Microsoft Secure Score ingest** so the diagnostics page shows a complete daily picture.
- Backfill on first run is unnecessary — the score is a CURRENT-state snapshot, not a time series; we accumulate the trend by snapshotting daily into a per-day RowKey.

### 3. Table schema

New table `AzureSecureScores`. Per-(tenantId, subscriptionId, snapshotDate) snapshot:

| Field | Source | Type | Notes |
|---|---|---|---|
| `PartitionKey` | `<tenantId>` | string | Multi-tenant forward-compat. |
| `RowKey` | `<subscriptionId>_<snapshotDate>` | string | Compound key — `subscriptionId` is a GUID, `snapshotDate` is `yyyy-mm-dd`. Mirrors MicrosoftSecureScore + IncidentSnapshots compound-key pattern. |
| `SubscriptionId` | URL path | string | GUID. Defence-in-depth replica of the RowKey prefix. |
| `SubscriptionName` | ARM `/subscriptions/{id}?api-version=2022-12-01` | string | Cached on first run; refreshed when SubscriptionId changes. Empty when Reader cannot read the parent `Microsoft.Resources/subscriptions` object (rare — Reader role usually covers it). |
| `SnapshotDate` | handler clock (`yyyy-mm-dd` UTC) | string | ISO date. |
| `CurrentScore` | `score.current` | number | 0..maxScore. Number of points the subscription has earned. |
| `MaxScore` | `score.max` | number | Total points available. Microsoft adjusts this as new controls land. |
| `Percentage` | `score.percentage` | number | 0..100. Convenience pre-compute (= current / max × 100). |
| `Weight` | `weight` | number | Multiplier in multi-subscription rollups. Captured even though v1 is single-sub for forward-compat. |
| `IngestedAt` | handler clock (ISO8601 UTC) | string | |
| `IngestRunId` | GUID | string | |

**Retention:** snapshot-replace IS NOT correct here — we want a 90-day trend (mirrors ADR-0011 §6 MicrosoftSecureScore). Daily writes accumulate; reads scan the partition + date-range filter. A retention sweep deletes rows older than 90 days on each ingest run (matches `trimSecureScoreRetention` pattern).

**Forward-compat:** `secureScoreControls` per-control breakdown is NOT ingested in v1 — the per-control list is large (50+ rows × N subscriptions) and the operationally relevant signal is the headline percentage. v2 adds a `AzureSecureScoreControls` table mirroring `SecureScoreControlProfiles`.

### 4. TenantSettings rows

**None added in v1.** The single-subscription target is sourced from `AZURE_SUBSCRIPTION_ID` env var (Bicep-set, FA app setting). No operator-facing toggle for "which subscriptions to track" until multi-sub v2.

### 5. RBAC grant — Bicep change

`infra/modules/storage-ops.bicep` extends `tableNames` with `'AzureSecureScores'` + adds two table-scoped role assignments (Contributor for ingest MI, Reader for api-reader MI), matching the pattern used by every other table in this module.

`infra/modules/defender-cloud-rbac.bicep` adds the subscription-scoped Security Reader assignment (v1.1 — see history note below):

```bicep
resource ingestMiSubscriptionSecurityReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, ingestMiPrincipalId, '39bc4728-0917-49c7-9d2c-d95423bc2eb4')
  scope: subscription()
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '39bc4728-0917-49c7-9d2c-d95423bc2eb4'
    )
    description: 'Ingest MI — Security Reader on subscription for Defender for Cloud Secure Score ingest (ADR-0036 + WS10 M-Q1).'
  }
}
```

**Identity (v1.2).** The role assignment targets the dedicated `armIngest` MI defined in `infra/modules/identities.bicep` — NOT the shared Graph `ingest` MI. Split per WS10 M-Q2 forward-track. The ARM-only identity carries: subscription-scope `Security Reader`, table-scoped `Storage Table Data Contributor` on `AzureSecureScores`, and table-scoped `Storage Table Data Contributor` on `IngestHealth` (so the ARM ingest path can write its own freshness row alongside the Graph ingest path; both can write — table-level Contributor doesn't conflict on different RowKeys).

**Role choice — `Security Reader` (v1.1+).** Microsoft documents `Security Reader` as the minimum for Defender for Cloud read APIs. The role's `Actions` list includes both `Microsoft.Security/*/read` (secure-score endpoints) and `Microsoft.Resources/subscriptions/read` (parent-subscription metadata for SubscriptionName resolution), so the ingest works without further widening. Aligns with CIS Microsoft Azure Foundations 1.23 (least-privilege).

**History.**

- **v1** — Subscription-scope `Reader` (`acdd72a7-3385-48ef-bd42-f606fba81ae7`) assigned to the shared Graph `ingest` MI. Rationale (since superseded): match the rest of the project's tenant-monitoring tooling and keep one identity per ingest plane.
- **v1.1 (§10.67 follow-up, 2026-05-12)** — Tightened to `Security Reader` (`39bc4728-0917-49c7-9d2c-d95423bc2eb4`); WS10 M-Q1 closed. Same shared `ingest` MI.
- **v1.2 (§10.67 follow-up, 2026-05-12)** — Moved the subscription-scope assignment AND the `AzureSecureScores` + `IngestHealth` table-Contributor grants off the shared `ingest` MI onto a new dedicated `armIngest` MI (`id-aegis-arm-ingest-<env>-<region>`). WS10 M-Q2 closed. Result: cross-data-plane blast-radius bounded — compromise of `ingest` no longer grants ARM read, compromise of `armIngest` no longer grants Graph read or any non-secure-score table write.

**Deployment caveat — orphaned v1.1 Security Reader on the `ingest` MI.** v1.2 moves the assignment to a new principalId (`armIngest` MI), so Bicep deploys a new assignment under a new GUID name. The v1.1 Security Reader assignment on the original `ingest` MI is NOT removed by Bicep — operators must delete it out-of-band, AFTER the new `armIngest` assignment is live and the next timer run has been confirmed succeeding under the new identity:

```bash
# Resolve principalIds.
INGEST_MI=$(azd env get-values | grep '^INGEST_MI_PRINCIPAL_ID=' | cut -d= -f2 | tr -d '"')
ARM_INGEST_MI=$(azd env get-values | grep '^ARM_INGEST_MI_PRINCIPAL_ID=' | cut -d= -f2 | tr -d '"')
SUB=$(az account show --query id -o tsv)

# 1. Provision the v1.2 change (creates armIngest MI + its Security Reader assignment;
#    legacy ingest MI's Security Reader stays in place during the soak).
azd provision

# 2. Confirm the new assignment is visible at subscription scope on armIngest.
az role assignment list \
  --assignee "$ARM_INGEST_MI" \
  --scope "/subscriptions/$SUB" \
  --query "[?roleDefinitionName=='Security Reader']" -o table

# 3. Trigger a smoke run (admin POST /api/ingest/azure-secure-score/run) or wait
#    for the next 02:30 UTC timer; confirm it succeeds in App Insights under the
#    new armIngest principalId (audit chain `callerPrincipalMiClientId` field).
#
#    ROLLBACK ON SMOKE FAILURE: if step 3 fails, do NOT proceed to step 4.
#    Both MIs hold their respective grants at this point so the ingest path is
#    safe (legacy ingest path still has Security Reader). Investigate via App
#    Insights `azureSecureScore.ingest.error` + ARM 403 audit lines; re-run
#    smoke after fixing. Only proceed to step 4 once a green smoke is on file.

# 4. Only after step 3 succeeds, delete the legacy Security Reader assignment
#    from the original ingest MI:
az role assignment delete \
  --assignee "$INGEST_MI" \
  --role 'Security Reader' \
  --scope "/subscriptions/$SUB"

# 5. Also delete the legacy AzureSecureScores table Contributor on the original
#    ingest MI. The new armIngest MI has its own grant; the legacy grant is now
#    over-grant.
INGEST_ROLE_ASGN=$(az role assignment list \
  --assignee "$INGEST_MI" \
  --query "[?contains(scope, 'AzureSecureScores') && roleDefinitionName=='Storage Table Data Contributor'].id" -o tsv)
test -n "$INGEST_ROLE_ASGN" && az role assignment delete --ids "$INGEST_ROLE_ASGN"
```

The intermediate state between step 1 and step 5 has BOTH MIs assigned to one or both roles, so the ingest path always has at least one route. The reverse ordering (delete first, then provision) opens a window where neither identity has access.

**Residual risk — IngestHealth table-Contributor surface (WS10 v1.2 MED).** v1.2 left this open: both `ingest` and `armIngest` MIs held `Storage Table Data Contributor` on the shared `IngestHealth` table, and a compromise of either could `UpsertEntity` against a RowKey owned by the other plane to mask outages. **Closed in v1.3.**

**v1.3 — IngestHealth split (per WS10 option (b)).** A new `ArmIngestHealth` table holds the freshness rows for `azure.security.*` sources; the legacy `IngestHealth` retains the rows for Graph-plane sources. Grants:

- `ingest` MI: `Storage Table Data Contributor` on `IngestHealth` only. No access to `ArmIngestHealth`.
- `armIngest` MI: `Storage Table Data Contributor` on `ArmIngestHealth` only. No access to `IngestHealth` (legacy grant from v1.2 revoked post-provision per the runbook below).
- `apiReader` MI: account-scope `Storage Table Data Reader` covers both tables transparently.

A compromise of either ingest MI can no longer forge a cross-plane freshness row.

**Source-to-table routing.** `api/src/lib/tables.ts:ingestHealthTableNameForSource(source)` returns `ArmIngestHealth` for any source whose name starts with `azure.`, else `IngestHealth`. Writers (ARM ingest runner) and point-readers (`getAzureSecureScoreSummary`, `settingsResponse.buildFullSettingsResponse`) use the helper. Aggregate readers (`getNotifications`, `reportEnvelope.assembleIngestHealth`) use `listHealthRowsFederated(ctx, tenantId)` which queries both tables concurrently and concatenates the rows.

**Defensive read-side filter (WS10 v1.3 F2 mitigation).** The federated reader drops any row from the legacy `IngestHealth` half whose RowKey starts with `azure.`. Pre-v1.3 deploys persisted an `azure.security.defenderForCloud.secureScores` row into `IngestHealth`; that row is now stale (the canonical home is `ArmIngestHealth`) but cannot be deleted by the standing ingest identities because they no longer have write access to the legacy table. The filter ensures the notifications panel doesn't fire a spurious `ingest-degrading` alert against the stale row once its `lastSuccessAt` ages out.

**Deployment caveat — v1.2 → v1.3 transition.** Bicep deploys the new `armIngest → ArmIngestHealth` grant under a new GUID name; it does NOT remove the v1.2 `armIngest → IngestHealth` grant. Operators must revoke it post-provision (the stale-row delete is optional — read-side filter handles it):

```bash
ARM_INGEST_MI=$(azd env get-values | grep '^ARM_INGEST_MI_PRINCIPAL_ID=' | cut -d= -f2 | tr -d '"')
SUB=$(az account show --query id -o tsv)
TABLES_SCOPE="/subscriptions/$SUB/resourcegroups/<rg>/providers/Microsoft.Storage/storageAccounts/<ops-storage-account>/tableServices/default/tables"

# 1. Provision the v1.3 change (creates ArmIngestHealth + armIngest's
#    new Contributor grant on it; legacy IngestHealth grant stays).
azd provision

# 2. Deploy the API code (writers/readers use the new helper).
azd deploy api

# 3. Confirm armIngest now has both Contributor grants live:
az role assignment list --assignee "$ARM_INGEST_MI" --all \
  --query "[?contains(scope, 'tables/')].{role:roleDefinitionName,scope:scope}" -o table

# 4. Trigger an admin smoke run OR wait for the 02:30 UTC timer; confirm
#    success in App Insights with the new ArmIngestHealth lineage.
#
#    ROLLBACK ON SMOKE FAILURE: if step 4 fails, do NOT proceed to step 5.
#    armIngest still has both Contributor grants so the legacy path is
#    available; investigate via App Insights `azureSecureScore.ingest.error`
#    + ARM 403 audit lines.

# 5. Only after step 4 succeeds, revoke the v1.2 grant:
az role assignment delete \
  --assignee "$ARM_INGEST_MI" \
  --role 'Storage Table Data Contributor' \
  --scope "$TABLES_SCOPE/IngestHealth"

# 6. (Optional) Delete the stale row from IngestHealth. Requires an ad-hoc
#    `Storage Table Data Contributor` grant on your user, since the
#    standing ingest identities no longer have write access. Read-side
#    filter handles it if you skip this step.
```

### 6. Ingest source + audit chain

- **Source identifier:** `azure.security.defenderForCloud.secureScores`
- **Audit chain key:** new `(azure.security.defenderForCloud.secureScores, tenantId)` chain. `ingest.run` line shape mirrors `graph.security.secureScores`. New optional fields on the audit-line type: `subscriptionId`, `currentScore`, `maxScore`, `percentage`.
- **Retention:** chain lines retained per ADR-0011 §6 (180d prod / 14d dev).

### 7. UI surfaces

- **Dashboard tile:** new `AzureSecureScoreTile` — hero: percentage; caption: score/max + subscription count + `Subscription: <name|id-prefix>`. 90-day sparkline mirroring the Microsoft Secure Score tile (reuses `SecureScoreTrend` if its props can be generalised; otherwise a minimal copy).
- **Tile visibility:** new `azureSecureScore` TILE_KEY (default true; legacy rows coerce true per ADR-0025 §1).
- **`/admin/diagnostics`:** new ingest source card via the existing `SOURCES` array — reuses the per-source run-history accessor.
- **Reports HTML renderer:** new section "Defender for Cloud Secure Score" rendered after the "Microsoft Secure Score" section in the board-pack envelope. Empty-state copy matches the existing `secureScore` empty.
- **Refresh-now:** admin trigger endpoint `POST /api/ingest/azure-secure-score/run` (rate-limited 30/day per tenant; admin-only).

### 8. Phase ordering

1. **This ADR + ADR-0013 §3 catalogue note.** No code, no Bicep edit. (this commit.)
2. **Phase A — ingest + tile.** Bicep RBAC + table; ARM client; parser; store; orchestrator; Timer; admin trigger; read endpoints; tile; HomePage wiring; Reports HTML section; tests; WS10. (this commit also.)
3. **Phase B (future) — multi-subscription operator-managed list.** TenantSettings `azure-secure-score-config` row; admin section; per-subscription drill-down; SubscriptionId-aware widening of the partition scan.
4. **Phase C (future) — per-control breakdown.** New `AzureSecureScoreControls` table; per-control drill-down page; trends per control.

Phases B + C are independently shippable; this ADR does not require them.

---

## Privacy + plain-text-only invariant

ADR-0012 §5 plain-text-only on Microsoft-authored prose extends to control-name strings (when Phase C ships). v1 only exposes aggregate numbers + the subscription's own GUID/name; both are operator-visible posture signals, not PII per UK GDPR Recital 30.

**Operator-visible only.** Reader-or-admin on read endpoints (matches Phase 8B/8C/8D/8E reader posture per ADR-0034 §9 amendment). Admin-only on the Refresh-now run.

**No agent-plane consumption.** None of the four agent-plane prompt builders consume Defender for Cloud data. Existing 4-layer prompt-injection defence (ADR-0020 §6) does not absorb new prose because there's no prose surface in v1.

---

## Audit chain extension

ADR-0015 §5 audit-line schema additions:

- New optional fields: `subscriptionId` (GUID), `currentScore` (number), `maxScore` (number), `percentage` (number).
- New `eventType` value NOT added — `ingest.run` is sufficient. Per-control diff detection (Phase C) would add a `azure.score.changed` eventType then.

---

## Out of scope

- **Multi-cloud Defender** (AWS, GCP). Defender for Cloud supports cross-cloud connectors, but the ARM secureScores endpoint only returns the Azure-pillar score. Cross-cloud is a v3+ ADR if a customer asks.
- **Compliance Manager** scores. Different service, different API; tracked separately.
- **Sentinel workspace health.** Niche to Sentinel customers; tracked separately.
- **Recommendation-level remediation.** Read-only posture; no write paths in v1, v2, or v3.

---

## References

- Microsoft Learn — Defender for Cloud Secure Score: https://learn.microsoft.com/en-us/azure/defender-for-cloud/secure-score-security-controls
- ARM API — `Microsoft.Security/secureScores`: https://learn.microsoft.com/en-us/rest/api/defenderforcloud/secure-scores/list
- Built-in role — `Security Reader`: https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#security-reader
- Built-in role — `Reader` (historical, v1): https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#reader
- CIS Microsoft Azure Foundations Benchmark — least-privilege role guidance: https://www.cisecurity.org/benchmark/azure
