import { describe, it, expect } from "vitest";
import {
  applyRetryAfterClamp,
  computeBackoffMs,
  internals,
  shouldUseExponentialBackoff,
} from "../src/lib/graphClient.js";

describe("applyRetryAfterClamp", () => {
  it("returns 0 with no header", () => {
    const r = applyRetryAfterClamp(null, 300_000, 1);
    expect(r.appliedMs).toBe(0);
    expect(r.clamped).toBe(false);
  });

  it("returns 0 for malformed header", () => {
    const r = applyRetryAfterClamp("not-a-number", 300_000, 1);
    expect(r.appliedMs).toBe(0);
  });

  it("honours small Retry-After under the hard cap", () => {
    const r = applyRetryAfterClamp("10", 300_000, 1);
    expect(r.appliedMs).toBe(10_000);
    expect(r.clamped).toBe(false);
  });

  it("clamps to 30 s hard cap", () => {
    const r = applyRetryAfterClamp("3600", 300_000, 1);
    expect(r.appliedMs).toBe(internals.RETRY_AFTER_HARD_CAP_MS);
    expect(r.clamped).toBe(true);
  });

  it("clamps to (leaseWindow - 5 s) when lease is the tightest bound", () => {
    // 20 s lease => cap = 15 s
    const r = applyRetryAfterClamp("25", 20_000, 1);
    expect(r.appliedMs).toBe(15_000);
    expect(r.clamped).toBe(true);
  });

  it("clamps to 0 if lease is already near-exhausted", () => {
    const r = applyRetryAfterClamp("60", 3_000, 1);
    expect(r.appliedMs).toBe(0);
    expect(r.clamped).toBe(true);
  });
});

describe("computeBackoffMs", () => {
  it("is monotonically bounded by the max", () => {
    for (let i = 1; i <= 10; i++) {
      const v = computeBackoffMs(i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(internals.BACKOFF_MAX_MS);
    }
  });
});

describe("shouldUseExponentialBackoff — version-agnostic IdP match (SEC-L-STEP6-CODE-05)", () => {
  it("matches /v1.0/identityProtection/riskyUsers", () => {
    expect(
      shouldUseExponentialBackoff(
        "https://graph.microsoft.com/v1.0/identityProtection/riskyUsers",
      ),
    ).toBe(true);
  });

  it("matches /beta/identityProtection/riskyUsers (beta-parity: Graph bucket is version-agnostic)", () => {
    expect(
      shouldUseExponentialBackoff(
        "https://graph.microsoft.com/beta/identityProtection/riskyUsers",
      ),
    ).toBe(true);
  });

  it("matches /v1.0/riskDetections", () => {
    expect(
      shouldUseExponentialBackoff(
        "https://graph.microsoft.com/v1.0/riskDetections",
      ),
    ).toBe(true);
  });

  it("matches /beta/namedLocations", () => {
    expect(
      shouldUseExponentialBackoff(
        "https://graph.microsoft.com/beta/namedLocations",
      ),
    ).toBe(true);
  });

  it("does NOT match /v1.0/security/incidents (generic backoff)", () => {
    expect(
      shouldUseExponentialBackoff(
        "https://graph.microsoft.com/v1.0/security/incidents",
      ),
    ).toBe(false);
  });

  it("does NOT match /v1.0/security/secureScores", () => {
    expect(
      shouldUseExponentialBackoff(
        "https://graph.microsoft.com/v1.0/security/secureScores",
      ),
    ).toBe(false);
  });

  it("does NOT match /v1.0/organization (licence probe uses directory bucket)", () => {
    expect(
      shouldUseExponentialBackoff(
        "https://graph.microsoft.com/v1.0/organization?$select=assignedPlans",
      ),
    ).toBe(false);
  });
});
