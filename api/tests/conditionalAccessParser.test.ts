// ADR-0034 §3.3 — Conditional Access policy parser: narrow, JCS-canonicalise,
// bound the three nested fields, skip-not-throw on malformed rows.

import { describe, expect, it } from "vitest";
import {
  parseConditionalAccessPage,
  parseConditionalAccessPages,
  __test__,
} from "../src/lib/conditionalAccessParser.js";

const CTX = {
  ingestedAt: "2026-05-10T12:00:00.000Z",
  ingestRunId: "run-1",
};

const POLICY_A = {
  id: "policy-a",
  displayName: "Require MFA for admins",
  state: "enabled",
  createdDateTime: "2026-04-01T00:00:00Z",
  modifiedDateTime: "2026-04-15T08:00:00Z",
  conditions: { applications: { includeApplications: ["All"] } },
  grantControls: { operator: "AND", builtInControls: ["mfa"] },
  sessionControls: null,
};

describe("parseConditionalAccessPage — happy path", () => {
  it("parses a well-formed enabled policy", () => {
    const out = parseConditionalAccessPage({ value: [POLICY_A] }, CTX);
    expect(out.skippedMalformed).toBe(0);
    expect(out.truncatedFieldCount).toBe(0);
    expect(out.rows).toHaveLength(1);
    const r = out.rows[0]!;
    expect(r.id).toBe("policy-a");
    expect(r.state).toBe("enabled");
    // JCS-canonical sort keys alphabetically — assert the structural form.
    expect(r.conditions).toMatch(/^\{"applications":\{"includeApplications":\["All"\]\}\}$/);
    expect(r.grantControls).toMatch(/builtInControls/);
    expect(r.sessionControls).toBeNull();
  });

  it("accepts all three documented states", () => {
    const out = parseConditionalAccessPage(
      {
        value: [
          { ...POLICY_A, id: "p1", state: "enabled" },
          { ...POLICY_A, id: "p2", state: "disabled" },
          { ...POLICY_A, id: "p3", state: "enabledForReportingButNotEnforced" },
        ],
      },
      CTX,
    );
    expect(out.rows).toHaveLength(3);
    const states = out.rows.map((r) => r.state).sort();
    expect(states).toEqual(["disabled", "enabled", "enabledForReportingButNotEnforced"]);
  });

  it("emits canonical 'null' string for absent conditions / grantControls", () => {
    const out = parseConditionalAccessPage(
      {
        value: [
          { ...POLICY_A, id: "p", conditions: null, grantControls: null },
        ],
      },
      CTX,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.conditions).toBe("null");
    expect(out.rows[0]!.grantControls).toBe("null");
  });
});

describe("parseConditionalAccessPage — defensive", () => {
  it("skips rows with malformed id", () => {
    const out = parseConditionalAccessPage(
      {
        value: [
          { ...POLICY_A, id: "" }, // empty
          { ...POLICY_A, id: "a/b/c" }, // illegal chars
          { ...POLICY_A, id: "x".repeat(129) }, // too long
          POLICY_A, // valid
        ],
      },
      CTX,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.skippedMalformed).toBe(3);
  });

  it("skips rows with missing displayName", () => {
    const { displayName: _drop, ...without } = POLICY_A;
    void _drop;
    const out = parseConditionalAccessPage({ value: [without] }, CTX);
    expect(out.rows).toHaveLength(0);
    expect(out.skippedMalformed).toBe(1);
  });

  it("skips rows with out-of-set state", () => {
    const out = parseConditionalAccessPage(
      { value: [{ ...POLICY_A, state: "unknownFutureValue" }] },
      CTX,
    );
    expect(out.rows).toHaveLength(0);
    expect(out.skippedMalformed).toBe(1);
  });

  it("returns empty batch on non-object input", () => {
    expect(parseConditionalAccessPage(null, CTX)).toEqual({
      rows: [],
      skippedMalformed: 0,
      truncatedFieldCount: 0,
    });
    expect(parseConditionalAccessPage({ value: "nope" }, CTX)).toEqual({
      rows: [],
      skippedMalformed: 0,
      truncatedFieldCount: 0,
    });
  });
});

describe("parseConditionalAccessPage — bounded fields", () => {
  it("truncates conditions when canonical JSON exceeds 16 KB", () => {
    const huge = { ipRanges: Array.from({ length: 2000 }, (_, i) => `10.0.${i % 256}.0/24`) };
    const out = parseConditionalAccessPage(
      { value: [{ ...POLICY_A, conditions: huge }] },
      CTX,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.conditions).toBe('{"_truncated":true}');
    expect(out.truncatedFieldCount).toBe(1);
  });

  it("does NOT truncate when bodies stay under the limit", () => {
    const small = { applications: { includeApplications: ["All"] } };
    const out = parseConditionalAccessPage(
      { value: [{ ...POLICY_A, conditions: small }] },
      CTX,
    );
    expect(out.rows[0]!.conditions).not.toBe('{"_truncated":true}');
    expect(out.truncatedFieldCount).toBe(0);
  });
});

describe("parseConditionalAccessPages — multi-page aggregation", () => {
  it("concatenates rows + sums skipped/truncated across pages", () => {
    const out = parseConditionalAccessPages(
      [
        { value: [POLICY_A] },
        { value: [{ ...POLICY_A, id: "policy-b" }, { id: "bad" }] },
      ],
      CTX,
    );
    expect(out.rows).toHaveLength(2);
    expect(out.skippedMalformed).toBe(1);
  });
});

describe("__test__ exports", () => {
  it("exposes the byte-limit constants", () => {
    expect(__test__.CONDITIONS_BYTE_LIMIT).toBe(16 * 1024);
    expect(__test__.GRANT_CONTROLS_BYTE_LIMIT).toBe(16 * 1024);
    expect(__test__.SESSION_CONTROLS_BYTE_LIMIT).toBe(4 * 1024);
  });
});
