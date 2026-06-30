// ADR-0037 Layer 5 — client-side mirror of the Layer 4 wire types.
//
// Hand-maintained mirror of `api/src/lib/types.ts` (RansomwareIntel*
// shapes). When the API contract widens, edit both sides — there's no
// codegen between them.
//
// Plain-text-only invariant (ADR-0037 §"Privacy"): the `activity` field
// on victim rows is threat-actor authored, the `summary` field on press
// rows is HudsonRock-enriched. The eslint `react/no-danger` rule pinned
// against this folder enforces no `dangerouslySetInnerHTML` callsite.

// Mirror of the server's `IngestStatus` plus the two derived states the
// summary handler emits (`awaiting_first_run` when no health row exists,
// `no_data` when the run was healthy but the current month is empty).
// Duplicated locally rather than imported from `features/incidents` to
// keep this feature folder self-contained.
export type RansomwareIntelHealthStatus =
  | "healthy"
  | "degrading"
  | "failing"
  | "licence_required"
  | "awaiting_first_run"
  | "no_data";

export interface RansomwareIntelSummary {
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
    readonly status: RansomwareIntelHealthStatus;
    readonly lastSuccessAt: string | null;
    readonly consecutiveFailures: number;
  };
  readonly country: string;
}

export type RansomwareIntelRowKind = "victim" | "press";

export interface RansomwareIntelListItem {
  readonly kind: RansomwareIntelRowKind;
  readonly anchorDate: string;
  readonly headline: string;
  readonly country: string;
  readonly group: string;
  readonly sector: string;
  readonly activity: string;
  readonly website: string;
  readonly permalink: string;
  readonly url: string;
  readonly source: string;
  readonly summary: string;
}

export interface RansomwareIntelList {
  readonly schemaVersion: 1;
  readonly rows: readonly RansomwareIntelListItem[];
  readonly page: {
    readonly count: number;
    readonly limit: number;
    readonly hasMore: boolean;
  };
  readonly country: string;
}
