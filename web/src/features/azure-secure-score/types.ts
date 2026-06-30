// ADR-0036 — typed shapes returned by /api/azure-secure-score/*.

export interface AzureSecureScoreLatest {
  readonly snapshotDate: string;
  readonly currentScore: number;
  readonly maxScore: number;
  readonly percentage: number;
  readonly weight: number;
}

export interface AzureSecureScoreTrendPoint {
  readonly snapshotDate: string;
  readonly percentage: number;
}

export interface AzureSecureScoreSubscription {
  readonly subscriptionId: string;
  readonly subscriptionName: string;
  readonly latest: AzureSecureScoreLatest;
  readonly trend: readonly AzureSecureScoreTrendPoint[];
}

export interface AzureSecureScoreSummaryResponse {
  readonly schemaVersion: 1;
  readonly subscriptions: readonly AzureSecureScoreSubscription[];
  readonly health: {
    readonly status: string;
    readonly lastSuccessAt: string | null;
    readonly consecutiveFailures: number;
  };
}
