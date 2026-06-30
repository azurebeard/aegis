import { describe, it, expect } from "vitest";
import { parseDays } from "../src/functions/getSecureScoreTrend.js";

describe("parseDays", () => {
  it("defaults to 90 when unspecified", () => {
    expect(parseDays(null)).toBe(90);
    expect(parseDays(undefined)).toBe(90);
    expect(parseDays("")).toBe(90);
  });

  it("accepts valid integers in [1, 400]", () => {
    expect(parseDays("1")).toBe(1);
    expect(parseDays("30")).toBe(30);
    expect(parseDays("400")).toBe(400);
  });

  it("rejects non-integers and out-of-range values", () => {
    expect(parseDays("0")).toBeNull();
    expect(parseDays("401")).toBeNull();
    expect(parseDays("-5")).toBeNull();
    expect(parseDays("3.5")).toBeNull();
    expect(parseDays("ten")).toBeNull();
    expect(parseDays("1e2")).toBeNull(); // exponential is not allowed
  });
});
