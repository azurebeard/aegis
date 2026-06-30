// Per-agent circuit breaker + failure-classification (ADR-0019 §Decision.6 / 7).
//
// One row per (tenantId, agentName):
//   PartitionKey = tenantId
//   RowKey       = `agent.${agentName}`   (e.g. "agent.brief")
//
// State machine:
//   closed     — normal operation; every call allowed.
//   open       — circuit tripped (≥3 consecutive failures); no calls until
//                NextProbeAt elapses.
//   half_open  — single trial probe in flight; further calls denied. On
//                trial success → closed. On trial failure → re-opens with
//                doubled backoff from the CURRENT ConsecutiveFailures
//                (preserving the failure history).
//
// Backoff schedule (ADR-0019 §Decision.7):
//   trip-at-3 → 60s; then exponential min(60s * 2^(n-3), 30m).
//
// 14-kind error classifier (ADR-0019 §Decision.6) — every code path that
// produces an error must call `classifyError` first; the kind feeds both the
// circuit decision and the audit-line `error.kind` field.

import { RestError, type TableClient } from "@azure/data-tables";
import { LeaseContendedError } from "./ingestHealth.js";

export const AGENT_HEALTH_TABLE_NAME = "AgentHealth";

export type AgentHealthState = "closed" | "open" | "half_open";

export type AgentFetchErrorKind =
  | "timeout"
  | "throttle_429"
  | "bad_gateway"
  | "unauthorised_401"
  | "forbidden_403"
  | "not_found_404"
  | "config"
  | "content_filter"
  | "output_schema"
  | "prompt_injection_detected"
  | "denylist_blocked"
  | "internal"
  | "network"
  | "other";

export interface AgentHealthRow {
  readonly tenantId: string;
  readonly rowKey: string; // `agent.${agentName}`
  readonly state: AgentHealthState;
  readonly consecutiveFailures: number;
  readonly nextProbeAt: string | null;
  readonly lastFailureKind: AgentFetchErrorKind | null;
  readonly lastFailureAt: string | null;
  readonly updatedAt: string;
  readonly etag: string;
}

interface AgentHealthEntity {
  readonly partitionKey: string;
  readonly rowKey: string;
  readonly State: AgentHealthState;
  readonly ConsecutiveFailures: number;
  readonly NextProbeAt: string | null;
  readonly LastFailureKind: string | null;
  readonly LastFailureAt: string | null;
  readonly UpdatedAt: string;
  readonly etag: string;
}

const TRIP_THRESHOLD = 3;
const BASE_BACKOFF_MS = 60_000; // 60s
const MAX_BACKOFF_MS = 30 * 60_000; // 30 min
const MAX_ETAG_RETRIES = 3;

/**
 * Read the current health row for an agent, initialising on first read.
 */
/**
 * Read-only variant — returns `null` when the row doesn't exist instead of
 * auto-creating it like {@link readHealth}. Safe for read-path handlers
 * running under the api-reader MI (which holds account-scope Reader, not
 * Writer). Callers receive `null` on first-look-before-first-fire and can
 * synthesise a default `closed/0` view client-side.
 */
export async function readHealthOptional(
  table: TableClient,
  tenantId: string,
  agentName: string,
): Promise<AgentHealthRow | null> {
  const rowKey = healthRowKey(agentName);
  try {
    const got = await table.getEntity<AgentHealthEntity>(tenantId, rowKey);
    return entityToRow(got);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function readHealth(
  table: TableClient,
  tenantId: string,
  agentName: string,
): Promise<AgentHealthRow> {
  const rowKey = healthRowKey(agentName);
  try {
    const got = await table.getEntity<AgentHealthEntity>(tenantId, rowKey);
    return entityToRow(got);
  } catch (err) {
    if (isNotFound(err)) {
      const init: AgentHealthEntity = {
        partitionKey: tenantId,
        rowKey,
        State: "closed",
        ConsecutiveFailures: 0,
        NextProbeAt: null,
        LastFailureKind: null,
        LastFailureAt: null,
        UpdatedAt: new Date().toISOString(),
        etag: "",
      };
      const created = await table.createEntity(init);
      const got = await table.getEntity<AgentHealthEntity>(tenantId, rowKey);
      return entityToRow({ ...got, etag: created.etag ?? got.etag });
    }
    throw err;
  }
}

export interface AllowCallDecision {
  readonly allow: boolean;
  /** True when this call is the half-open trial probe. */
  readonly trial: boolean;
}

/**
 * Decide whether to allow a call given the row + current time.
 *   closed                          → allow, not trial
 *   open  + now < NextProbeAt       → deny
 *   open  + now ≥ NextProbeAt       → allow as half-open trial
 *   half_open                       → deny (another trial in flight)
 */
export function allowCall(
  row: AgentHealthRow,
  now: Date = new Date(),
): AllowCallDecision {
  if (row.state === "closed") return { allow: true, trial: false };
  if (row.state === "half_open") return { allow: false, trial: false };
  // state === "open"
  if (!row.nextProbeAt) {
    // Defensive: open with no probe time is malformed — treat as eligible.
    return { allow: true, trial: true };
  }
  const probeMs = Date.parse(row.nextProbeAt);
  if (!Number.isFinite(probeMs)) return { allow: true, trial: true };
  if (now.getTime() < probeMs) return { allow: false, trial: false };
  return { allow: true, trial: true };
}

/**
 * Record a failure. Increments ConsecutiveFailures; opens the circuit at
 * `>= TRIP_THRESHOLD`. From half_open, a failure re-opens with doubled
 * backoff (computed from the now-incremented ConsecutiveFailures).
 */
export async function recordFailure(
  table: TableClient,
  row: AgentHealthRow,
  kind: AgentFetchErrorKind,
  now: Date = new Date(),
): Promise<AgentHealthRow> {
  for (let attempt = 0; attempt < MAX_ETAG_RETRIES; attempt++) {
    const current =
      attempt === 0
        ? row
        : await readHealth(table, row.tenantId, agentNameFromRowKey(row.rowKey));
    const nextCount = current.consecutiveFailures + 1;
    const shouldOpen = nextCount >= TRIP_THRESHOLD || current.state !== "closed";
    const next: AgentHealthRow = {
      ...current,
      state: shouldOpen ? "open" : "closed",
      consecutiveFailures: nextCount,
      nextProbeAt: shouldOpen
        ? new Date(now.getTime() + backoffMs(nextCount)).toISOString()
        : null,
      lastFailureKind: kind,
      lastFailureAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    try {
      await writeRow(table, next);
      return next;
    } catch (err) {
      if (isPreconditionFailed(err)) continue;
      throw err;
    }
  }
  throw new LeaseContendedError(
    `AgentHealth ETag drifted for ${row.rowKey} after ${MAX_ETAG_RETRIES} retries`,
  );
}

/**
 * Mark the call eligible for closing the circuit. From half_open, success
 * flips back to closed and resets all failure state.
 */
export async function recordSuccess(
  table: TableClient,
  row: AgentHealthRow,
  now: Date = new Date(),
): Promise<AgentHealthRow> {
  for (let attempt = 0; attempt < MAX_ETAG_RETRIES; attempt++) {
    const current =
      attempt === 0
        ? row
        : await readHealth(table, row.tenantId, agentNameFromRowKey(row.rowKey));
    const next: AgentHealthRow = {
      ...current,
      state: "closed",
      consecutiveFailures: 0,
      nextProbeAt: null,
      // Preserve LastFailureKind / LastFailureAt for diagnostics.
      updatedAt: now.toISOString(),
    };
    try {
      await writeRow(table, next);
      return next;
    } catch (err) {
      if (isPreconditionFailed(err)) continue;
      throw err;
    }
  }
  throw new LeaseContendedError(
    `AgentHealth ETag drifted for ${row.rowKey} after ${MAX_ETAG_RETRIES} retries`,
  );
}

/**
 * Mark a half-open trial in flight. ETag-protected — a concurrent caller
 * racing the same probe loses at `updateEntity` (412) and gets a
 * `LeaseContendedError`. The orchestrator uses this to enforce the
 * "one-trial-probe at a time" invariant (ADR-0019 §Decision.7).
 */
export async function recordTrialInFlight(
  table: TableClient,
  row: AgentHealthRow,
  now: Date = new Date(),
): Promise<AgentHealthRow> {
  if (row.state === "half_open") return row;
  const next: AgentHealthRow = {
    ...row,
    state: "half_open",
    updatedAt: now.toISOString(),
  };
  try {
    await writeRow(table, next);
    return next;
  } catch (err) {
    if (isPreconditionFailed(err)) {
      throw new LeaseContendedError(
        `AgentHealth trial-marker ETag drifted for ${row.rowKey}`,
      );
    }
    throw err;
  }
}

/**
 * Alias for `recordTrialInFlight` — named for the orchestrator call-site.
 * Use from `runAgent` when `allowCall` returns `{allow:true, trial:true}` to
 * serialise the half-open trial. LeaseContendedError on race.
 * (SEC-M-STEP5-CODE-01 resolution — WS10 verdict 2026-04-19 step5-code.)
 */
export async function startHalfOpenTrial(
  table: TableClient,
  row: AgentHealthRow,
  now: Date = new Date(),
): Promise<AgentHealthRow> {
  return recordTrialInFlight(table, row, now);
}

/** Exponential backoff: min(60s * 2^(n-3), 30 min) for `n >= 3`. */
export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures < TRIP_THRESHOLD) return 0;
  const exponent = consecutiveFailures - TRIP_THRESHOLD;
  const raw = BASE_BACKOFF_MS * 2 ** exponent;
  return Math.min(raw, MAX_BACKOFF_MS);
}

/**
 * Map an arbitrary error to one of the 14 canonical kinds (ADR-0019 §Decision.6).
 * Looks at:
 *   - explicit `kind` on AgentFetchError
 *   - status codes on RestError / OpenAI-shaped errors
 *   - `name` on standard error subclasses (TimeoutError, AbortError, etc.)
 *   - message substrings as a last resort.
 */
export function classifyError(err: unknown): AgentFetchErrorKind {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    // Direct AgentFetchError-shaped marker.
    if (typeof e.kind === "string" && isKnownKind(e.kind)) {
      return e.kind;
    }
    // RestError / fetch-style status codes.
    const status = numericField(e, "status") ?? numericField(e, "statusCode");
    if (status === 401) return "unauthorised_401";
    if (status === 403) return "forbidden_403";
    if (status === 404) return "not_found_404";
    if (status === 408) return "timeout";
    if (status === 429) return "throttle_429";
    if (typeof status === "number" && status >= 500 && status < 600) {
      return "bad_gateway";
    }
    // Name-based hints.
    const name = typeof e.name === "string" ? e.name : "";
    if (name === "AbortError" || name === "TimeoutError") return "timeout";
    if (name === "ConfigError") return "config";
    // Message substrings (last resort).
    const msg =
      typeof e.message === "string" ? e.message.toLowerCase() : "";
    if (msg.includes("content filter") || msg.includes("content_filter")) {
      return "content_filter";
    }
    if (msg.includes("prompt injection")) return "prompt_injection_detected";
    if (msg.includes("denylist")) return "denylist_blocked";
    if (msg.includes("schema") || msg.includes("invalid output")) {
      return "output_schema";
    }
    if (msg.includes("timed out") || msg.includes("timeout")) return "timeout";
    if (
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("enotfound") ||
      msg.includes("etimedout") ||
      msg.includes("fetch failed")
    ) {
      return "network";
    }
    return "internal";
  }
  return "other";
}

const KNOWN_KINDS = new Set<string>([
  "timeout",
  "throttle_429",
  "bad_gateway",
  "unauthorised_401",
  "forbidden_403",
  "not_found_404",
  "config",
  "content_filter",
  "output_schema",
  "prompt_injection_detected",
  "denylist_blocked",
  "internal",
  "network",
  "other",
]);

function isKnownKind(s: string): s is AgentFetchErrorKind {
  return KNOWN_KINDS.has(s);
}

function numericField(
  e: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = e[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function healthRowKey(agentName: string): string {
  return `agent.${agentName}`;
}

function agentNameFromRowKey(rowKey: string): string {
  return rowKey.startsWith("agent.") ? rowKey.slice("agent.".length) : rowKey;
}

async function writeRow(table: TableClient, row: AgentHealthRow): Promise<void> {
  const entity: AgentHealthEntity = {
    partitionKey: row.tenantId,
    rowKey: row.rowKey,
    State: row.state,
    ConsecutiveFailures: row.consecutiveFailures,
    NextProbeAt: row.nextProbeAt,
    LastFailureKind: row.lastFailureKind,
    LastFailureAt: row.lastFailureAt,
    UpdatedAt: row.updatedAt,
    etag: row.etag,
  };
  await table.updateEntity(entity, "Replace", { etag: row.etag });
}

function entityToRow(e: AgentHealthEntity): AgentHealthRow {
  return {
    tenantId: e.partitionKey,
    rowKey: e.rowKey,
    state: (e.State ?? "closed") as AgentHealthState,
    consecutiveFailures: e.ConsecutiveFailures ?? 0,
    nextProbeAt: e.NextProbeAt ?? null,
    lastFailureKind: (e.LastFailureKind ?? null) as AgentFetchErrorKind | null,
    lastFailureAt: e.LastFailureAt ?? null,
    updatedAt: e.UpdatedAt,
    etag: e.etag,
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 404;
}

function isPreconditionFailed(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 412;
}
