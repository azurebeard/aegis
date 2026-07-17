// ADR-0032 — wire shape for /api/kev/summary.

export interface KevSummaryResponse {
  readonly schemaVersion: 1;
  readonly catalog: {
    readonly totalEntries: number;
    readonly removedEntries: number;
  };
  readonly matches: {
    readonly totalPairs: number;
    /** ADR-0033 per-status breakdown. Optional for forward-compat
     *  with pre-Phase-2 servers; SPA falls back to `0` when absent. */
    readonly open?: number;
    readonly acknowledged?: number;
    readonly riskAccepted?: number;
    readonly remediated?: number;
    readonly notApplicable?: number;
    readonly matchedItemCount: number;
    readonly dueThisWeek: number;
  };
  readonly health: {
    readonly status: string;
    readonly lastSuccessAt: string | null;
    readonly consecutiveFailures: number;
  };
}
