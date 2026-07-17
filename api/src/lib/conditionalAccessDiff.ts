// ADR-0034 §3.3 + §10 — Conditional Access policy diff detection.
//
// Run AFTER upsert + reconciliation. Compares the prior snapshot (what the
// store returned BEFORE this run wrote) against the freshly-parsed batch.
// Three outcome categories:
//
//   `created` — id present in the new batch but not in the prior snapshot.
//   `deleted` — id present in the prior snapshot but not in the new batch.
//   `modified` — id present in both AND any of (state, modifiedDateTime,
//                hash(conditions), hash(grantControls), hash(sessionControls))
//                differ.
//
// Each non-zero diff produces one `ca.policy.changed` audit line in the
// orchestrator (`runConditionalAccessIngest.ts`). The line is chained on the
// same `(source, tenantId)` chain as the ingest.run line — preserves the
// ADR-0015 forward-only invariant.

import { createHash } from "node:crypto";
import type { ConditionalAccessPolicyDomain } from "./conditionalAccessParser.js";

export interface PolicyDiffEntry {
  readonly kind: "created" | "modified" | "deleted";
  readonly policyId: string;
  readonly displayName: string;
  /** State + canonical-JSON hashes for the prior version (null on `created`). */
  readonly before: PolicyFingerprint | null;
  /** Same shape for the new version (null on `deleted`). */
  readonly after: PolicyFingerprint | null;
}

/** Compact, audit-line-friendly hash-only summary of a policy. The full
 *  policy bodies are NOT embedded — keeps the audit line size bounded
 *  (operator-defined IP lists can be kilobytes). Reviewers compare by
 *  hash; full diff content lives in the table snapshot. */
export interface PolicyFingerprint {
  readonly state: ConditionalAccessPolicyDomain["state"];
  readonly modifiedDateTime: string | null;
  readonly conditionsSha256: string;
  readonly grantControlsSha256: string;
  readonly sessionControlsSha256: string | null;
}

export interface DiffResult {
  readonly entries: readonly PolicyDiffEntry[];
  readonly createdCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

function fingerprint(p: ConditionalAccessPolicyDomain): PolicyFingerprint {
  return {
    state: p.state,
    modifiedDateTime: p.modifiedDateTime,
    conditionsSha256: sha256Hex(p.conditions),
    grantControlsSha256: sha256Hex(p.grantControls),
    sessionControlsSha256:
      p.sessionControls === null ? null : sha256Hex(p.sessionControls),
  };
}

function fingerprintsEqual(a: PolicyFingerprint, b: PolicyFingerprint): boolean {
  return (
    a.state === b.state &&
    a.modifiedDateTime === b.modifiedDateTime &&
    a.conditionsSha256 === b.conditionsSha256 &&
    a.grantControlsSha256 === b.grantControlsSha256 &&
    a.sessionControlsSha256 === b.sessionControlsSha256
  );
}

/** Compute the diff between a prior snapshot (from `listConditionalAccess
 *  Policies` BEFORE this run) and the freshly-parsed batch. */
export function diffConditionalAccessPolicies(
  prior: readonly ConditionalAccessPolicyDomain[],
  current: readonly ConditionalAccessPolicyDomain[],
): DiffResult {
  const priorById = new Map(prior.map((p) => [p.id, p]));
  const currentById = new Map(current.map((p) => [p.id, p]));
  const entries: PolicyDiffEntry[] = [];
  let created = 0;
  let modified = 0;
  let deleted = 0;

  for (const [id, c] of currentById) {
    const p = priorById.get(id);
    const cFp = fingerprint(c);
    if (p === undefined) {
      entries.push({
        kind: "created",
        policyId: id,
        displayName: c.displayName,
        before: null,
        after: cFp,
      });
      created += 1;
      continue;
    }
    const pFp = fingerprint(p);
    if (!fingerprintsEqual(pFp, cFp)) {
      entries.push({
        kind: "modified",
        policyId: id,
        displayName: c.displayName,
        before: pFp,
        after: cFp,
      });
      modified += 1;
    }
  }

  for (const [id, p] of priorById) {
    if (!currentById.has(id)) {
      entries.push({
        kind: "deleted",
        policyId: id,
        displayName: p.displayName,
        before: fingerprint(p),
        after: null,
      });
      deleted += 1;
    }
  }

  return { entries, createdCount: created, modifiedCount: modified, deletedCount: deleted };
}

// Test-only re-exports.
export const __test__ = { fingerprint, fingerprintsEqual, sha256Hex };
