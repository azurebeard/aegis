// Unit tests for the canonical source-key registry (ADR-0020 amendment
// 2026-04-20 + ADR-0027 §Decision.8 + ADR-0028 §Decision.8).

import { describe, it, expect } from "vitest";
import {
  CANONICAL_SOURCE_KEYS,
  MissingSourceKeyContextError,
  isCanonicalSourceKey,
} from "../src/lib/agentSourceKeys.js";

describe("CANONICAL_SOURCE_KEYS — static tuple", () => {
  it("contains the canonical source keys from ADR-0020 amendment + ADR-0027 posture extension", () => {
    // Asserting the exact tuple (not a subset) — a drift in either
    // direction (addition without ADR amendment, or accidental removal)
    // must fail this test loudly. FD-B1-01 (B2 landing): posture-agent
    // added `ingestHealth.secureScore`.
    expect(CANONICAL_SOURCE_KEYS).toEqual([
      "secureScore.latest",
      "secureScore.trend14d",
      "incidents.summary",
      "incidents.highSeverity.active",
      "ingestHealth.all",
      "ingestHealth.secureScore",
      "riskyUsers.summary",
      "riskyUsers.recent",
    ]);
  });

  it("includes posture-agent's per-source IngestHealth key (FD-B1-01 / ADR-0027 §Decision.1)", () => {
    expect(CANONICAL_SOURCE_KEYS).toContain("ingestHealth.secureScore");
  });

  it("uses dotted-namespace convention (lowercase-starting segments)", () => {
    // Dotted-namespace per the 2026-04-20 amendment: <domain>.<facet>, each
    // segment starts lowercase (camelCase permitted within a segment, e.g.
    // `secureScore`, `highSeverity`) and there are at least two segments.
    for (const key of CANONICAL_SOURCE_KEYS) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
      // Belt-and-braces: no key starts with uppercase (catches accidental
      // PascalCase regression per SEC-M-ADR-20-AMEND-01).
      expect(key[0]).toBe(key[0]?.toLowerCase());
    }
  });

  it("has no duplicates", () => {
    const set = new Set(CANONICAL_SOURCE_KEYS);
    expect(set.size).toBe(CANONICAL_SOURCE_KEYS.length);
  });
});

describe("isCanonicalSourceKey — static keys", () => {
  it("accepts every member of CANONICAL_SOURCE_KEYS", () => {
    for (const key of CANONICAL_SOURCE_KEYS) {
      expect(isCanonicalSourceKey(key)).toBe(true);
      expect(isCanonicalSourceKey(key, {})).toBe(true);
      expect(isCanonicalSourceKey(key, { incidentId: "unused" })).toBe(true);
    }
  });

  it("rejects static keys that are not in the tuple", () => {
    expect(isCanonicalSourceKey("unknown.key")).toBe(false);
    expect(isCanonicalSourceKey("secureScore.latest.extra")).toBe(false);
    expect(isCanonicalSourceKey("")).toBe(false);
    // PascalCase variants of canonical keys must not sneak through — the
    // match is exact-string, not case-insensitive.
    expect(isCanonicalSourceKey("SecureScore")).toBe(false);
    expect(isCanonicalSourceKey("Incidents")).toBe(false);
  });
});

describe("isCanonicalSourceKey — dynamic incidents.(summary|detail).<id>", () => {
  const INCIDENT_ID = "abc-123_XYZ";

  it("accepts a dynamic summary key whose suffix matches context.incidentId", () => {
    expect(
      isCanonicalSourceKey(`incidents.summary.${INCIDENT_ID}`, {
        incidentId: INCIDENT_ID,
      }),
    ).toBe(true);
  });

  it("accepts a dynamic detail key whose suffix matches context.incidentId", () => {
    expect(
      isCanonicalSourceKey(`incidents.detail.${INCIDENT_ID}`, {
        incidentId: INCIDENT_ID,
      }),
    ).toBe(true);
  });

  it("rejects a dynamic key whose suffix does NOT match context.incidentId (fabrication attempt)", () => {
    expect(
      isCanonicalSourceKey("incidents.detail.different-id", {
        incidentId: INCIDENT_ID,
      }),
    ).toBe(false);
    expect(
      isCanonicalSourceKey("incidents.summary.different-id", {
        incidentId: INCIDENT_ID,
      }),
    ).toBe(false);
  });

  it("rejects a key that looks incidents-namespaced but doesn't match the dynamic regex", () => {
    // Wrong facet word — only `summary` and `detail` are dynamic facets.
    expect(
      isCanonicalSourceKey("incidents.timeline.abc", { incidentId: "abc" }),
    ).toBe(false);
    // Dots inside the ID part — the ID regex is [A-Za-z0-9_-]+, excluding
    // dots. An ID containing dots is a different-shape key and falls
    // outside the dynamic match entirely.
    expect(
      isCanonicalSourceKey("incidents.detail.ab.cd", { incidentId: "ab.cd" }),
    ).toBe(false);
    // `incidents.summary` + `incidents.highSeverity.active` are static
    // canonical keys — they legitimately accept with any/no context
    // because they're in the exact-match set, separate from the dynamic
    // namespace.
  });

  it("throws MissingSourceKeyContextError when a dynamic key is tested with no context", () => {
    expect(() =>
      isCanonicalSourceKey(`incidents.detail.${INCIDENT_ID}`),
    ).toThrowError(MissingSourceKeyContextError);
    expect(() =>
      isCanonicalSourceKey(`incidents.summary.${INCIDENT_ID}`, {}),
    ).toThrowError(MissingSourceKeyContextError);
    // `context.incidentId` is explicitly undefined — same as missing.
    expect(() =>
      isCanonicalSourceKey(`incidents.detail.${INCIDENT_ID}`, {
        incidentId: undefined,
      }),
    ).toThrowError(MissingSourceKeyContextError);
  });

  it("does NOT throw for non-dynamic-shape keys without context", () => {
    // Calling `isCanonicalSourceKey("unknown.thing")` with no context is
    // a legitimate subset-check call — it should return false cleanly,
    // not throw.
    expect(() => isCanonicalSourceKey("unknown.thing")).not.toThrow();
    expect(isCanonicalSourceKey("unknown.thing")).toBe(false);
    // And a canonical static key without context also does not throw.
    expect(() => isCanonicalSourceKey("secureScore.latest")).not.toThrow();
    expect(isCanonicalSourceKey("secureScore.latest")).toBe(true);
  });
});
