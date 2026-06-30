import { describe, it, expect } from "vitest";
import type { SecureScore } from "@microsoft/microsoft-graph-types";
import {
  computePercentage,
  deriveSnapshotDate,
  parseSecureScore,
} from "../src/lib/secureScoreParser.js";

describe("deriveSnapshotDate", () => {
  it("formats UTC YYYY-MM-DD from ISO8601", () => {
    expect(deriveSnapshotDate("2026-04-18T00:12:03Z")).toBe("2026-04-18");
  });
  it("rolls back to the prior UTC day for early-UTC timestamps", () => {
    expect(deriveSnapshotDate("2026-04-18T00:00:00Z")).toBe("2026-04-18");
  });
  it("throws on nonsense input", () => {
    expect(() => deriveSnapshotDate("nope")).toThrow(/invalid createdDateTime/);
  });
});

describe("computePercentage", () => {
  it("rounds to 1 d.p.", () => {
    expect(computePercentage(387, 697)).toBeCloseTo(55.5, 1);
    expect(computePercentage(412, 697)).toBeCloseTo(59.1, 1);
  });
  it("guards against max <= 0 or non-finite values", () => {
    expect(computePercentage(10, 0)).toBe(0);
    expect(computePercentage(Number.NaN, 100)).toBe(0);
    expect(computePercentage(10, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("parseSecureScore", () => {
  const base: SecureScore = {
    id: "tenant_2026-04-18",
    createdDateTime: "2026-04-18T00:12:03Z",
    currentScore: 412,
    maxScore: 697,
    activeUserCount: 0,
    licensedUserCount: 100,
    enabledServices: ["HasExchange"],
    averageComparativeScores: [{ basis: "AllTenants", averageScore: 37 }],
    controlScores: [
      {
        controlCategory: "Identity",
        controlName: "AdminMFA",
        description: "Requiring MFA",
        score: 35,
      },
    ],
  };

  it("parses a well-formed graph response", () => {
    const snap = parseSecureScore(base, {
      ingestedAt: "2026-04-19T03:02:18.902Z",
      ingestRunId: "run-guid",
    });
    expect(snap.snapshotDate).toBe("2026-04-18");
    expect(snap.currentScore).toBe(412);
    expect(snap.maxScore).toBe(697);
    expect(snap.percentage).toBeCloseTo(59.1, 1);
    expect(snap.controlScores).toHaveLength(1);
    expect(snap.controlScores[0]?.controlName).toBe("AdminMFA");
    expect(snap.ingestRunId).toBe("run-guid");
  });

  it("coerces missing nested collections to empty arrays", () => {
    const snap = parseSecureScore(
      { ...base, averageComparativeScores: undefined, controlScores: undefined, enabledServices: undefined },
      { ingestedAt: "2026-04-19T00:00:00Z", ingestRunId: "r" },
    );
    expect(snap.averageComparativeScores).toEqual([]);
    expect(snap.controlScores).toEqual([]);
    expect(snap.enabledServices).toEqual([]);
  });

  it("throws when required numeric fields are non-finite", () => {
    expect(() =>
      parseSecureScore({ ...base, currentScore: Number.NaN }, { ingestedAt: "", ingestRunId: "" }),
    ).toThrow(/currentScore/);
    expect(() =>
      parseSecureScore({ ...base, maxScore: undefined }, { ingestedAt: "", ingestRunId: "" }),
    ).toThrow(/maxScore/);
  });

  it("throws when createdDateTime is missing", () => {
    expect(() =>
      parseSecureScore({ ...base, createdDateTime: undefined }, { ingestedAt: "", ingestRunId: "" }),
    ).toThrow(/createdDateTime/);
  });

  it("preserves description verbatim — rendering-safety is the tile's job", () => {
    const hostile = "<script>alert(1)</script> javascript:void(0)";
    const snap = parseSecureScore(
      {
        ...base,
        controlScores: [
          { controlCategory: "X", controlName: "Y", description: hostile, score: 1 },
        ],
      },
      { ingestedAt: "2026-04-19T00:00:00Z", ingestRunId: "r" },
    );
    expect(snap.controlScores[0]?.description).toBe(hostile);
  });
});
