// Runtime configuration resolver — reads the app settings that Bicep writes
// on the Function App and normalises them into a typed object. Fails loud on
// missing required values so a mis-provisioned deploy surfaces immediately
// rather than silently calling the wrong MI or hitting the wrong endpoint.

export interface IngestConfig {
  readonly ingestMiClientId: string;
  readonly auditMiClientId: string;
  readonly apiReaderMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly opsBlobEndpoint: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly brandingAssetsContainer: string;
  readonly graphBaseUrl: string;
  readonly graphApiTimeoutMs: number;
  readonly tenantId: string;
  readonly leaseWindowMs: number;
  readonly retentionCap: number;
  readonly source: string;
  /** Mirror of `ApiConfig.deployAiAgents` — same parse rule. Kept here
   *  so admin-write handlers (patchSettings / uploadBrandingLogo /
   *  deleteBrandingLogo) can read the flag from a single config object
   *  rather than a separate `resolveDeployAiAgents()` call (SEC-L-DAAA-01
   *  resolution — standardised plumbing across all four settings-
   *  response callers). */
  readonly deployAiAgents: boolean;
}

/** ADR-0032 — config bundle for the KEV ingest vertical. */
export interface KevIngestConfig {
  readonly ingestMiClientId: string;
  readonly auditMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly tenantId: string;
  readonly leaseWindowMs: number;
  readonly source: string; // "cisa.kev"
  readonly feedUrl: string;
  readonly feedTimeoutMs: number;
  readonly feedMaxBytes: number;
}

export function resolveKevIngestConfig(env: NodeJS.ProcessEnv = process.env): KevIngestConfig {
  const opsTableEndpoint = must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT);
  const feedTimeoutMs = Number.parseInt(env.KEV_FEED_TIMEOUT_MS ?? "30000", 10);
  if (!Number.isFinite(feedTimeoutMs) || feedTimeoutMs < 1000) {
    throw new ConfigError(`KEV_FEED_TIMEOUT_MS must be >= 1000 (got ${env.KEV_FEED_TIMEOUT_MS ?? "<unset>"})`);
  }
  const feedMaxBytes = Number.parseInt(env.KEV_FEED_MAX_BYTES ?? "52428800", 10);
  if (!Number.isFinite(feedMaxBytes) || feedMaxBytes < 1024 * 1024) {
    throw new ConfigError(`KEV_FEED_MAX_BYTES must be >= 1048576 (got ${env.KEV_FEED_MAX_BYTES ?? "<unset>"})`);
  }
  return {
    ingestMiClientId: must("INGEST_MI_CLIENT_ID", env.INGEST_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    opsTableEndpoint,
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    leaseWindowMs: Number.parseInt(env.INGEST_LEASE_WINDOW_MS ?? "300000", 10),
    source: env.KEV_SOURCE ?? "cisa.kev",
    feedUrl: env.KEV_FEED_URL ?? "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    feedTimeoutMs,
    feedMaxBytes,
  };
}

/** ADR-0030 — config bundle for the reports/snapshots vertical. Pulled
 *  from app settings authoritative on functions.bicep:
 *    REPORT_SNAPSHOT_VERSIONS_PER_PERIOD (>=3 enforced at config load)
 *    REPORT_SNAPSHOT_RETENTION_DAYS      (>=30 enforced at config load)
 *    REPORT_SNAPSHOT_SOURCE              (audit-chain source, defaults to "report.snapshot") */
export interface ReportSnapshotConfig {
  readonly versionsPerPeriod: number;
  readonly retentionDays: number;
  readonly source: string;
  /** ADR-0030 Phase B — daily auto-capture Timer cron. The Timer binds via
   *  `%REPORT_SNAPSHOT_AUTO_CAPTURE_CRON%`; this string is also surfaced to
   *  the SPA via the settings response so /reports can render a "next
   *  auto-capture" badge without hard-coding the schedule. */
  readonly autoCaptureCron: string;
}

export function resolveReportSnapshotConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReportSnapshotConfig {
  const versionsPerPeriod = Number.parseInt(
    env.REPORT_SNAPSHOT_VERSIONS_PER_PERIOD ?? "3",
    10,
  );
  if (!Number.isFinite(versionsPerPeriod) || versionsPerPeriod < 3) {
    throw new ConfigError(
      `REPORT_SNAPSHOT_VERSIONS_PER_PERIOD must be >= 3 (got ${env.REPORT_SNAPSHOT_VERSIONS_PER_PERIOD ?? "<unset>"})`,
    );
  }
  const retentionDays = Number.parseInt(env.REPORT_SNAPSHOT_RETENTION_DAYS ?? "2555", 10);
  if (!Number.isFinite(retentionDays) || retentionDays < 30) {
    throw new ConfigError(
      `REPORT_SNAPSHOT_RETENTION_DAYS must be >= 30 (got ${env.REPORT_SNAPSHOT_RETENTION_DAYS ?? "<unset>"})`,
    );
  }
  return {
    versionsPerPeriod,
    retentionDays,
    source: env.REPORT_SNAPSHOT_SOURCE ?? "report.snapshot",
    autoCaptureCron: env.REPORT_SNAPSHOT_AUTO_CAPTURE_CRON ?? "0 0 4 * * *",
  };
}

export interface IncidentsIngestConfig {
  readonly ingestMiClientId: string;
  readonly auditMiClientId: string;
  readonly apiReaderMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly opsBlobEndpoint: string; // https://<opsAcct>.blob.<suffix>
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly incidentsDetailContainerName: string;
  readonly graphBaseUrl: string;
  readonly graphApiTimeoutMs: number;
  readonly tenantId: string;
  readonly leaseWindowMs: number;
  readonly source: string; // "graph.security.incidents"
  readonly retentionDays: number; // ADR-0014 §5
  readonly cursorOverlapMs: number; // ADR-0014 §2 — default 120_000
  readonly cursorWriteSkewAllowanceMs: number; // ADR-0014 §2 — default 5min
  readonly cursorReadCorruptThresholdMs: number; // ADR-0014 §2 — default 1h
  readonly firstRunSeedBackSeekMs: number; // ADR-0014 §2 — default 24h
  readonly pageSize: number; // $top — default 50
}

export class ConfigError extends Error {
  constructor(missing: string) {
    super(`missing required app setting: ${missing}`);
    this.name = "ConfigError";
  }
}

function must(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new ConfigError(name);
  }
  return value;
}

export function resolveIngestConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const opsTableEndpoint = must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT);
  return {
    ingestMiClientId: must("INGEST_MI_CLIENT_ID", env.INGEST_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    apiReaderMiClientId: must("API_READER_MI_CLIENT_ID", env.API_READER_MI_CLIENT_ID),
    opsTableEndpoint,
    opsBlobEndpoint: deriveOpsBlobEndpoint(opsTableEndpoint),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    brandingAssetsContainer: env.BRANDING_ASSETS_CONTAINER ?? "branding-assets",
    graphBaseUrl: must("GRAPH_BASE_URL", env.GRAPH_BASE_URL),
    graphApiTimeoutMs: Number.parseInt(env.GRAPH_API_TIMEOUT_MS ?? "30000", 10),
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    leaseWindowMs: Number.parseInt(env.INGEST_LEASE_WINDOW_MS ?? "300000", 10), // 5 min
    retentionCap: Number.parseInt(env.SECURE_SCORE_RETENTION_CAP ?? "400", 10),
    source: env.INGEST_SOURCE ?? "graph.security.secureScores",
    deployAiAgents: parseBooleanDefaultTrue(env.AZURE_DEPLOY_AI_AGENTS),
  };
}

export interface ApiConfig {
  readonly apiReaderMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly opsBlobEndpoint: string;
  readonly brandingAssetsContainer: string;
  readonly tenantId: string;
  readonly source: string;
  /** HANDOVER §6.3 `deployAiAgents` — resolved from `AZURE_DEPLOY_AI_AGENTS`
   *  app setting. Default true (the AI plane deploys unconditionally unless
   *  the operator explicitly opts out at provision time). Handlers gate
   *  their own registration on this flag in `api/src/index.ts`; the
   *  settings response surfaces it to the SPA as `aiPlaneEnabled` so the
   *  admin page hides agent-related sections and HomePage hides the AI
   *  tiles without extra routing changes.
   *
   *  Parsing rule: the string `"false"` (case-insensitive) is the only
   *  value that disables the plane. Any other value — absent, empty,
   *  "true", garbage — resolves to `true`. Fail-open posture matches the
   *  migration story (existing deployments without the setting keep their
   *  current behaviour). */
  readonly deployAiAgents: boolean;
}

/** Parse an optional `"true" | "false"` env var with fail-open default.
 *  The ONLY value that returns false is the literal string `"false"`
 *  (case-insensitive). Absent / empty / anything-else → true. */
function parseBooleanDefaultTrue(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const normalised = raw.trim().toLowerCase();
  return normalised !== "false";
}

export function resolveApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const opsTableEndpoint = must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT);
  return {
    apiReaderMiClientId: must("API_READER_MI_CLIENT_ID", env.API_READER_MI_CLIENT_ID),
    opsTableEndpoint,
    opsBlobEndpoint: deriveOpsBlobEndpoint(opsTableEndpoint),
    brandingAssetsContainer: env.BRANDING_ASSETS_CONTAINER ?? "branding-assets",
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    source: env.INGEST_SOURCE ?? "graph.security.secureScores",
    deployAiAgents: parseBooleanDefaultTrue(env.AZURE_DEPLOY_AI_AGENTS),
  };
}

/** Exported for use by the handler-registration short-circuit in
 *  `api/src/index.ts` and for unit tests. Single source of truth so the
 *  Function App + handler guard both read the same env var with the
 *  same parse rule. */
export function resolveDeployAiAgents(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanDefaultTrue(env.AZURE_DEPLOY_AI_AGENTS);
}

// --- Incidents-specific config (ADR-0014 + ADR-0016) ------------------------

export interface IncidentsApiConfig extends ApiConfig {
  readonly opsBlobEndpoint: string;
  readonly incidentsDetailContainerName: string;
  readonly incidentsSource: string;
}

/**
 * Derive the ops-blob endpoint from the ops-table endpoint. The Bicep module
 * only exports `OPS_TABLE_ENDPOINT` today; the ops-blob host differs only in
 * the sub-domain (`.table.` → `.blob.`). Keeping the transform here avoids
 * a second Bicep output + app setting per vertical.
 */
export function deriveOpsBlobEndpoint(opsTableEndpoint: string): string {
  return opsTableEndpoint.replace(/\.table\./, ".blob.");
}

export function resolveIncidentsApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): IncidentsApiConfig {
  const base = resolveApiConfig(env);
  const opsBlobEndpoint = deriveOpsBlobEndpoint(base.opsTableEndpoint);
  return {
    ...base,
    opsBlobEndpoint,
    incidentsDetailContainerName: must(
      "INCIDENTS_DETAIL_CONTAINER_NAME",
      env.INCIDENTS_DETAIL_CONTAINER_NAME,
    ),
    incidentsSource: env.INCIDENTS_SOURCE ?? "graph.security.incidents",
  };
}

// --- Brief-agent config (ADRs 0017–0022) --------------------------------------

export interface BriefAgentConfig {
  readonly agentMiClientId: string;
  readonly auditMiClientId: string;
  readonly apiReaderMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly opsBlobEndpoint: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly briefCacheContainer: string;
  readonly postureCacheContainer: string; // ADR-0027 §Decision.5 — "posture-narratives"
  readonly incidentsDetailContainerName: string;
  readonly tenantId: string;
  readonly foundryProjectEndpoint: string;
  readonly foundryProjectName: string;
  readonly foundryRegion: string;
  readonly briefModelDeployment: string;
  readonly briefDailyTokenBudget: number;
  readonly briefDailyRunCeiling: number;
  readonly briefDailyManualRunCeiling: number;
  readonly briefTimerCron: string;
  readonly briefRetentionDays: number;
  readonly briefStalenessFreshHours: number;
  readonly briefStalenessCeilingHours: number;
  readonly agentBriefSource: string; // "agent.aegis.brief"
  /** ADR-0027 §Decision.4 — posture-agent budget + schedule + freshness.
   *  Naming is `Weekly` because the AgentBudget row is keyed per ISO week
   *  for posture (`agent.posture.<yyyy-Www>`); ceilings therefore enforce
   *  weekly aggregates (SEC-L-B2-01 resolution 2026-04-21). */
  readonly postureWeeklyTokenBudget: number;
  readonly postureWeeklyRunCeiling: number;
  readonly postureWeeklyManualRunCeiling: number;
  readonly postureTimerCron: string;
  readonly postureRetentionDays: number;
  readonly postureStalenessFreshDays: number;
  readonly postureStalenessCeilingDays: number;
  readonly agentPostureSource: string; // "agent.aegis.posture"
  /** ADR-0028 §Decision.4 — incidents-agent budget + freshness. */
  readonly incidentsAnalysisDailyTokenBudget: number;
  readonly incidentsAnalysisDailyRunCeiling: number;
  readonly incidentsAnalysisDailyManualRunCeiling: number;
  readonly incidentsAnalysisRedactionLockHours: number;
  readonly incidentsAnalysisCacheContainer: string;
  readonly incidentsAnalysisRetentionDays: number;
  readonly agentIncidentsSource: string; // "agent.aegis.incidents"
  readonly leaseWindowMs: number;
  readonly incidentsSource: string;
  readonly secureScoreSource: string;
}

export function resolveBriefAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): BriefAgentConfig {
  const opsTableEndpoint = must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT);
  const foundryRegion = must("FOUNDRY_REGION", env.FOUNDRY_REGION);
  // Region-parity belt-and-braces (ADR-0017 §2): ops endpoint host encodes the
  // region (e.g. staegisopsdevweu.table.core.windows.net → weu ≈ westeurope).
  // An operator who edited app settings post-deploy without re-running azd up
  // could land a divergent FOUNDRY_REGION; surface as ConfigError at boot.
  const opsRegionSlug = deriveRegionSlug(opsTableEndpoint);
  const foundryRegionSlug = normaliseRegion(foundryRegion);
  if (opsRegionSlug && foundryRegionSlug && opsRegionSlug !== foundryRegionSlug) {
    throw new ConfigError(
      `region parity violation: ops endpoint region=${opsRegionSlug} FOUNDRY_REGION=${foundryRegionSlug} (ADR-0017 §2)`,
    );
  }
  return {
    agentMiClientId: must("AGENT_MI_CLIENT_ID", env.AGENT_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    apiReaderMiClientId: must("API_READER_MI_CLIENT_ID", env.API_READER_MI_CLIENT_ID),
    opsTableEndpoint,
    opsBlobEndpoint: deriveOpsBlobEndpoint(opsTableEndpoint),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    briefCacheContainer: must("BRIEF_CACHE_CONTAINER", env.BRIEF_CACHE_CONTAINER),
    postureCacheContainer: env.POSTURE_CACHE_CONTAINER ?? "posture-narratives",
    incidentsDetailContainerName: must(
      "INCIDENTS_DETAIL_CONTAINER_NAME",
      env.INCIDENTS_DETAIL_CONTAINER_NAME,
    ),
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    foundryProjectEndpoint: must(
      "FOUNDRY_PROJECT_ENDPOINT",
      env.FOUNDRY_PROJECT_ENDPOINT,
    ),
    foundryProjectName: must("FOUNDRY_PROJECT_NAME", env.FOUNDRY_PROJECT_NAME),
    foundryRegion,
    briefModelDeployment: must("BRIEF_MODEL_DEPLOYMENT", env.BRIEF_MODEL_DEPLOYMENT),
    briefDailyTokenBudget: Number.parseInt(
      env.BRIEF_DAILY_TOKEN_BUDGET ?? "200000",
      10,
    ),
    briefDailyRunCeiling: Number.parseInt(env.BRIEF_DAILY_RUN_CEILING ?? "50", 10),
    briefDailyManualRunCeiling: Number.parseInt(
      env.BRIEF_DAILY_MANUAL_RUN_CEILING ?? "30",
      10,
    ),
    briefTimerCron: env.BRIEF_TIMER_CRON ?? "0 0 5 * * *",
    briefRetentionDays: Number.parseInt(env.BRIEF_RETENTION_DAYS ?? "14", 10),
    briefStalenessFreshHours: Number.parseInt(
      env.BRIEF_STALENESS_FRESH_HOURS ?? "26",
      10,
    ),
    briefStalenessCeilingHours: Number.parseInt(
      env.BRIEF_STALENESS_CEILING_HOURS ?? "72",
      10,
    ),
    agentBriefSource: env.AGENT_BRIEF_SOURCE ?? "agent.aegis.brief",
    postureWeeklyTokenBudget: Number.parseInt(
      env.POSTURE_WEEKLY_TOKEN_BUDGET ?? "20000",
      10,
    ),
    postureWeeklyRunCeiling: Number.parseInt(
      env.POSTURE_WEEKLY_RUN_CEILING ?? "15",
      10,
    ),
    postureWeeklyManualRunCeiling: Number.parseInt(
      env.POSTURE_WEEKLY_MANUAL_RUN_CEILING ?? "10",
      10,
    ),
    postureTimerCron: env.POSTURE_TIMER_CRON ?? "0 0 6 * * 1",
    postureRetentionDays: Number.parseInt(env.POSTURE_RETENTION_DAYS ?? "21", 10),
    postureStalenessFreshDays: Number.parseInt(
      env.POSTURE_STALENESS_FRESH_DAYS ?? "7",
      10,
    ),
    postureStalenessCeilingDays: Number.parseInt(
      env.POSTURE_STALENESS_CEILING_DAYS ?? "14",
      10,
    ),
    agentPostureSource: env.AGENT_POSTURE_SOURCE ?? "agent.aegis.posture",
    incidentsAnalysisDailyTokenBudget: Number.parseInt(
      env.INCIDENTS_ANALYSIS_DAILY_TOKEN_BUDGET ?? "15000",
      10,
    ),
    incidentsAnalysisDailyRunCeiling: Number.parseInt(
      env.INCIDENTS_ANALYSIS_DAILY_RUN_CEILING ?? "30",
      10,
    ),
    incidentsAnalysisDailyManualRunCeiling: Number.parseInt(
      env.INCIDENTS_ANALYSIS_DAILY_MANUAL_RUN_CEILING ?? "20",
      10,
    ),
    incidentsAnalysisRedactionLockHours: Number.parseInt(
      env.INCIDENTS_ANALYSIS_REDACTION_LOCK_HOURS ?? "24",
      10,
    ),
    incidentsAnalysisCacheContainer:
      env.INCIDENTS_ANALYSIS_CACHE_CONTAINER ?? "incident-narratives",
    incidentsAnalysisRetentionDays: Number.parseInt(
      env.INCIDENTS_ANALYSIS_RETENTION_DAYS ?? "90",
      10,
    ),
    agentIncidentsSource: env.AGENT_INCIDENTS_SOURCE ?? "agent.aegis.incidents",
    leaseWindowMs: Number.parseInt(env.AGENT_LEASE_WINDOW_MS ?? "300000", 10),
    incidentsSource: env.INCIDENTS_SOURCE ?? "graph.security.incidents",
    secureScoreSource: env.INGEST_SOURCE ?? "graph.security.secureScores",
  };
}

/** Parse `https://staegisopsdevweu.table.core.windows.net` → `weu`. */
function deriveRegionSlug(endpoint: string): string | null {
  const match = endpoint.match(/\/\/[^.]+?([a-z]{3})\.table\./);
  return match?.[1] ?? null;
}

/** Map Azure region name to the 3-letter slug used in CAF naming. */
function normaliseRegion(region: string): string | null {
  const lower = region.toLowerCase().replace(/\s+/g, "");
  const map: Record<string, string> = {
    westeurope: "weu",
    northeurope: "neu",
    uksouth: "uks",
    ukwest: "ukw",
    eastus: "eus",
    eastus2: "eus2",
    westus: "wus",
    westus2: "wus2",
    westus3: "wus3",
    centralus: "cus",
    swedencentral: "sec",
  };
  return map[lower] ?? null;
}

// --- EntraRisk-specific config (ADR-0023 + ADR-0024) -------------------------

export interface EntraRiskIngestConfig {
  readonly ingestMiClientId: string;
  readonly auditMiClientId: string;
  readonly apiReaderMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly graphBaseUrl: string;
  readonly graphApiTimeoutMs: number;
  readonly tenantId: string;
  readonly leaseWindowMs: number;
  readonly source: string; // "graph.security.riskyUsers"
  readonly entraRiskTimerCron: string;
  readonly entraRiskRetentionDays: number;
  readonly cursorOverlapMs: number; // ADR-0023 §5 — default 120_000
  readonly cursorWriteSkewAllowanceMs: number; // default 5min
  readonly cursorReadCorruptThresholdMs: number; // default 1h
  readonly firstRunSeedBackSeekMs: number; // default 24h
  readonly pageSize: number; // $top — default 500 (Graph max for this endpoint)
  readonly adminDailyRunCeiling: number; // ADR-0024 §1.3 — default 30
}

export interface EntraRiskApiConfig extends ApiConfig {
  readonly entraRiskSource: string;
}

export function resolveEntraRiskApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): EntraRiskApiConfig {
  const base = resolveApiConfig(env);
  return {
    ...base,
    entraRiskSource: env.ENTRA_RISK_SOURCE ?? "graph.security.riskyUsers",
  };
}

// --- User dormancy config (ADR-0034 §1) ----------------------------

export interface UserDormancyIngestConfig {
  readonly ingestMiClientId: string;
  readonly auditMiClientId: string;
  readonly apiReaderMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly graphBaseUrl: string;
  readonly graphApiTimeoutMs: number;
  readonly tenantId: string;
  readonly leaseWindowMs: number;
  readonly source: string; // "graph.users.dormancy"
  readonly userDormancyTimerCron: string;
  readonly userDormancyDefaultThresholdDays: number;
  readonly pageSize: number;
  readonly adminDailyRunCeiling: number;
}

export interface UserDormancyApiConfig extends ApiConfig {
  readonly userDormancySource: string;
}

export function resolveUserDormancyApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): UserDormancyApiConfig {
  const base = resolveApiConfig(env);
  return {
    ...base,
    userDormancySource: env.USER_DORMANCY_SOURCE ?? "graph.users.dormancy",
  };
}

/** ADR-0034 Phase 8E — config for `/api/identities/service-principals`. The
 *  endpoint makes a Graph call at read time so it needs the ingest MI's
 *  client ID (Graph token source) AND the Graph base URL. Reads no Tables
 *  itself; tenant identity flows through for log/correlation parity. */
export interface IdentitiesApiConfig extends ApiConfig {
  readonly ingestMiClientId: string;
  readonly graphBaseUrl: string;
  readonly graphApiTimeoutMs: number;
}

export function resolveIdentitiesApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdentitiesApiConfig {
  const base = resolveApiConfig(env);
  return {
    ...base,
    ingestMiClientId: must("INGEST_MI_CLIENT_ID", env.INGEST_MI_CLIENT_ID),
    graphBaseUrl: must("GRAPH_BASE_URL", env.GRAPH_BASE_URL),
    graphApiTimeoutMs: Number.parseInt(env.GRAPH_API_TIMEOUT_MS ?? "30000", 10),
  };
}

// --- Defender for Cloud Secure Score config (ADR-0036) ---------------------

export interface AzureSecureScoreIngestConfig {
  /** ARM data-plane MI (ADR-0036 v1.2 M-Q2). Used for the secureScores ARM
   *  call AND for the table writes against AzureSecureScores + IngestHealth.
   *  Originally this path used `ingestMiClientId` (shared with the Graph
   *  ingest path); split-out in v1.2 to bound cross-data-plane blast radius. */
  readonly armIngestMiClientId: string;
  readonly auditMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly armApiTimeoutMs: number;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly source: string; // "azure.security.defenderForCloud.secureScores"
  readonly azureSecureScoreTimerCron: string;
  readonly retentionDays: number;
  readonly adminDailyRunCeiling: number;
}

export interface AzureSecureScoreApiConfig extends ApiConfig {
  readonly azureSecureScoreSource: string;
}

export function resolveAzureSecureScoreApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): AzureSecureScoreApiConfig {
  const base = resolveApiConfig(env);
  return {
    ...base,
    azureSecureScoreSource:
      env.AZURE_SECURE_SCORE_SOURCE ?? "azure.security.defenderForCloud.secureScores",
  };
}

export function resolveAzureSecureScoreIngestConfig(
  env: NodeJS.ProcessEnv = process.env,
): AzureSecureScoreIngestConfig {
  return {
    armIngestMiClientId: must("ARM_INGEST_MI_CLIENT_ID", env.ARM_INGEST_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    opsTableEndpoint: must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    // ADR-0036 v1.1 observation — dedicated ARM_API_TIMEOUT_MS so the ARM
    // ingest path can be tuned independently of the Graph timeout (ARM
    // throttling behaviour is distinct from Graph's per-app-quota model).
    // Falls back to GRAPH_API_TIMEOUT_MS for backwards-compat with any
    // operator who set the latter before ARM_API_TIMEOUT_MS shipped.
    armApiTimeoutMs: Number.parseInt(
      env.ARM_API_TIMEOUT_MS ?? env.GRAPH_API_TIMEOUT_MS ?? "30000",
      10,
    ),
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    subscriptionId: must(
      "AZURE_SECURE_SCORE_SUBSCRIPTION_ID",
      env.AZURE_SECURE_SCORE_SUBSCRIPTION_ID,
    ),
    source: env.AZURE_SECURE_SCORE_SOURCE ?? "azure.security.defenderForCloud.secureScores",
    azureSecureScoreTimerCron: env.AZURE_SECURE_SCORE_TIMER_CRON ?? "0 30 2 * * *",
    retentionDays: Number.parseInt(env.AZURE_SECURE_SCORE_RETENTION_DAYS ?? "90", 10),
    adminDailyRunCeiling: Number.parseInt(env.ADMIN_RUN_DAILY_CEILING ?? "30", 10),
  };
}

// --- Conditional Access policy state config (ADR-0034 §3.3) -------

export interface ConditionalAccessIngestConfig {
  readonly ingestMiClientId: string;
  readonly auditMiClientId: string;
  readonly apiReaderMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly graphBaseUrl: string;
  readonly graphApiTimeoutMs: number;
  readonly tenantId: string;
  readonly leaseWindowMs: number;
  readonly source: string; // "graph.identity.conditionalAccess.policies"
  readonly conditionalAccessTimerCron: string;
  readonly adminDailyRunCeiling: number;
}

/** Shared audit-context resolver. Surfaces that read the audit blob (e.g.
 *  `getConditionalAccessSummary`'s drift-24h, `getNotifications`'
 *  ca.policy.changed entries) MUST go through this single helper so a
 *  missing env var fails fast at one site rather than silently degrading
 *  via `?? ""` fallbacks scattered across handlers (WS10 SEC-MED-CA-TILE-
 *  NOTIF-01 — "secure-by-default config, not by intention"). The audit MI
 *  has read access to the container; api-reader MI does not. */
export interface AuditReadContext {
  readonly auditMiClientId: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
}

export function resolveAuditReadContext(
  env: NodeJS.ProcessEnv = process.env,
): AuditReadContext {
  return {
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
  };
}

export interface ConditionalAccessApiConfig extends ApiConfig, AuditReadContext {
  readonly conditionalAccessSource: string;
}

export function resolveConditionalAccessApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConditionalAccessApiConfig {
  const base = resolveApiConfig(env);
  const audit = resolveAuditReadContext(env);
  return {
    ...base,
    ...audit,
    conditionalAccessSource:
      env.CONDITIONAL_ACCESS_SOURCE ?? "graph.identity.conditionalAccess.policies",
  };
}

export function resolveConditionalAccessIngestConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConditionalAccessIngestConfig {
  return {
    ingestMiClientId: must("INGEST_MI_CLIENT_ID", env.INGEST_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    apiReaderMiClientId: must("API_READER_MI_CLIENT_ID", env.API_READER_MI_CLIENT_ID),
    opsTableEndpoint: must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    graphBaseUrl: must("GRAPH_BASE_URL", env.GRAPH_BASE_URL),
    graphApiTimeoutMs: Number.parseInt(env.GRAPH_API_TIMEOUT_MS ?? "30000", 10),
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    leaseWindowMs: Number.parseInt(env.INGEST_LEASE_WINDOW_MS ?? "300000", 10),
    source: env.CONDITIONAL_ACCESS_SOURCE ?? "graph.identity.conditionalAccess.policies",
    // ADR-0034 §1 — hourly cron at minute 0.
    conditionalAccessTimerCron: env.CONDITIONAL_ACCESS_TIMER_CRON ?? "0 0 * * * *",
    adminDailyRunCeiling: Number.parseInt(env.ADMIN_RUN_DAILY_CEILING ?? "30", 10),
  };
}

export function resolveUserDormancyIngestConfig(
  env: NodeJS.ProcessEnv = process.env,
): UserDormancyIngestConfig {
  return {
    ingestMiClientId: must("INGEST_MI_CLIENT_ID", env.INGEST_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    apiReaderMiClientId: must("API_READER_MI_CLIENT_ID", env.API_READER_MI_CLIENT_ID),
    opsTableEndpoint: must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    graphBaseUrl: must("GRAPH_BASE_URL", env.GRAPH_BASE_URL),
    graphApiTimeoutMs: Number.parseInt(env.GRAPH_API_TIMEOUT_MS ?? "30000", 10),
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    leaseWindowMs: Number.parseInt(env.INGEST_LEASE_WINDOW_MS ?? "300000", 10),
    source: env.USER_DORMANCY_SOURCE ?? "graph.users.dormancy",
    // ADR-0034 §1 — daily 01:30 UTC. Lands before the SecureScore 03:00 fire.
    userDormancyTimerCron: env.USER_DORMANCY_TIMER_CRON ?? "0 30 1 * * *",
    userDormancyDefaultThresholdDays: Number.parseInt(
      env.USER_DORMANCY_DEFAULT_THRESHOLD_DAYS ?? "30",
      10,
    ),
    pageSize: Number.parseInt(env.USER_DORMANCY_PAGE_SIZE ?? "999", 10),
    adminDailyRunCeiling: Number.parseInt(
      env.USER_DORMANCY_ADMIN_DAILY_RUN_CEILING ?? "30",
      10,
    ),
  };
}

// --- Sign-ins config (ADR-0034 §1, §3.2) ----------------------------

export interface SignInsIngestConfig {
  readonly ingestMiClientId: string;
  readonly auditMiClientId: string;
  readonly apiReaderMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly graphBaseUrl: string;
  readonly graphApiTimeoutMs: number;
  readonly tenantId: string;
  readonly leaseWindowMs: number;
  readonly source: string; // "graph.auditLogs.signIns"
  readonly signInsTimerCron: string;
  readonly retentionDays: number;
  readonly cursorOverlapMs: number;
  readonly cursorWriteSkewAllowanceMs: number;
  readonly cursorReadCorruptThresholdMs: number;
  readonly firstRunSeedBackSeekMs: number;
  readonly pageSize: number;
  readonly adminDailyRunCeiling: number;
}

export interface SignInsApiConfig extends ApiConfig {
  readonly signInsSource: string;
}

export function resolveSignInsApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): SignInsApiConfig {
  const base = resolveApiConfig(env);
  return {
    ...base,
    signInsSource: env.SIGN_INS_SOURCE ?? "graph.auditLogs.signIns",
  };
}

export function resolveSignInsIngestConfig(
  env: NodeJS.ProcessEnv = process.env,
): SignInsIngestConfig {
  const isDev = (env.AZURE_ENV_NAME ?? "dev") !== "prod";
  return {
    ingestMiClientId: must("INGEST_MI_CLIENT_ID", env.INGEST_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    apiReaderMiClientId: must("API_READER_MI_CLIENT_ID", env.API_READER_MI_CLIENT_ID),
    opsTableEndpoint: must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    graphBaseUrl: must("GRAPH_BASE_URL", env.GRAPH_BASE_URL),
    graphApiTimeoutMs: Number.parseInt(env.GRAPH_API_TIMEOUT_MS ?? "30000", 10),
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    leaseWindowMs: Number.parseInt(env.INGEST_LEASE_WINDOW_MS ?? "300000", 10),
    source: env.SIGN_INS_SOURCE ?? "graph.auditLogs.signIns",
    signInsTimerCron: env.SIGN_INS_TIMER_CRON ?? "0 */15 * * * *",
    // Sentinel-0 → env-aware default. ADR-0034 §3.2 — 30d prod / 7d dev.
    retentionDays:
      Number.parseInt(env.SIGN_INS_RETENTION_DAYS ?? "0", 10) > 0
        ? Number.parseInt(env.SIGN_INS_RETENTION_DAYS ?? "30", 10)
        : isDev ? 7 : 30,
    cursorOverlapMs: Number.parseInt(env.SIGN_INS_CURSOR_OVERLAP_MS ?? "120000", 10),
    cursorWriteSkewAllowanceMs: Number.parseInt(
      env.SIGN_INS_CURSOR_WRITE_SKEW_ALLOWANCE_MS ?? "300000",
      10,
    ),
    cursorReadCorruptThresholdMs: Number.parseInt(
      env.SIGN_INS_CURSOR_READ_CORRUPT_THRESHOLD_MS ?? "3600000",
      10,
    ),
    firstRunSeedBackSeekMs: Number.parseInt(
      env.SIGN_INS_FIRST_RUN_SEED_BACK_SEEK_MS ?? "3600000",
      10,
    ),
    pageSize: Number.parseInt(env.SIGN_INS_PAGE_SIZE ?? "500", 10),
    adminDailyRunCeiling: Number.parseInt(
      env.SIGN_INS_ADMIN_DAILY_RUN_CEILING ?? "30",
      10,
    ),
  };
}

export function resolveEntraRiskIngestConfig(
  env: NodeJS.ProcessEnv = process.env,
): EntraRiskIngestConfig {
  return {
    ingestMiClientId: must("INGEST_MI_CLIENT_ID", env.INGEST_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    apiReaderMiClientId: must("API_READER_MI_CLIENT_ID", env.API_READER_MI_CLIENT_ID),
    opsTableEndpoint: must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    graphBaseUrl: must("GRAPH_BASE_URL", env.GRAPH_BASE_URL),
    graphApiTimeoutMs: Number.parseInt(env.GRAPH_API_TIMEOUT_MS ?? "30000", 10),
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    leaseWindowMs: Number.parseInt(env.INGEST_LEASE_WINDOW_MS ?? "300000", 10),
    source: env.ENTRA_RISK_SOURCE ?? "graph.security.riskyUsers",
    entraRiskTimerCron: env.ENTRA_RISK_TIMER_CRON ?? "0 0 */4 * * *",
    entraRiskRetentionDays: Number.parseInt(env.ENTRA_RISK_RETENTION_DAYS ?? "180", 10),
    cursorOverlapMs: Number.parseInt(env.ENTRA_RISK_CURSOR_OVERLAP_MS ?? "120000", 10),
    cursorWriteSkewAllowanceMs: Number.parseInt(
      env.ENTRA_RISK_CURSOR_WRITE_SKEW_ALLOWANCE_MS ?? "300000",
      10,
    ),
    cursorReadCorruptThresholdMs: Number.parseInt(
      env.ENTRA_RISK_CURSOR_READ_CORRUPT_THRESHOLD_MS ?? "3600000",
      10,
    ),
    firstRunSeedBackSeekMs: Number.parseInt(
      env.ENTRA_RISK_FIRST_RUN_SEED_BACK_SEEK_MS ?? "86400000",
      10,
    ),
    pageSize: Number.parseInt(env.ENTRA_RISK_PAGE_SIZE ?? "500", 10),
    adminDailyRunCeiling: Number.parseInt(
      env.ENTRA_RISK_ADMIN_DAILY_RUN_CEILING ?? "30",
      10,
    ),
  };
}

export function resolveIncidentsIngestConfig(
  env: NodeJS.ProcessEnv = process.env,
): IncidentsIngestConfig {
  const opsTableEndpoint = must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT);
  return {
    ingestMiClientId: must("INGEST_MI_CLIENT_ID", env.INGEST_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    apiReaderMiClientId: must("API_READER_MI_CLIENT_ID", env.API_READER_MI_CLIENT_ID),
    opsTableEndpoint,
    opsBlobEndpoint: deriveOpsBlobEndpoint(opsTableEndpoint),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    incidentsDetailContainerName: must(
      "INCIDENTS_DETAIL_CONTAINER_NAME",
      env.INCIDENTS_DETAIL_CONTAINER_NAME,
    ),
    graphBaseUrl: must("GRAPH_BASE_URL", env.GRAPH_BASE_URL),
    graphApiTimeoutMs: Number.parseInt(env.GRAPH_API_TIMEOUT_MS ?? "30000", 10),
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    leaseWindowMs: Number.parseInt(env.INGEST_LEASE_WINDOW_MS ?? "300000", 10),
    source: env.INCIDENTS_SOURCE ?? "graph.security.incidents",
    retentionDays: Number.parseInt(env.INCIDENTS_RETENTION_DAYS ?? "180", 10),
    cursorOverlapMs: Number.parseInt(env.INCIDENTS_CURSOR_OVERLAP_MS ?? "120000", 10),
    cursorWriteSkewAllowanceMs: Number.parseInt(
      env.INCIDENTS_CURSOR_WRITE_SKEW_ALLOWANCE_MS ?? "300000",
      10,
    ),
    cursorReadCorruptThresholdMs: Number.parseInt(
      env.INCIDENTS_CURSOR_READ_CORRUPT_THRESHOLD_MS ?? "3600000",
      10,
    ),
    firstRunSeedBackSeekMs: Number.parseInt(
      env.INCIDENTS_FIRST_RUN_SEED_BACK_SEEK_MS ?? "86400000",
      10,
    ),
    pageSize: Number.parseInt(env.INCIDENTS_PAGE_SIZE ?? "50", 10),
  };
}

// ADR-0037 Layer 3c — ransomware.live PRO threat-intel ingest config.
//
// NB the API key itself is NOT carried in this config — Layer 3b's
// `loadRansomwareLiveApiKey()` is the single point of secret access,
// keyed on `RANSOMWARE_LIVE_API_KEY_KV_NAME` / `_KV_SECRET_NAME` /
// `THREAT_INTEL_MI_CLIENT_ID`. The orchestrator depends on the loader,
// not on this config, so a config that compiles never carries a secret.
export interface RansomwareIntelIngestConfig {
  readonly threatIntelMiClientId: string;
  readonly auditMiClientId: string;
  readonly opsTableEndpoint: string;
  readonly auditBlobEndpoint: string;
  readonly auditContainerName: string;
  readonly tenantId: string;
  /** "external.ransomware.live" — the audit-chain + IngestHealth row key. */
  readonly source: string;
  /** ISO 3166-1 alpha-2 country code for the per-tenant filter. Default
   *  "GB" matches the dev tenant; Layer 5 admin UI moves this to a per-
   *  tenant Table-backed config row. */
  readonly country: string;
  /** Retention window in days for the RansomwareIntel Table. Env-aware
   *  sentinel-0: 90d prod / 14d dev. */
  readonly retentionDays: number;
  /** Daily budget for admin "ingest now" calls per tenant (shared with
   *  the other admin-run endpoints). */
  readonly adminDailyRunCeiling: number;
}

// ADR-0037 Layer 4 — reader-side config for the summary + list GET handlers.
// Reader handlers run under the api-reader MI (read-only Table grant), so
// the shape mirrors `ApiConfig` + the source string. Separate from the
// ingest-side config (`RansomwareIntelIngestConfig`) so a reader can't
// accidentally pick up the threatIntel MI client id.
export interface RansomwareIntelApiConfig extends ApiConfig {
  readonly ransomwareIntelSource: string;
}

export function resolveRansomwareIntelApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): RansomwareIntelApiConfig {
  const base = resolveApiConfig(env);
  return {
    ...base,
    ransomwareIntelSource: env.THREAT_INTEL_SOURCE ?? "external.ransomware.live",
  };
}

export function resolveRansomwareIntelIngestConfig(
  env: NodeJS.ProcessEnv = process.env,
): RansomwareIntelIngestConfig {
  const isDev = (env.AZURE_ENV_NAME ?? "dev") !== "prod";
  const raw = Number.parseInt(env.THREAT_INTEL_RETENTION_DAYS ?? "0", 10);
  return {
    threatIntelMiClientId: must("THREAT_INTEL_MI_CLIENT_ID", env.THREAT_INTEL_MI_CLIENT_ID),
    auditMiClientId: must("AUDIT_MI_CLIENT_ID", env.AUDIT_MI_CLIENT_ID),
    opsTableEndpoint: must("OPS_TABLE_ENDPOINT", env.OPS_TABLE_ENDPOINT),
    auditBlobEndpoint: must("AUDIT_BLOB_ENDPOINT", env.AUDIT_BLOB_ENDPOINT),
    auditContainerName: env.AUDIT_CONTAINER_NAME ?? "audit",
    tenantId: must("AZURE_TENANT_ID", env.AZURE_TENANT_ID ?? env.WEBSITE_AUTH_TENANT_ID),
    source: env.THREAT_INTEL_SOURCE ?? "external.ransomware.live",
    country: (env.THREAT_INTEL_COUNTRY ?? "GB").toUpperCase(),
    retentionDays: raw > 0 ? raw : isDev ? 14 : 90,
    adminDailyRunCeiling: Number.parseInt(
      env.THREAT_INTEL_ADMIN_DAILY_RUN_CEILING ?? "30",
      10,
    ),
  };
}
