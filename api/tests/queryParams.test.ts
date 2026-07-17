// Unit tests for getAllMulti — the defensive parser that closes the
// SWA-linked-backend-proxy quirk where repeated query params are
// collapsed into a single comma-joined value before reaching the FA.

import { describe, expect, it } from "vitest";
import { getAllMulti } from "../src/lib/queryParams.js";

function q(s: string): URLSearchParams {
  return new URLSearchParams(s);
}

describe("getAllMulti", () => {
  it("returns [] when the param is absent", () => {
    expect(getAllMulti(q(""), "severity")).toEqual([]);
    expect(getAllMulti(q("limit=25"), "severity")).toEqual([]);
  });

  it("returns [] when the param is empty", () => {
    expect(getAllMulti(q("severity="), "severity")).toEqual([]);
  });

  it("returns [] when the param has only commas", () => {
    expect(getAllMulti(q("severity=,,"), "severity")).toEqual([]);
  });

  it("returns a single value as a single-element array", () => {
    expect(getAllMulti(q("severity=high"), "severity")).toEqual(["high"]);
  });

  it("expands native repeated params into separate elements", () => {
    expect(getAllMulti(q("severity=high&severity=medium"), "severity")).toEqual([
      "high",
      "medium",
    ]);
  });

  it("expands a comma-joined value into separate elements (the proxy-collapse case)", () => {
    expect(getAllMulti(q("severity=high,medium"), "severity")).toEqual([
      "high",
      "medium",
    ]);
  });

  it("expands a URL-encoded comma the same way as a literal comma", () => {
    expect(getAllMulti(q("severity=high%2Cmedium"), "severity")).toEqual([
      "high",
      "medium",
    ]);
  });

  it("handles mixed shapes (some native, some comma-joined)", () => {
    expect(
      getAllMulti(q("severity=high&severity=medium,low"), "severity"),
    ).toEqual(["high", "medium", "low"]);
  });

  it("trims whitespace around tokens", () => {
    expect(getAllMulti(q("severity=high, medium ,low"), "severity")).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  it("drops empty tokens from trailing commas", () => {
    expect(getAllMulti(q("severity=high,"), "severity")).toEqual(["high"]);
    expect(getAllMulti(q("severity=,high,"), "severity")).toEqual(["high"]);
  });

  it("preserves camelCase enum values (status=inProgress)", () => {
    // Defensive against a hypothetical lowercase coercion that would have
    // broken the canonicaliser's strict casing rule.
    expect(getAllMulti(q("status=active&status=inProgress"), "status")).toEqual(
      ["active", "inProgress"],
    );
    expect(getAllMulti(q("status=active,inProgress"), "status")).toEqual([
      "active",
      "inProgress",
    ]);
  });

  it("does NOT deduplicate — that's the canonicaliser's job", () => {
    expect(
      getAllMulti(q("severity=high&severity=high"), "severity"),
    ).toEqual(["high", "high"]);
    expect(getAllMulti(q("severity=high,high"), "severity")).toEqual([
      "high",
      "high",
    ]);
  });

  it("isolates per-param expansion (severity expansion doesn't leak to status)", () => {
    const u = q("severity=high,medium&status=active,inProgress");
    expect(getAllMulti(u, "severity")).toEqual(["high", "medium"]);
    expect(getAllMulti(u, "status")).toEqual(["active", "inProgress"]);
  });
});
