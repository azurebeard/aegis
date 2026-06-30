// Client-side mirror of the API shape (ADR-0025 Phase 1 + Phase 2 contract).

export const TILE_KEYS = [
  "secureScore",
  "incidents",
  "brief",
  "riskyUsers",
  "posture",
  "stack", // ADR-0031 Phase A
  "kev", // ADR-0032
  "userDormancy", // ADR-0034 Phase 8B
  "signIns", // ADR-0034 Phase 8C
  "conditionalAccess", // ADR-0034 Phase 8D
  "azureSecureScore", // ADR-0036
  "ransomwareIntel", // ADR-0037
] as const;
export type TileKey = (typeof TILE_KEYS)[number];

export type TileVisibility = Record<TileKey, boolean>;

/** Derived from IngestHealth at read time on the server (ADR-0025 §8). */
export type TileCapability = "present" | "licence_required" | "unknown";
export type TileCapabilities = Record<TileKey, TileCapability>;

/** Phase 3 — operator-controlled agent spend ceilings (ADR-0025 §9 +
 *  ADR-0027 §Decision.4 + ADR-0028 §Decision.4 flat-additive). */
export interface AgentBudgetRecord {
  readonly briefManualRunCeiling: number;
  readonly briefDailyTokenBudget: number;
  readonly postureManualRunCeiling: number;
  /** Per-ISO-week token budget for posture-agent (SEC-L-B2-01 resolution
   *  2026-04-21 — the AgentBudget row is keyed per ISO week for posture,
   *  so this ceiling enforces a weekly aggregate). */
  readonly postureWeeklyTokenBudget: number;
  readonly incidentsAnalysisManualRunCeiling: number;
  readonly incidentsAnalysisDailyTokenBudget: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

/** Phase 3 — brief-agent EntraRisk user identifier strategy. */
export const USER_IDENTIFIER_STRATEGIES = ["objectId", "partial_mask", "display_name"] as const;
export type UserIdentifierStrategy = (typeof USER_IDENTIFIER_STRATEGIES)[number];

export interface UserIdentifierStrategyRecord {
  readonly strategy: UserIdentifierStrategy;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

/** ADR-0030 Phase A — operator-controlled report cadence. */
export const REPORT_CADENCES = ["weekly", "monthly", "quarterly"] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

export interface ReportCadenceRecord {
  readonly cadence: ReportCadence;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

export const REPORT_CADENCE_LABELS: Readonly<Record<ReportCadence, string>> = {
  weekly: "Weekly (ISO week)",
  monthly: "Monthly",
  quarterly: "Quarterly",
};

/** ADR-0030 Phase C Slice 1(d) — operator-controlled email send config. */
export interface ReportEmailConfigRecord {
  readonly enabled: boolean;
  readonly recipients: readonly string[];
  readonly allowExternalRecipients: boolean;
  readonly externalRecipientDomains: readonly string[];
  readonly subjectPrefix: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

/** Mirror of the API validator caps in api/src/functions/patchSettings.ts. */
export const REPORT_EMAIL_MAX_RECIPIENTS = 50;
export const REPORT_EMAIL_MAX_EXTERNAL_DOMAINS = 20;
export const REPORT_EMAIL_SUBJECT_PREFIX_MAX = 30;

/** ADR-0033 Phase 2.5 — KEV deployment-baseline mode. */
export const KEV_BASELINE_MODES = ["historic", "from-deploy"] as const;
export type KevBaselineMode = (typeof KEV_BASELINE_MODES)[number];

export const KEV_BASELINE_MODE_LABELS: Readonly<Record<KevBaselineMode, string>> = {
  historic: "Historic — every match starts as Open",
  "from-deploy": "From deploy — auto-acknowledge pre-baseline CVEs",
};

export interface KevBaselineRecord {
  readonly mode: KevBaselineMode;
  /** Empty string when mode is "historic". YYYY-MM-DD when "from-deploy". */
  readonly baselineDate: string;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

/** Validation bounds (mirrors ADR-0025 §9.3 + ADR-0027 + ADR-0028 §Decision.4). */
export const AGENT_BUDGET_BOUNDS = Object.freeze({
  briefManualRunCeiling: { min: 1, max: 100, step: 1 } as const,
  briefDailyTokenBudget: { min: 50_000, max: 500_000, step: 10_000 } as const,
  postureManualRunCeiling: { min: 1, max: 50, step: 1 } as const,
  postureWeeklyTokenBudget: { min: 5_000, max: 200_000, step: 1_000 } as const,
  incidentsAnalysisManualRunCeiling: { min: 1, max: 100, step: 1 } as const,
  // SEC-BUG-INCIDENTS-BUDGET-MIN: min, max, and step are all multiples of
  // the per-run reservation (`estimateReservedTokens` in
  // api/src/lib/runIncidentsAgent.ts returns 3_000 as of 2026-06-22).
  // Step=3K means each slider tick is +1 run/day — the operator drags in
  // run-units instead of computing N × 3_000 themselves. Max=60K =
  // 20 runs/day; combined with the settle-release fix below
  // (SEC-BUG-BUDGET-SETTLE-RELEASE) a 60K budget supports a lot more
  // actual runs because settled reservations free capacity.
  // Keep all three in lock-step with the server-side bound in
  // api/src/lib/tenantSettingsStore.ts.
  incidentsAnalysisDailyTokenBudget: { min: 3_000, max: 60_000, step: 3_000 } as const,
});

/** ADR-0029 Phase A — tenant branding customisation. */
export const DEFAULT_THEMES = ["light", "dark", "system"] as const;
export type DefaultTheme = (typeof DEFAULT_THEMES)[number];

export const BRANDING_BOUNDS = Object.freeze({
  productName: { maxChars: 64 } as const,
  primaryHex: { pattern: /^#[0-9a-fA-F]{6}$/ } as const,
  footerText: { maxChars: 128 } as const,
});

export const BRANDING_DEFAULTS = Object.freeze({
  productName: "Aegis",
  primaryHex: "#0078D4",
  footerText: "",
  defaultTheme: "system" as DefaultTheme,
  logoSha256: "",
  logoContentType: "",
  logoSize: 0,
  logoUrl: null as string | null,
});

/** Phase B — allowed upload MIME types. SVG deliberately excluded. */
export const LOGO_CONTENT_TYPES = ["image/png", "image/webp", "image/jpeg"] as const;
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

/** Phase B — 1 MB cap. Mirrors api `LOGO_MAX_BYTES`. */
export const LOGO_MAX_BYTES = 1_048_576;

export interface BrandingRecord {
  readonly productName: string;
  readonly primaryHex: string;
  readonly footerText: string;
  readonly defaultTheme: DefaultTheme;
  /** Phase B. Empty string when no logo is uploaded. */
  readonly logoSha256: string;
  readonly logoContentType: string;
  readonly logoSize: number;
  /** Phase B. Server-computed same-origin URL with `?v=<sha>` cache buster;
   *  `null` when no logo is set. The SPA `<img src=>` this directly. */
  readonly logoUrl: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly source: "default" | "tenant";
}

/** Per-agent Bicep-pinned cron schedule + computed next-fire ETA.
 *  Returned by GET /api/settings + PATCH /api/ingest/settings. The SPA
 *  renders "next fire in Nh / Nd" badges on the corresponding tiles
 *  (B4 — Timer ETA badges). `incidents` is on-demand only, hence null. */
export interface AgentScheduleEntry {
  readonly nextFireAt: string; // ISO8601 UTC
  readonly cron: string;
  readonly cadence: "daily" | "weekly";
}

export interface AgentSchedules {
  readonly brief: AgentScheduleEntry | null;
  readonly posture: AgentScheduleEntry | null;
  readonly incidents: null;
}

/** ADR-0030 Phase B — daily auto-capture Timer for report snapshots.
 *  /reports renders a "next auto-capture in Nh" badge so operators can
 *  see when the snapshot will refresh without an admin click. */
export interface ReportSchedules {
  readonly autoCapture: AgentScheduleEntry | null;
}

/** Per-agent CURRENT-bucket actuals (B4 — today's-spend visualisation).
 *  `bucketCadence` controls the label shown next to the figures (e.g.
 *  "Today" vs "This week"). */
export interface AgentSpendBucket {
  readonly bucketKey: string;
  readonly bucketCadence: "daily" | "weekly";
  readonly tokensActualTotal: number;
  readonly runsSucceeded: number;
  readonly runsFailed: number;
  readonly manualRunsToday: number;
  readonly empty: boolean;
}

export interface AgentSpendCurrent {
  readonly brief: AgentSpendBucket;
  readonly posture: AgentSpendBucket;
  readonly incidents: AgentSpendBucket;
}

export interface TenantSettings {
  readonly tileVisibility: TileVisibility;
  /** Phase 2 — per-tile capability. Old clients ignore. */
  readonly tileCapabilities?: TileCapabilities;
  /**
   * Phase 2 — server-side derivation: `visibility && capability !== "licence_required"`.
   * HomePage reads this rather than `tileVisibility` so a licence-blocked
   * tile auto-hides even when the operator toggle is on. Old clients fall
   * back to `tileVisibility` (safe — before Phase 2 rolled out on both sides,
   * visibility alone was the source of truth).
   */
  readonly effectiveVisibility?: TileVisibility;
  /** Phase 3 — operator-controlled budget. Present on Phase 3+ servers. */
  readonly agentBudget?: AgentBudgetRecord;
  /** Phase 3 — operator-controlled user identifier strategy. */
  readonly userIdentifierStrategy?: UserIdentifierStrategyRecord;
  /** ADR-0029 Phase A — operator-controlled branding. */
  readonly branding?: BrandingRecord;
  /** ADR-0030 Phase A — operator-controlled report cadence. */
  readonly reportCadence?: ReportCadenceRecord;
  /** ADR-0030 Phase C Slice 1(d) — operator-controlled email send config.
   *  Optional for forward-compat with pre-Phase-C servers. */
  readonly reportEmailConfig?: ReportEmailConfigRecord;
  /** ADR-0030 Phase C Slice 1(d)/C — AZURE_MAIL_SENDER_UPN echoed by the
   *  server so the consent dialog can render the From: address and derive
   *  the sender domain for external-recipient detection. Empty when
   *  Phase C is inert / not configured. */
  readonly reportEmailSenderUpn?: string;
  /** ADR-0033 Phase 2.5 — operator-controlled KEV deployment-baseline. */
  readonly kevBaseline?: KevBaselineRecord;
  /** ADR-0034 §4.1 — operator-controlled geo-fence policy. */
  readonly geoFence?: {
    readonly enabled: boolean;
    readonly allowedCountries: readonly string[];
    readonly allowedIpRanges: readonly string[];
    readonly unknownLocationPolicy: "alert" | "ignore";
    readonly source: "tenant" | "default";
  };
  /** B4 — Timer ETA badges. Always present on B4+ servers. */
  readonly agentSchedules?: AgentSchedules;
  /** ADR-0030 Phase B — Timer ETA for the daily report-snapshot
   *  auto-capture. Optional for forward-compat with pre-Phase-B servers. */
  readonly reportSchedules?: ReportSchedules;
  /** B4 — current-bucket actuals for the admin spend viz. */
  readonly agentSpendCurrent?: AgentSpendCurrent;
  /** HANDOVER §6.3 `deployAiAgents` — required field. Server-side
   *  resolvers populate it unconditionally from `apiConfig.deployAiAgents`
   *  / `ingestConfig.deployAiAgents`, so the SPA evaluates it strictly
   *  via `=== true` rather than the previous `!== false` fail-open
   *  (SEC-INFO-DAAA-02 resolution — pre-toggle backwards
   *  compatibility window has elapsed). When `false`, the SPA hides
   *  BriefTile + PostureTile + the admin-page AgentBudget /
   *  UserIdentifierStrategy sections + the incident-detail analysis tab. */
  readonly aiPlaneEnabled: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/** Labels rendered in the admin settings page. Kept alongside the keys
 *  so a single edit covers both data + UI. */
export const TILE_LABELS: Readonly<Record<TileKey, string>> = {
  secureScore: "Microsoft Secure Score",
  incidents: "Incidents",
  brief: "Daily Brief",
  riskyUsers: "Risky Users",
  posture: "Weekly Posture",
  stack: "Stack inventory",
  kev: "KEV exposure",
  userDormancy: "Dormant accounts",
  signIns: "Sign-ins (geo-fence)",
  conditionalAccess: "Conditional Access",
  azureSecureScore: "Defender for Cloud Secure Score",
  ransomwareIntel: "Ransomware intel",
};

/** Tile-specific deep link rendered on "Licence required" pills so an
 *  operator can quickly jump to Microsoft's licensing docs. Only tiles with
 *  a known licence dimension get an entry; missing keys render no link. */
export const TILE_LICENCE_LEARN_MORE: Readonly<Partial<Record<TileKey, string>>> = {
  riskyUsers: "https://learn.microsoft.com/en-us/entra/id-protection/overview-identity-protection",
  userDormancy: "https://learn.microsoft.com/en-us/entra/identity/users/users-revoke-access",
  signIns: "https://learn.microsoft.com/en-us/entra/identity/monitoring-health/concept-sign-ins",
};
