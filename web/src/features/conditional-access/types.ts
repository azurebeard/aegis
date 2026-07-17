// ADR-0034 §3.3 — typed shapes returned by /api/conditional-access/*.

export type ConditionalAccessState = "enabled" | "disabled" | "enabledForReportingButNotEnforced";

export interface ConditionalAccessPolicy {
  readonly id: string;
  readonly displayName: string;
  readonly state: ConditionalAccessState;
  readonly createdDateTime: string | null;
  readonly modifiedDateTime: string | null;
  /** JCS-canonical JSON string of the conditions block. SPA renders a
   *  best-effort human summary by parsing this defensively. */
  readonly conditions: string;
  readonly grantControls: string;
  readonly sessionControls: string | null;
}

export interface ConditionalAccessPoliciesResponse {
  readonly schemaVersion: 1;
  readonly items: readonly ConditionalAccessPolicy[];
}

export interface RecentCaChangeSample {
  readonly policyId: string;
  readonly displayName: string;
  readonly diffKind: "created" | "modified" | "deleted";
  readonly observedAt: string;
}

export interface RecentCaChanges {
  readonly windowHours: number;
  readonly count: number;
  readonly samples: readonly RecentCaChangeSample[];
}

export interface ConditionalAccessSummaryResponse {
  readonly schemaVersion: 1;
  readonly counts: {
    readonly total: number;
    readonly enabled: number;
    readonly disabled: number;
    readonly reportOnly: number;
  };
  readonly health: {
    readonly status: string;
    readonly lastSuccessAt: string | null;
    readonly consecutiveFailures: number;
  };
  readonly recentChanges: RecentCaChanges;
}
