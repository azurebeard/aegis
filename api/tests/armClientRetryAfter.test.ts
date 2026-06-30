// ADR-0036 L-Q4 follow-track — `parseRetryAfterMs` handles both forms
// of the RFC 9110 §10.2.3 Retry-After header: delta-seconds AND
// HTTP-date (IMF-fixdate / obsolete RFC 850 / asctime).
//
// Pre-this-change the ARM client only handled delta-seconds and fell
// back to exponential backoff on HTTP-date headers — sub-optimal under
// sustained per-subscription throttling where ARM emits the absolute
// timestamp form.

import { describe, expect, it } from "vitest";
import { parseRetryAfterMs } from "../src/lib/armClient.js";

const NOW = Date.parse("2026-05-12T12:00:00Z"); // fixed reference

describe("parseRetryAfterMs (ADR-0036 L-Q4)", () => {
  describe("delta-seconds form", () => {
    it("returns ms for a bare non-negative integer", () => {
      expect(parseRetryAfterMs("120", NOW)).toBe(120_000);
      expect(parseRetryAfterMs("0", NOW)).toBe(0);
      expect(parseRetryAfterMs("3600", NOW)).toBe(3_600_000);
    });

    it("rejects mixed-content like '120abc' (RFC contract)", () => {
      expect(parseRetryAfterMs("120abc", NOW)).toBeNull();
    });

    it("never returns a negative duration for a negative integer header", () => {
      // The strict delta-seconds regex `^\d+$` rejects `-1`. The fall-
      // through path passes it to `Date.parse`, which in some V8 builds
      // resolves to an early-AD instant — well in the past, so the
      // past-clamp returns 0. The invariant the caller relies on is
      // "never a negative number"; the exact null-vs-0 split for malformed
      // input is best-effort.
      const result = parseRetryAfterMs("-1", NOW);
      expect(result === null || result >= 0).toBe(true);
    });
  });

  describe("HTTP-date form", () => {
    it("returns the delta-ms for an IMF-fixdate in the future", () => {
      // 90 seconds after NOW.
      const future = new Date(NOW + 90_000).toUTCString();
      expect(parseRetryAfterMs(future, NOW)).toBe(90_000);
    });

    it("returns 0 for an HTTP-date already in the past", () => {
      const past = new Date(NOW - 60_000).toUTCString();
      expect(parseRetryAfterMs(past, NOW)).toBe(0);
    });

    it("returns null for an unparseable date", () => {
      expect(parseRetryAfterMs("not-a-date", NOW)).toBeNull();
    });

    it("accepts the asctime obsolete form (e.g. `Sun Nov  6 08:49:37 1994`)", () => {
      // Date.parse accepts asctime; the delta will be negative-massive
      // since 1994 is well in the past, so we get 0.
      expect(parseRetryAfterMs("Sun Nov  6 08:49:37 1994", NOW)).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("returns null on null header", () => {
      expect(parseRetryAfterMs(null, NOW)).toBeNull();
    });

    it("returns null on empty string", () => {
      expect(parseRetryAfterMs("", NOW)).toBeNull();
      expect(parseRetryAfterMs("   ", NOW)).toBeNull();
    });

    it("trims whitespace before parsing", () => {
      expect(parseRetryAfterMs("  60  ", NOW)).toBe(60_000);
    });
  });
});
