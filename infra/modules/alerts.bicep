// alerts.bicep — RG-scope monitoring primitives.
//   - ActionGroup (email-only) for cost + AgentRun alerts.
//   - AgentRun token-consumption anomaly alert rule on App Insights
//     (ADR-0017 §Decision.8 item 3, ADR-0019 AgentRun custom event).
//
// Shared module so the budget (subscription-scope) and the alert rule
// (RG-scope) point at one ActionGroup. `adminEmail` is the only destination
// for MVP — no SMS / Teams / PagerDuty integrations in Phase 2. Extend here
// when a downstream op pattern is settled.

targetScope = 'resourceGroup'

param workload string
param environment string
param regionShort string
param tags object

@description('Admin email for cost + anomaly alerts.')
param adminEmail string

@description('Application Insights resource ID — target of the AgentRun anomaly alert.')
param appInsightsResourceId string

@description('Log Analytics workspace resource ID — target of the L12-FT-03 KV ABAC-denial alert + L12-FT-06 share-link probe alert. KV diagnostics land in `AzureDiagnostics`, Function App logs land in `FunctionAppLogs`; both tables live in this workspace.')
param logAnalyticsWorkspaceResourceId string

@description('Daily token budget (sum of tokensIn + tokensOut). Alert fires when rolling 1h sum exceeds 3× this value per ADR-0017 §Decision.8 item 3.')
@minValue(1000)
@maxValue(100000000)
param dailyTokenBudget int = 200000

@description('Deploy the AgentRun anomaly alert rule. Gated by the top-level `deployAiAgents` toggle — set to false for ingest-only deployments where no AgentRun custom events will ever fire. The ActionGroup is retained unconditionally (shared with cost-budget alerts). HANDOVER §6.3 `deployAiAgents` item.')
param deployAiAgents bool = true

@description('L12-FT-03 — deploy the KV SecretGet Forbidden alert rule. Fires when a managed identity attempts to read a secret outside its ABAC allowlist (closes the silent-403 observability gap surfaced in the SEC-L-L12-04 WS10 review). Default true; operators can disable during the first deploy of L12-04 if RA propagation produces transient false positives.')
param deployKvAbacDenialAlert bool = true

@description('L12-FT-03 — minimum number of KV `SecretGet` Forbidden events in the 1h evaluation window before the alert fires. Default 1 (single denial is forensically interesting). Bump during noisy deploys if RA propagation flaps; reset once steady-state.')
@minValue(1)
@maxValue(1000)
param kvAbacDenialThreshold int = 1

@description('L12-FT-06 — deploy the share-link probe alert rule. Fires when invalid_token / bad_token_shape / tenant_mismatch warns from `GET /api/reports/share/{token}` exceed the burst threshold (closes the share-link brute-force observability gap surfaced in the audit-chain WS10 review). Default true; harmless when REPORT_SHARE_URL_BASE is unset (no share-link reads, no alert fire).')
param deployShareLinkProbeAlert bool = true

@description('L12-FT-06 — minimum number of share-link probe warns in the 5-minute evaluation window before the alert fires. Default 20 (a recipient mis-clicking a stale link once or twice should NOT page; sustained burst from one CIDR is the signal).')
@minValue(1)
@maxValue(10000)
param shareLinkProbeThreshold int = 20

var actionGroupName = 'ag-${workload}-${environment}-${regionShort}'
var agentRunAlertName = 'alert-${workload}-agentrun-anomaly-${environment}-${regionShort}'
var kvAbacDenialAlertName = 'alert-${workload}-kv-abac-denial-${environment}-${regionShort}'
var shareLinkProbeAlertName = 'alert-${workload}-share-link-probe-${environment}-${regionShort}'

// Threshold: 3× daily budget over 1 hour (ADR-0017 §Decision.8 item 3).
// Integer maths to keep the alert rule deterministic.
var tokensPerHourCeiling = dailyTokenBudget * 3

// -- ActionGroup --

resource actionGroup 'Microsoft.Insights/actionGroups@2024-10-01-preview' = {
  name: actionGroupName
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take('aegis-${environment}', 12)
    enabled: true
    emailReceivers: [
      {
        name: 'admin-email'
        emailAddress: adminEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

// -- AgentRun token-consumption anomaly alert --
//
// Scheduled query alert on App Insights customEvents. Fires when the sum of
// tokensIn + tokensOut across AgentRun events in the last 1h exceeds 3× the
// daily budget. Catches:
//   - Prompt-injection-induced reasoning loops that bypass in-orchestrator
//     budget via concurrent runs.
//   - Regressions in per-agent budget enforcement introduced by future agent
//     verticals.

resource agentRunAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (deployAiAgents) {
  name: agentRunAlertName
  location: resourceGroup().location
  tags: tags
  properties: {
    displayName: 'Aegis AgentRun token-consumption anomaly'
    description: 'Rolling-1h sum of AgentRun tokensIn + tokensOut exceeded 3× the configured daily budget (${dailyTokenBudget} tokens/day, ceiling ${tokensPerHourCeiling} tokens/hr). ADR-0017 §Decision.8 item 3.'
    // Severity 1 (Error) — prompt-injection reasoning loops that bypass the
    // in-orchestrator budget are a security signal, not a warning. OBS-STEP5-INFRA-01.
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT1H'
    scopes: [
      appInsightsResourceId
    ]
    targetResourceTypes: [
      'microsoft.insights/components'
    ]
    criteria: {
      allOf: [
        {
          // Time window is scoped by `windowSize: PT1H` on the rule; a
          // redundant `| where timestamp > ago(1h)` filter was removed
          query: 'customEvents\n| where name == "AgentRun"\n| extend tokensIn = toint(customDimensions["tokensIn"]),\n         tokensOut = toint(customDimensions["tokensOut"])\n| summarize totalTokens = sum(coalesce(tokensIn, 0) + coalesce(tokensOut, 0))'
          timeAggregation: 'Total'
          metricMeasureColumn: 'totalTokens'
          operator: 'GreaterThan'
          threshold: tokensPerHourCeiling
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

// -- L12-FT-03 — Key Vault ABAC-denial alert --
//
// Fires when a managed identity attempts to read a secret OUTSIDE its
// ABAC allowlist (SEC-L-L12-04 closure). KV ABAC denials surface as
// `Forbidden` results on `SecretGet` operations in `AzureDiagnostics`.
// Without this alert the denial is silent at the application layer —
// the MI just gets a 403 and the app's existing error handling logs
// it — but operators have no aggregate signal of "ABAC is doing what
// we expect" OR "ABAC is misconfigured" OR "an attacker is probing".
//
// Severity 2 (Warning) — a denial is forensically interesting but
// not P1. Tune to severity 1 if a tenant onboards a SOC that wants
// it page-worthy.

resource kvAbacDenialAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (deployKvAbacDenialAlert) {
  name: kvAbacDenialAlertName
  location: resourceGroup().location
  tags: tags
  properties: {
    displayName: 'Aegis KV ABAC denial (SEC-L-L12-04 / L12-FT-03)'
    description: 'Managed-identity attempt to read a Key Vault secret outside its ABAC allowlist. Investigate via the projected `identity_claim_xms_mirid_s` (the MI) + `id_s` (the targeted secret name) + `CallerIPAddress`. Routine cause: a misconfigured deploy. Adversarial cause: token theft + lateral movement attempt.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    scopes: [
      logAnalyticsWorkspaceResourceId
    ]
    targetResourceTypes: [
      'microsoft.operationalinsights/workspaces'
    ]
    criteria: {
      allOf: [
        {
          // Window scoping comes from `windowSize: PT1H` on the rule
          // (matches the AgentRun pattern at line 92 above) — no
          // redundant `| where TimeGenerated > ago(1h)` filter.
          // L12-FT-FT-IDENTITY-COLUMN — the generic `Identity` column
          // populates for BOTH MI-token and operator-CLI calls;
          // `identity_claim_xms_mirid_s` is MI-token-only (the
          // `xms_mirid` claim doesn't exist on user tokens). Projecting
          // both gives the SOC analyst a single column that always has
          // a value PLUS the structured MI resource ID when present.
          //
          // L12-FT-FT-IDENTITY-COLUMN follow-up: wrap ALL
          // dynamic columns in `column_ifexists("col", "")` so deploy-time
          // KQL semantic validation passes against a truly fresh
          // workspace schema (NO AzureDiagnostics rows yet).
          //
          // History:
          //   v1 (87c79c5) — added `Identity` column. Validation passed
          //     against existing dev workspace because dev already had
          //     KV audit rows from older operations. **Broke on fresh
          //     workspace** (`Identity` not in discovered schema).
          //   v2 (39f1d25) — wrapped only `Identity`. Validation passed
          //     against existing dev workspace. **Broke again on fresh
          //     workspace** (`identity_claim_xms_mirid_s` also not in
          //     discovered schema — my assumption that `_s`-suffix
          //     columns are schema-tolerant was wrong for workspaces
          //     with zero historical KV audit rows).
          //   v3 (this commit) — wrap ALL dynamic columns. Definitive.
          //
          // Without this, `azd provision` against a customer's clean
          // tenant fails with `'project' operator: Failed to resolve
          // scalar expression named '<col>'`. Each column surfaces with
          // a real value immediately once the first matching KV ABAC
          // denial lands in the workspace.
          //
          // Captured during the fresh `azd up` walk-through documented
          // in `docs/onboarding-runbook.md` — the runbook references this
          // commit as proof the alert is now fresh-workspace-safe.
          query: 'AzureDiagnostics\n| where ResourceType == "VAULTS"\n| where OperationName == "SecretGet"\n| where ResultType == "Forbidden" or ResultSignature has "Forbidden"\n| extend IdentitySafe = column_ifexists("Identity", "")\n| extend MiResourceId = column_ifexists("identity_claim_xms_mirid_s", "")\n| extend SecretId = column_ifexists("id_s", "")\n| extend CallerIp = column_ifexists("CallerIPAddress", "")\n| project TimeGenerated, IdentitySafe, MiResourceId, SecretId, CallerIp, ResultType, ResultDescription'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: kvAbacDenialThreshold
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

// -- L12-FT-06 — share-link probe alert --
//
// Fires when failed-verification warns from `GET /api/reports/share/
// {token}` exceed a burst threshold over 5 minutes. The handler at
// `api/src/functions/getReportShare.ts` emits structured warns for
// every failed-verification branch:
//   - bad_token_shape       (regex reject — malformed path)
//   - invalid_token         (signature / version failure)
//   - tenant_mismatch       (token tenant ≠ FA tenant)
//   - link_expired          (NOT included here — recipient clicked
//                            a stale link, benign in practice)
//   - signing_key_unavailable (NOT included here — infra failure,
//                              not a probe signal)
//   - snapshot_missing      (NOT included here — operator-triggered
//                            right-to-erasure on a deleted period)
//
// Three security-relevant branches; sustained burst from one CIDR
// is the probe signal. The audit chain doesn't carry these (failed
// verification reveals nothing about a snapshot), so this KQL
// surface is the only detection signal.
//
// Severity 2 (Warning) — same posture as the KV ABAC alert.

resource shareLinkProbeAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (deployShareLinkProbeAlert) {
  name: shareLinkProbeAlertName
  location: resourceGroup().location
  tags: tags
  properties: {
    displayName: 'Aegis share-link probe burst (L12-FT-06)'
    description: 'Burst of failed-verification warns from `GET /api/reports/share/{token}`. Investigate the projected `correlationId` series, cross-reference with FunctionApp ingress logs for the source CIDR, and consider rotating the share-link signing key (provision-report-share-signing-key.ps1 -Mode Rotate) if the burst persists.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [
      logAnalyticsWorkspaceResourceId
    ]
    targetResourceTypes: [
      'microsoft.operationalinsights/workspaces'
    ]
    criteria: {
      allOf: [
        {
          // Window scoping comes from the rule. `has_any` is the
          // idiomatic KQL multi-token match for this kind of
          // log-message-pattern signal (faster than three OR'd
          // `contains` clauses on a high-volume table).
          query: 'FunctionAppLogs\n| where Message has_any ("report.html.share.invalid_token", "report.html.share.bad_token_shape", "report.html.share.tenant_mismatch")\n| project TimeGenerated, Message, _ResourceId'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: shareLinkProbeThreshold
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

output actionGroupId string = actionGroup.id
// Null-safe — empty when the alert is skipped (`deployAiAgents=false`).
output agentRunAlertId string = agentRunAlert.?id ?? ''
output kvAbacDenialAlertId string = kvAbacDenialAlert.?id ?? ''
output shareLinkProbeAlertId string = shareLinkProbeAlert.?id ?? ''
