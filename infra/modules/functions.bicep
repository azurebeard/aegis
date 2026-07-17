// functions.bicep — Flex Consumption Function App for the primary API (ADR-0004).
// Easy Auth is enabled at creation with a placeholder `allowedClientApplications`
// (ADR-0007 "Backend protection"). Postprovision replaces the placeholder with
// the SWA system-assigned MI's application ID and links SWA → Function App.

param workload string
param environment string
param regionShort string
param location string
param uniqueSuffix string
param tags object

@description('Resource ID of the user-assigned MI for HTTP read handlers (from identities.bicep). Narrow: HTTP read-path only. Does NOT own Functions runtime storage — that moved to the host MI on 2026-04-19.')
param apiReaderMiResourceId string

@description('Client ID of the api-reader user-assigned MI.')
param apiReaderMiClientId string

@description('Resource ID of the user-assigned MI for ingest Timer handlers (ADR-0011 §5a). Carries the Graph app role (ADR-0010).')
param ingestMiResourceId string

@description('Client ID of the ingest user-assigned MI.')
param ingestMiClientId string

@description('Resource ID of the arm-ingest user-assigned MI (ADR-0036 v1.2 — M-Q2 split). ARM data plane only — Defender for Cloud Secure Score ingest. Attached to the Function App so the runtime can resolve managedIdentityClientId=armIngestMiClientId.')
param armIngestMiResourceId string

@description('Client ID of the arm-ingest user-assigned MI.')
param armIngestMiClientId string

@description('Resource ID of the mail-sender user-assigned MI (ADR-0030 Phase C — outbound email of report snapshots). Attached to the Function App; Graph permissions (Mail.Send + Mail.Read) provisioned by bootstrap-entra.ps1 when AZURE_MAIL_SENDER_UPN is set, scoped to a single mailbox via Exchange Application Access Policy. Inert if no mailbox configured.')
param mailSenderMiResourceId string

@description('Client ID of the mail-sender user-assigned MI.')
param mailSenderMiClientId string

@description('Operator-configured sender mailbox UPN (AZURE_MAIL_SENDER_UPN). Surfaced as a Function App app setting so reportEmail.ts and settingsResponse.ts can read it via process.env. Empty when Phase C is inert.')
param mailSenderUpn string = ''

@description('ADR-0030 §C.21 — Key Vault name hosting the recipient-hash pepper secret. The mailSender MI reads this via @azure/keyvault-secrets at first send; empty disables peppered hashing (orchestrator falls back to the legacy tenant-bound hash and emits an AIEVENT).')
param recipientHashPepperKvName string = ''
@description('ADR-0030 §C.21 — Key Vault secret name for the recipient-hash pepper. Default `recipient-hash-pepper`.')
param recipientHashPepperKvSecretName string = 'recipient-hash-pepper'

@description('SEC-L-L12-01 — when "true" (literal, case-insensitive), the API throws RecipientHashPepperRequiredError and the email send returns 502 if the pepper cannot be loaded from Key Vault. Default empty leaves the fail-soft posture (legacy hash + AIEVENT) — intended for prod after pepper provisioning is confirmed live.')
param recipientHashPepperRequired string = ''

@description('ADR-0030 §C.22 — Key Vault name hosting the report-share-link HMAC signing key. The api-reader MI reads this via @azure/keyvault-secrets at first share-link mint or verify; empty disables the share-link feature (email body falls back to the legacy KPI render + AIEVENT report.email.share_link.fallback).')
param reportShareSigningKeyKvName string = ''
@description('ADR-0030 §C.22 — Key Vault secret name for the share-link signing key. Default `report-share-signing-key`.')
param reportShareSigningKeyKvSecretName string = 'report-share-signing-key'
@description('ADR-0030 §C.22 — fully-qualified URL base for the share-link endpoint, e.g. `https://<swa-hostname>/api/reports/share`. The email-issuer mints a token and appends `/<token>` to this base. Required for HTTPS; empty disables the share-link feature.')
param reportShareUrlBase string = ''

@description('ADR-0037 — Resource ID of the threatIntel user-assigned MI. Attached to the Function App so runRansomwareIntelIngest.ts can resolve managedIdentityClientId=threatIntelMiClientId for the KV-read + Table-write paths.')
param threatIntelMiResourceId string

@description('Client ID of the threatIntel user-assigned MI.')
param threatIntelMiClientId string

@description('ADR-0037 — Key Vault name hosting the ransomware.live PRO API key. The threatIntel MI reads this via @azure/keyvault-secrets at first ingest; empty disables the threatIntel ingest path (tile auto-hides, IngestHealth status sticky `not_configured`).')
param ransomwareLiveApiKeyKvName string = ''

@description('ADR-0037 — Key Vault secret name for the ransomware.live PRO API key. Default `ransomware-live-api-key`. MUST match `keyvault.bicep:ransomwareLiveSecretName` and the `-SecretName` default of `provision-ransomware-live-api-key.ps1`.')
param ransomwareLiveApiKeyKvSecretName string = 'ransomware-live-api-key'

@description('ADR-0037 — Timer cron for the ransomware.live ingest. Default `0 0 * * * *` (top of every hour). Operator override via `azd env set AZURE_THREAT_INTEL_TIMER_CRON "<cron>"`.')
param threatIntelTimerCron string = '0 0 * * * *'

@description('ADR-0037 — retention days for RansomwareIntel table rows. 0 selects env-aware default in main.bicep (90 prod / 14 dev). Override with any positive integer to force a specific retention regardless of environment.')
param threatIntelRetentionDays int = 14

@description('Optional. Resource ID of the subnet provisioned by `networking.bicep` for Function App VNet integration. When non-empty, the FA routes all outbound traffic (and Flex Consumption deployment-storage I/O) via this subnet → private endpoints. Empty preserves the public-network outbound posture. Set from `networking.outputs.funcSubnetId` in main.bicep when `privateEndpointsEnabled=true`.')
param functionAppSubnetId string = ''

@description('Resource ID of the user-assigned MI that appends to the audit blob (reused from step 1).')
param auditWriterMiResourceId string

@description('Client ID of the audit-writer user-assigned MI.')
param auditWriterMiClientId string

@description('Resource ID of the host user-assigned MI. Owns AzureWebJobsStorage + Flex Consumption deployment storage. Introduced 2026-04-19 to keep api-reader narrow (live-observed Timer NoOpListener state without account-scope host-storage access).')
param hostMiResourceId string

@description('Client ID of the host user-assigned MI.')
param hostMiClientId string

@description('Resource ID of the agent user-assigned MI (ADR-0017 §3). Calls Foundry + writes BriefCache / AgentBudget / AgentHealth + daily-briefs blobs.')
param agentMiResourceId string

@description('Client ID of the agent user-assigned MI.')
param agentMiClientId string

@description('Foundry Project endpoint (from ai-foundry.bicep output). Consumed by `@azure/ai-projects` AIProjectClient.')
param foundryProjectEndpoint string

@description('Foundry Project name (from ai-foundry.bicep output). Echoed in app settings for observability correlation.')
param foundryProjectName string

@description('Foundry region (from ai-foundry.bicep output). Belt-and-braces second-layer region-parity check; handler compares this against ops-endpoint region at boot (ADR-0017 §2).')
param foundryRegion string

@description('Model deployment name used by brief-agent (ADR-0018 aegis-small). Runtime uses this name; the underlying model SKU is set by the Foundry deployment resource in ai-foundry.bicep.')
param briefModelDeployment string

@minValue(1000)
@maxValue(100000000)
@description('Daily per-tenant token budget for brief-agent (ADR-0019). tokensIn + tokensOut sum across all runs in a UTC day.')
param briefDailyTokenBudget int = 200000

@minValue(1)
@maxValue(1000)
@description('Max successful brief-agent runs per UTC day per tenant (ADR-0019 / ADR-0020). Scheduled Timer fires once, admin reruns capped by briefDailyManualRunCeiling.')
param briefDailyRunCeiling int = 50

@minValue(1)
@maxValue(100)
@description('Max admin-triggered brief-agent runs per UTC day per tenant (ADR-0020 §rate-limit). Narrower than the overall ceiling so a well-meaning admin cannot empty the budget.')
param briefDailyManualRunCeiling int = 30

@description('NCRONTAB schedule for the brief-agent daily Timer. Default `0 0 5 * * *` = 05:00 UTC daily. Overridable per env for smoke tests.')
param briefTimerCron string = '0 0 5 * * *'

@description('Blob container name for daily-brief bodies (ADR-0022).')
param briefCacheContainer string

@minValue(7)
@maxValue(3650)
@description('Retention in days for daily-brief blobs. Informational; lifecycle policy in storage-ops is authoritative.')
param briefRetentionDays int

@minValue(1)
@maxValue(48)
@description('Fresh-window ceiling in hours for the BriefCache read contract (ADR-0022). Default 26h = 24h schedule + 2h jitter buffer on the daily Timer. Below this, read-path returns cached brief without orchestrator fire.')
param briefStalenessFreshHours int = 26

@minValue(25)
@maxValue(168)
@description('Staleness ceiling in hours past which a cached brief is considered stale-not-serviceable (ADR-0022).')
param briefStalenessCeilingHours int = 72

@description('Audit-chain source key for agent-run events (ADR-0021). Distinct from `graph.security.*` so hash chains do not collide.')
param agentBriefSource string = 'agent.aegis.brief'

// --- Posture-agent (ADR-0027) --------------------------------------------------

@description('NCRONTAB schedule for the posture-agent weekly Timer (ADR-0027 §Decision.4). Default `0 0 6 * * 1` = 06:00 UTC Mondays. Overridable per env.')
param postureTimerCron string = '0 0 6 * * 1'

@description('Blob container name for posture-narrative bodies (ADR-0027 §Decision.5).')
param postureCacheContainer string

@minValue(7)
@maxValue(3650)
@description('Retention in days for posture-narrative blobs. Informational; lifecycle policy in storage-ops is authoritative.')
param postureRetentionDays int

@minValue(1000)
@maxValue(1000000)
@description('Per-tenant token budget for posture-agent within one ISO week (SEC-L-B2-01 resolution: AgentBudget row keyed by ISO week, ceiling enforces weekly aggregate).')
param postureWeeklyTokenBudget int = 20000

@minValue(1)
@maxValue(100)
@description('Max successful posture-agent runs per ISO week per tenant. One Timer fire per week + admin-manual headroom + failure-retry envelope.')
param postureWeeklyRunCeiling int = 15

@minValue(1)
@maxValue(50)
@description('Max admin-triggered posture-agent runs per UTC day per tenant. Counter is per-day so a sustained operator click-storm cannot empty the weekly token budget in one day.')
param postureWeeklyManualRunCeiling int = 10

@minValue(1)
@maxValue(31)
@description('Fresh-window ceiling in DAYS for the PostureCache read contract (ADR-0027 §Decision.5). Default 7 = one Timer cadence window.')
param postureStalenessFreshDays int = 7

@minValue(2)
@maxValue(60)
@description('Staleness ceiling in days past which a cached posture narrative is considered stale-unservable (ADR-0027 §Decision.5). Default 14 = two weeks.')
param postureStalenessCeilingDays int = 14

@description('Audit-chain source key for posture-agent runs (ADR-0021 + ADR-0027).')
param agentPostureSource string = 'agent.aegis.posture'

// --- Incidents-agent (ADR-0028) ------------------------------------------------

@description('Blob container name for incident-narrative bodies (ADR-0028 §Decision.5).')
param incidentsAnalysisCacheContainer string

@minValue(7)
@maxValue(3650)
@description('Retention in days for incident-narrative blobs. Informational; lifecycle policy in storage-ops is authoritative.')
param incidentsAnalysisRetentionDays int

@minValue(1000)
@maxValue(1000000)
@description('Daily per-tenant token budget for incidents-agent (ADR-0028 §Decision.4). On-demand cadence = lower ceiling than brief-agent; ~750 tokens/run × 20 runs = 15K default.')
param incidentsAnalysisDailyTokenBudget int = 15000

@minValue(1)
@maxValue(100)
@description('Max successful incidents-agent runs per UTC day per tenant (ADR-0028 §Decision.4). On-demand only; ceiling guards against budget-grind.')
param incidentsAnalysisDailyRunCeiling int = 30

@minValue(1)
@maxValue(100)
@description('Max admin-triggered incidents-agent runs per UTC day per tenant (ADR-0028 §Decision.4). 20 runs × 750 tokens/run fits a full investigation day + retry headroom.')
param incidentsAnalysisDailyManualRunCeiling int = 20

@minValue(1)
@maxValue(168)
@description('Redaction-lock duration in hours (ADR-0028 §Decision.7d). 24h default matches typical investigation cadence; admin can clear the lock via DELETE /api/ingest/incidents/{id}/redaction-lock.')
param incidentsAnalysisRedactionLockHours int = 24

@description('Audit-chain source key for incidents-agent runs (ADR-0021 + ADR-0028).')
param agentIncidentsSource string = 'agent.aegis.incidents'

@description('Name of the ops storage account that also hosts the Function deployment container.')
param opsStorageAccountName string

@description('Name of the audit storage account (used for the audit blob endpoint URL).')
param auditStorageAccountName string

@description('Name of the Function-deployment blob container inside the ops storage account.')
param deploymentContainerName string

@description('Name of the incidents-detail blob container (step 4, ADR-0014 §3.2).')
param incidentsDetailContainerName string

@description('Name of the branding-assets blob container (ADR-0029 Phase B §Decision.2). One blob per tenant at `<tenantId>/logo`. Ingest MI Contributor; api-reader MI Reader.')
param brandingAssetsContainerName string

@description('Deploy the AI plane. When false, the agent MI is NOT bound to the Function App, all agent-related app settings (AGENT_MI_CLIENT_ID, FOUNDRY_*, BRIEF_*, POSTURE_*, INCIDENTS_ANALYSIS_*, AGENT_*_SOURCE) are omitted, and the agent-handler registrations short-circuit at module load via the `AZURE_DEPLOY_AI_AGENTS` app setting read in `api/src/index.ts`. Default true. HANDOVER §6.3 `deployAiAgents` item.')
param deployAiAgents bool = true

@description('Retention in days for incidents-detail blobs. Used by the ingest handler for cursor-window calculations. Informational only — actual deletion is driven by the storage lifecycle policy (ADR-0014 §5).')
param incidentsRetentionDays int

@description('NCRONTAB expression for the incidents ingest Timer (ADR-0014 §1). Parameterised so dev environments can override to a faster cadence for testing without a code change.')
param incidentsTimerCron string = '0 */15 * * * *'

@description('NCRONTAB expression for the EntraRisk ingest Timer (ADR-0023 §1 — 4h cadence). Overridable per env.')
param entraRiskTimerCron string = '0 0 */4 * * *'

@description('Retention in days for EntraRisk Table rows (ADR-0023 §6). Informational only; handler-side sweeper prunes rows older than this. Same env-aware sentinel-0 pattern as incidentsRetentionDays.')
param entraRiskRetentionDays int

@description('Audit-chain source key for EntraRisk ingest (ADR-0023 §2). Distinct per-source chain key.')
param entraRiskSource string = 'graph.security.riskyUsers'

// --- ADR-0030 (reports) ---
@description('Versions of a captured report kept per (tenantId, periodKey). ADR-0030 §3 floor of 3 enforced at config load. Production recommendation: 3 for active operations, 5+ when attestation requires multiple intra-period captures.')
@minValue(3)
param reportSnapshotVersionsPerPeriod int = 3

@description('Maximum age in days for any report snapshot. Age-based trim is Phase B. Production recommendation: 2555 (7 years; covers Cyber Essentials Plus + NIS2 + UK GDPR audit horizons).')
@minValue(30)
param reportSnapshotRetentionDays int = 2555

@description('Audit-chain source key for report capture (ADR-0030 §6). Routes to its own audit blob filename `report.ndjson` via auditFilenameForSource dispatch.')
param reportSnapshotSource string = 'report.snapshot'

// --- ADR-0032 (KEV) ---
@description('Timer schedule for the KEV ingest (ADR-0032 §1). Default 02:00 UTC daily — fires before the SecureScore 03:00 timer to spread load. NCRONTAB.')
param kevTimerCron string = '0 0 2 * * *'

@description('Timer schedule for the KevSuppressions expiry sweep (ADR-0033 §5 Phase 2.5). Default 03:00 UTC daily — runs after the KEV ingest so the new catalogue is in place. NCRONTAB.')
param kevSuppressionsSweepCron string = '0 0 3 * * *'

@description('Timer schedule for the report-snapshot auto-capture (ADR-0030 Phase B). Default 04:00 UTC daily — runs after KEV ingest + sweep so the snapshot reads fresh data on period-rollover day. Idempotent skip-if-already-captured. NCRONTAB.')
param reportSnapshotAutoCaptureCron string = '0 0 4 * * *'

// --- ADR-0034 (Identity vertical) ---
@description('Timer schedule for the User dormancy ingest (ADR-0034 §1). Default 01:30 UTC daily — fires before the SecureScore 03:00 timer so the diagnostics page shows a complete daily picture. NCRONTAB.')
param userDormancyTimerCron string = '0 30 1 * * *'

@description('Source identifier on every audit line + IngestHealth row + AIEVENT for User dormancy (ADR-0034 §2). Override only for fork / sovereign-cloud naming.')
param userDormancySource string = 'graph.users.dormancy'

// --- ADR-0034 (Identity vertical — Geo-fenced sign-ins) ---
@description('Timer schedule for the Sign-ins ingest (ADR-0034 §1). Default every 15 minutes — sign-in events are operationally time-sensitive (matches the Incidents cadence). NCRONTAB.')
param signInsTimerCron string = '0 */15 * * * *'

@description('Retention in days for SignIns rows (ADR-0034 §3.2). 30 in prod / 7 in dev by default; the orchestrator trims rows older than this on each run.')
@minValue(7)
@maxValue(365)
param signInsRetentionDays int = 7

@description('Source identifier on every audit line + IngestHealth row + AIEVENT for Sign-ins (ADR-0034 §2). Override only for fork / sovereign-cloud naming.')
param signInsSource string = 'graph.auditLogs.signIns'

// --- ADR-0034 (Identity vertical — Conditional Access policy state) ---
@description('Timer schedule for the Conditional Access policy ingest (ADR-0034 §3.3). Default minute 0 of every hour — CA policies change rarely so hourly catches drift fast enough without burning Graph quota. NCRONTAB.')
param conditionalAccessTimerCron string = '0 0 * * * *'

@description('Source identifier on every audit line + IngestHealth row + AIEVENT for Conditional Access (ADR-0034 §3.3). Override only for fork / sovereign-cloud naming.')
param conditionalAccessSource string = 'graph.identity.conditionalAccess.policies'

// --- ADR-0036 (Defender for Cloud Secure Score ingest) ---
@description('Timer schedule for the Defender for Cloud Secure Score ingest (ADR-0036). Default 02:30 UTC daily — between the 02:00 KEV ingest and the 03:00 Microsoft Secure Score ingest. NCRONTAB.')
param azureSecureScoreTimerCron string = '0 30 2 * * *'

@description('Source identifier on every audit line + IngestHealth row + AIEVENT for Defender for Cloud Secure Score (ADR-0036). Override only for fork / sovereign-cloud naming.')
param azureSecureScoreSource string = 'azure.security.defenderForCloud.secureScores'

@description('Retention in days for AzureSecureScores rows (ADR-0036). 90d default; the orchestrator trims rows older than this on each run, mirroring MicrosoftSecureScore.')
@minValue(7)
@maxValue(365)
param azureSecureScoreRetentionDays int = 90

@description('CISA KEV feed URL (ADR-0032 §1). Sovereign-cloud or test-fixture override surface. Defaults to the canonical CISA-served URL.')
param kevFeedUrl string = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'

@description('HTTP timeout for the KEV feed fetch (ADR-0032 §7). Defaults to 30 s — KEV is a ~1.5 MB JSON file, well under any plausible large-file timeout.')
@minValue(5000)
param kevFeedTimeoutMs int = 30000

@description('Hard cap on the KEV feed response body in bytes (ADR-0032 §7 — defence against feed-size-attack). 50 MB is well above current ~1.5 MB and any plausible KEV growth horizon.')
@minValue(1048576)
param kevFeedMaxBytes int = 52428800

@description('Audit-chain source key for KEV ingest (ADR-0032 §5). Distinct per-source chain key on the existing ingest.ndjson filename.')
param kevSource string = 'cisa.kev'

// --- ADR-0035 (Native Entra authentication migration, Phase D1) ---
@description('Application (client) ID of the API app registration created by `bootstrap-entra.ps1` Phase B (ADR-0035 §8). The bare GUID, NOT the `api://` form. Surfaced as the `AEGIS_API_APP_ID` Function App setting and consumed by `api/src/lib/authMiddleware.ts` as the v2.0 JWT `aud` value. Leave empty on first deploy; after bootstrap, persist via `azd env set AZURE_AEGIS_API_APP_ID=<apiAppId>` (the postprovision hook does this automatically by reading `nativeAuth.apiAppId` from BOOTSTRAP_JSON). Empty value parses as a hard config error in `resolveAuthConfig` — fail-closed at Function App boot if a Bearer token ever arrives.')
param aegisApiAppId string = ''

@description('App Insights connection string (from observability.bicep).')
@secure()
param appInsightsConnectionString string

@description('Log Analytics workspace resource ID (from observability.bicep).')
param logAnalyticsWorkspaceId string

var baseFunctionAppName = 'func-${workload}-api-${environment}-${regionShort}'
var functionAppName = empty(uniqueSuffix) ? baseFunctionAppName : '${baseFunctionAppName}-${toLower(uniqueSuffix)}'
var planName = 'asp-${workload}-${environment}-${regionShort}'

// §10.66 Phase E — Easy Auth (authsettingsV2) retired. Network gate moved
// to siteConfig.ipSecurityRestrictions below; authentication is native
// MSAL Bearer validated by `api/src/lib/authMiddleware.ts`.

// --- AI-plane app settings (ADRs 0017–0022 / 0027 / 0028) --------------------
// Extracted into a `var` so the top-level `deployAiAgents` toggle can
// conditionally concat this block onto the base settings. When the
// toggle is false, NONE of these land on the Function App — the handler
// registrations in `api/src/index.ts` short-circuit on `AZURE_DEPLOY_AI_AGENTS`
// before any of them are read, so an operator running ingest-only sees
// a clean Function App without unused app settings accumulating.
var agentAppSettings = [
  // Agent MI selector — brief/posture/incidents agents construct
  //   `new DefaultAzureCredential({ managedIdentityClientId: AGENT_MI_CLIENT_ID })`
  // to call Foundry (ADR-0017 §4). Distinct from API_READER / INGEST /
  // AUDIT / HOST selectors so privilege separation survives refactors.
  { name: 'AGENT_MI_CLIENT_ID', value: agentMiClientId }
  // Foundry endpoint (ADR-0017 §4). SDK-locked URL shape; emitted by
  // ai-foundry.bicep.
  { name: 'FOUNDRY_PROJECT_ENDPOINT', value: foundryProjectEndpoint }
  { name: 'FOUNDRY_PROJECT_NAME', value: foundryProjectName }
  // Runtime region-parity belt-and-braces check (ADR-0017 §2). Handler
  // compares against the ops-store endpoint region at boot; mismatch
  // throws ConfigError before any Foundry call fires.
  { name: 'FOUNDRY_REGION', value: foundryRegion }
  // Deployment-name indirection (ADR-0018). Handler references
  // `aegis-small` — Bicep binds it to the current underlying SKU
  // (gpt-4.1-mini today). Swapping the model is a Bicep param override.
  { name: 'BRIEF_MODEL_DEPLOYMENT', value: briefModelDeployment }
  // Per-agent per-day token budget (ADR-0019). Enforced by the
  // orchestrator via AgentBudget table pessimistic reservation +
  // TTL sweep. App Insights alert (alerts.bicep) fires on 3× this
  // value in a rolling 1h window as defence-in-depth.
  { name: 'BRIEF_DAILY_TOKEN_BUDGET', value: string(briefDailyTokenBudget) }
  { name: 'BRIEF_DAILY_RUN_CEILING', value: string(briefDailyRunCeiling) }
  // Narrower admin-trigger ceiling (ADR-0020 §rate-limit). Separate
  // counter so a scheduled Timer fire + admin reruns both accrue.
  { name: 'BRIEF_DAILY_MANUAL_RUN_CEILING', value: string(briefDailyManualRunCeiling) }
  // Timer schedule — Bicep is authoritative, same pattern as
  // INCIDENTS_TIMER_CRON.
  { name: 'BRIEF_TIMER_CRON', value: briefTimerCron }
  { name: 'BRIEF_CACHE_CONTAINER', value: briefCacheContainer }
  { name: 'BRIEF_RETENTION_DAYS', value: string(briefRetentionDays) }
  // Staleness states (ADR-0022).
  { name: 'BRIEF_STALENESS_FRESH_HOURS', value: string(briefStalenessFreshHours) }
  { name: 'BRIEF_STALENESS_CEILING_HOURS', value: string(briefStalenessCeilingHours) }
  // Audit-chain source key (ADR-0021). Distinct per-source chain key.
  { name: 'AGENT_BRIEF_SOURCE', value: agentBriefSource }
  // Posture-agent (ADR-0027)
  { name: 'POSTURE_TIMER_CRON', value: postureTimerCron }
  { name: 'POSTURE_CACHE_CONTAINER', value: postureCacheContainer }
  { name: 'POSTURE_RETENTION_DAYS', value: string(postureRetentionDays) }
  { name: 'POSTURE_WEEKLY_TOKEN_BUDGET', value: string(postureWeeklyTokenBudget) }
  { name: 'POSTURE_WEEKLY_RUN_CEILING', value: string(postureWeeklyRunCeiling) }
  { name: 'POSTURE_WEEKLY_MANUAL_RUN_CEILING', value: string(postureWeeklyManualRunCeiling) }
  { name: 'POSTURE_STALENESS_FRESH_DAYS', value: string(postureStalenessFreshDays) }
  { name: 'POSTURE_STALENESS_CEILING_DAYS', value: string(postureStalenessCeilingDays) }
  { name: 'AGENT_POSTURE_SOURCE', value: agentPostureSource }
  // Incidents-agent (ADR-0028)
  { name: 'INCIDENTS_ANALYSIS_CACHE_CONTAINER', value: incidentsAnalysisCacheContainer }
  { name: 'INCIDENTS_ANALYSIS_RETENTION_DAYS', value: string(incidentsAnalysisRetentionDays) }
  { name: 'INCIDENTS_ANALYSIS_DAILY_TOKEN_BUDGET', value: string(incidentsAnalysisDailyTokenBudget) }
  { name: 'INCIDENTS_ANALYSIS_DAILY_RUN_CEILING', value: string(incidentsAnalysisDailyRunCeiling) }
  { name: 'INCIDENTS_ANALYSIS_DAILY_MANUAL_RUN_CEILING', value: string(incidentsAnalysisDailyManualRunCeiling) }
  { name: 'INCIDENTS_ANALYSIS_REDACTION_LOCK_HOURS', value: string(incidentsAnalysisRedactionLockHours) }
  { name: 'AGENT_INCIDENTS_SOURCE', value: agentIncidentsSource }
]

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: tags
  sku: {
    tier: 'FlexConsumption'
    name: 'FC1'
  }
  kind: 'functionapp'
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  tags: union(tags, { 'azd-service-name': 'api' })
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned, UserAssigned'
    // Agent MI bound only when the AI plane is enabled. `union()` merges
    // the two maps so the Function App's userAssignedIdentities collection
    // stays narrow (ingest + api-reader + audit + host) under
    // `deployAiAgents=false`. The agent MI resource itself is still
    // created in identities.bicep — unconditional there, re-bindable on
    // flip-back without a recreate.
    userAssignedIdentities: union({
      '${apiReaderMiResourceId}': {}
      '${ingestMiResourceId}': {}
      '${armIngestMiResourceId}': {}
      '${mailSenderMiResourceId}': {}
      '${auditWriterMiResourceId}': {}
      '${hostMiResourceId}': {}
      '${threatIntelMiResourceId}': {}
    }, deployAiAgents ? {
      '${agentMiResourceId}': {}
    } : {})
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    clientAffinityEnabled: false
    keyVaultReferenceIdentity: apiReaderMiResourceId
    // Flex Consumption VNet integration. `virtualNetworkSubnetId` binds
    // the FA's outbound to the `snet-func` subnet in `networking.bicep`;
    // `vnetRouteAllEnabled: true` forces ALL outbound (incl. Flex's
    // deployment-storage reads) through the VNet → private endpoints.
    // The subnet must be delegated to `Microsoft.App/environments` (done
    // in `networking.bicep`); a /24 minimum is enforced by Flex
    // Consumption itself, not Bicep. Empty `functionAppSubnetId`
    // preserves the legacy public-outbound posture (dev/test default).
    virtualNetworkSubnetId: empty(functionAppSubnetId) ? null : functionAppSubnetId
    vnetRouteAllEnabled: !empty(functionAppSubnetId)
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: 'https://${opsStorageAccountName}.blob.${az.environment().suffixes.storage}/${deploymentContainerName}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: hostMiResourceId
          }
        }
      }
      runtime: {
        name: 'node'
        version: '22'
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 100
        instanceMemoryMB: 2048
      }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      http20Enabled: true
      ftpsState: 'Disabled'
      // §10.66 Phase E (WS10 SEC-M-01 — risk-accepted option (a)). Boundary
      // protection replacing Easy Auth: allow ONLY Azure-internal traffic
      // sourced from the West Europe scale unit (covers SWA's outbound IPs
      // for the linked-backend proxy). The JWT validator in
      // api/src/lib/authMiddleware.ts is still the primary auth control;
      // this layer reduces the attack surface from "anywhere on the
      // internet" to "anywhere on Azure West Europe" per NIST SP 800-53
      // SC-7 (Boundary Protection).
      //
      // Forward-track (v1.1 hardening): narrow to the published per-region
      // SWA outbound CIDR list (refresh monthly from the Microsoft IP
      // Ranges JSON) AND lock the SCM site down to the deploy-agent CIDR
      // so Kudu / azd-deploy reach is only available from the runner
      // that legitimately needs it. The single-tenant dev workload
      // accepts the shared-scale-unit blast radius + open-SCM trade-off
      // today.
      //
      // SCM site (Kudu / azd-deploy reach) intentionally left
      // unrestricted — locking down requires a self-hosted build agent
      // and breaks `azd deploy` from arbitrary deploy origins. Forward-
      // tracked alongside the SWA outbound narrowing above.
      ipSecurityRestrictionsDefaultAction: 'Deny'
      ipSecurityRestrictions: [
        {
          ipAddress: 'AzureCloud.westeurope'
          tag: 'ServiceTag'
          action: 'Allow'
          priority: 100
          name: 'AllowAzureWestEurope'
          description: 'WS10 SEC-M-01(a) Azure West Europe (SWA outbound)'
        }
      ]
      scmIpSecurityRestrictionsUseMain: false
      appSettings: concat([
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'AzureWebJobsStorage__accountName'
          value: opsStorageAccountName
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          // Host MI owns AzureWebJobsStorage (account-scope Blob Data Owner +
          // Queue Data Contributor) — required for Timer singleton leases on
          // Flex Consumption. Moved off api-reader on 2026-04-19 to keep the
          // HTTP read-path MI narrow. See ADR-0011 update / storage-ops.bicep
          // `hostAccount*RoleAssignment` comments.
          name: 'AzureWebJobsStorage__clientId'
          value: hostMiClientId
        }
        // Application-layer MI selectors. Handlers pick the right MI by clientId via
        // `new DefaultAzureCredential({managedIdentityClientId: ...})`.
        {
          name: 'API_READER_MI_CLIENT_ID'
          value: apiReaderMiClientId
        }
        {
          name: 'HOST_MI_CLIENT_ID'
          value: hostMiClientId
        }
        {
          name: 'ARM_INGEST_MI_CLIENT_ID'
          value: armIngestMiClientId
        }
        // ADR-0030 Phase C — mail-sender MI client ID. Consumed by
        // `api/src/lib/reportEmail.ts` (Slice 1(b)+). Inert when no
        // mailbox configured (orchestrator §C.5.2 gates on this + the
        // TenantSettings `report-email-config.enabled` flag).
        {
          name: 'MAIL_SENDER_MI_CLIENT_ID'
          value: mailSenderMiClientId
        }
        // ADR-0030 Phase C Slice 1(c)+ — sender mailbox UPN. Read by
        // `api/src/functions/emailReportSnapshot.ts` (passed to orchestrator's
        // config.senderMailbox) and surfaced verbatim by settingsResponse.ts
        // for the SPA consent dialog. Empty when not configured — Phase C
        // stays inert and the admin endpoint returns 503 not_configured.
        {
          name: 'AZURE_MAIL_SENDER_UPN'
          value: mailSenderUpn
        }
        // ADR-0030 §C.21 — recipient-hash pepper KV coordinates. Read by
        // `api/src/lib/recipientHashPepper.ts` on first send. Empty values
        // leave the orchestrator on the legacy tenant-bound hash with an
        // AIEVENT (`report.email.pepper.fallback`) to surface the degraded
        // posture in telemetry.
        {
          name: 'RECIPIENT_HASH_PEPPER_KV_NAME'
          value: recipientHashPepperKvName
        }
        {
          name: 'RECIPIENT_HASH_PEPPER_KV_SECRET_NAME'
          value: recipientHashPepperKvSecretName
        }
        // SEC-L-L12-01 — hard-fail flag. Default empty string preserves the
        // fail-soft posture. Operator sets to "true" in prod after live
        // pepper-load is confirmed; first KV regression then returns 502
        // instead of silently downgrading to the legacy hash.
        {
          name: 'RECIPIENT_HASH_PEPPER_REQUIRED'
          value: recipientHashPepperRequired
        }
        // ADR-0030 §C.22 — report-share-link signing key KV coordinates.
        // The api-reader MI reads on demand at first share-link mint OR
        // verify. Empty values leave the share-link feature offline; the
        // email body falls back to legacy KPI rendering and an AIEVENT
        // `report.email.share_link.fallback` surfaces the degraded posture.
        {
          name: 'REPORT_SHARE_SIGNING_KEY_KV_NAME'
          value: reportShareSigningKeyKvName
        }
        {
          name: 'REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME'
          value: reportShareSigningKeyKvSecretName
        }
        // Fully-qualified URL prefix the email-issuer appends `/<token>` to.
        // Must be HTTPS — `buildShareUrlOrAievent` rejects non-HTTPS bases
        // defensively with a `url_base_not_https` AIEVENT fallback.
        {
          name: 'REPORT_SHARE_URL_BASE'
          value: reportShareUrlBase
        }
        // ADR-0037 — threatIntel MI selector. Consumed by
        // `api/src/lib/runRansomwareIntelIngest.ts` via
        // `new DefaultAzureCredential({managedIdentityClientId: ...})`.
        {
          name: 'THREAT_INTEL_MI_CLIENT_ID'
          value: threatIntelMiClientId
        }
        // ADR-0037 — ransomware.live PRO API key KV coordinates. Read by
        // the ingest lib on each Timer fire (cached for 1h, mirrors the
        // recipient-hash-pepper caching pattern). Empty values leave the
        // ingest path inert — IngestHealth status sticks at `not_configured`
        // and the tile auto-hides.
        {
          name: 'RANSOMWARE_LIVE_API_KEY_KV_NAME'
          value: ransomwareLiveApiKeyKvName
        }
        {
          name: 'RANSOMWARE_LIVE_API_KEY_KV_SECRET_NAME'
          value: ransomwareLiveApiKeyKvSecretName
        }
        // ADR-0037 — Timer cron string. Default 0 0 * * * * (top of every
        // hour, UTC). Operator override via AZURE_THREAT_INTEL_TIMER_CRON.
        {
          name: 'THREAT_INTEL_TIMER_CRON'
          value: threatIntelTimerCron
        }
        // ADR-0037 — RansomwareIntel table retention (days). Env-aware
        // sentinel-0 resolved in main.bicep (90 prod / 14 dev) flows in
        // here as a concrete int.
        {
          name: 'THREAT_INTEL_RETENTION_DAYS'
          value: string(threatIntelRetentionDays)
        }
        {
          name: 'INGEST_MI_CLIENT_ID'
          value: ingestMiClientId
        }
        {
          name: 'AUDIT_MI_CLIENT_ID'
          value: auditWriterMiClientId
        }
        // Ops + audit endpoints — derived here so sovereign-cloud deployers pick up the right
        // storage suffix from `az.environment()` without any code change (ADR-0010 §6).
        {
          name: 'OPS_TABLE_ENDPOINT'
          value: 'https://${opsStorageAccountName}.table.${az.environment().suffixes.storage}'
        }
        {
          name: 'AUDIT_BLOB_ENDPOINT'
          value: 'https://${auditStorageAccountName}.blob.${az.environment().suffixes.storage}'
        }
        // Microsoft Graph v1.0. Hardcoded because `az.environment().graph` in
        // Bicep returns the LEGACY Azure AD Graph endpoint
        // (`https://graph.windows.net/`), not Microsoft Graph — the two are
        // distinct services and Bicep's environment() schema does not expose
        // Microsoft Graph as a separate property. Pointing at AAD Graph yields
        // `Request_DataContractVersionMissing` 400 on the first call
        // (verified in step-3 deploy). Sovereign-cloud deployments
        // (US Government / China 21Vianet) need to override this as a
        // deployment parameter in a future pass.
        //   AzureCloud:        https://graph.microsoft.com/v1.0
        //   AzureUSGovernment: https://graph.microsoft.us/v1.0
        //   AzureChinaCloud:   https://microsoftgraph.chinacloudapi.cn/v1.0
        {
          name: 'GRAPH_BASE_URL'
          value: 'https://graph.microsoft.com/v1.0'
        }
        {
          name: 'GRAPH_API_TIMEOUT_MS'
          value: '30000'
        }
        // ADR-0036 v1.1 observation — dedicated ARM_API_TIMEOUT_MS so the
        // ARM ingest path can be tuned independently. Resolver falls back
        // to GRAPH_API_TIMEOUT_MS if unset.
        {
          name: 'ARM_API_TIMEOUT_MS'
          value: '30000'
        }
        // Deployment tenant GUID — partition key on IngestHealth and several
        // other per-tenant rows (ADR-0011 §5a). Required by resolveIngestConfig /
        // resolveApiConfig; ConfigError thrown on every handler invocation
        // if this is missing.
        {
          name: 'AZURE_TENANT_ID'
          value: subscription().tenantId
        }
        // --- Step 4 (ADR-0014 / ADR-0016) ---
        // Container name hint used by the API detail handler and the ingest
        // handler to construct the blob path — kept as an env var so any
        // rename of the container in Bicep lands in app settings without a
        // code change on the handler side.
        {
          name: 'INCIDENTS_DETAIL_CONTAINER_NAME'
          value: incidentsDetailContainerName
        }
        // Retention is authoritative on the storage lifecycle policy (ADR-0014
        // §3.3). This env var is informational — the ingest handler uses it
        // to derive the first-run cursor seed (`now - 24h` typically, but the
        // handler bounds back-seek at `min(24h, incidentsRetentionDays * 1d)`
        // so a dev env with 14d retention doesn't seed outside retention).
        {
          name: 'INCIDENTS_RETENTION_DAYS'
          value: string(incidentsRetentionDays)
        }
        // Timer schedule — Bicep is authoritative. The step-4 ingest handler
        // MUST bind the Timer trigger's schedule via the `%INCIDENTS_TIMER_CRON%`
        // binding expression so this app setting is the single source of truth:
        //
        //   app.timer("incidentsTimer", {
        //     schedule: "%INCIDENTS_TIMER_CRON%",
        //     runOnStartup: false,
        //     useMonitor: true,
        //     handler,
        //   });
        //
        // Hard-coding the CRON in the handler would make this Bicep param
        // cosmetic. Overriding per environment
        // (e.g. dev-smoke-test with `0 */1 * * * *`) is then one `azd env
        // set AZURE_INCIDENTS_TIMER_CRON=...` + `azd provision` away.
        {
          name: 'INCIDENTS_TIMER_CRON'
          value: incidentsTimerCron
        }
        // --- Step 6 (EntraRisk — ADRs 0023 / 0024) ---
        // Same `%NAME%` binding pattern as INCIDENTS_TIMER_CRON so the handler's
        // Timer schedule is Bicep-authoritative.
        {
          name: 'ENTRA_RISK_TIMER_CRON'
          value: entraRiskTimerCron
        }
        {
          name: 'ENTRA_RISK_RETENTION_DAYS'
          value: string(entraRiskRetentionDays)
        }
        {
          name: 'ENTRA_RISK_SOURCE'
          value: entraRiskSource
        }
        // --- Tenant branding (ADR-0029 Phase B) — not AI-plane ---
        {
          name: 'BRANDING_ASSETS_CONTAINER'
          value: brandingAssetsContainerName
        }
        // --- Reports (ADR-0030) — period snapshots ---
        {
          name: 'REPORT_SNAPSHOT_VERSIONS_PER_PERIOD'
          value: string(reportSnapshotVersionsPerPeriod)
        }
        {
          name: 'REPORT_SNAPSHOT_RETENTION_DAYS'
          value: string(reportSnapshotRetentionDays)
        }
        {
          name: 'REPORT_SNAPSHOT_SOURCE'
          value: reportSnapshotSource
        }
        // --- KEV (ADR-0032) — CISA Known Exploited Vulnerabilities ingest ---
        // Same %NAME% binding pattern as INCIDENTS_TIMER_CRON / ENTRA_RISK_TIMER_CRON
        // — handler binds via `schedule: "%KEV_TIMER_CRON%"` so Bicep is the single
        // source of truth. Feed URL is overridable for sovereign-cloud / test fixtures.
        {
          name: 'KEV_TIMER_CRON'
          value: kevTimerCron
        }
        // ADR-0033 §5 Phase 2.5 — KevSuppressions expiry sweep schedule.
        // Handler binds via `schedule: "%KEV_SUPPRESSIONS_SWEEP_CRON%"`.
        {
          name: 'KEV_SUPPRESSIONS_SWEEP_CRON'
          value: kevSuppressionsSweepCron
        }
        // ADR-0030 Phase B — report-snapshot auto-capture schedule.
        // Handler binds via `schedule: "%REPORT_SNAPSHOT_AUTO_CAPTURE_CRON%"`.
        {
          name: 'REPORT_SNAPSHOT_AUTO_CAPTURE_CRON'
          value: reportSnapshotAutoCaptureCron
        }
        // ADR-0034 §1 Phase 8B — User dormancy daily timer.
        // Handler binds via `schedule: "%USER_DORMANCY_TIMER_CRON%"`.
        {
          name: 'USER_DORMANCY_TIMER_CRON'
          value: userDormancyTimerCron
        }
        {
          name: 'USER_DORMANCY_SOURCE'
          value: userDormancySource
        }
        // ADR-0034 §1 Phase 8C — Sign-ins 15-minute timer.
        // Handler binds via `schedule: "%SIGN_INS_TIMER_CRON%"`.
        {
          name: 'SIGN_INS_TIMER_CRON'
          value: signInsTimerCron
        }
        // ADR-0034 §3.3 Phase 8D — Conditional Access hourly timer.
        // Handler binds via `schedule: "%CONDITIONAL_ACCESS_TIMER_CRON%"`.
        {
          name: 'CONDITIONAL_ACCESS_TIMER_CRON'
          value: conditionalAccessTimerCron
        }
        {
          name: 'CONDITIONAL_ACCESS_SOURCE'
          value: conditionalAccessSource
        }
        // ADR-0036 — Defender for Cloud Secure Score daily timer.
        // Handler binds via `schedule: "%AZURE_SECURE_SCORE_TIMER_CRON%"`.
        {
          name: 'AZURE_SECURE_SCORE_TIMER_CRON'
          value: azureSecureScoreTimerCron
        }
        {
          name: 'AZURE_SECURE_SCORE_SOURCE'
          value: azureSecureScoreSource
        }
        {
          name: 'AZURE_SECURE_SCORE_RETENTION_DAYS'
          value: string(azureSecureScoreRetentionDays)
        }
        // Subscription ID is sourced from Bicep at deploy time (single
        // sub in v1; multi-sub becomes operator-managed in ADR-0036
        // Phase B). Bicep's `subscription().id` returns
        // /subscriptions/<guid>; we want just the GUID.
        {
          name: 'AZURE_SECURE_SCORE_SUBSCRIPTION_ID'
          value: subscription().subscriptionId
        }
        {
          name: 'SIGN_INS_RETENTION_DAYS'
          value: string(signInsRetentionDays)
        }
        {
          name: 'SIGN_INS_SOURCE'
          value: signInsSource
        }
        // ADR-0035 §3 — native Entra JWT validator config. `AEGIS_API_APP_ID`
        // is the bare-GUID v2.0 audience; consumed by
        // `api/src/lib/authMiddleware.ts:resolveAuthConfig`. Empty-string
        // value here fails closed at boot — `resolveAuthConfig` rejects
        // non-GUID inputs with AuthConfigError. §10.66 Phase E: this is now
        // the sole auth surface (legacy x-ms-client-principal header path
        // retired; AEGIS_LEGACY_CLIENT_PRINCIPAL app setting dropped).
        {
          name: 'AEGIS_API_APP_ID'
          value: aegisApiAppId
        }
        {
          name: 'KEV_FEED_URL'
          value: kevFeedUrl
        }
        {
          name: 'KEV_FEED_TIMEOUT_MS'
          value: string(kevFeedTimeoutMs)
        }
        {
          name: 'KEV_FEED_MAX_BYTES'
          value: string(kevFeedMaxBytes)
        }
        {
          name: 'KEV_SOURCE'
          value: kevSource
        }
        // --- AI-plane toggle ---
        // Handler registrations in `api/src/index.ts` read this at module
        // load and short-circuit the agent imports when false. Always
        // present so the handler logic doesn't depend on an absent
        // setting (default-false interpretation fails closed).
        {
          name: 'AZURE_DEPLOY_AI_AGENTS'
          value: string(deployAiAgents)
        }
      ], deployAiAgents ? agentAppSettings : [])
    }
  }
}

// §10.66 Phase E — Easy Auth retired. Authentication is native MSAL Bearer
// validated in `api/src/lib/authMiddleware.ts`; network boundary is
// `siteConfig.ipSecurityRestrictions` above (WS10 SEC-M-01 risk-accepted
// option (a)). The resource is explicitly disabled (rather than deleted from
// the Bicep file) so the next provision flips a previously-enabled Easy Auth
// configuration to off — leaving the file out would let the existing
// configuration persist on the deployed FA.
resource auth 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: false
      runtimeVersion: '~2'
    }
    globalValidation: {
      requireAuthentication: false
      unauthenticatedClientAction: 'AllowAnonymous'
    }
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-to-law'
  scope: functionApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// NOTE: RBAC for the api-reader MI to the deployment container is assigned in
// storage-ops.bicep, scoped to the container only (least privilege per
// WS10 step-1 SEC-L-01 pattern). Not assigned here to avoid account- or
// RG-scoped assignments.

output functionAppName string = functionApp.name
output functionAppResourceId string = functionApp.id
output functionAppDefaultHostName string = functionApp.properties.defaultHostName
output functionAppSystemMiPrincipalId string = functionApp.identity.principalId
output planName string = plan.name
