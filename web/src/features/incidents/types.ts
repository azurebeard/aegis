// Wire shapes for /api/incidents/*. Keep in sync with
// `/api/src/lib/types.ts` — schemaVersion bumps when these diverge.

export type IncidentSeverity = "unknown" | "informational" | "low" | "medium" | "high";

export type IncidentStatus = "active" | "resolved" | "inProgress" | "redirected" | "awaitingAction";

export type IncidentClassification =
  | "unknown"
  | "truePositive"
  | "falsePositive"
  | "informationalExpectedActivity";

export type IngestHealthStatus =
  | "healthy"
  | "degrading"
  | "failing"
  | "awaiting_first_run"
  | "no_data";

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
  // True when this incident has a committed analysis row in the incident-
  // analysis cache — drives the "AI" column on the list. Optional for
  // backward-compatibility with older API responses.
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
    readonly status: IngestHealthStatus;
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
    readonly alerts?: readonly {
      readonly id?: string;
      readonly title?: string;
      readonly severity?: string;
      readonly description?: string;
      readonly recommendedActions?: string;
      readonly evidence?: readonly unknown[];
    }[];
  };
  readonly ingest: {
    readonly ingestedAt: string;
    readonly ingestRunId: string;
    readonly detailBlobPath: string;
    readonly detailBlobMissing?: boolean;
    readonly detailBlobMissingClassification?: "lifecycle-trim" | "lookup-failure" | "unexplained";
  };
}

export interface IncidentTrendBucket {
  readonly day: string;
  readonly bySeverity: Record<IncidentSeverity, number>;
  readonly total: number;
}

export interface IncidentsTrendsResponse {
  readonly schemaVersion: 1;
  readonly items: readonly IncidentTrendBucket[];
  readonly range: {
    readonly from: string | null;
    readonly to: string | null;
    readonly requestedDays: number;
    readonly returnedCount: number;
  };
}

export interface IncidentsListFilters {
  readonly severity?: readonly IncidentSeverity[];
  readonly status?: readonly IncidentStatus[];
  readonly classification?: readonly IncidentClassification[];
  readonly since?: string | null;
  readonly includeRedirected?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}
