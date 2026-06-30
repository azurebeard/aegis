// §10.58 INFO-2 — freshness-rollup registry invariants.
//
// Pre-§10.58 the dashboard's "every tile is at least this fresh" headline
// hand-listed 4 of the 11 tiles' freshness paths; the verticals shipped
// after (KEV, userDormancy, signIns, conditionalAccess, azureSecureScore)
// were silently missing for weeks until the original §10.58 fix added
// them. This invariant test prevents a recurrence: any new TileKey in
// `TILE_KEYS` MUST appear in `FRESHNESS_REGISTRY` with an explicit
// `included` vs `excluded` declaration. A future tile that lands without
// a registry entry fails the type compile (`Record<TileKey, …>`) AND
// this test at PR time.
//
// `excluded` entries must carry a non-empty `reason` so the omission is
// a deliberate, reviewable choice rather than a forgetfulness bug.

import { describe, expect, it } from "vitest";
import { FRESHNESS_REGISTRY } from "@/features/common/DashboardFreshness";
import { TILE_KEYS } from "@/features/settings/types";

describe("FRESHNESS_REGISTRY (§10.58 INFO-2)", () => {
  it("has an entry for every TileKey", () => {
    for (const k of TILE_KEYS) {
      expect(
        FRESHNESS_REGISTRY[k],
        `TileKey '${k}' is missing from FRESHNESS_REGISTRY — add an 'included' or 'excluded' entry`,
      ).toBeDefined();
    }
  });

  it("contains no extra entries beyond TILE_KEYS (stale-key drift guard)", () => {
    const registered = Object.keys(FRESHNESS_REGISTRY);
    for (const k of registered) {
      expect(
        TILE_KEYS.includes(k as (typeof TILE_KEYS)[number]),
        `FRESHNESS_REGISTRY has stale key '${k}' that's not in TILE_KEYS`,
      ).toBe(true);
    }
  });

  for (const k of TILE_KEYS) {
    it(`'${k}' is well-formed (included path OR excluded reason)`, () => {
      const entry = FRESHNESS_REGISTRY[k];
      if (entry.kind === "included") {
        expect(entry.path.length, `'${k}' included entry has empty path`).toBeGreaterThan(0);
        expect(entry.path).toMatch(/^data\./);
      } else {
        expect(
          entry.reason.length,
          `'${k}' excluded entry has empty reason — explain why so future reviewers don't re-include silently`,
        ).toBeGreaterThan(0);
      }
    });
  }

  it("has at least 8 included surfaces (sanity — the headline must reflect most tiles)", () => {
    const included = TILE_KEYS.filter((k) => FRESHNESS_REGISTRY[k].kind === "included");
    expect(included.length).toBeGreaterThanOrEqual(8);
  });
});
