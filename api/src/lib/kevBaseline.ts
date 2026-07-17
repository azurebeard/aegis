// ADR-0033 Phase 2.5 — KEV deployment-baseline mode.
//
// One-shot bulk-acknowledge: when an admin flips kev-baseline mode to
// `from-deploy` with a baselineDate, every (stackItem, CVE) match where
// the KEV `dateAdded < baselineDate` AND no suppression row already
// exists is auto-written with status="acknowledged".
//
// Operator decisions are NEVER clobbered — if a row already exists for a
// given (stackItemId, cveID), it's skipped regardless of its current
// status. Idempotent: running twice on the same baselineDate produces
// `acknowledgedCount: 0, alreadyHandledCount: N` on the second run.

import {
  matchesForStackItem,
  type KevRow,
} from "./kevStore.js";
import {
  suppressionRowKey,
  upsertSuppression,
  type KevSuppressionRow,
} from "./kevSuppressionsStore.js";
import type { StackItem } from "./stackItemsStore.js";
import type { TableClient } from "@azure/data-tables";

export interface ApplyKevBaselineArgs {
  readonly tenantId: string;
  readonly baselineDate: string; // YYYY-MM-DD
  readonly stackItems: readonly StackItem[];
  readonly kevRows: readonly KevRow[];
  readonly existingSuppressions: readonly KevSuppressionRow[];
  readonly suppressionsTable: TableClient;
  readonly updatedBy: string;
  readonly now: string;
}

export interface ApplyKevBaselineResult {
  /** New acknowledged rows written by this run. */
  readonly acknowledgedCount: number;
  /** (item, CVE) pairs skipped because a suppression row already exists,
   *  regardless of its status (operator decisions are not clobbered). */
  readonly alreadyHandledCount: number;
  /** Total (item, CVE) pairs evaluated (joined matches). */
  readonly totalMatches: number;
  /** (item, CVE) pairs skipped because KEV `dateAdded >= baselineDate`. */
  readonly afterBaselineCount: number;
}

/**
 * Walk every (stack item, CVE) match and write `acknowledged` suppression
 * rows for those that qualify. The walk is read-driven by the same
 * matcher used in GET /api/stack/items, so the join shape can't drift
 * between display and bulk-action.
 *
 * The notes field on each generated row is humanly readable so an
 * operator inspecting the row in Storage Explorer (or via API) sees the
 * provenance — distinguishes auto-baseline rows from operator-set rows.
 */
export async function applyKevBaseline(
  args: ApplyKevBaselineArgs,
): Promise<ApplyKevBaselineResult> {
  const existingByKey = new Map<string, KevSuppressionRow>();
  for (const s of args.existingSuppressions) {
    existingByKey.set(suppressionRowKey(s.stackItemId, s.cveID), s);
  }

  const notes = `Deployment baseline ${args.baselineDate}`;
  let totalMatches = 0;
  let alreadyHandledCount = 0;
  let afterBaselineCount = 0;
  const toWrite: Array<{ stackItemId: string; cveID: string }> = [];

  for (const item of args.stackItems) {
    const matches = matchesForStackItem(args.kevRows, {
      vendor: item.vendor,
      product: item.product,
    });
    for (const m of matches) {
      totalMatches++;
      // Skip if KEV dateAdded missing or >= baseline. String compare is
      // valid for ISO dates (YYYY-MM-DD lexicographic == chronological).
      if (!m.dateAdded || m.dateAdded >= args.baselineDate) {
        afterBaselineCount++;
        continue;
      }
      const key = suppressionRowKey(item.id, m.cveID);
      if (existingByKey.has(key)) {
        alreadyHandledCount++;
        continue;
      }
      toWrite.push({ stackItemId: item.id, cveID: m.cveID });
    }
  }

  // Sequential writes — at v1 scale (≤100 stack items × ~1500 KEV rows
  // typically yielding 50–250 matches) this is well under any practical
  // ceiling. Parallelism would risk Table-Storage throttling without
  // measurable wall-clock benefit; revisit only if a larger tenant
  // surfaces a real latency issue.
  for (const { stackItemId, cveID } of toWrite) {
    await upsertSuppression(args.suppressionsTable, {
      tenantId: args.tenantId,
      stackItemId,
      cveID,
      status: "acknowledged",
      notes,
      expiresAt: "",
      updatedBy: args.updatedBy,
      now: args.now,
    });
  }

  return {
    acknowledgedCount: toWrite.length,
    alreadyHandledCount,
    totalMatches,
    afterBaselineCount,
  };
}
