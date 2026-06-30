// Wire shapes for /api/risky-users/*. Mirrors the API's
// `api/src/lib/types.ts` EntraRisk exports.

export type EntraRiskLevel = "low" | "medium" | "high" | "hidden" | "none" | "unknown";

export type EntraRiskState =
  | "none"
  | "atRisk"
  | "confirmedSafe"
  | "confirmedCompromised"
  | "remediated"
  | "dismissed"
  | "unknown";

export type EntraRiskHealthStatus =
  | "healthy"
  | "degrading"
  | "failing"
  | "licence_required"
  | "awaiting_first_run"
  | "no_data";

export interface RiskyUser {
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
  readonly mostRecent: RiskyUser | null;
  readonly health: {
    readonly status: EntraRiskHealthStatus;
    readonly lastSuccessAt: string | null;
    readonly consecutiveFailures: number;
  };
  readonly ingestedAt: string | null;
}

export interface RiskyUsersListResponse {
  readonly schemaVersion: 1;
  readonly riskyUsers: readonly RiskyUser[];
  readonly page: {
    readonly count: number;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
}

export interface RiskyUsersListFilters {
  readonly riskLevel?: readonly EntraRiskLevel[];
  readonly riskState?: readonly EntraRiskState[];
  readonly since?: string | null;
  readonly includeDeleted?: boolean;
  readonly includeRemediated?: boolean;
  readonly limit?: number;
  readonly cursor?: string | null;
}
