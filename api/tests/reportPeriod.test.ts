// ADR-0030 §2 — period-key derivation + validation tests.

import { describe, expect, it } from "vitest";
import {
  isReportCadence,
  isValidPeriodKey,
  periodForCadence,
  periodFromKey,
} from "../src/lib/reportPeriod.js";

describe("isReportCadence", () => {
  it("accepts only the three documented cadences", () => {
    expect(isReportCadence("weekly")).toBe(true);
    expect(isReportCadence("monthly")).toBe(true);
    expect(isReportCadence("quarterly")).toBe(true);
    for (const bad of [
      "",
      "WEEKLY",
      "daily",
      "annual",
      null,
      undefined,
      0,
      true,
      ["weekly"],
    ]) {
      expect(isReportCadence(bad)).toBe(false);
    }
  });
});

describe("isValidPeriodKey", () => {
  it("matches the right shape per cadence", () => {
    expect(isValidPeriodKey("weekly", "2026-W17")).toBe(true);
    expect(isValidPeriodKey("monthly", "2026-04")).toBe(true);
    expect(isValidPeriodKey("quarterly", "2026-Q2")).toBe(true);
  });
  it("rejects mismatched / hostile keys", () => {
    for (const bad of [
      "",
      "2026-w17", // lowercase W
      "26-W17",
      "2026-W1",
      "2026-13",
      "2026-Q5",
      "2026-Q0",
      "../../../etc/passwd",
      "2026-W17_extra",
    ]) {
      expect(isValidPeriodKey("weekly", bad)).toBe(false);
      expect(isValidPeriodKey("monthly", bad)).toBe(false);
      expect(isValidPeriodKey("quarterly", bad)).toBe(false);
    }
  });
});

describe("periodForCadence (current period)", () => {
  it("derives a weekly key for a Wednesday", () => {
    const wed = new Date("2026-04-22T12:00:00Z"); // ISO week 17 of 2026
    const p = periodForCadence("weekly", wed);
    expect(p.periodKey).toBe("2026-W17");
    expect(p.periodStart).toBe("2026-04-20T00:00:00.000Z"); // Mon
    expect(p.periodEnd.startsWith("2026-04-26T23:59:59")).toBe(true);
  });

  it("derives a monthly key", () => {
    const p = periodForCadence("monthly", new Date("2026-04-15T12:00:00Z"));
    expect(p.periodKey).toBe("2026-04");
    expect(p.periodStart).toBe("2026-04-01T00:00:00.000Z");
    expect(p.periodEnd.startsWith("2026-04-30T23:59:59")).toBe(true);
  });

  it("derives a quarterly key for Q2", () => {
    const p = periodForCadence("quarterly", new Date("2026-05-15T12:00:00Z"));
    expect(p.periodKey).toBe("2026-Q2");
    expect(p.periodStart).toBe("2026-04-01T00:00:00.000Z");
    expect(p.periodEnd.startsWith("2026-06-30T23:59:59")).toBe(true);
  });

  it("derives a quarterly key for Q1 boundary", () => {
    const p = periodForCadence("quarterly", new Date("2026-01-01T00:00:00Z"));
    expect(p.periodKey).toBe("2026-Q1");
  });

  it("derives a quarterly key for Q4 boundary (last day)", () => {
    const p = periodForCadence("quarterly", new Date("2026-12-31T23:59:59Z"));
    expect(p.periodKey).toBe("2026-Q4");
    expect(p.periodEnd.startsWith("2026-12-31T23:59:59")).toBe(true);
  });

  it("derives an ISO-week key for an end-of-year edge case (week 53)", () => {
    // 2026 is a 53-ISO-week year. 2026-12-31 is a Thursday → week 53.
    const p = periodForCadence("weekly", new Date("2026-12-31T12:00:00Z"));
    expect(p.periodKey).toBe("2026-W53");
  });
});

describe("periodFromKey (explicit key → bounds)", () => {
  it("round-trips a weekly key", () => {
    const a = periodForCadence("weekly", new Date("2026-04-22T12:00:00Z"));
    const b = periodFromKey("weekly", a.periodKey);
    expect(b).not.toBeNull();
    expect(b!.periodKey).toBe(a.periodKey);
    expect(b!.periodStart).toBe(a.periodStart);
    expect(b!.periodEnd).toBe(a.periodEnd);
  });

  it("rejects malformed keys", () => {
    expect(periodFromKey("weekly", "2026-W00")).toBeNull();
    expect(periodFromKey("weekly", "2026-W54")).toBeNull();
    expect(periodFromKey("monthly", "2026-13")).toBeNull();
    expect(periodFromKey("monthly", "2026-00")).toBeNull();
    expect(periodFromKey("quarterly", "2026-Q5")).toBeNull();
    expect(periodFromKey("quarterly", "2026-Q0")).toBeNull();
  });

  it("rejects a week-53 key in a year that doesn't have one", () => {
    // 2025 has no ISO week 53 (2025-12-31 is in 2026-W01).
    expect(periodFromKey("weekly", "2025-W53")).toBeNull();
  });
});
