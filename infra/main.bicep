// main.bicep — XDR Hub (codename: aegis) — subscription-scope entry point
// Step 1 foundations: RG + Storage (ops + audit) + Key Vault + App Insights + Log Analytics + managed identities.
// Ref: PROJECT_BRIEF.md §15 build order; ADR-0001 naming; WS10 verdict 2026-04-18.

targetScope = 'subscription'

// -- Parameters --

@description('Workload token used in every resource name. ADR-0001.')
param workload string = 'aegis'

@allowed([
  'dev'
  'test'
  'prod'
])
@description('Environment token. Drives the hardening tier: prod gets locked WORM, resource locks, and KV purge protection; dev and test do not.')
param environment string

@description('Azure region name, e.g. uksouth.')
param region string = 'uksouth'

@description('Short region code used in resource names, e.g. uks for uksouth. ADR-0001.')
param regionShort string = 'uks'

// SWA region is INDEPENDENT of the main deploy region — Microsoft only
// hosts the Static Web Apps control plane in 5 regions. Decoupling lets
// a customer deploy backend resources in (say) `uksouth` while SWA
// metadata + linked-backend wiring lives in `westeurope`. The SWA edge
// CDN reaches users globally regardless of which of the 5 SWA regions
// the resource lives in — this param is a control-plane choice, not
// a user-latency choice. See:
// https://learn.microsoft.com/azure/static-web-apps/faq#how-do-i-ensure-my-app-is-deployed-to-a-specific-azure-region
//
// Phase 2 dry-run lesson (docs/prod-tier-dryrun-phase2-findings.md §4.1):
// previously the swa module took `location: region`, which failed with
// `LocationNotAvailableForResourceType` mid-provision for any operator
// whose `region` wasn't one of the 5 supported SWA regions. Default
// `westeurope` keeps the existing dev (already WEU) at parity.
@allowed([
  'centralus'
  'eastus2'
  'westus2'
  'westeurope'
  'eastasia'
])
@description('Static Web App location. SWA is only available in 5 regions; this is the control-plane location, not a user-latency choice (Azure routes via SWA edge regardless). Override with `AZURE_STATIC_WEB_APP_LOCATION`.')
param staticWebAppLocation string = 'westeurope'

@description('Admin email for cost alerts and (later) Easy Auth allowlist seed. Collected here so azd env captures it from the first deploy; consumed when the cost-alert Action Group lands in a later pass (PROJECT_BRIEF §11).')
#disable-next-line no-unused-params
param adminEmail string

@description('ADR-0035 §3 — bare-GUID application (client) ID of the API app registration created by `bootstrap-entra.ps1`. Populates `AEGIS_API_APP_ID` on the Function App for the v2.0 JWT `aud` validation. Empty on first deploy; the postprovision hook persists via `azd env set AZURE_AEGIS_API_APP_ID=<apiAppId>` reading `nativeAuth.apiAppId` from BOOTSTRAP_JSON.')
param aegisApiAppId string = ''

@description('ADR-0030 Phase C — operator-configured sender mailbox UPN (azd env var `AZURE_MAIL_SENDER_UPN`). Surfaced to the Function App as the `AZURE_MAIL_SENDER_UPN` app setting so `emailReportSnapshot.ts` and `settingsResponse.ts` can read it via `process.env`. Empty when Phase C is inert — admin send endpoint returns 503 not_configured until set.')
param azureMailSenderUpn string = ''

@description('ADR-0030 §C.21 / WS10 L12 — operator (or azd SP) object ID granted Key Vault Secrets Officer so `bootstrap-entra.ps1` can write/rotate the recipient-hash pepper. Empty disables the grant (headless/CI deploys that intentionally skip pepper provisioning). Surfaced via azd env var `AZURE_DEPLOYER_OBJECT_ID`.')
param deployerObjectId string = ''

@allowed([
  'User'
  'ServicePrincipal'
])
@description('L12-FT-OFFICER-PRINCIPAL-TYPE — principal type for the deployer Secrets Officer grant. Default `User` (operator-laptop deploys). CI / headless azd-SP deploys MUST set this via azd env var `AZURE_DEPLOYER_PRINCIPAL_TYPE=ServicePrincipal`. Threaded through to `keyvault.bicep` only — no effect when `deployerObjectId` is empty.')
param deployerPrincipalType string = 'User'

@description('F-fwd-3/F-fwd-4 — comma-separated operator CIDR allowlist applied to KV + ops storage `networkAcls.ipRules` when `publicNetworkAccess: Disabled`. Lets the operator running `azd provision` / `azd deploy` write secrets and upload the FA zip without flipping public access off-and-on. Empty (default) preserves the pre-fix posture. Surfaced via azd env var `AZURE_DEPLOYER_IP_ALLOWLIST` (example: `"203.0.113.42/32"` or `"203.0.113.42/32,198.51.100.7/32"`). Only applied to KV + ops storage; audit storage stays VNet-only (immutability surface, no operator-from-outside writes). IPv4 only (Storage + KV reject IPv6 ipRules).')
param deployerIpAllowlist string = ''

// Parsed once here so both consumer modules see a normalised array.
// `split('', ',')` returns [''] on empty input, which would inject an
// empty CIDR into `networkAcls.ipRules` and fail at provision with
// "InvalidIpRule". Guard with the ternary so empty input → empty array.
// No trim() — for-expression inside a ternary is rejected by Bicep
// (BCP138); operators must supply tokens without trailing whitespace
// ("a,b" not "a, b"). The runbook env-var section calls this out.
var deployerIpAllowlistArray = empty(deployerIpAllowlist) ? [] : split(deployerIpAllowlist, ',')

@description('SEC-L-L12-01 — when set to the literal string `"true"` (case-insensitive), the email send returns 502 instead of falling back to the legacy non-peppered hash if the Key Vault pepper cannot be loaded. Default empty preserves the fail-soft posture. Intended for prod after pepper provisioning is confirmed live. Surfaced via azd env var `AZURE_RECIPIENT_HASH_PEPPER_REQUIRED`.')
param recipientHashPepperRequired string = ''

@description('ADR-0030 §C.22 — override for the share-link URL base. When empty (default), derives from the SWA default hostname (https://<swa-hostname>/api/reports/share). Operators with a custom domain set this to that domain plus the path. Surfaced via azd env var AZURE_REPORT_SHARE_URL_BASE.')
param reportShareUrlBaseOverride string = ''

// L12-FT-01 — single source of truth for the two Aegis-managed Key
// Vault secret names. These vars are passed VERBATIM to both
// `keyvault.bicep` (where they bind the per-secret ABAC conditions
// from SEC-L-L12-04) and `functions.bicep` (where they become app
// settings the API reads via `process.env`). The PowerShell
// provisioning scripts (`provision-recipient-hash-pepper.ps1` +
// `provision-report-share-signing-key.ps1`) hardcode the same
// defaults in their `-SecretName` params — keep all three surfaces
// aligned. Drift fails closed (silent 403 on the MI read path);
// pinning the literals here narrows the drift surface to a single
// declaration that future contributors touching the secret names
// MUST update in lock-step.
var recipientHashPepperSecretName = 'recipient-hash-pepper'
var reportShareSigningKeySecretName = 'report-share-signing-key'
// ADR-0037 — same pattern. `scripts/provision-ransomware-live-api-key.ps1`
// (operator-side ops; runs out-of-band from azd provision) and
// `keyvault.bicep:ransomwareLiveSecretName` must stay in lock-step.
var ransomwareLiveSecretName = 'ransomware-live-api-key'

@minValue(30)
@maxValue(3650)
@description('Audit log retention in days. Applied as a locked time-based immutability policy in prod only; applied as a regular retention value in non-prod. PROJECT_BRIEF §4.')
param auditRetentionDays int = 365

@minValue(0)
@maxValue(3650)
@description('Incidents detail-blob retention in days (ADR-0014 §5). A sentinel 0 selects the env-aware default: 180 in prod, 14 in dev / test. An explicit positive value overrides the env-aware default — useful when a prod deploy needs a shorter window temporarily or dev needs a longer one for investigation.')
param incidentsRetentionDays int = 0

@description('NCRONTAB schedule for the incidents ingest Timer (ADR-0014 §1). Overridable per environment — dev/test may use a faster cadence for smoke tests.')
param incidentsTimerCron string = '0 */15 * * * *'

@minValue(0)
@maxValue(3650)
@description('EntraRisk Table row retention in days (ADR-0023 §6). Sentinel 0 selects the env-aware default: 180 in prod, 14 in dev / test. Mirrors incidentsRetentionDays.')
param entraRiskRetentionDays int = 0

@description('ADR-0030 §3 — report snapshot versions kept per (tenantId, periodKey). Floor of 3 enforced at param-level; production recommendation 3 (active ops) or 5+ (attestation-heavy).')
@minValue(3)
param reportSnapshotVersionsPerPeriod int = 3

@description('ADR-0030 §3 — report snapshot maximum age in days. Age-based trim is Phase B; param surfaces today so operators can set ahead of Phase B without redeploying. Production recommendation 2555 (7 years; covers Cyber Essentials Plus + NIS2 + UK GDPR audit horizons).')
@minValue(30)
param reportSnapshotRetentionDays int = 2555

@description('ADR-0032 §1 — KEV ingest Timer cron. Default 02:00 UTC daily.')
param kevTimerCron string = '0 0 2 * * *'

@description('ADR-0033 §5 Phase 2.5 — KevSuppressions expiry-sweep Timer cron. Default 03:00 UTC daily (one hour after KEV ingest).')
param kevSuppressionsSweepCron string = '0 0 3 * * *'

@description('ADR-0030 Phase B — report-snapshot auto-capture Timer cron. Default 04:00 UTC daily (after KEV ingest + sweep). Idempotent skip-if-already-captured.')
param reportSnapshotAutoCaptureCron string = '0 0 4 * * *'

@description('NCRONTAB schedule for the EntraRisk ingest Timer (ADR-0023 §1 — 4h cadence). Overridable per environment.')
param entraRiskTimerCron string = '0 0 */4 * * *'

@minValue(0)
@maxValue(3650)
@description('Daily-briefs blob retention in days (ADR-0022). Sentinel 0 selects the env-aware default: 180 in prod, 14 in dev / test. Mirrors `incidentsRetentionDays`.')
param briefRetentionDays int = 0

@description('NCRONTAB schedule for the brief-agent daily Timer (ADR-0022). Default `0 0 5 * * *` = 05:00 UTC daily. Overridable per environment.')
param briefTimerCron string = '0 0 5 * * *'

@minValue(1000)
@maxValue(100000000)
@description('Daily per-tenant token budget for brief-agent (ADR-0019). Single source of truth wired to BOTH the Function App `BRIEF_DAILY_TOKEN_BUDGET` app setting (code-plane enforcement) AND the App Insights AgentRun anomaly alert (Azure-plane ceiling = 3× this value over 1h). WS10 SEC-M-STEP5-INFRA-02 resolution — prevents drift between the two gates.')
param briefDailyTokenBudget int = 200000

@minValue(0)
@maxValue(3650)
@description('Posture-narratives blob retention in days (ADR-0027 §Decision.5). Sentinel 0 selects the env-aware default: 90 in prod (two-sprint window × 4 weeks + buffer), 21 in dev / test.')
param postureRetentionDays int = 0

@description('NCRONTAB schedule for the posture-agent weekly Timer (ADR-0027 §Decision.4). Default `0 0 6 * * 1` = 06:00 UTC Mondays. Overridable per environment.')
param postureTimerCron string = '0 0 6 * * 1'

@minValue(1000)
@maxValue(1000000)
@description('Per-tenant token budget for posture-agent within one ISO week (SEC-L-B2-01 resolution 2026-04-21 — AgentBudget row keyed per ISO week for posture, ceiling enforces weekly aggregate). Code-plane enforcement only.')
param postureWeeklyTokenBudget int = 20000

@minValue(0)
@maxValue(3650)
@description('Incident-narratives blob retention in days (ADR-0028 §Decision.5). Sentinel 0 selects the env-aware default: 180d prod / 90d dev. Retention is a belt-and-braces floor alongside the daily sweep that removes the row when the parent incident is purged.')
param incidentsAnalysisRetentionDays int = 0

@minValue(0)
@maxValue(3650)
@description('RansomwareIntel table retention in days (ADR-0037 §7). Sentinel 0 selects the env-aware default: 90 prod / 14 dev. Operator override via `azd env set AZURE_THREAT_INTEL_RETENTION_DAYS <int>`.')
param threatIntelRetentionDays int = 0

@description('NCRONTAB schedule for the ransomware.live PRO threat-intel Timer (ADR-0037 §1). Default `0 0 * * * *` = top of every hour, UTC. Operator override via `azd env set AZURE_THREAT_INTEL_TIMER_CRON "<cron>"`.')
param threatIntelTimerCron string = '0 0 * * * *'

@minValue(1000)
@maxValue(1000000)
@description('Daily per-tenant token budget for incidents-agent (ADR-0028 §Decision.4). On-demand only; ~750 tokens/run × 20 runs = 15K default.')
param incidentsAnalysisDailyTokenBudget int = 15000

@minValue(1)
@maxValue(168)
@description('Redaction-lock duration in hours for incidents-agent (ADR-0028 §Decision.7d). 24h default = typical investigation cadence.')
param incidentsAnalysisRedactionLockHours int = 24

@minValue(0)
@maxValue(100000)
@description('Monthly Foundry + ops budget in the billing account currency (ADR-0017 §Decision.8 item 1). Sentinel 0 selects the env-aware default: 25 (dev/test), 100 (prod).')
param foundryBudgetGbp int = 0

@description('Opt-in to the future Logic App auto-disable action when the cost budget hits 100% (ADR-0017 §Decision.8 item 1). MVP behaviour: notify-only. When the Logic App module lands, this toggle gates its deployment.')
param autoDisableOnBudgetBreach bool = false

@description('Start date for the cost budget. Must be the first of a month. Azure rules: (a) on first deployment, startDate must be the current month\'s first or later — earlier dates are rejected with "Start date for monthly time grain should not be prior to current month"; (b) once created, startDate is IMMUTABLE — Azure rejects any change with "Start date of budgets cannot be updated". The empty-string sentinel selects `_budgetStartDateFallback` (= utcNow first-of-month) for first deploys; subsequent deploys persist the canonical value via `AZURE_BUDGET_START_DATE` (azd env var written by postprovision) so re-runs in a later calendar month do not trigger the immutable-startDate rejection.')
param budgetStartDate string = ''

@description('Internal sentinel — computed at deployment start as the current month\'s first day. Bicep restricts `utcNow()` to parameter defaults, so the empty-string fallback for `budgetStartDate` routes through this sentinel. Do not override.')
param _budgetStartDateFallback string = utcNow('yyyy-MM-01')

var effectiveBudgetStartDate = empty(budgetStartDate) ? _budgetStartDateFallback : budgetStartDate

@description('Master switch for the network-perimeter posture. When `true`, `networking.bicep` provisions a VNet + 2 subnets + 5 private DNS zones + 6 private endpoints (KV / audit-SA blob / ops-SA blob+table+queue / Foundry), and the Function App gets VNet integration on `snet-func`. The backing modules switch `publicNetworkAccess` to `Disabled` (legacy behaviour preserved at `false`). Static Web App inbound stays public (linked-backend proxy requirement). See `docs/prod-tier-dryrun-phase1a-findings.md` §F2.')
param privateEndpointsEnabled bool = false

// Derived perimeter-posture knobs. Centralising them at the top of main.bicep
// keeps the consumer modules' inputs declarative (each takes `Enabled` /
// `Disabled` strings rather than re-deriving from the boolean flag).
var publicNetworkAccessOnBackingServices = privateEndpointsEnabled ? 'Disabled' : 'Enabled'

@minValue(7)
@maxValue(730)
@description('Log Analytics workspace retention in days.')
param logAnalyticsRetentionDays int = 30

@description('Optional suffix appended to globally-unique resource names (storage accounts, Key Vault) when a name collision is hit. ADR-0001.')
param uniqueSuffix string = ''

@description('Deploy the AI plane — Foundry project + model deployments + agent MI bindings + brief/posture/incidents-analysis handlers. Default true. Set to false for (a) evaluation/demo deployments that want just the ingest + dashboard surface, (b) regulated tenants that cannot permit third-party LLM retention even with Modified Abuse Monitoring, (c) air-gapped scenarios. HANDOVER §6.3 `deployAiAgents` item. When false, tables + blob containers for AI plane are retained (data-preservation on toggle) but all agent MI role assignments, Foundry module, and agent handler registrations are skipped.')
param deployAiAgents bool = true

// -- Environment-derived policy flags --

var isProd = environment == 'prod'
var auditImmutabilityEnabled = isProd
var resourceLocksEnabled = isProd
var kvPurgeProtection = isProd
var kvSoftDeleteRetentionDays = isProd ? 90 : 7
// Resolved retention — sentinel 0 on the incidentsRetentionDays param selects the
// env-aware default (180 prod / 14 dev). An explicit value overrides.
// (ADR-0014 §5; WS10 SEC-L-STEP4-INFRA-01.)
// The conditional guarantees a value >= 14, but Bicep's flow analysis can't see
// that through the conditional expression, so it warns about the storage-ops
// module's @minValue(7) constraint on the same-named param. Disable locally.
#disable-next-line BCP329
var resolvedIncidentsRetentionDays = incidentsRetentionDays > 0 ? incidentsRetentionDays : (isProd ? 180 : 14)
// EntraRisk retention — same env-aware sentinel-0 pattern (ADR-0023 §6).
#disable-next-line BCP329
var resolvedEntraRiskRetentionDays = entraRiskRetentionDays > 0 ? entraRiskRetentionDays : (isProd ? 180 : 14)
// Same env-aware pattern for daily-briefs retention (ADR-0022). Mirrors the
// incidents logic above so behaviour is symmetric across the two application
// containers.
#disable-next-line BCP329
var resolvedBriefRetentionDays = briefRetentionDays > 0 ? briefRetentionDays : (isProd ? 180 : 14)
// Posture-narratives retention — env-aware sentinel-0 (ADR-0027 §Decision.5).
// Prod is larger (90d) because the weekly cadence means only ~13 narratives
// land in a 90-day window per tenant, and an operator reviewing quarter-over-
// quarter trend will want the full set. Dev/test default matches the ADR's
// 21-day "two-sprint + buffer" envelope.
#disable-next-line BCP329
var resolvedPostureRetentionDays = postureRetentionDays > 0 ? postureRetentionDays : (isProd ? 90 : 21)
// Incident-narratives retention — env-aware sentinel-0 (ADR-0028 §Decision.5).
// Prod 180d (full investigation window + post-mortem review); dev 90d.
#disable-next-line BCP329
var resolvedIncidentsAnalysisRetentionDays = incidentsAnalysisRetentionDays > 0 ? incidentsAnalysisRetentionDays : (isProd ? 180 : 90)
// RansomwareIntel retention — env-aware sentinel-0 (ADR-0037 §7). Prod 90d
// covers monthly cadence + post-dated victim disclosures + cross-period
// comparison; dev 14d is enough to validate end-to-end without amassing
// rows during repeated provisions.
#disable-next-line BCP329
var resolvedThreatIntelRetentionDays = threatIntelRetentionDays > 0 ? threatIntelRetentionDays : (isProd ? 90 : 14)
// Budget sentinel: 0 → env-aware default. Prod gets a 4× multiplier over
// dev/test because the Foundry throughput ceiling scales with the deploy's
// user count, and small-tenant dev budgets frequently undercount post-SWA
// adoption (per ADR-0017 §Decision.8 item 1 defaults).
#disable-next-line BCP329
var resolvedFoundryBudget = foundryBudgetGbp > 0 ? foundryBudgetGbp : (isProd ? 100 : 25)

// -- Tags applied to the RG; resources inherit via Azure Policy / dashboard convention --

var commonTags = {
  workload: workload
  environment: environment
  managedBy: 'azd'
  'azd-env-name': environment
  codename: 'aegis'
  costCentre: 'community-mvp'
}

// -- Resource Group --

resource rg 'Microsoft.Resources/resourceGroups@2024-07-01' = {
  name: 'rg-${workload}-${environment}-${regionShort}'
  location: region
  tags: commonTags
}

// -- Observability first (other modules take its workspace as an input for diagnostics) --

module observability 'modules/observability.bicep' = {
  scope: rg
  name: 'deploy-observability'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    location: region
    retentionInDays: logAnalyticsRetentionDays
    tags: commonTags
  }
}

// -- User-assigned managed identities (audit writer + API reader placeholder) --

module identities 'modules/identities.bicep' = {
  scope: rg
  name: 'deploy-identities'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    location: region
    tags: commonTags
  }
}

// -- Operational Table Storage (ADR-0006) + Function deployment container (step 2) --

module storageOps 'modules/storage-ops.bicep' = {
  scope: rg
  name: 'deploy-storage-ops'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    location: region
    uniqueSuffix: uniqueSuffix
    resourceLocksEnabled: resourceLocksEnabled
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    tags: commonTags
    apiReaderMiPrincipalId: identities.outputs.apiReaderMiPrincipalId
    ingestMiPrincipalId: identities.outputs.ingestMiPrincipalId
    armIngestMiPrincipalId: identities.outputs.armIngestMiPrincipalId
    hostMiPrincipalId: identities.outputs.hostMiPrincipalId
    agentMiPrincipalId: identities.outputs.agentMiPrincipalId
    mailSenderMiPrincipalId: identities.outputs.mailSenderMiPrincipalId
    threatIntelMiPrincipalId: identities.outputs.threatIntelMiPrincipalId
    deployAiAgents: deployAiAgents
    incidentsRetentionDays: resolvedIncidentsRetentionDays
    briefRetentionDays: resolvedBriefRetentionDays
    postureRetentionDays: resolvedPostureRetentionDays
    incidentsAnalysisRetentionDays: resolvedIncidentsAnalysisRetentionDays
    publicNetworkAccess: publicNetworkAccessOnBackingServices
    deployerIpAllowlist: deployerIpAllowlistArray
  }
}

// -- Audit Blob Storage with environment-aware WORM (ADR-0006) --

module storageAudit 'modules/storage-audit.bicep' = {
  scope: rg
  name: 'deploy-storage-audit'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    location: region
    uniqueSuffix: uniqueSuffix
    immutabilityEnabled: auditImmutabilityEnabled
    retentionDays: auditRetentionDays
    resourceLocksEnabled: resourceLocksEnabled
    auditWriterMiPrincipalId: identities.outputs.auditWriterMiPrincipalId
    apiReaderMiPrincipalId: identities.outputs.apiReaderMiPrincipalId
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    tags: commonTags
    publicNetworkAccess: publicNetworkAccessOnBackingServices
  }
}

// -- Key Vault (MI-based access; no secrets provisioned in this pass) --

module keyvault 'modules/keyvault.bicep' = {
  scope: rg
  name: 'deploy-keyvault'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    location: region
    uniqueSuffix: uniqueSuffix
    purgeProtection: kvPurgeProtection
    softDeleteRetentionDays: kvSoftDeleteRetentionDays
    resourceLocksEnabled: resourceLocksEnabled
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    tags: commonTags
    // ADR-0030 §C.21 — recipient-hash pepper RBAC. Both principals are
    // optional so headless / pre-bootstrap deploys keep landing cleanly;
    // bootstrap-entra.ps1 sets AZURE_DEPLOYER_OBJECT_ID, identities.bicep
    // exports mailSenderMiPrincipalId.
    mailSenderMiPrincipalId: identities.outputs.mailSenderMiPrincipalId
    deployerObjectId: deployerObjectId
    deployerPrincipalType: deployerPrincipalType
    // ADR-0030 §C.22 chunk 4 — api-reader MI reads the share-link signing
    // key. Same vault as the pepper; second Aegis-managed secret.
    apiReaderMiPrincipalId: identities.outputs.apiReaderMiPrincipalId
    // L12-FT-01 — secret names from the single source of truth at the
    // top of this file. keyvault.bicep binds these into the SEC-L-L12-04
    // per-secret ABAC conditions on the two read MIs.
    recipientHashPepperSecretName: recipientHashPepperSecretName
    reportShareSigningKeySecretName: reportShareSigningKeySecretName
    // ADR-0037 — threatIntel MI per-secret ABAC + new secret added to
    // the deployer multi-secret Officer allowlist.
    threatIntelMiPrincipalId: identities.outputs.threatIntelMiPrincipalId
    ransomwareLiveSecretName: ransomwareLiveSecretName
    publicNetworkAccess: publicNetworkAccessOnBackingServices
    deployerIpAllowlist: deployerIpAllowlistArray
  }
}

// -- Function App (primary API, Flex Consumption plan, Easy Auth with placeholder allowedClientApplications) --

module functions 'modules/functions.bicep' = {
  scope: rg
  name: 'deploy-functions'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    location: region
    uniqueSuffix: uniqueSuffix
    tags: commonTags
    apiReaderMiResourceId: identities.outputs.apiReaderMiResourceId
    apiReaderMiClientId: identities.outputs.apiReaderMiClientId
    ingestMiResourceId: identities.outputs.ingestMiResourceId
    ingestMiClientId: identities.outputs.ingestMiClientId
    armIngestMiResourceId: identities.outputs.armIngestMiResourceId
    armIngestMiClientId: identities.outputs.armIngestMiClientId
    mailSenderMiResourceId: identities.outputs.mailSenderMiResourceId
    mailSenderMiClientId: identities.outputs.mailSenderMiClientId
    mailSenderUpn: azureMailSenderUpn
    // ADR-0037 — threatIntel MI binding + KV coordinates + cron + retention.
    // KV name reused from the same vault as the other Aegis secrets; secret
    // name is the single-source-of-truth literal at the top of this file.
    // Empty KV name disables the threatIntel ingest path; the MI is still
    // bound to the FA but the KV read returns 404 and runRansomwareIntelIngest
    // sets IngestHealth status to `not_configured` (sticky).
    threatIntelMiResourceId: identities.outputs.threatIntelMiResourceId
    threatIntelMiClientId: identities.outputs.threatIntelMiClientId
    ransomwareLiveApiKeyKvName: keyvault.outputs.keyVaultName
    ransomwareLiveApiKeyKvSecretName: ransomwareLiveSecretName
    threatIntelTimerCron: threatIntelTimerCron
    threatIntelRetentionDays: resolvedThreatIntelRetentionDays
    // ADR-0030 §C.21 — recipient-hash pepper KV coordinates. Vault name
    // comes from the keyvault module; secret name is the operator-set
    // default. Both surface to the Function App as app settings.
    recipientHashPepperKvName: keyvault.outputs.keyVaultName
    // L12-FT-01 — single source of truth at the top of this file.
    recipientHashPepperKvSecretName: recipientHashPepperSecretName
    // SEC-L-L12-01 — hard-fail flag for prod after pepper is confirmed live.
    // Default empty leaves the fail-soft posture; operator sets to "true"
    // via AZURE_RECIPIENT_HASH_PEPPER_REQUIRED env var on the azd env.
    recipientHashPepperRequired: recipientHashPepperRequired
    // ADR-0030 §C.22 chunk 4 — share-link signing key + URL base.
    // KV name reused from the same vault as the pepper; secret name is the
    // operator-set default. URL base derives from the SWA hostname by
    // default; operators can override via AZURE_REPORT_SHARE_URL_BASE for
    // a custom-domain deploy. Empty disables the share-link feature
    // (email body falls back to legacy KPI rendering + AIEVENT).
    reportShareSigningKeyKvName: keyvault.outputs.keyVaultName
    // L12-FT-01 — single source of truth at the top of this file.
    reportShareSigningKeyKvSecretName: reportShareSigningKeySecretName
    reportShareUrlBase: empty(reportShareUrlBaseOverride)
      ? 'https://${swa.outputs.swaDefaultHostname}/api/reports/share'
      : reportShareUrlBaseOverride
    auditWriterMiResourceId: identities.outputs.auditWriterMiResourceId
    auditWriterMiClientId: identities.outputs.auditWriterMiClientId
    hostMiResourceId: identities.outputs.hostMiResourceId
    hostMiClientId: identities.outputs.hostMiClientId
    agentMiResourceId: identities.outputs.agentMiResourceId
    agentMiClientId: identities.outputs.agentMiClientId
    opsStorageAccountName: storageOps.outputs.storageAccountName
    auditStorageAccountName: storageAudit.outputs.storageAccountName
    deploymentContainerName: storageOps.outputs.funcDeploymentsContainerName
    incidentsDetailContainerName: storageOps.outputs.incidentsDetailContainerName
    brandingAssetsContainerName: storageOps.outputs.brandingAssetsContainerName
    incidentsRetentionDays: resolvedIncidentsRetentionDays
    incidentsTimerCron: incidentsTimerCron
    entraRiskTimerCron: entraRiskTimerCron
    entraRiskRetentionDays: resolvedEntraRiskRetentionDays
    // ADR-0030 (reports). Defaults match the Bicep param declarations on
    // functions.bicep — minimum 3 versions per period (floor enforced),
    // 7-year retention horizon. Operators can override via azd env vars
    // AZURE_REPORT_SNAPSHOT_VERSIONS_PER_PERIOD / AZURE_REPORT_SNAPSHOT_RETENTION_DAYS.
    reportSnapshotVersionsPerPeriod: reportSnapshotVersionsPerPeriod
    reportSnapshotRetentionDays: reportSnapshotRetentionDays
    // ADR-0032 (KEV). Timer schedule overridable via AZURE_KEV_TIMER_CRON.
    kevTimerCron: kevTimerCron
    // ADR-0033 §5 Phase 2.5 — daily expiry sweep, defaults 03:00 UTC.
    kevSuppressionsSweepCron: kevSuppressionsSweepCron
    // ADR-0030 Phase B — daily report-snapshot auto-capture, defaults 04:00 UTC.
    reportSnapshotAutoCaptureCron: reportSnapshotAutoCaptureCron
    // Agent layer (ADRs 0017–0022). Foundry outputs reach through the
    // safe-navigation operator `.?` so the reference stays valid when
    // the module is skipped (`deployAiAgents=false`). Empty-string
    // fallbacks flow into the Function App app-settings array, which
    // itself is gated on `deployAiAgents` — nothing downstream sees
    // the empty sentinels in the false branch.
    deployAiAgents: deployAiAgents
    foundryProjectEndpoint: aiFoundry.?outputs.projectEndpoint ?? ''
    foundryProjectName: aiFoundry.?outputs.projectName ?? ''
    foundryRegion: aiFoundry.?outputs.foundryRegion ?? ''
    briefModelDeployment: aiFoundry.?outputs.smallDeploymentName ?? ''
    briefTimerCron: briefTimerCron
    briefDailyTokenBudget: briefDailyTokenBudget
    briefCacheContainer: storageOps.outputs.dailyBriefsContainerName
    #disable-next-line BCP329
    briefRetentionDays: resolvedBriefRetentionDays
    // Posture-agent (ADR-0027)
    postureCacheContainer: storageOps.outputs.postureNarrativesContainerName
    postureTimerCron: postureTimerCron
    postureWeeklyTokenBudget: postureWeeklyTokenBudget
    #disable-next-line BCP329
    postureRetentionDays: resolvedPostureRetentionDays
    // Incidents-agent (ADR-0028)
    incidentsAnalysisCacheContainer: storageOps.outputs.incidentNarrativesContainerName
    #disable-next-line BCP329
    incidentsAnalysisRetentionDays: resolvedIncidentsAnalysisRetentionDays
    incidentsAnalysisDailyTokenBudget: incidentsAnalysisDailyTokenBudget
    incidentsAnalysisRedactionLockHours: incidentsAnalysisRedactionLockHours
    appInsightsConnectionString: observability.outputs.appInsightsConnectionString
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    // ADR-0035 Phase E (§10.66) — Easy Auth retired; the FA gates auth via
    // native MSAL Bearer + ipSecurityRestrictions. swaMiAppId +
    // aegisLegacyClientPrincipal params are gone.
    aegisApiAppId: aegisApiAppId
    // VNet integration. Empty when `privateEndpointsEnabled=false` (legacy
    // posture preserved). When set, the FA routes all outbound through
    // `snet-func` → private endpoints → backing services.
    functionAppSubnetId: networking.outputs.funcSubnetId
  }
}

// -- AI Foundry Hub + Project + model deployments (ADR-0017) --
// Conditional on `deployAiAgents` — the Foundry hub + project + model
// deployments are skipped entirely for ingest-only deployments. Agent
// handler registrations + Foundry-region app settings are gated
// accordingly in functions.bicep and `api/src/index.ts`.

module aiFoundry 'modules/ai-foundry.bicep' = if (deployAiAgents) {
  scope: rg
  name: 'deploy-ai-foundry'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    // Region parity is structural — opsLocation is the sole location knob on
    // this module (no separate `location` override).
    opsLocation: region
    tags: commonTags
    agentMiPrincipalId: identities.outputs.agentMiPrincipalId
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    resourceLocksEnabled: resourceLocksEnabled
    publicNetworkAccessEnabled: !privateEndpointsEnabled
  }
}

// -- Networking — VNet + private DNS zones + private endpoints --
//
// When `privateEndpointsEnabled=false` the module is a no-op (legacy
// behaviour preserved). When `true` it provisions the full perimeter:
// VNet, two subnets (PE + FA delegation), five private DNS zones with
// VNet links, and six private endpoints (KV / audit-blob /
// ops-blob+table+queue / Foundry). Function App VNet integration is
// wired in `functions.bicep` from the `funcSubnetId` output below.
//
// Deploy ordering: Bicep tracks dependencies via output references —
// this module reads `*.outputs.*Id` from KV / Storage / Foundry, so
// it implicitly waits for those modules regardless of textual order.

module networking 'modules/networking.bicep' = {
  scope: rg
  name: 'deploy-networking'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    location: region
    tags: commonTags
    privateEndpointsEnabled: privateEndpointsEnabled
    keyVaultResourceId: keyvault.outputs.keyVaultId
    auditStorageResourceId: storageAudit.outputs.storageAccountId
    opsStorageResourceId: storageOps.outputs.storageAccountId
    // Safe-navigation `.?` mirrors the `functions.bicep` pattern — keeps
    // the reference valid when `deployAiAgents=false` (module skipped).
    foundryAccountResourceId: aiFoundry.?outputs.hubAccountId ?? ''
  }
}

// -- Alerts (ActionGroup + AgentRun anomaly rule) — shared with cost-budget --

module alerts 'modules/alerts.bicep' = {
  scope: rg
  name: 'deploy-alerts'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    tags: commonTags
    adminEmail: adminEmail
    appInsightsResourceId: observability.outputs.appInsightsResourceId
    // L12-FT-03 + L12-FT-06 — LA workspace for the KV ABAC-denial and
    // share-link probe scheduledQueryRules (the two new alert sources
    // live in `AzureDiagnostics` and `FunctionAppLogs` respectively,
    // both in the same LA workspace as the AppInsights backend).
    logAnalyticsWorkspaceResourceId: observability.outputs.logAnalyticsWorkspaceId
    dailyTokenBudget: briefDailyTokenBudget
    deployAiAgents: deployAiAgents
  }
}

// -- Subscription-scope Cost Management budget (ADR-0017 §Decision.8 item 1) --

module costBudget 'modules/cost-budget.bicep' = {
  name: 'deploy-cost-budget'
  params: {
    workload: workload
    environment: environment
    budgetAmount: resolvedFoundryBudget
    startDate: effectiveBudgetStartDate
    adminEmail: adminEmail
    actionGroupResourceId: alerts.outputs.actionGroupId
    autoDisableOnBudgetBreach: autoDisableOnBudgetBreach
  }
}

// -- Azure Policy (Foundry model SKU + model-name allowlist, ADR-0017 §Decision.8 item 2) --

module foundrySkuPolicy 'modules/policy-foundry-sku.bicep' = {
  name: 'deploy-foundry-sku-policy'
  params: {
    workload: workload
    resourceGroupId: rg.id
  }
}

// -- Static Web App (Standard tier, system-assigned MI for linked backend) --

module swa 'modules/swa.bicep' = {
  scope: rg
  name: 'deploy-swa'
  params: {
    workload: workload
    environment: environment
    regionShort: regionShort
    // SWA control-plane region (see staticWebAppLocation param header at
    // top of file). Decoupled from `region` because SWA is only available
    // in 5 of Azure's ~50 regions and the rest of the deploy may target
    // any region.
    location: staticWebAppLocation
    uniqueSuffix: uniqueSuffix
    tags: commonTags
    appInsightsConnectionString: observability.outputs.appInsightsConnectionString
  }
}

// -- Outputs consumed by azd, by `azure.yaml` postprovision hook, and by future passes --

// ADR-0036 — Defender for Cloud Secure Score ingest. Sub-scoped Reader
// for the ingest MI. The role-assignment lives in its own module to defer
// the `guid()` name calculation (Bicep BCP120 — sub-scope role-assignment
// names must be calculable at deploy start; passing principalId as a
// module param resolves the forward reference).
module defenderCloudRbac 'modules/defender-cloud-rbac.bicep' = {
  name: 'deploy-defender-cloud-rbac'
  scope: subscription()
  params: {
    armIngestMiPrincipalId: identities.outputs.armIngestMiPrincipalId
  }
}

output AZURE_RESOURCE_GROUP_NAME string = rg.name
output AZURE_LOCATION string = region
output AZURE_ENVIRONMENT string = environment

output LOG_ANALYTICS_WORKSPACE_ID string = observability.outputs.logAnalyticsWorkspaceId
output LOG_ANALYTICS_WORKSPACE_NAME string = observability.outputs.logAnalyticsWorkspaceName
output APPLICATIONINSIGHTS_CONNECTION_STRING string = observability.outputs.appInsightsConnectionString
output APP_INSIGHTS_NAME string = observability.outputs.appInsightsName

output OPS_STORAGE_ACCOUNT_NAME string = storageOps.outputs.storageAccountName
output AUDIT_STORAGE_ACCOUNT_NAME string = storageAudit.outputs.storageAccountName
output AUDIT_IMMUTABILITY_ENABLED bool = auditImmutabilityEnabled

output KEY_VAULT_NAME string = keyvault.outputs.keyVaultName
output KEY_VAULT_URI string = keyvault.outputs.keyVaultUri

// L12-FT-SoT-PS1 (closure) — surface the two canonical secret names
// as azd env vars so the postprovision PowerShell scripts can be
// invoked with `-SecretName <env>` instead of relying on the PS1
// hardcoded defaults. Without the explicit pass-through, the
// hardcoded `-SecretName` defaults in
// `provision-{recipient-hash-pepper,report-share-signing-key}.ps1`
// are a 4th surface that could silently drift from the Bicep
// canonical (failing closed as a 403 on the MI read path; hard to
// diagnose). Bicep is now the single source of truth at deploy time.
output RECIPIENT_HASH_PEPPER_SECRET_NAME string = recipientHashPepperSecretName
output REPORT_SHARE_SIGNING_KEY_SECRET_NAME string = reportShareSigningKeySecretName
// ADR-0037 — consumed by `scripts/provision-ransomware-live-api-key.ps1`
// at runtime so the operator can't pick a name that drifts from the
// Bicep-declared one.
output RANSOMWARE_LIVE_SECRET_NAME string = ransomwareLiveSecretName

output AUDIT_WRITER_MI_CLIENT_ID string = identities.outputs.auditWriterMiClientId
output AUDIT_WRITER_MI_RESOURCE_ID string = identities.outputs.auditWriterMiResourceId
output AUDIT_WRITER_MI_PRINCIPAL_ID string = identities.outputs.auditWriterMiPrincipalId
output API_READER_MI_CLIENT_ID string = identities.outputs.apiReaderMiClientId
output API_READER_MI_RESOURCE_ID string = identities.outputs.apiReaderMiResourceId
output API_READER_MI_PRINCIPAL_ID string = identities.outputs.apiReaderMiPrincipalId
output INGEST_MI_CLIENT_ID string = identities.outputs.ingestMiClientId
output INGEST_MI_RESOURCE_ID string = identities.outputs.ingestMiResourceId
output INGEST_MI_PRINCIPAL_ID string = identities.outputs.ingestMiPrincipalId
output ARM_INGEST_MI_CLIENT_ID string = identities.outputs.armIngestMiClientId
output ARM_INGEST_MI_RESOURCE_ID string = identities.outputs.armIngestMiResourceId
output ARM_INGEST_MI_PRINCIPAL_ID string = identities.outputs.armIngestMiPrincipalId
output MAIL_SENDER_MI_CLIENT_ID string = identities.outputs.mailSenderMiClientId
output MAIL_SENDER_MI_RESOURCE_ID string = identities.outputs.mailSenderMiResourceId
output MAIL_SENDER_MI_PRINCIPAL_ID string = identities.outputs.mailSenderMiPrincipalId
output HOST_MI_CLIENT_ID string = identities.outputs.hostMiClientId
output HOST_MI_RESOURCE_ID string = identities.outputs.hostMiResourceId
output HOST_MI_PRINCIPAL_ID string = identities.outputs.hostMiPrincipalId
output AGENT_MI_CLIENT_ID string = identities.outputs.agentMiClientId
output AGENT_MI_RESOURCE_ID string = identities.outputs.agentMiResourceId
output AGENT_MI_PRINCIPAL_ID string = identities.outputs.agentMiPrincipalId

// Foundry outputs null-safe — empty string when the module is skipped
// (`deployAiAgents=false`). Downstream consumers reading these via
// `azd env get-values` see "" rather than a failed deployment.
output FOUNDRY_HUB_ACCOUNT_NAME string = aiFoundry.?outputs.hubAccountName ?? ''
output FOUNDRY_PROJECT_NAME string = aiFoundry.?outputs.projectName ?? ''
output FOUNDRY_PROJECT_ENDPOINT string = aiFoundry.?outputs.projectEndpoint ?? ''
output FOUNDRY_REGION string = aiFoundry.?outputs.foundryRegion ?? ''
output BRIEF_MODEL_DEPLOYMENT string = aiFoundry.?outputs.smallDeploymentName ?? ''
output NANO_MODEL_DEPLOYMENT string = aiFoundry.?outputs.nanoDeploymentName ?? ''
output DEPLOY_AI_AGENTS bool = deployAiAgents
output DAILY_BRIEFS_CONTAINER string = storageOps.outputs.dailyBriefsContainerName
output POSTURE_NARRATIVES_CONTAINER string = storageOps.outputs.postureNarrativesContainerName
output INCIDENT_NARRATIVES_CONTAINER string = storageOps.outputs.incidentNarrativesContainerName
output BRANDING_ASSETS_CONTAINER string = storageOps.outputs.brandingAssetsContainerName
output COST_BUDGET_NAME string = costBudget.outputs.budgetName
output AGENT_RUN_ALERT_ID string = alerts.outputs.agentRunAlertId

output FUNCTION_APP_NAME string = functions.outputs.functionAppName
output FUNCTION_APP_DEFAULT_HOSTNAME string = functions.outputs.functionAppDefaultHostName
output FUNCTION_APP_RESOURCE_ID string = functions.outputs.functionAppResourceId

output SWA_NAME string = swa.outputs.swaName
output SWA_DEFAULT_HOSTNAME string = swa.outputs.swaDefaultHostname
output SWA_RESOURCE_ID string = swa.outputs.swaResourceId
output SWA_SYSTEM_MI_PRINCIPAL_ID string = swa.outputs.swaSystemMiPrincipalId

output FUNC_DEPLOYMENTS_CONTAINER string = storageOps.outputs.funcDeploymentsContainerName
output AZURE_TENANT_ID string = subscription().tenantId
