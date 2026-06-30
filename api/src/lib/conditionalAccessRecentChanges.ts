// ADR-0034 §3.3 — derives the dashboard tile's "drift in last 24h" signal +
// notifications-bell entries from the audit chain. The orchestrator
// (`runConditionalAccessIngest.ts`) already emits one `ca.policy.changed`
// line per (created|modified|deleted) policy delta; this helper reads them
// back via the existing `readRecentAuditLines` accessor and projects to the
// minimal shape consumed by `/api/conditional-access/summary` and
// `/api/notifications`.

import { readRecentAuditLines, type AuditContext } from "./audit.js";

export interface RecentCaChangeSample {
  readonly policyId: string;
  readonly displayName: string;
  readonly diffKind: "created" | "modified" | "deleted";
  /** ISO8601 timestamp the change was first observed (the run's `startedAt`). */
  readonly observedAt: string;
}

export interface RecentCaChanges {
  readonly windowHours: number;
  readonly count: number;
  /** First N samples (default 5) for the tile + notifications; the full
   *  history is in the audit chain for verification. */
  readonly samples: readonly RecentCaChangeSample[];
}

const SOURCE = "graph.identity.conditionalAccess.policies";
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_SAMPLES = 5;
// Bounds the audit-blob walk: the orchestrator emits at most O(N) lines per
// run where N is the policy delta count; tenants typically have 5–20
// policies, so a 24h window won't exceed a few hundred lines under any
// plausible churn scenario. 500 keeps the worst-case bounded.
const READ_LIMIT = 500;

export async function readRecentConditionalAccessChanges(
  auditCtx: AuditContext,
  tenantId: string,
  options: { readonly windowHours?: number; readonly samples?: number } = {},
): Promise<RecentCaChanges> {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const samplesCount = options.samples ?? DEFAULT_SAMPLES;
  const nowMs = Date.now();
  const cutoffMs = nowMs - windowHours * 3_600_000;

  // §10.55 L-2 fix: tighten the day-blob walk to exactly the day-boundaries
  // the window crosses. `readRecentAuditLines` walks `today + lookbackDays
  // days back`, so dayDelta=0 → today only; dayDelta=1 → today + yesterday.
  // Previous formula `ceil(h/24)+1` over-read by one day in the steady-state
  // 24h case (computed 2, but a 24h window straddles exactly one midnight
  // = today + yesterday = lookbackDays=1 in this accessor's terms). For
  // sub-day windows that don't cross midnight, the original always read two
  // days; this version reads one.
  const startDay = new Date(cutoffMs).toISOString().slice(0, 10);
  const endDay = new Date(nowMs).toISOString().slice(0, 10);
  const lookbackDays = Math.round(
    (Date.parse(endDay) - Date.parse(startDay)) / 86_400_000,
  );
  const lines = await readRecentAuditLines(auditCtx, SOURCE, tenantId, READ_LIMIT, lookbackDays);

  const samples: RecentCaChangeSample[] = [];
  let count = 0;
  for (const l of lines) {
    if (l.eventType !== "ca.policy.changed") continue;
    const t = Date.parse(l.startedAt);
    if (!Number.isFinite(t) || t < cutoffMs) continue;
    count += 1;
    if (samples.length < samplesCount) {
      // The audit-line shape carries `policyId`, `displayName`, `diffKind` —
      // narrow defensively so a future schema bump doesn't blow up the tile.
      const policyId = typeof l.policyId === "string" ? l.policyId : "";
      const displayName = typeof l.displayName === "string" ? l.displayName : "";
      const kind = l.diffKind;
      if (
        policyId.length > 0 &&
        (kind === "created" || kind === "modified" || kind === "deleted")
      ) {
        samples.push({
          policyId,
          displayName,
          diffKind: kind,
          observedAt: l.startedAt,
        });
      }
    }
  }
  return { windowHours, count, samples };
}
