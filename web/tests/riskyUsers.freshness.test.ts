import { describe, it, expect } from "vitest";
import {
  deriveRiskyUsersBadge,
  formatRelative,
  STALE_AFTER_MS,
  VERY_STALE_AFTER_MS,
} from "@/features/risky-users/freshness";

const NOW = Date.UTC(2026, 3, 19, 12, 0, 0);

describe("deriveRiskyUsersBadge", () => {
  it("returns null for healthy + fresh", () => {
    expect(
      deriveRiskyUsersBadge({
        healthStatus: "healthy",
        ingestedAt: new Date(NOW - 60 * 60_000).toISOString(),
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("returns stale when older than STALE_AFTER_MS", () => {
    const out = deriveRiskyUsersBadge({
      healthStatus: "healthy",
      ingestedAt: new Date(NOW - STALE_AFTER_MS - 60_000).toISOString(),
      nowMs: NOW,
    });
    expect(out?.state).toBe("stale");
  });

  it("returns very_stale when older than VERY_STALE_AFTER_MS", () => {
    const out = deriveRiskyUsersBadge({
      healthStatus: "healthy",
      ingestedAt: new Date(NOW - VERY_STALE_AFTER_MS - 60_000).toISOString(),
      nowMs: NOW,
    });
    expect(out?.state).toBe("very_stale");
  });

  it("returns licence_required with informative tone", () => {
    const out = deriveRiskyUsersBadge({
      healthStatus: "licence_required",
      ingestedAt: null,
      nowMs: NOW,
    });
    expect(out?.state).toBe("licence_required");
    expect(out?.tone).toBe("informative");
  });

  it("failing wins over stale", () => {
    const out = deriveRiskyUsersBadge({
      healthStatus: "failing",
      ingestedAt: new Date(NOW - 60_000).toISOString(),
      nowMs: NOW,
    });
    expect(out?.state).toBe("failing");
    expect(out?.tone).toBe("danger");
  });

  it("returns awaiting_first_run for the first-run status", () => {
    const out = deriveRiskyUsersBadge({
      healthStatus: "awaiting_first_run",
      ingestedAt: null,
      nowMs: NOW,
    });
    expect(out?.state).toBe("awaiting_first_run");
  });
});

describe("formatRelative", () => {
  it("returns 'never' for null", () => {
    expect(formatRelative(null, NOW)).toBe("never");
  });

  it("returns minutes for < 1 hour delta", () => {
    expect(formatRelative(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
  });

  it("returns hours for < 48 hours delta", () => {
    expect(formatRelative(new Date(NOW - 6 * 3_600_000).toISOString(), NOW)).toBe("6h ago");
  });
});
