// Unit tests for formatRelativeFuture — SEC-OBS-B4-03 resolution.
// Asserts the sub-unit precision breakpoints ("Nh Nm", "Nd Nh") match
// the documented contract so operator-visible "next fire" strings are
// exact rather than floored to the nearest whole unit.

import { describe, expect, it } from "vitest";
import { formatRelativeFuture } from "@/features/common/NextFireBadge";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelativeFuture — sub-minute + <60min", () => {
  it("sub-minute deltas render as `<1 min`", () => {
    expect(formatRelativeFuture(0)).toBe("<1 min");
    expect(formatRelativeFuture(1_000)).toBe("<1 min");
    expect(formatRelativeFuture(59_999)).toBe("<1 min");
  });

  it("minute deltas render as `N min`", () => {
    expect(formatRelativeFuture(1 * MIN)).toBe("1 min");
    expect(formatRelativeFuture(35 * MIN)).toBe("35 min");
    expect(formatRelativeFuture(59 * MIN)).toBe("59 min");
  });
});

describe("formatRelativeFuture — <24h with sub-hour precision", () => {
  it("whole-hour deltas render without the `m` suffix", () => {
    expect(formatRelativeFuture(1 * HOUR)).toBe("1h");
    expect(formatRelativeFuture(4 * HOUR)).toBe("4h");
    expect(formatRelativeFuture(23 * HOUR)).toBe("23h");
  });

  it("non-whole-hour deltas render `Nh Nm` (SEC-OBS-B4-03)", () => {
    // Prior floor-only behaviour reported "1h" for 1h45m — now reports
    // the correct `1h 45m`.
    expect(formatRelativeFuture(1 * HOUR + 45 * MIN)).toBe("1h 45m");
    expect(formatRelativeFuture(4 * HOUR + 30 * MIN)).toBe("4h 30m");
    expect(formatRelativeFuture(23 * HOUR + 59 * MIN)).toBe("23h 59m");
  });
});

describe("formatRelativeFuture — <7d with sub-day precision", () => {
  it("whole-day deltas render without the `h` suffix", () => {
    expect(formatRelativeFuture(1 * DAY)).toBe("1d");
    expect(formatRelativeFuture(3 * DAY)).toBe("3d");
    expect(formatRelativeFuture(6 * DAY)).toBe("6d");
  });

  it("non-whole-day deltas render `Nd Nh`", () => {
    expect(formatRelativeFuture(1 * DAY + 6 * HOUR)).toBe("1d 6h");
    expect(formatRelativeFuture(3 * DAY + 12 * HOUR)).toBe("3d 12h");
    expect(formatRelativeFuture(6 * DAY + 23 * HOUR)).toBe("6d 23h");
  });
});

describe("formatRelativeFuture — ≥7d coarse-only", () => {
  it("7+ days drops the hours suffix (cosmetic noise at that scale)", () => {
    expect(formatRelativeFuture(7 * DAY)).toBe("7d");
    expect(formatRelativeFuture(7 * DAY + 5 * HOUR)).toBe("7d");
    expect(formatRelativeFuture(30 * DAY + 12 * HOUR)).toBe("30d");
  });
});
