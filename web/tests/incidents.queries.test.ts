import { describe, it, expect } from "vitest";
import { buildQueryString } from "@/features/incidents/queries";

describe("buildQueryString", () => {
  it("returns empty string when no filters are set", () => {
    expect(buildQueryString({})).toBe("");
  });

  it("appends each severity as a repeated param", () => {
    expect(buildQueryString({ severity: ["high", "medium"] })).toBe(
      "?severity=high&severity=medium",
    );
  });

  it("includes `since` verbatim", () => {
    expect(buildQueryString({ since: "2026-04-18T00:00:00.000Z" })).toBe(
      "?since=2026-04-18T00%3A00%3A00.000Z",
    );
  });

  it("only emits includeRedirected when true (default false is omitted)", () => {
    expect(buildQueryString({ includeRedirected: false })).toBe("");
    expect(buildQueryString({ includeRedirected: true })).toBe("?includeRedirected=true");
  });

  it("passes a non-default limit through", () => {
    expect(buildQueryString({ limit: 50 })).toBe("?limit=50");
  });

  it("passes cursor through (opaque to client)", () => {
    expect(buildQueryString({ cursor: "abc123" })).toBe("?cursor=abc123");
  });
});
