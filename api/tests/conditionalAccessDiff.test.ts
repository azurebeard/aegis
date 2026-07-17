// ADR-0034 §3.3 + §10 — Conditional Access policy diff detection.

import { describe, expect, it } from "vitest";
import { diffConditionalAccessPolicies } from "../src/lib/conditionalAccessDiff.js";
import type { ConditionalAccessPolicyDomain } from "../src/lib/conditionalAccessParser.js";

function policy(
  partial: Partial<ConditionalAccessPolicyDomain>,
): ConditionalAccessPolicyDomain {
  return {
    id: "policy-a",
    displayName: "Require MFA for admins",
    state: "enabled",
    createdDateTime: "2026-04-01T00:00:00Z",
    modifiedDateTime: "2026-04-15T08:00:00Z",
    conditions: '{"applications":{"includeApplications":["All"]}}',
    grantControls: '{"builtInControls":["mfa"],"operator":"AND"}',
    sessionControls: null,
    ingestedAt: "2026-05-10T12:00:00.000Z",
    ingestRunId: "run-1",
    ...partial,
  };
}

describe("diffConditionalAccessPolicies — empty vs empty", () => {
  it("returns zero entries", () => {
    expect(diffConditionalAccessPolicies([], [])).toEqual({
      entries: [],
      createdCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
    });
  });
});

describe("diffConditionalAccessPolicies — unchanged", () => {
  it("returns zero entries when prior and current are byte-identical", () => {
    const p = policy({});
    const out = diffConditionalAccessPolicies([p], [p]);
    expect(out.entries).toEqual([]);
    expect(out.createdCount).toBe(0);
    expect(out.modifiedCount).toBe(0);
    expect(out.deletedCount).toBe(0);
  });
});

describe("diffConditionalAccessPolicies — created", () => {
  it("flags new policy not in prior", () => {
    const out = diffConditionalAccessPolicies([], [policy({})]);
    expect(out.createdCount).toBe(1);
    expect(out.entries[0]!.kind).toBe("created");
    expect(out.entries[0]!.before).toBeNull();
    expect(out.entries[0]!.after).not.toBeNull();
    expect(out.entries[0]!.after!.state).toBe("enabled");
  });
});

describe("diffConditionalAccessPolicies — deleted", () => {
  it("flags policy in prior but absent from current", () => {
    const out = diffConditionalAccessPolicies([policy({})], []);
    expect(out.deletedCount).toBe(1);
    expect(out.entries[0]!.kind).toBe("deleted");
    expect(out.entries[0]!.before).not.toBeNull();
    expect(out.entries[0]!.after).toBeNull();
  });
});

describe("diffConditionalAccessPolicies — modified", () => {
  it("flags state change", () => {
    const prior = [policy({ state: "enabled" })];
    const current = [policy({ state: "disabled" })];
    const out = diffConditionalAccessPolicies(prior, current);
    expect(out.modifiedCount).toBe(1);
    expect(out.entries[0]!.kind).toBe("modified");
    expect(out.entries[0]!.before!.state).toBe("enabled");
    expect(out.entries[0]!.after!.state).toBe("disabled");
  });

  it("flags conditions change (different canonical JSON)", () => {
    const out = diffConditionalAccessPolicies(
      [policy({ conditions: '{"applications":{"includeApplications":["All"]}}' })],
      [policy({ conditions: '{"applications":{"includeApplications":["123"]}}' })],
    );
    expect(out.modifiedCount).toBe(1);
    expect(out.entries[0]!.before!.conditionsSha256).not.toEqual(
      out.entries[0]!.after!.conditionsSha256,
    );
  });

  it("does NOT flag identical-content rows where displayName changes", () => {
    // displayName is metadata only — not a fingerprint field per ADR §3.3.
    // The diff fires on (state, modifiedDateTime, hash(conditions),
    // hash(grantControls), hash(sessionControls)).
    const out = diffConditionalAccessPolicies(
      [policy({ displayName: "v1" })],
      [policy({ displayName: "v2" })],
    );
    expect(out.modifiedCount).toBe(0);
  });

  it("flags modifiedDateTime drift even when content hashes match", () => {
    // Microsoft updates the modifiedDateTime stamp on policy edits even
    // when the operator's intended change is benign — the diff captures
    // it as a modified-but-content-stable signal.
    const out = diffConditionalAccessPolicies(
      [policy({ modifiedDateTime: "2026-04-15T08:00:00Z" })],
      [policy({ modifiedDateTime: "2026-04-16T09:00:00Z" })],
    );
    expect(out.modifiedCount).toBe(1);
  });
});

describe("diffConditionalAccessPolicies — mixed", () => {
  it("handles created + modified + deleted in one diff", () => {
    const prior = [
      policy({ id: "p1" }), // unchanged
      policy({ id: "p2", state: "enabled" }), // will be modified
      policy({ id: "p3" }), // will be deleted
    ];
    const current = [
      policy({ id: "p1" }), // unchanged
      policy({ id: "p2", state: "disabled" }), // modified
      policy({ id: "p4" }), // created
    ];
    const out = diffConditionalAccessPolicies(prior, current);
    expect(out.createdCount).toBe(1);
    expect(out.modifiedCount).toBe(1);
    expect(out.deletedCount).toBe(1);
    expect(out.entries.map((e) => e.kind).sort()).toEqual(["created", "deleted", "modified"]);
  });
});
