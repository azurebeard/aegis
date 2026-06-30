import { describe, it, expect } from "vitest";
import {
  deriveIncidentsBadge,
  formatRelative,
  STALE_AFTER_MS,
  VERY_STALE_AFTER_MS,
} from "@/features/incidents/freshness";

const NOW = Date.UTC(2026, 3, 18, 12, 0, 0); // 2026-04-18T12:00:00Z

describe("deriveIncidentsBadge", () => {
  it("returns null for healthy + fresh (no badge)", () => {
    const out = deriveIncidentsBadge({
      healthStatus: "healthy",
      ingestedAt: new Date(NOW - 5 * 60_000).toISOString(),
      nowMs: NOW,
    });
    expect(out).toBeNull();
  });

  it("returns stale when older than STALE_AFTER_MS but under VERY_STALE", () => {
    const out = deriveIncidentsBadge({
      healthStatus: "healthy",
      ingestedAt: new Date(NOW - STALE_AFTER_MS - 60_000).toISOString(),
      nowMs: NOW,
    });
    expect(out?.state).toBe("stale");
  });

  it("returns very_stale when older than VERY_STALE_AFTER_MS", () => {
    const out = deriveIncidentsBadge({
      healthStatus: "healthy",
      ingestedAt: new Date(NOW - VERY_STALE_AFTER_MS - 60_000).toISOString(),
      nowMs: NOW,
    });
    expect(out?.state).toBe("very_stale");
  });

  it("server failing always wins precedence over staleness", () => {
    const out = deriveIncidentsBadge({
      healthStatus: "failing",
      ingestedAt: new Date(NOW - 60_000).toISOString(),
      nowMs: NOW,
    });
    expect(out?.state).toBe("failing");
    expect(out?.tone).toBe("danger");
  });

  it("server degrading wins over client-derived staleness", () => {
    const out = deriveIncidentsBadge({
      healthStatus: "degrading",
      ingestedAt: new Date(NOW - 60_000).toISOString(),
      nowMs: NOW,
    });
    expect(out?.state).toBe("degrading");
    expect(out?.tone).toBe("warning");
  });

  it("returns awaiting_first_run for the special health status", () => {
    const out = deriveIncidentsBadge({
      healthStatus: "awaiting_first_run",
      ingestedAt: null,
      nowMs: NOW,
    });
    expect(out?.state).toBe("awaiting_first_run");
  });

  it("returns no_data for the no-rows-in-store case", () => {
    const out = deriveIncidentsBadge({
      healthStatus: "no_data",
      ingestedAt: null,
      nowMs: NOW,
    });
    expect(out?.state).toBe("no_data");
  });

  it("returns null when ingestedAt is malformed (defensive — server ensures ISO8601)", () => {
    expect(
      deriveIncidentsBadge({
        healthStatus: "healthy",
        ingestedAt: "not-iso",
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});

describe("formatRelative", () => {
  it("returns 'never' for null", () => {
    expect(formatRelative(null, NOW)).toBe("never");
  });

  it("returns 'just now' for < 1 minute delta", () => {
    expect(formatRelative(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
  });

  it("returns minutes for < 1 hour delta", () => {
    expect(formatRelative(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
  });

  it("returns hours for < 48 hours delta", () => {
    expect(formatRelative(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h ago");
  });

  it("returns days for >= 48 hours delta", () => {
    expect(formatRelative(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe("3d ago");
  });
});
