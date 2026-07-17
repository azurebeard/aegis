// ADR-0034 §3.2 — wire shapes for the Sign-ins SPA feature.

export type SignInsHealthStatus =
  | "healthy"
  | "degrading"
  | "failing"
  | "licence_required"
  | "awaiting_first_run"
  | "no_data";

export interface SignInsHealth {
  readonly status: SignInsHealthStatus;
  readonly lastSuccessAt: string | null;
  readonly consecutiveFailures: number;
}

export interface GeoFencePolicy {
  readonly enabled: boolean;
  readonly allowedCountries: readonly string[];
  readonly unknownLocationPolicy: "alert" | "ignore";
  readonly source: "tenant" | "default";
}

export interface SignInsCounts {
  readonly totalToday: number;
  readonly outOfAreaToday: number;
  readonly caFailuresToday: number;
}

export interface SignInsMostRecent {
  readonly id: string;
  readonly userPrincipalName: string;
  readonly userDisplayName: string;
  readonly country: string;
  readonly createdDateTime: string;
  readonly outOfArea: boolean;
}

export interface SignInsSummaryResponse {
  readonly schemaVersion: 1;
  readonly counts: SignInsCounts | null;
  readonly mostRecent: SignInsMostRecent | null;
  readonly mostRecentOutOfArea: SignInsMostRecent | null;
  readonly policy: GeoFencePolicy | null;
  readonly health: SignInsHealth;
  readonly ingestedAt: string | null;
}

export interface SignInsListItem {
  readonly id: string;
  readonly createdDateTime: string;
  readonly userId: string;
  readonly userPrincipalName: string;
  readonly userDisplayName: string;
  readonly appDisplayName: string;
  readonly ipAddress: string;
  readonly country: string;
  readonly city: string;
  readonly state: string;
  readonly conditionalAccessStatus: string;
  readonly outOfArea: boolean;
}

export interface SignInsListResponse {
  readonly schemaVersion: 1;
  readonly items: readonly SignInsListItem[];
  readonly range: {
    readonly requestedLimit: number;
    readonly returnedCount: number;
    readonly totalRows?: number;
    readonly lookbackDays: number;
    readonly outOfAreaOnly: boolean;
    readonly caFailuresOnly: boolean;
  };
  readonly health: SignInsHealth;
}
