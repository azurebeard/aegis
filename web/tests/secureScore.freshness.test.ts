import { describe, it, expect } from "vitest";
import {
  deriveBadge,
  formatRelative,
  STALE_AFTER_MS,
  VERY_STALE_AFTER_MS,
} from "@/features/secureScore/freshness";

const now = Date.UTC(2026, 3, 19, 12, 0, 0); // 2026-04-19T12:00:00Z

describe("deriveBadge", () => {
  it("returns null when healthy and fresh", () => {
    expect(
      deriveBadge({
        healthStatus: "healthy",
        ingestedAt: new Date(now - 60_000).toISOString(),
        nowMs: now,
      }),
    ).toBeNull();
  });

  it("emits Stale after 36h", () => {
    const b = deriveBadge({
      healthStatus: "healthy",
      ingestedAt: new Date(now - STALE_AFTER_MS - 1).toISOString(),
      nowMs: now,
    });
    expect(b?.state).toBe("stale");
    expect(b?.tone).toBe("warning");
  });

  it("emits Very stale after 72h", () => {
    const b = deriveBadge({
      healthStatus: "healthy",
      ingestedAt: new Date(now - VERY_STALE_AFTER_MS - 1).toISOString(),
      nowMs: now,
    });
    expect(b?.state).toBe("very_stale");
  });

  it("prioritises server failing status over client-derived freshness", () => {
    const b = deriveBadge({
      healthStatus: "failing",
      ingestedAt: new Date(now - 60_000).toISOString(),
      nowMs: now,
    });
    expect(b?.state).toBe("failing");
    expect(b?.tone).toBe("danger");
  });

  it("prioritises server degrading status", () => {
    const b = deriveBadge({
      healthStatus: "degrading",
      ingestedAt: new Date(now - 60_000).toISOString(),
      nowMs: now,
    });
    expect(b?.state).toBe("degrading");
  });

  it("returns awaiting_first_run badge when the status indicates so", () => {
    const b = deriveBadge({ healthStatus: "awaiting_first_run", ingestedAt: null, nowMs: now });
    expect(b?.state).toBe("awaiting_first_run");
    expect(b?.tone).toBe("informative");
  });

  it("handles missing or malformed ingestedAt for healthy status", () => {
    expect(deriveBadge({ healthStatus: "healthy", ingestedAt: null, nowMs: now })).toBeNull();
    expect(deriveBadge({ healthStatus: "healthy", ingestedAt: "nope", nowMs: now })).toBeNull();
  });
});

describe("formatRelative", () => {
  it("returns 'never' for null", () => {
    expect(formatRelative(null, now)).toBe("never");
  });
  it("formats hours and days", () => {
    expect(formatRelative(new Date(now - 30_000).toISOString(), now)).toBe("just now");
    expect(formatRelative(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
    expect(formatRelative(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h ago");
    expect(formatRelative(new Date(now - 72 * 3_600_000).toISOString(), now)).toBe("3d ago");
  });
});
