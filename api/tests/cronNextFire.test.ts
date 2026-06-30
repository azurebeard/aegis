// Unit tests for cronNextFire — B4 Timer ETA badge calculator. Covers
// the two cron shapes the Bicep deploy actually emits, the wraparound
// edge cases (today's fire already past → tomorrow / next-week), and
// the explicit fail-safe (unsupported shape → null).

import { describe, expect, it } from "vitest";
import { nextFireOf } from "../src/lib/cronNextFire.js";

const MON_2026_04_20_T_0500 = new Date("2026-04-20T05:00:00Z"); // Monday 05:00 UTC

describe("nextFireOf — daily cron `0 0 5 * * *`", () => {
  const cron = "0 0 5 * * *";

  it("returns today 05:00 when called BEFORE today's fire", () => {
    const before = new Date("2026-04-20T04:00:00Z");
    const r = nextFireOf(cron, before);
    expect(r?.cadence).toBe("daily");
    expect(r?.nextFireAt).toBe("2026-04-20T05:00:00.000Z");
  });

  it("returns tomorrow 05:00 when called AT or AFTER today's fire", () => {
    const after = new Date("2026-04-20T05:00:01Z");
    const r = nextFireOf(cron, after);
    expect(r?.nextFireAt).toBe("2026-04-21T05:00:00.000Z");
  });

  it("rolls into the next month correctly", () => {
    const lastDay = new Date("2026-04-30T05:30:00Z");
    const r = nextFireOf(cron, lastDay);
    expect(r?.nextFireAt).toBe("2026-05-01T05:00:00.000Z");
  });

  it("rolls into the next year correctly", () => {
    const yearEnd = new Date("2026-12-31T23:30:00Z");
    const r = nextFireOf(cron, yearEnd);
    expect(r?.nextFireAt).toBe("2027-01-01T05:00:00.000Z");
  });
});

describe("nextFireOf — weekly cron `0 0 6 * * 1` (Mondays 06:00)", () => {
  const cron = "0 0 6 * * 1";

  it("returns today 06:00 when called BEFORE the fire on a Monday", () => {
    // 2026-04-20 is a Monday.
    const before = new Date("2026-04-20T05:30:00Z");
    const r = nextFireOf(cron, before);
    expect(r?.cadence).toBe("weekly");
    expect(r?.nextFireAt).toBe("2026-04-20T06:00:00.000Z");
  });

  it("returns next Monday when called AFTER Monday's fire", () => {
    const after = new Date("2026-04-20T07:00:00Z");
    const r = nextFireOf(cron, after);
    expect(r?.nextFireAt).toBe("2026-04-27T06:00:00.000Z");
  });

  it("returns the upcoming Monday when called on a Tuesday", () => {
    // 2026-04-21 is a Tuesday.
    const tue = new Date("2026-04-21T12:00:00Z");
    const r = nextFireOf(cron, tue);
    expect(r?.nextFireAt).toBe("2026-04-27T06:00:00.000Z");
  });

  it("returns the upcoming Monday when called on a Sunday", () => {
    // 2026-04-26 is a Sunday.
    const sun = new Date("2026-04-26T22:00:00Z");
    const r = nextFireOf(cron, sun);
    expect(r?.nextFireAt).toBe("2026-04-27T06:00:00.000Z");
  });

  it("crosses a month boundary correctly", () => {
    // 2026-04-29 is a Wednesday → next Monday = 2026-05-04.
    const wed = new Date("2026-04-29T08:00:00Z");
    const r = nextFireOf(cron, wed);
    expect(r?.nextFireAt).toBe("2026-05-04T06:00:00.000Z");
  });
});

describe("nextFireOf — fail-safe on unsupported shapes", () => {
  it("returns null on a 5-field cron", () => {
    expect(nextFireOf("0 5 * * *", MON_2026_04_20_T_0500)).toBeNull();
  });

  it("returns null on day-of-month restriction", () => {
    expect(nextFireOf("0 0 5 15 * *", MON_2026_04_20_T_0500)).toBeNull();
  });

  it("returns null on month restriction", () => {
    expect(nextFireOf("0 0 5 * 6 *", MON_2026_04_20_T_0500)).toBeNull();
  });

  it("returns null on a step value", () => {
    expect(nextFireOf("0 0 */4 * * *", MON_2026_04_20_T_0500)).toBeNull();
  });

  it("returns null on a list", () => {
    expect(nextFireOf("0 0 5,17 * * *", MON_2026_04_20_T_0500)).toBeNull();
  });

  it("returns null on a range", () => {
    expect(nextFireOf("0 0 5-7 * * *", MON_2026_04_20_T_0500)).toBeNull();
  });

  it("returns null on a day-of-week outside [0, 6]", () => {
    expect(nextFireOf("0 0 5 * * 7", MON_2026_04_20_T_0500)).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(nextFireOf("not a cron", MON_2026_04_20_T_0500)).toBeNull();
    expect(nextFireOf("", MON_2026_04_20_T_0500)).toBeNull();
  });

  it("returns the cron string back on success (so the SPA can label its source)", () => {
    const r = nextFireOf("0 0 5 * * *", MON_2026_04_20_T_0500);
    expect(r?.cron).toBe("0 0 5 * * *");
  });
});
