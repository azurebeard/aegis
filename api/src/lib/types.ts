// Shared domain types used by the Step-3 ingest path and the dashboard API.
// Kept free of SDK imports so the same shapes can be asserted in unit tests
// without pulling in @azure/* at test time.

export interface SecureScoreSnapshot {
  readonly snapshotDate: string; // yyyy-MM-dd (UTC)
  readonly createdDateTime: string; // ISO8601 from Graph
  readonly ingestedAt: string; // ISO8601 set at write time
  readonly currentScore: number;
  readonly maxScore: number;
  readonly percentage: number; // rounded to 1 d.p., server-authoritative (ADR-0012 §1.1)
  readonly activeUserCount: number;
  readonly licensedUserCount: number;
  readonly enabledServices: readonly string[];
  readonly averageComparativeScores: readonly {
    readonly basis: string;
    readonly averageScore: number;
  }[];
  readonly controlScores: readonly {
    readonly controlCategory: string;
    readonly controlName: string;
    readonly description: string;
    readonly score: number;
    /** Microsoft-supplied control title (e.g. "Require MFA for admin roles")
     *  joined from the `secureScoreControlProfiles` cache at report-envelope
     *  assembly time. Optional — absent in:
     *    (a) the raw ingest path (not persisted; the SecureScore table stores
     *        only controlName/category/score),
     *    (b) historical envelopes captured before the join shipped,
     *    (c) controls whose profile row hasn't been ingested yet.
     *  Consumers MUST fall back to `controlName` when missing/empty. */
    readonly title?: string;
  }[];
  readonly graphId: string;
  readonly ingestRunId: string;
}

// ADR-0011 §5a amended by ADR-0023 §7 — `licence_required` added as a sticky
// status for sources whose upstream requires a licence the tenant lacks (e.g.
// Entra ID P2 for `graph.security.riskyUsers`). Readers that don't recognise
// the value treat it as "non-healthy" per the additive-schema rule.
export type IngestStatus = "healthy" | "degrading" | "failing" | "licence_required";

export interface IngestHealthRow {
  readonly tenantId: string;
  readonly source: string;
  readonly status: IngestStatus;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly consecutiveFailureCount: number;
  readonly lastRunId: string | null;
  readonly lastAuditSeq: number;
  // ADR-0015 §5 — `lineSha256` of the last audit line successfully appended to
  // this (source, tenantId) chain. Empty string until the chain is initialised
  // (forward-only migration per ADR-0015 §6).
  readonly lastLineSha256: string;
  // ADR-0014 §2 — Incidents cursor: max `lastUpdateDateTime` observed on the
  // last successful run minus the 2-minute safety overlap. ISO8601 UTC or
  // empty string on first-ever run for this source.
  readonly lastCursor: string;
  readonly updatedAt: string;
  readonly etag: string;
}

export interface SecureScoreLatestResponse {
  readonly schemaVersion: 1;
  readonly snapshot: SecureScoreSnapshot | null;
  readonly health: {
    readonly status: IngestStatus | "awaiting_first_run" | "no_data";
    readonly lastSuccessAt: string | null;
    readonly consecutiveFailures: number;
  };
}

export interface SecureScoreTrendEntry {
  readonly snapshotDate: string;
  readonly currentScore: number;
  readonly maxScore: number;
  readonly percentage: number;
}

export interface SecureScoreTrendResponse {
  readonly schemaVersion: 1;
  readonly snapshots: readonly SecureScoreTrendEntry[];
  readonly range: {
    readonly from: string | null;
    readonly to: string | null;
    readonly requestedDays: number;
    readonly returnedCount: number;
  };
}

export interface IngestOutcome {
  readonly runId: string;
  readonly status: "success" | "no_data" | "error";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly rowsWritten: number;
  readonly retentionRowsDeleted: number;
  readonly graphAttempts: number;
  readonly httpStatusFinal: number | null;
  readonly error?: {
    readonly kind:
      | "timeout"
      | "throttle"
      | "4xx"
      | "5xx"
      | "network"
      | "lease_contended"
      | "cursor_rejected"
      | "chain_unavailable"
      | "license_probe_failed"
      // ADR-0037 Layer 3b/3c — ransomware.live ingest surfaces these:
      //   auth_unavailable  → KV-secret not seeded / KV unreachable; SPA
      //                       renders "configure me" rather than "broken".
      //   schema_invalid    → upstream returned 2xx but the body didn't
      //                       match the validator; treat as terminal (next
      //                       fire re-tries; persistent surfaces as failing).
      | "auth_unavailable"
      | "schema_invalid"
      | "internal";
    readonly message: string;
  };
  readonly snapshot?: {
    readonly snapshotDate: string;
    readonly currentScore: number;
    readonly maxScore: number;
  };
}

// --- Incidents (ADR-0014 §3.1) ------------------------------------------------

export type IncidentSeverity =
  | "unknown"
  | "informational"
  | "low"
  | "medium"
  | "high";

export type IncidentStatus =
  | "active"
  | "resolved"
  | "inProgress"
  | "redirected"
  | "awaitingAction";

export type IncidentClassification =
  | "unknown"
  | "truePositive"
  | "falsePositive"
  | "informationalExpectedActivity";

export interface IncidentSummary {
  readonly id: string;
  readonly displayName: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly classification: IncidentClassification;
  readonly determination: string;
  readonly priorityScore: number | null;
  readonly assignedTo: string | null;
  readonly createdDateTime: string;
  readonly lastUpdateDateTime: string;
  readonly alertCount: number;
  readonly customTags: readonly string[];
  readonly systemTags: readonly string[];
  readonly incidentWebUrl: string;
  readonly hasRedirect: boolean;
  readonly redirectIncidentId: string | null;
  readonly ingestedAt: string;
  readonly ingestRunId: string;
  // True when `IncidentAnalysisCache` has a row for this incident — drives
  // the "AI" column on the incidents list. Optional in the type so the
  // storage-layer mapper can omit it; the list handler (`getIncidentsList`)
  // computes it at the response boundary via a single per-tenant cache-table
  // probe, then merges before returning.
  readonly hasAnalysis?: boolean;
}

export interface IncidentsSummaryResponse {
  readonly schemaVersion: 1;
  readonly counts: {
    readonly total: number;
    readonly bySeverity: Record<IncidentSeverity, number>;
    readonly byStatus: Record<IncidentStatus, number>;
    readonly byClassification: Record<IncidentClassification, number>;
  };
  readonly mostRecent: {
    readonly id: string;
    readonly displayName: string;
    readonly severity: IncidentSeverity;
    readonly status: IncidentStatus;
    readonly lastUpdateDateTime: string;
  } | null;
  readonly health: {
    readonly status: IngestStatus | "awaiting_first_run" | "no_data";
    readonly lastSuccessAt: string | null;
    readonly consecutiveFailures: number;
  };
  readonly ingestedAt: string | null;
}

export interface IncidentsListResponse {
  readonly schemaVersion: 1;
  readonly incidents: readonly IncidentSummary[];
  readonly page: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
}

export interface IncidentDetailResponse {
  readonly schemaVersion: 1;
  readonly incident: IncidentSummary & {
    readonly description?: string;
    readonly summary?: string;
    readonly resolvingComment?: string | null;
    readonly lastModifiedBy?: string | null;
    readonly comments?: readonly unknown[];
    readonly alerts?: readonly unknown[];
  };
  readonly ingest: {
    readonly ingestedAt: string;
    readonly ingestRunId: string;
    readonly detailBlobPath: string;
    readonly detailBlobMissing?: boolean;
    readonly detailBlobMissingClassification?:
      | "lifecycle-trim"
      | "lookup-failure"
      | "unexplained";
  };
}

export interface IncidentsIngestOutcome extends IngestOutcome {
  readonly cursorBefore?: string | null;
  readonly cursorAfter?: string | null;
  readonly pagesFetched?: number;
  readonly incidentsIngested?: number;
  readonly incidentsSkipped?: number;
  readonly detailBlobsWritten?: number;
  readonly alertsIngested?: number;
}

// --- EntraRisk (ADR-0023 + ADR-0024) -----------------------------------------

export type EntraRiskLevel = "low" | "medium" | "high" | "hidden" | "none" | "unknown";

export type EntraRiskState =
  | "none"
  | "confirmedSafe"
  | "remediated"
  | "dismissed"
  | "atRisk"
  | "confirmedCompromised"
  | "unknown";

export type EntraRiskLicenceState = "present" | "licence_required" | "unknown";

export interface RiskyUserSummary {
  readonly id: string;
  readonly userPrincipalName: string;
  readonly userDisplayName: string;
  readonly riskLevel: EntraRiskLevel;
  readonly riskState: EntraRiskState;
  readonly riskDetail: string;
  readonly riskLastUpdatedDateTime: string;
  readonly isDeleted: boolean;
  readonly isProcessing: boolean;
}

export type EntraRiskWireHealthStatus =
  | IngestStatus
  | "awaiting_first_run"
  | "no_data";

export interface RiskyUsersSummaryCounts {
  readonly total: number;
  readonly byRiskLevel: Record<EntraRiskLevel, number>;
  readonly byRiskState: Record<EntraRiskState, number>;
  readonly processing: number;
  readonly softDeleted: number;
}

export interface RiskyUsersSummaryResponse {
  readonly schemaVersion: 1;
  readonly counts: RiskyUsersSummaryCounts | null;
  readonly mostRecent: RiskyUserSummary | null;
  readonly health: {
    readonly status: EntraRiskWireHealthStatus;
    readonly lastSuccessAt: string | null;
    readonly consecutiveFailures: number;
  };
  readonly ingestedAt: string | null;
}

export interface RiskyUsersListResponse {
  readonly schemaVersion: 1;
  readonly riskyUsers: readonly RiskyUserSummary[];
  readonly page: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
}

export interface EntraRiskIngestOutcome extends IngestOutcome {
  readonly cursorBefore?: string | null;
  readonly cursorAfter?: string | null;
  readonly pagesFetched?: number;
  readonly riskyUsersIngested?: number;
  readonly riskyUsersSkipped?: number;
  readonly riskyUsersProcessing?: number;
  readonly licenceState?: EntraRiskLicenceState;
}

// ADR-0037 Layer 4 — ransomware.live PRO reader response envelopes.
// Plain-text only at the SPA per ADR-0037 §"Privacy"; the schema layer
// already control-strips + length-caps the free-text fields, so the
// wire types just narrow them to `string`.
export interface RansomwareIntelSummaryResponse {
  readonly schemaVersion: 1;
  readonly counts: {
    readonly victimsThisMonth: number;
    readonly victimsPriorMonth: number;
    readonly pressThisMonth: number;
    readonly pressPriorMonth: number;
    readonly distinctGroupsThisMonth: number;
  };
  readonly mostRecentVictim: {
    readonly victim: string;
    readonly group: string;
    readonly discoveredDate: string | null;
    readonly country: string;
  } | null;
  readonly health: {
    readonly status: IngestStatus | "awaiting_first_run" | "no_data";
    readonly lastSuccessAt: string | null;
    readonly consecutiveFailures: number;
  };
  /** ISO 3166-1 alpha-2 country code the ingest is configured against —
   *  surfaced so the SPA can render "United Kingdom" alongside the
   *  numbers without a separate config round-trip. */
  readonly country: string;
}

export type RansomwareIntelRowKind = "victim" | "press";

export interface RansomwareIntelListItem {
  readonly kind: RansomwareIntelRowKind;
  /** Chronological anchor — `discoveredDate` for victims, `publishedAt`
   *  for press, falling back to `ingestedAt` when the upstream values are
   *  null. Pre-sorted desc by the store. */
  readonly anchorDate: string;
  /** Common fields rendered on every row (victim name OR press title). */
  readonly headline: string;
  readonly country: string;
  /** Victim-only fields — empty string on press rows. */
  readonly group: string;
  readonly sector: string;
  readonly activity: string;
  readonly website: string;
  readonly permalink: string;
  /** Press-only fields — empty string on victim rows. */
  readonly url: string;
  readonly source: string;
  readonly summary: string;
}

export interface RansomwareIntelListResponse {
  readonly schemaVersion: 1;
  readonly rows: readonly RansomwareIntelListItem[];
  readonly page: {
    readonly count: number;
    readonly limit: number;
    readonly hasMore: boolean;
  };
  readonly country: string;
}

// ADR-0037 Layer 3c — ransomware.live PRO threat-intel ingest outcome.
// `graphAttempts` on the parent IngestOutcome counts ALL upstream HTTP
// attempts across both endpoints (victims + press) — kept on the parent
// shape so existing dashboards (`/api/notifications`, `/api/ingest-health`)
// render uniformly across verticals without per-source branching.
export interface RansomwareIntelIngestOutcome extends IngestOutcome {
  readonly victimsIngested: number;
  readonly pressIngested: number;
  /** Country filter the orchestrator used for this run. Surfaces in the
   *  admin "ingest now" response so the operator can confirm the active
   *  per-tenant config without an extra round-trip. */
  readonly country: string;
  /** YYYY-MM the orchestrator queried (current month at run time, UTC).
   *  Surfaced so an operator running a manual backfill in the future can
   *  tell which window the run covered. */
  readonly period: string;
}
