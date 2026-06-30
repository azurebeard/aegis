import { describe, it, expect } from "vitest";
import {
  ADMIN_RUN_DAILY_CEILING,
  entraRiskAdminRunRateLimiter,
  incidentsAdminRunRateLimiter,
  reportEmailAutoCaptureRateLimiter,
  reportEmailDeleteRateLimiter,
  reportEmailSendRateLimiter,
  secureScoreAdminRunRateLimiter,
  SlidingWindowRateLimiter,
} from "../src/lib/rateLimit.js";

describe("SlidingWindowRateLimiter", () => {
  it("allows up to the limit and blocks the N+1th", () => {
    const l = new SlidingWindowRateLimiter(3, 10_000);
    const now = 1_000_000;
    expect(l.check("k", now).allowed).toBe(true);
    expect(l.check("k", now).allowed).toBe(true);
    expect(l.check("k", now).allowed).toBe(true);
    const denied = l.check("k", now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it("tracks per-key independently", () => {
    const l = new SlidingWindowRateLimiter(2, 10_000);
    const now = 1_000_000;
    expect(l.check("a", now).allowed).toBe(true);
    expect(l.check("a", now).allowed).toBe(true);
    expect(l.check("a", now).allowed).toBe(false);
    expect(l.check("b", now).allowed).toBe(true);
  });

  it("recovers once the oldest timestamp falls out of the window", () => {
    const l = new SlidingWindowRateLimiter(2, 1_000);
    const t0 = 0;
    expect(l.check("k", t0).allowed).toBe(true);
    expect(l.check("k", t0 + 500).allowed).toBe(true);
    expect(l.check("k", t0 + 750).allowed).toBe(false);
    expect(l.check("k", t0 + 1_500).allowed).toBe(true); // first slot is now >1s old
  });
});

// WS10 SEC-L-UI-POLISH-03 — pin the cross-vertical admin-run parity. The
// three admin-run limiters share the same 30/day per-tenant ceiling so a
// misbehaving Refresh-now button can't burn Graph quota faster on one
// vertical than another. Drift here would mean either a forgotten new
// vertical (parity break) or a silent ceiling change.
describe("admin-run rate-limiter parity (WS10 SEC-L-UI-POLISH-03)", () => {
  it("exports a 30/day ceiling matching the cross-vertical contract", () => {
    expect(ADMIN_RUN_DAILY_CEILING).toBe(30);
  });

  for (const [name, limiter] of [
    ["entraRiskAdminRunRateLimiter", entraRiskAdminRunRateLimiter],
    ["secureScoreAdminRunRateLimiter", secureScoreAdminRunRateLimiter],
    ["incidentsAdminRunRateLimiter", incidentsAdminRunRateLimiter],
  ] as const) {
    it(`${name} blocks the 31st call within a 24h window`, () => {
      // Use a unique tenant key per limiter — the limiters are module-level
      // singletons so tests need to be isolated by key rather than instance.
      const tenant = `t-${name}`;
      const t0 = Date.parse("2026-04-27T00:00:00Z");
      for (let i = 0; i < ADMIN_RUN_DAILY_CEILING; i++) {
        expect(limiter.check(tenant, t0 + i * 1_000).allowed).toBe(true);
      }
      const denied = limiter.check(tenant, t0 + ADMIN_RUN_DAILY_CEILING * 1_000);
      expect(denied.allowed).toBe(false);
      // Retry-after must point inside the next 24h window.
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(24 * 60 * 60_000);
    });

    it(`${name} keys per-tenant — one tenant's exhaustion does not starve another`, () => {
      const t0 = Date.parse("2026-04-27T01:00:00Z");
      const a = `a-${name}`;
      const b = `b-${name}`;
      for (let i = 0; i < ADMIN_RUN_DAILY_CEILING; i++) {
        limiter.check(a, t0 + i * 1_000);
      }
      expect(limiter.check(a, t0 + ADMIN_RUN_DAILY_CEILING * 1_000).allowed).toBe(false);
      expect(limiter.check(b, t0 + ADMIN_RUN_DAILY_CEILING * 1_000).allowed).toBe(true);
    });
  }
});

// ADR-0030 Phase C — per-admin DELETE rate-limit on the report email send
// erasure endpoint (WS10 Slice 1(c)/B3). 30/day per admin (principal-keyed)
// to bound the audit/telemetry surface that a scripted DELETE loop would
// otherwise flood.
describe("reportEmailDeleteRateLimiter (WS10 Slice 1(c)/B3 — per-admin)", () => {
  it("blocks the 31st DELETE within a 24h window", () => {
    const principal = "admin-A-delete-cap";
    const t0 = Date.parse("2026-05-21T00:00:00Z");
    for (let i = 0; i < ADMIN_RUN_DAILY_CEILING; i++) {
      expect(reportEmailDeleteRateLimiter.check(principal, t0 + i * 1_000).allowed).toBe(true);
    }
    const denied = reportEmailDeleteRateLimiter.check(
      principal,
      t0 + ADMIN_RUN_DAILY_CEILING * 1_000,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("keys per-principal — one admin's exhaustion does not starve another", () => {
    const t0 = Date.parse("2026-05-21T01:00:00Z");
    const a = "admin-A-isolation";
    const b = "admin-B-isolation";
    for (let i = 0; i < ADMIN_RUN_DAILY_CEILING; i++) {
      reportEmailDeleteRateLimiter.check(a, t0 + i * 1_000);
    }
    expect(reportEmailDeleteRateLimiter.check(a, t0 + ADMIN_RUN_DAILY_CEILING * 1_000).allowed).toBe(
      false,
    );
    expect(reportEmailDeleteRateLimiter.check(b, t0 + ADMIN_RUN_DAILY_CEILING * 1_000).allowed).toBe(
      true,
    );
  });

  it("auto-capture sub-budget is a different bucket from send (5/24h vs 10/24h)", () => {
    const t0 = Date.parse("2026-05-21T03:00:00Z");
    const tenant = "auto-capture-isolation";
    // Consume the auto-capture sub-budget in full (5/day).
    for (let i = 0; i < 5; i++) {
      expect(
        reportEmailAutoCaptureRateLimiter.check(tenant, t0 + i * 1_000).allowed,
      ).toBe(true);
    }
    const denied = reportEmailAutoCaptureRateLimiter.check(tenant, t0 + 5 * 1_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // The send limiter is independent — sending a previously-captured period
    // must still succeed.
    expect(reportEmailSendRateLimiter.check(tenant, t0 + 5 * 1_000).allowed).toBe(true);
  });

  it("is a different bucket from reportEmailSendRateLimiter — exhausting one does not starve the other", () => {
    const t0 = Date.parse("2026-05-21T02:00:00Z");
    // The send limiter is per-TENANT (10/day), the delete limiter is
    // per-PRINCIPAL (30/day). Even with same string used as the key, the
    // bucket independence MUST hold or a tenant could exhaust both with
    // one stream of requests.
    const key = "shared-key-bucket-isolation";
    for (let i = 0; i < 10; i++) {
      expect(reportEmailSendRateLimiter.check(key, t0 + i * 1_000).allowed).toBe(true);
    }
    expect(reportEmailSendRateLimiter.check(key, t0 + 10 * 1_000).allowed).toBe(false);
    // Delete bucket is untouched.
    expect(
      reportEmailDeleteRateLimiter.check(key, t0 + 10 * 1_000).allowed,
    ).toBe(true);
  });
});
