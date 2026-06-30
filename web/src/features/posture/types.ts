// Wire shapes for /api/posture/* — aligned with the server envelope in
// /api/src/lib/posturePromptBuilder.ts + getPostureLatest.ts. schemaVersion
// bumps when these diverge.

export type PostureFreshness = "fresh" | "stale_serviceable" | "stale_unservable";
export type PostureSeverity = "informational" | "notable" | "urgent" | "unknown";

export interface PostureSections {
  readonly currentPosture: string;
  readonly recentMovement: string;
  readonly priorityActions: string;
}

export interface PostureLatestResponse {
  readonly schemaVersion: 1;
  readonly posture?: null;
  readonly isoWeek?: string;
  readonly headline?: string;
  readonly severity?: PostureSeverity;
  readonly sections?: PostureSections;
  readonly runId?: string;
  readonly generatedAt?: string;
  readonly outputSha256?: string;
  readonly modelDeployment?: string;
  readonly freshness?: PostureFreshness;
  readonly retryHintSeconds?: number;
  readonly health?: { readonly status: "awaiting_first_run" };
}

export interface PostureByWeekResponse {
  readonly schemaVersion: 1;
  readonly isoWeek: string;
  readonly headline: string;
  readonly severity: PostureSeverity;
  readonly sections: PostureSections;
  readonly runId: string;
  readonly generatedAt: string;
  readonly outputSha256: string;
  readonly modelDeployment: string;
  readonly freshness: PostureFreshness;
}

/** History list item — metadata only; bodies fetched lazily via byWeek. */
export interface PostureHistoryItem {
  readonly isoWeek: string;
  readonly generatedAt: string;
  readonly runId: string;
  readonly outputSha256: string;
  readonly modelDeployment: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface PostureHistoryResponse {
  readonly schemaVersion: 1;
  readonly items: readonly PostureHistoryItem[];
  readonly limit: number;
  readonly count: number;
}
