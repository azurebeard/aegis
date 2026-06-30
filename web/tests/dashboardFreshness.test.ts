import { describe, expect, it } from "vitest";
import { _internal } from "@/features/common/DashboardFreshness";

const { oldest, formatAge } = _internal;

describe("DashboardFreshness.oldest", () => {
  it("returns null when every candidate is missing", () => {
    expect(oldest([null, undefined, null])).toBeNull();
    expect(oldest([])).toBeNull();
    expect(oldest(["", null])).toBeNull();
  });

  it("returns the lone timestamp when only one is present", () => {
    expect(oldest(["2026-04-19T09:00:00.000Z", null, undefined])).toBe(
      "2026-04-19T09:00:00.000Z",
    );
  });

  it("returns the oldest (smallest-sort) ISO timestamp", () => {
    const a = "2026-04-19T09:00:00.000Z";
    const b = "2026-04-19T12:00:00.000Z";
    const c = "2026-04-18T23:00:00.000Z";
    expect(oldest([a, b, c])).toBe(c);
  });

  it("ignores empty-string candidates", () => {
    expect(oldest(["", "2026-04-19T09:00:00.000Z", ""])).toBe(
      "2026-04-19T09:00:00.000Z",
    );
  });
});

describe("DashboardFreshness.formatAge", () => {
  const now = new Date("2026-04-19T12:00:00.000Z");

  it("returns null for null input", () => {
    expect(formatAge(null, now)).toBeNull();
  });

  it("returns null for non-parseable input", () => {
    expect(formatAge("not a date", now)).toBeNull();
  });

  it("returns 'just now' for future + sub-minute timestamps", () => {
    expect(formatAge("2026-04-19T12:00:05.000Z", now)).toBe("just now");
    expect(formatAge("2026-04-19T11:59:30.000Z", now)).toBe("just now");
  });

  it("formats minutes correctly under 60m", () => {
    expect(formatAge("2026-04-19T11:45:00.000Z", now)).toBe("15m ago");
    expect(formatAge("2026-04-19T11:01:00.000Z", now)).toBe("59m ago");
  });

  it("formats hours under 24h", () => {
    expect(formatAge("2026-04-19T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatAge("2026-04-18T13:00:00.000Z", now)).toBe("23h ago");
  });

  it("formats days beyond 24h", () => {
    expect(formatAge("2026-04-17T12:00:00.000Z", now)).toBe("2d ago");
    expect(formatAge("2026-04-12T12:00:00.000Z", now)).toBe("7d ago");
  });
});
