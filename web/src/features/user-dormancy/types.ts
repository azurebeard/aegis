// ADR-0034 §3.1 — wire shapes for the User dormancy SPA feature.

export type UserDormancyHealthStatus =
  | "healthy"
  | "degrading"
  | "failing"
  | "licence_required"
  | "awaiting_first_run"
  | "no_data";

export interface UserDormancyHealth {
  readonly status: UserDormancyHealthStatus;
  readonly lastSuccessAt: string | null;
  readonly consecutiveFailures: number;
}

export interface UserDormancyPolicy {
  readonly thresholdDays: number;
  readonly includeDisabledAccounts: boolean;
  readonly excludeServiceAccountSuffixes: readonly string[];
  /** §10.55 — operator-configurable highlight window for new users on the
   *  /identities Humans tab. Stored alongside dormancy fields so a single
   *  TenantSettings row covers the user-lifecycle UX knobs. */
  readonly newUserThresholdDays: number;
  readonly source: "tenant" | "default";
}

export interface UserDormancyCounts {
  readonly total: number;
  readonly dormant: number;
  readonly enabledDormant: number;
  readonly disabledDormant: number;
  readonly excluded: number;
  readonly oldestDormantUpn: string | null;
  readonly oldestDormantLastSignIn: string | null;
}

export interface UserDormancySummaryResponse {
  readonly schemaVersion: 1;
  readonly counts: UserDormancyCounts | null;
  readonly policy: UserDormancyPolicy | null;
  readonly health: UserDormancyHealth;
  readonly ingestedAt: string | null;
}

export interface UserDormancyListItem {
  readonly id: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
  readonly accountEnabled: boolean;
  readonly lastSignIn: string | null;
  readonly lastInteractiveSignIn: string | null;
  readonly lastNonInteractiveSignIn: string | null;
  readonly ageDays: number | null;
  readonly isDormant: boolean;
  /** §10.55 — Microsoft Graph createdDateTime, ISO8601 UTC, or null. */
  readonly createdDateTime: string | null;
  /** Server-derived from `now - createdDateTime <= newUserThresholdDays`. */
  readonly isNewUser: boolean;
}

export interface UserDormancyListResponse {
  readonly schemaVersion: 1;
  readonly items: readonly UserDormancyListItem[];
  readonly range: {
    readonly requestedLimit: number;
    readonly returnedCount: number;
    readonly totalRows?: number;
    readonly dormantOnly: boolean;
  };
  readonly policy: UserDormancyPolicy | null;
  readonly health: UserDormancyHealth;
}
