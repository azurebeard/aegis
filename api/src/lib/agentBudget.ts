// Pessimistic per-day token-budget reservations for agent runs (ADR-0019 §Decision.4).
//
// One row per (tenantId, agentName, yyyy-mm-dd):
//   PartitionKey = tenantId
//   RowKey       = `agent.${agentName}.${yyyy-mm-dd}` (e.g. "agent.brief.2026-04-19")
//
// Why pessimistic: a model call can take 30-60s; in that window a competing
// timer or admin trigger could otherwise blow the daily ceiling. The handler
// reserves up-front (`reserveTokens`), then settles with the actual usage
// (`settleReservation`). Stale reservations (a crashed handler) are swept by
// the next caller before its own validation runs (`sweepExpiredReservations`,
// 5-minute TTL).
//
// Counters semantics (ADR-0019 §Decision.4):
//   - `TokensReservedTotal` — in-flight + historical settled reservations. The
//     budget check is `TokensReservedTotal + proposed > dailyTokenBudget`.
//   - `TokensActualTotal`   — sum of actually-consumed tokens once settled.
//   - `RunsSucceeded` / `RunsFailed` — terminal outcome counters.
//   - `ManualRunsToday`     — incremented only when `trigger === "admin"`,
//                             enforces the separate manual ceiling.
//   - `ActiveReservations`  — JSON-encoded array of {runId, reservedAt,
//                             reservedTokens}; sweep removes entries older than
//                             ttlMs and rolls their reservedTokens back out of
//                             TokensReservedTotal (they never actually ran).
//
// Lease pattern: ETag IfMatch on every mutation, 3-retry loop on 412.

import { RestError, type TableClient } from "@azure/data-tables";
import { LeaseContendedError } from "./ingestHealth.js";

export const AGENT_BUDGET_TABLE_NAME = "AgentBudget";

export interface ActiveReservation {
  readonly runId: string;
  readonly reservedAt: string; // ISO8601 UTC
  readonly reservedTokens: number;
}

export interface AgentBudgetRow {
  readonly tenantId: string;
  readonly rowKey: string; // `agent.${agentName}.${yyyy-mm-dd}`
  readonly tokensReservedTotal: number;
  readonly tokensActualTotal: number;
  readonly runsSucceeded: number;
  readonly runsFailed: number;
  readonly manualRunsToday: number;
  readonly activeReservations: readonly ActiveReservation[];
  readonly etag: string;
}

interface AgentBudgetEntity {
  readonly partitionKey: string;
  readonly rowKey: string;
  readonly TokensReservedTotal: number;
  readonly TokensActualTotal: number;
  readonly RunsSucceeded: number;
  readonly RunsFailed: number;
  readonly ManualRunsToday: number;
  readonly ActiveReservations: string; // JSON-encoded array
  readonly UpdatedAt: string;
  readonly etag: string;
}

export interface BudgetCeilings {
  readonly dailyTokenBudget: number;
  readonly dailyRunCeiling: number;
  readonly dailyManualRunCeiling: number;
}

export interface ReserveResult {
  readonly ok: boolean;
  readonly reason?: "budget_exhausted" | "run_ceiling" | "manual_ceiling";
}

const DEFAULT_TTL_MS = 300_000; // 5 minutes — ADR-0019 §Decision.4
const MAX_ETAG_RETRIES = 3;

/**
 * Reserve `reservedTokens` tokens for `runId` against today's budget row.
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` if any ceiling
 * would be exceeded. Sweeps stale reservations before validation. Retries on
 * ETag 412 up to 3 times; throws `LeaseContendedError` on exhaustion.
 */
export async function reserveTokens(
  table: TableClient,
  tenantId: string,
  agentName: string,
  yyyymmdd: string,
  runId: string,
  reservedTokens: number,
  trigger: "timer" | "admin",
  ceilings: BudgetCeilings,
  now: Date = new Date(),
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<ReserveResult> {
  const rowKey = budgetRowKey(agentName, yyyymmdd);
  for (let attempt = 0; attempt < MAX_ETAG_RETRIES; attempt++) {
    const row = await getOrInitBudgetRow(table, tenantId, rowKey);
    const swept = sweepExpiredReservations(row, now, ttlMs);

    // Validate against ceilings.
    if (
      trigger === "admin" &&
      swept.manualRunsToday >= ceilings.dailyManualRunCeiling
    ) {
      return { ok: false, reason: "manual_ceiling" };
    }
    const inFlight = swept.activeReservations.length;
    if (
      swept.runsSucceeded + swept.runsFailed + inFlight >=
      ceilings.dailyRunCeiling
    ) {
      return { ok: false, reason: "run_ceiling" };
    }
    // SEC-BUG-BUDGET-SETTLE-RELEASE — cap reflects cumulative daily spend:
    // already-settled actual usage + currently-in-flight reservations + the
    // new request. Pre-fix this only summed `tokensReservedTotal + new`,
    // but `settleReservation` never released the held reservation on
    // success — so `tokensReservedTotal` accumulated unbounded across the
    // day and capped operators at `floor(cap / perRunReservation)` runs
    // even when actual usage was a fraction of the reservation. After the
    // companion fix to `settleReservation` (releases the hold + records
    // actual), this formula is the correct cumulative check.
    if (
      swept.tokensActualTotal + swept.tokensReservedTotal + reservedTokens >
      ceilings.dailyTokenBudget
    ) {
      return { ok: false, reason: "budget_exhausted" };
    }

    const next: AgentBudgetRow = {
      ...swept,
      tokensReservedTotal: swept.tokensReservedTotal + reservedTokens,
      manualRunsToday:
        swept.manualRunsToday + (trigger === "admin" ? 1 : 0),
      activeReservations: [
        ...swept.activeReservations,
        { runId, reservedAt: now.toISOString(), reservedTokens },
      ],
    };
    try {
      await writeRow(table, next, now);
      return { ok: true };
    } catch (err) {
      if (isPreconditionFailed(err)) continue;
      throw err;
    }
  }
  throw new LeaseContendedError(
    `AgentBudget ETag drifted for ${rowKey} after ${MAX_ETAG_RETRIES} retries`,
  );
}

/**
 * Settle a reservation: remove it from ActiveReservations, add `actualTokens`
 * to TokensActualTotal, increment RunsSucceeded or RunsFailed. The reserved
 * amount stays counted in TokensReservedTotal so the daily budget claim is
 * preserved (the model already used quota — over-reservation is a one-way
 * door per ADR-0019 §Decision.4).
 */
export async function settleReservation(
  table: TableClient,
  tenantId: string,
  agentName: string,
  yyyymmdd: string,
  runId: string,
  actualTokens: number,
  outcome: "success" | "failure",
  now: Date = new Date(),
): Promise<void> {
  const rowKey = budgetRowKey(agentName, yyyymmdd);
  for (let attempt = 0; attempt < MAX_ETAG_RETRIES; attempt++) {
    const row = await getOrInitBudgetRow(table, tenantId, rowKey);
    const target = row.activeReservations.find((r) => r.runId === runId);
    const remaining = row.activeReservations.filter((r) => r.runId !== runId);
    // SEC-BUG-BUDGET-SETTLE-RELEASE — release the hold against
    // tokensReservedTotal, mirroring releaseReservation. Pre-fix only
    // activeReservations was filtered; tokensReservedTotal stayed bloated
    // and the cap check tightened with every settled run. The companion
    // change in reserveTokens makes the cap check
    // `actualTotal + reservedTotal + new`, so released reservations correctly
    // free capacity for future runs while actual usage still counts toward
    // the daily cap. Idempotent / lease-safe: when the reservation has
    // already been swept (TTL expired or never recorded), `target` is
    // undefined and the reserved-total subtraction is a no-op.
    const reservedDelta = target?.reservedTokens ?? 0;
    const next: AgentBudgetRow = {
      ...row,
      tokensActualTotal: row.tokensActualTotal + actualTokens,
      tokensReservedTotal: Math.max(0, row.tokensReservedTotal - reservedDelta),
      runsSucceeded: row.runsSucceeded + (outcome === "success" ? 1 : 0),
      runsFailed: row.runsFailed + (outcome === "failure" ? 1 : 0),
      activeReservations: remaining,
    };
    try {
      await writeRow(table, next, now);
      return;
    } catch (err) {
      if (isPreconditionFailed(err)) continue;
      throw err;
    }
  }
  throw new LeaseContendedError(
    `AgentBudget settle ETag drifted for ${rowKey} after ${MAX_ETAG_RETRIES} retries`,
  );
}

/**
 * Release a reservation without incrementing RunsSucceeded / RunsFailed and
 * without crediting actualTokens. Used on circuit-open early-exit, ConfigError,
 * or any path where the model was never called. Subtracts the reserved amount
 * from `TokensReservedTotal` so the budget claim is rolled back.
 */
export async function releaseReservation(
  table: TableClient,
  tenantId: string,
  agentName: string,
  yyyymmdd: string,
  runId: string,
  now: Date = new Date(),
): Promise<void> {
  const rowKey = budgetRowKey(agentName, yyyymmdd);
  for (let attempt = 0; attempt < MAX_ETAG_RETRIES; attempt++) {
    const row = await getOrInitBudgetRow(table, tenantId, rowKey);
    const target = row.activeReservations.find((r) => r.runId === runId);
    if (!target) {
      // Either swept already, or never recorded (settle raced); idempotent no-op.
      return;
    }
    const remaining = row.activeReservations.filter((r) => r.runId !== runId);
    const next: AgentBudgetRow = {
      ...row,
      tokensReservedTotal: Math.max(
        0,
        row.tokensReservedTotal - target.reservedTokens,
      ),
      activeReservations: remaining,
    };
    try {
      await writeRow(table, next, now);
      return;
    } catch (err) {
      if (isPreconditionFailed(err)) continue;
      throw err;
    }
  }
  throw new LeaseContendedError(
    `AgentBudget release ETag drifted for ${rowKey} after ${MAX_ETAG_RETRIES} retries`,
  );
}

/**
 * Pure helper: sweep reservations older than `ttlMs` from the row and roll
 * their `reservedTokens` back out of `TokensReservedTotal`. Stale reservations
 * never finished, so the tokens were never actually consumed.
 */
export function sweepExpiredReservations(
  row: AgentBudgetRow,
  now: Date,
  ttlMs: number = DEFAULT_TTL_MS,
): AgentBudgetRow {
  const cutoff = now.getTime() - ttlMs;
  const live: ActiveReservation[] = [];
  let staleTokens = 0;
  for (const r of row.activeReservations) {
    const ms = Date.parse(r.reservedAt);
    if (Number.isFinite(ms) && ms < cutoff) {
      staleTokens += r.reservedTokens;
    } else {
      live.push(r);
    }
  }
  if (staleTokens === 0) return row;
  return {
    ...row,
    tokensReservedTotal: Math.max(0, row.tokensReservedTotal - staleTokens),
    activeReservations: live,
  };
}

/** Build the canonical row key for the daily budget row. */
export function budgetRowKey(agentName: string, yyyymmdd: string): string {
  return `agent.${agentName}.${yyyymmdd}`;
}

/** Per-agent today's-actuals projection for the admin "today's spend"
 *  viz (B4). Read-only — does NOT initialise the row if absent (zero-
 *  initialised result returned instead). Safe to call from the read
 *  path under api-reader MI; no writes. */
export interface BudgetSummary {
  readonly agentName: string;
  readonly yyyymmdd: string;
  readonly tokensActualTotal: number;
  readonly runsSucceeded: number;
  readonly runsFailed: number;
  readonly manualRunsToday: number;
  /** True when no row has been written yet for this (agent, day). */
  readonly empty: boolean;
}

const ZERO_BUDGET_SUMMARY: Omit<BudgetSummary, "agentName" | "yyyymmdd"> = {
  tokensActualTotal: 0,
  runsSucceeded: 0,
  runsFailed: 0,
  manualRunsToday: 0,
  empty: true,
};

export async function readBudgetSummary(
  table: TableClient,
  tenantId: string,
  agentName: string,
  yyyymmdd: string,
): Promise<BudgetSummary> {
  const rowKey = budgetRowKey(agentName, yyyymmdd);
  try {
    const got = await table.getEntity<AgentBudgetEntity>(tenantId, rowKey);
    return {
      agentName,
      yyyymmdd,
      tokensActualTotal: got.TokensActualTotal ?? 0,
      runsSucceeded: got.RunsSucceeded ?? 0,
      runsFailed: got.RunsFailed ?? 0,
      manualRunsToday: got.ManualRunsToday ?? 0,
      empty: false,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { agentName, yyyymmdd, ...ZERO_BUDGET_SUMMARY };
    }
    throw err;
  }
}

/** Read or initialise today's budget row. Returns the row + ETag. */
export async function getOrInitBudgetRow(
  table: TableClient,
  tenantId: string,
  rowKey: string,
): Promise<AgentBudgetRow> {
  try {
    const got = await table.getEntity<AgentBudgetEntity>(tenantId, rowKey);
    return entityToRow(got);
  } catch (err) {
    if (isNotFound(err)) {
      const init: AgentBudgetEntity = {
        partitionKey: tenantId,
        rowKey,
        TokensReservedTotal: 0,
        TokensActualTotal: 0,
        RunsSucceeded: 0,
        RunsFailed: 0,
        ManualRunsToday: 0,
        ActiveReservations: "[]",
        UpdatedAt: new Date().toISOString(),
        etag: "",
      };
      const created = await table.createEntity(init);
      const got = await table.getEntity<AgentBudgetEntity>(tenantId, rowKey);
      return entityToRow({ ...got, etag: created.etag ?? got.etag });
    }
    throw err;
  }
}

async function writeRow(
  table: TableClient,
  row: AgentBudgetRow,
  now: Date,
): Promise<void> {
  const entity: AgentBudgetEntity = {
    partitionKey: row.tenantId,
    rowKey: row.rowKey,
    TokensReservedTotal: row.tokensReservedTotal,
    TokensActualTotal: row.tokensActualTotal,
    RunsSucceeded: row.runsSucceeded,
    RunsFailed: row.runsFailed,
    ManualRunsToday: row.manualRunsToday,
    ActiveReservations: JSON.stringify(row.activeReservations),
    UpdatedAt: now.toISOString(),
    etag: row.etag,
  };
  await table.updateEntity(entity, "Replace", { etag: row.etag });
}

function entityToRow(e: AgentBudgetEntity): AgentBudgetRow {
  let parsed: ActiveReservation[];
  try {
    const raw = JSON.parse(e.ActiveReservations ?? "[]") as unknown;
    parsed = Array.isArray(raw)
      ? raw
          .filter(
            (x): x is ActiveReservation =>
              !!x &&
              typeof x === "object" &&
              typeof (x as Record<string, unknown>).runId === "string" &&
              typeof (x as Record<string, unknown>).reservedAt === "string" &&
              typeof (x as Record<string, unknown>).reservedTokens === "number",
          )
          .map((x) => ({
            runId: x.runId,
            reservedAt: x.reservedAt,
            reservedTokens: x.reservedTokens,
          }))
      : [];
  } catch {
    parsed = [];
  }
  return {
    tenantId: e.partitionKey,
    rowKey: e.rowKey,
    tokensReservedTotal: e.TokensReservedTotal ?? 0,
    tokensActualTotal: e.TokensActualTotal ?? 0,
    runsSucceeded: e.RunsSucceeded ?? 0,
    runsFailed: e.RunsFailed ?? 0,
    manualRunsToday: e.ManualRunsToday ?? 0,
    activeReservations: parsed,
    etag: e.etag,
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 404;
}

function isPreconditionFailed(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 412;
}
