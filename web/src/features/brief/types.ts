// Wire shapes for /api/brief/* — keep aligned with /api/src/lib/* envelope.
// schemaVersion bumps when these diverge.

export type BriefFreshness = "fresh" | "stale_serviceable" | "stale_unservable";

export interface BriefSection {
  readonly heading: string;
  readonly bullets: readonly string[];
}

export interface BriefEnvelope {
  readonly briefDate: string;
  readonly headline: string;
  readonly sections: readonly BriefSection[];
  readonly runId: string;
  readonly generatedAt: string;
  readonly outputSha256: string;
  readonly modelDeployment: string;
  readonly freshness: BriefFreshness;
  readonly retryHintSeconds?: number;
}

export interface BriefLatestResponse {
  readonly schemaVersion: 1;
  readonly brief: BriefEnvelope | null;
  readonly briefDate?: string;
  readonly headline?: string;
  readonly sections?: readonly BriefSection[];
  readonly runId?: string;
  readonly generatedAt?: string;
  readonly outputSha256?: string;
  readonly modelDeployment?: string;
  readonly freshness?: BriefFreshness;
  readonly retryHintSeconds?: number;
  readonly health?: { readonly status: "awaiting_first_run" };
}

export interface BriefByDateResponse extends BriefEnvelope {
  readonly schemaVersion: 1;
}

/** History list item — metadata only; bodies fetched lazily via byDate. */
export interface BriefHistoryItem {
  readonly briefDate: string;
  readonly generatedAt: string;
  readonly runId: string;
  readonly outputSha256: string;
  readonly modelDeployment: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface BriefHistoryResponse {
  readonly schemaVersion: 1;
  readonly items: readonly BriefHistoryItem[];
  readonly limit: number;
  readonly count: number;
}
