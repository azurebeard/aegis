// Wire shapes for /api/secure-score/*. Keep in sync with
// `/api/src/lib/types.ts` — schemaVersion bumps when these diverge.

export interface SecureScoreSnapshot {
  readonly snapshotDate: string;
  readonly createdDateTime: string;
  readonly ingestedAt: string;
  readonly currentScore: number;
  readonly maxScore: number;
  readonly percentage: number;
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
  }[];
}

export type IngestHealthStatus =
  | "healthy"
  | "degrading"
  | "failing"
  | "awaiting_first_run"
  | "no_data";

export interface SecureScoreLatestResponse {
  readonly schemaVersion: 1;
  readonly snapshot: SecureScoreSnapshot | null;
  readonly health: {
    readonly status: IngestHealthStatus;
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

export interface SecureScoreControlProfile {
  readonly controlName: string;
  readonly controlCategory: string;
  readonly title: string;
  readonly tier: string | null;
  readonly service: string | null;
  readonly maxScore: number | null;
  readonly rank: number | null;
  readonly actionType: string | null;
  readonly actionUrl: string | null;
  readonly remediation: string;
  readonly remediationImpact: string;
  readonly userImpact: string | null;
  readonly implementationCost: string | null;
  readonly threats: readonly string[];
  readonly deprecated: boolean;
  readonly profileLastModified: string | null;
  readonly ingestedAt: string;
}

export interface SecureScoreControlProfilesResponse {
  readonly schemaVersion: 1;
  readonly items: readonly SecureScoreControlProfile[];
  readonly count: number;
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
