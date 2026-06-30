import { describe, it, expect } from "vitest";
import {
  ALLOWED_RISK_LEVELS,
  ALLOWED_RISK_STATES,
  canonicaliseFilterSet,
  canonicaliseRiskyUsersFilterSet,
  computeFilterFingerprint,
  computeRiskyUsersFilterFingerprint,
  DEFAULT_LIMIT,
  FilterValidationError,
} from "../src/lib/filterFingerprint.js";

describe("canonicaliseFilterSet", () => {
  it("sorts and dedupes enum arrays deterministically", () => {
    const a = canonicaliseFilterSet({ severity: ["medium", "high", "medium"] });
    const b = canonicaliseFilterSet({ severity: ["high", "medium"] });
    expect(a.severity).toEqual(b.severity);
    expect(a.severity).toEqual(["high", "medium"]);
  });

  it("rejects non-lowercase enum casing", () => {
    expect(() => canonicaliseFilterSet({ severity: ["High"] })).toThrow(FilterValidationError);
    try {
      canonicaliseFilterSet({ severity: ["High"] });
    } catch (err) {
      expect((err as FilterValidationError).kind).toBe("enum_casing");
      expect((err as FilterValidationError).field).toBe("severity");
    }
  });

  it("rejects unknown enum values", () => {
    expect(() => canonicaliseFilterSet({ severity: ["critical"] })).toThrow(FilterValidationError);
  });

  it("rejects malformed `since` (must be strict YYYY-MM-DDTHH:mm:ss.sssZ)", () => {
    expect(() => canonicaliseFilterSet({ since: "2026-04-18" })).toThrow(FilterValidationError);
    expect(() => canonicaliseFilterSet({ since: "2026-04-18T00:00:00Z" })).toThrow(
      FilterValidationError,
    );
    expect(() => canonicaliseFilterSet({ since: "2026-04-18T00:00:00.000+01:00" })).toThrow(
      FilterValidationError,
    );
  });

  it("accepts well-formed strict UTC since", () => {
    const set = canonicaliseFilterSet({ since: "2026-04-18T00:00:00.000Z" });
    expect(set.since).toBe("2026-04-18T00:00:00.000Z");
  });

  it("rejects semantically-invalid dates (Feb 30) even when syntactically well-formed", () => {
    expect(() =>
      canonicaliseFilterSet({ since: "2026-02-30T00:00:00.000Z" }),
    ).toThrow(FilterValidationError);
  });

  it("rejects out-of-range limit", () => {
    expect(() => canonicaliseFilterSet({ limit: 0 })).toThrow(FilterValidationError);
    expect(() => canonicaliseFilterSet({ limit: 51 })).toThrow(FilterValidationError);
    expect(() => canonicaliseFilterSet({ limit: 2.5 })).toThrow(FilterValidationError);
  });

  it("defaults limit to DEFAULT_LIMIT", () => {
    const set = canonicaliseFilterSet({});
    expect(set.limit).toBe(DEFAULT_LIMIT);
  });

  it("defaults includeRedirected to false", () => {
    expect(canonicaliseFilterSet({}).includeRedirected).toBe(false);
    expect(canonicaliseFilterSet({ includeRedirected: false }).includeRedirected).toBe(false);
  });
});

describe("computeFilterFingerprint — ADR-0016 §2a stability assertions", () => {
  it("?severity=high&severity=medium === ?severity=medium&severity=high", () => {
    const a = computeFilterFingerprint({ severity: ["high", "medium"] });
    const b = computeFilterFingerprint({ severity: ["medium", "high"] });
    expect(a).toBe(b);
  });

  it("?severity=high&severity=high&severity=medium === ?severity=high&severity=medium (dedupe)", () => {
    const a = computeFilterFingerprint({ severity: ["high", "high", "medium"] });
    const b = computeFilterFingerprint({ severity: ["high", "medium"] });
    expect(a).toBe(b);
  });

  it("? === ?limit=25 (default limit resolved)", () => {
    const a = computeFilterFingerprint({});
    const b = computeFilterFingerprint({ limit: 25 });
    expect(a).toBe(b);
  });

  it("?includeRedirected=false === ? (default false omitted)", () => {
    const a = computeFilterFingerprint({ includeRedirected: false });
    const b = computeFilterFingerprint({});
    expect(a).toBe(b);
  });

  it("? differs from ?severity=<all values>", () => {
    const a = computeFilterFingerprint({});
    const b = computeFilterFingerprint({
      severity: ["unknown", "informational", "low", "medium", "high"],
    });
    expect(a).not.toBe(b);
  });

  it("?limit=25 differs from ?limit=50", () => {
    const a = computeFilterFingerprint({ limit: 25 });
    const b = computeFilterFingerprint({ limit: 50 });
    expect(a).not.toBe(b);
  });

  it("?severity=high differs from ?severity=High (case rejected — not normalised)", () => {
    expect(() => computeFilterFingerprint({ severity: ["High"] })).toThrow(
      FilterValidationError,
    );
  });

  it("fingerprint is a 64-char lowercase-hex string", () => {
    expect(computeFilterFingerprint({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it("`since` participates in the fingerprint", () => {
    const a = computeFilterFingerprint({ since: "2026-04-18T00:00:00.000Z" });
    const b = computeFilterFingerprint({ since: "2026-04-19T00:00:00.000Z" });
    expect(a).not.toBe(b);
  });
});

describe("canonicaliseRiskyUsersFilterSet — camelCase enum support (SEC-L-STEP6-CODE-04)", () => {
  // Graph's riskState allowed-set is camelCase per ADR-0024 §2a. The
  // canonicaliser must accept those values verbatim (the audit-chain + table
  // rows store Microsoft's canonical form).
  it.each(ALLOWED_RISK_STATES.map((v) => [v]))(
    "accepts riskState %s without throwing enum_casing",
    (value) => {
      const out = canonicaliseRiskyUsersFilterSet({ riskState: [value] });
      expect(out.riskState).toEqual([value]);
    },
  );

  it.each(ALLOWED_RISK_LEVELS.map((v) => [v]))(
    "accepts riskLevel %s without throwing enum_casing",
    (value) => {
      const out = canonicaliseRiskyUsersFilterSet({ riskLevel: [value] });
      expect(out.riskLevel).toEqual([value]);
    },
  );

  it("preserves camelCase on the canonicalised output (does NOT lowercase)", () => {
    const out = canonicaliseRiskyUsersFilterSet({
      riskState: ["atRisk", "confirmedCompromised"],
    });
    // Sorted by UTF-16 code-unit order — both preserve their original casing.
    expect(out.riskState).toEqual(["atRisk", "confirmedCompromised"]);
  });

  it("rejects mis-cased variants when the lowered form is in the allowed set — reports enum_casing", () => {
    // `HIGH` -> `high` (in allowed set). The wire form is camelCase/lowercase
    // per Graph; mis-cased input must be rejected (allowed-set membership is
    // the source of truth), and classified as casing mismatch (not
    // wholly-unknown) for operator observability.
    expect(() =>
      canonicaliseRiskyUsersFilterSet({ riskLevel: ["HIGH"] }),
    ).toThrow(FilterValidationError);
    try {
      canonicaliseRiskyUsersFilterSet({ riskLevel: ["HIGH"] });
    } catch (err) {
      expect((err as FilterValidationError).kind).toBe("enum_casing");
    }
  });

  it("rejects ALL-lowercased camelCase values (lowered form is NOT in the allowed set)", () => {
    // `atrisk` (fully lowercase) is neither the canonical camelCase
    // (`atRisk`) nor something whose lowered form hits the allowed set —
    // the allowed set contains `atRisk`, not `atrisk`. So this is
    // classified as enum_invalid (wholly-unknown value).
    expect(() =>
      canonicaliseRiskyUsersFilterSet({ riskState: ["atrisk"] }),
    ).toThrow(FilterValidationError);
    try {
      canonicaliseRiskyUsersFilterSet({ riskState: ["atrisk"] });
    } catch (err) {
      expect((err as FilterValidationError).kind).toBe("enum_invalid");
    }
  });

  it("rejects wholly-unknown values with enum_invalid", () => {
    expect(() =>
      canonicaliseRiskyUsersFilterSet({ riskState: ["undefinedBehaviour"] }),
    ).toThrow(FilterValidationError);
    try {
      canonicaliseRiskyUsersFilterSet({ riskState: ["undefinedBehaviour"] });
    } catch (err) {
      expect((err as FilterValidationError).kind).toBe("enum_invalid");
    }
  });

  it("dedupes + sorts by UTF-16 code-unit order while keeping camelCase", () => {
    const out = canonicaliseRiskyUsersFilterSet({
      riskState: ["confirmedCompromised", "atRisk", "atRisk"],
    });
    expect(out.riskState).toEqual(["atRisk", "confirmedCompromised"]);
  });

  it("computes a stable fingerprint for camelCase riskState", () => {
    const a = computeRiskyUsersFilterFingerprint({ riskState: ["atRisk"] });
    const b = computeRiskyUsersFilterFingerprint({ riskState: ["atRisk"] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
