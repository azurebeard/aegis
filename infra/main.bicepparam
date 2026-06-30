using 'main.bicep'

param workload = readEnvironmentVariable('AZURE_WORKLOAD', 'aegis')
param environment = readEnvironmentVariable('AZURE_ENV_NAME', 'dev')
param region = readEnvironmentVariable('AZURE_LOCATION', 'uksouth')
param regionShort = readEnvironmentVariable('AZURE_REGION_SHORT', 'uks')
// SWA control-plane region — independent of `region`, only 5 valid values.
// Default WEU keeps existing dev (already in WEU) at parity. See param
// header in main.bicep for the rationale + the SWA FAQ link.
param staticWebAppLocation = readEnvironmentVariable('AZURE_STATIC_WEB_APP_LOCATION', 'westeurope')
param adminEmail = readEnvironmentVariable('AZURE_ADMIN_EMAIL', '')
// ADR-0035 §3 — native Entra JWT validator config.
// `aegisApiAppId` is the bare-GUID v2.0 audience for the Function App's JWT
// validator. The postprovision hook reads `nativeAuth.apiAppId` from
// BOOTSTRAP_JSON and runs `azd env set AZURE_AEGIS_API_APP_ID=<appId>` after
// bootstrap-entra.ps1 reconciles the API app registration (Phase B). Empty
// on first deploy is fine — handlers fail-closed when a Bearer arrives at a
// FA with no configured audience.
//
// §10.66 Phase E — `swaMiAppId` (Easy Auth binding) and
// `aegisLegacyClientPrincipal` (dual-mode flag) both dropped here and in
// `main.bicep` / `functions.bicep`.
param aegisApiAppId = readEnvironmentVariable('AZURE_AEGIS_API_APP_ID', '')
// ADR-0030 Phase C — sender mailbox UPN. Set via `azd env set
// AZURE_MAIL_SENDER_UPN <upn>`; bootstrap-entra.ps1 reads the same var
// (azure.yaml passes it through) so Bicep + bootstrap stay aligned.
param azureMailSenderUpn = readEnvironmentVariable('AZURE_MAIL_SENDER_UPN', '')
// ADR-0030 §C.21 / WS10 L12 — operator (or azd SP) object ID granted
// Key Vault Secrets Officer so the bootstrap script can write/rotate the
// recipient-hash pepper. Empty disables the grant (headless deploys that
// skip pepper provisioning); a subsequent `bootstrap-entra.ps1` run will
// fail with a clear "no KV access" message instead of silently leaving
// the API on the legacy hash. Set via:
//   azd env set AZURE_DEPLOYER_OBJECT_ID $(az ad signed-in-user show --query id -o tsv)
param deployerObjectId = readEnvironmentVariable('AZURE_DEPLOYER_OBJECT_ID', '')
// F-fwd-3/F-fwd-4 — operator-public CIDR allowlist threaded to KV +
// ops-storage `networkAcls.ipRules` when `publicNetworkAccess=Disabled`.
// Comma-separated; empty default preserves the no-exception posture.
// Example: `azd env set AZURE_DEPLOYER_IP_ALLOWLIST "203.0.113.42/32"`.
param deployerIpAllowlist = readEnvironmentVariable('AZURE_DEPLOYER_IP_ALLOWLIST', '')
// SEC-L-L12-01 — hard-fail flag for prod. Set on the azd env with:
//   azd env set AZURE_RECIPIENT_HASH_PEPPER_REQUIRED true
// Default empty leaves the fail-soft posture (legacy hash + AIEVENT).
// Literal `"true"` (case-insensitive, whitespace-trimmed at the API)
// activates the 502 path when the KV pepper cannot be loaded.
param recipientHashPepperRequired = readEnvironmentVariable('AZURE_RECIPIENT_HASH_PEPPER_REQUIRED', '')
// ADR-0030 §C.22 — share-link URL base override (optional). Leave unset
// for the default SWA-hostname-derived URL. Set on the azd env with:
//   azd env set AZURE_REPORT_SHARE_URL_BASE https://reports.example.com/api/reports/share
// for a custom-domain deploy. Must be HTTPS — the API rejects non-HTTPS
// values via the fail-soft AIEVENT path.
param reportShareUrlBaseOverride = readEnvironmentVariable('AZURE_REPORT_SHARE_URL_BASE', '')
param auditRetentionDays = int(readEnvironmentVariable('AZURE_AUDIT_RETENTION_DAYS', '365'))
param privateEndpointsEnabled = bool(readEnvironmentVariable('AZURE_PRIVATE_ENDPOINTS_ENABLED', 'false'))
param logAnalyticsRetentionDays = int(readEnvironmentVariable('AZURE_LOG_ANALYTICS_RETENTION_DAYS', '30'))
param uniqueSuffix = readEnvironmentVariable('AZURE_UNIQUE_SUFFIX', '')
// 0 selects env-aware default in main.bicep (180 prod / 14 dev). Override with any
// positive integer to force a specific retention regardless of environment.
param incidentsRetentionDays = int(readEnvironmentVariable('AZURE_INCIDENTS_RETENTION_DAYS', '0'))
param incidentsTimerCron = readEnvironmentVariable('AZURE_INCIDENTS_TIMER_CRON', '0 */15 * * * *')

// Step 6 EntraRisk — ADR-0023. Same sentinel-0 env-aware retention pattern.
param entraRiskRetentionDays = int(readEnvironmentVariable('AZURE_ENTRA_RISK_RETENTION_DAYS', '0'))
param entraRiskTimerCron = readEnvironmentVariable('AZURE_ENTRA_RISK_TIMER_CRON', '0 0 */4 * * *')

// ADR-0030 (reports). Floor of 3 enforced at param-level; production
// recommendation 2555 days (7 years). Override via:
//   azd env set AZURE_REPORT_SNAPSHOT_VERSIONS_PER_PERIOD <int >= 3>
//   azd env set AZURE_REPORT_SNAPSHOT_RETENTION_DAYS <int >= 30>
param reportSnapshotVersionsPerPeriod = int(readEnvironmentVariable('AZURE_REPORT_SNAPSHOT_VERSIONS_PER_PERIOD', '3'))
param reportSnapshotRetentionDays = int(readEnvironmentVariable('AZURE_REPORT_SNAPSHOT_RETENTION_DAYS', '2555'))

// ADR-0032 (KEV). Daily 02:00 UTC default. Override via:
//   azd env set AZURE_KEV_TIMER_CRON "0 0 2 * * *"
param kevTimerCron = readEnvironmentVariable('AZURE_KEV_TIMER_CRON', '0 0 2 * * *')

// ADR-0037 (ransomware.live threat-intel). Hourly default. Override via:
//   azd env set AZURE_THREAT_INTEL_TIMER_CRON "0 0 * * * *"
//   azd env set AZURE_THREAT_INTEL_RETENTION_DAYS 90
// 0 selects env-aware default in main.bicep (90 prod / 14 dev).
param threatIntelTimerCron = readEnvironmentVariable('AZURE_THREAT_INTEL_TIMER_CRON', '0 0 * * * *')
param threatIntelRetentionDays = int(readEnvironmentVariable('AZURE_THREAT_INTEL_RETENTION_DAYS', '0'))

// ADR-0033 §5 Phase 2.5 — KevSuppressions expiry sweep. Daily 03:00 UTC
// default (one hour after the KEV ingest at 02:00). Hygiene-only; the
// read-time resolver already returns "open" for expired rows, so this
// Timer just physically deletes the dead entries. Override via:
//   azd env set AZURE_KEV_SUPPRESSIONS_SWEEP_CRON "0 0 3 * * *"
param kevSuppressionsSweepCron = readEnvironmentVariable('AZURE_KEV_SUPPRESSIONS_SWEEP_CRON', '0 0 3 * * *')

// ADR-0030 Phase B — daily auto-capture Timer for report snapshots.
// 04:00 UTC default — runs after KEV ingest (02:00) + suppressions sweep
// (03:00) so the snapshot reads fresh KEV data on the period-rollover day.
// Idempotent: skip-if-period-already-has-a-version. Override via:
//   azd env set AZURE_REPORT_SNAPSHOT_AUTO_CAPTURE_CRON "0 0 4 * * *"
param reportSnapshotAutoCaptureCron = readEnvironmentVariable('AZURE_REPORT_SNAPSHOT_AUTO_CAPTURE_CRON', '0 0 4 * * *')

// HANDOVER §6.3 `deployAiAgents` toggle. **Default `false`** (changed
// 2026-06-29 from `true` as part of the install-friction sweep). The AI
// plane brings in Foundry region availability + per-model SKU policy +
// cost budget commitments; a first-time installer who just wants the
// security dashboard shouldn't have to reason about any of that. Enable
// explicitly via:
//   azd env set AZURE_DEPLOY_AI_AGENTS true
// Accepted values: the literal strings `true` or `false` only. Bicep's
// `bool()` is strict — anything else (e.g. "0", "no", "off") fails at
// provision with "Expected a Boolean value". The API-side parse rule
// (config.ts:parseBooleanDefaultTrue) is fail-open for the SAME env var
// at runtime: only the literal "false" (case-insensitive, trimmed)
// disables the plane; everything else resolves to true. This two-layer
// posture is deliberate — Bicep surfaces typos loudly at deploy, the
// runtime fails-open to keep existing deployments on current behaviour
// (SEC-L-DAAA-02 resolution).
//
// Existing deployments are unaffected by this default change: their
// azd env already has `AZURE_DEPLOY_AI_AGENTS=true` persisted from the
// original deploy, and `readEnvironmentVariable` honours the persisted
// value before the default. Only NEW azd envs (`azd env new …` after
// this commit) start with the AI plane off; flipping it back on later
// is `azd env set AZURE_DEPLOY_AI_AGENTS true && azd provision` and
// Bicep re-creates everything via the standard path.
//
// Use cases for keeping it false: (a) evaluation deployments that want
// just the ingest + dashboard, (b) regulated tenants that cannot permit
// LLM retention even with Modified Abuse Monitoring, (c) air-gapped
// scenarios, (d) the first-time installer evaluating Aegis.
// Tables + blob containers for the AI plane persist across toggle
// (data-preservation); only RBAC, Foundry module, and handler
// registrations are skipped. Re-enable with `false → true` + reprovision.
// SEC-OBS-DAAA-04's cleanup script handles the reverse direction
// (`true → false`) so a flip-back leaves zero stale grants.
param deployAiAgents = bool(readEnvironmentVariable('AZURE_DEPLOY_AI_AGENTS', 'false'))

// Step 5 agent-layer knobs (ADRs 0017–0022). Same sentinel-0 env-aware pattern
// as incidentsRetentionDays for the retention and budget params.
param briefRetentionDays = int(readEnvironmentVariable('AZURE_BRIEF_RETENTION_DAYS', '0'))
param briefTimerCron = readEnvironmentVariable('AZURE_BRIEF_TIMER_CRON', '0 0 5 * * *')
param briefDailyTokenBudget = int(readEnvironmentVariable('AZURE_BRIEF_DAILY_TOKEN_BUDGET', '200000'))
param foundryBudgetGbp = int(readEnvironmentVariable('AZURE_FOUNDRY_BUDGET_GBP', '0'))
param autoDisableOnBudgetBreach = bool(readEnvironmentVariable('AZURE_FOUNDRY_AUTO_DISABLE_ON_BREACH', 'false'))
// budgetStartDate: empty default selects utcNow('yyyy-MM-01') in main.bicep
// on first deploy. After provision succeeds, postprovision captures the
// canonical value from Azure and writes AZURE_BUDGET_START_DATE so future
// deploys submit an unchanged value (Microsoft.Consumption/budgets enforces
// startDate immutability — any change is rejected with "Start date of
// budgets cannot be updated").
param budgetStartDate = readEnvironmentVariable('AZURE_BUDGET_START_DATE', '')
