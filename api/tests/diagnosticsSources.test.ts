// Tests for the diagnostics-source registry — the single source of truth
// that the run-history handler + the new GET /ingest-sources endpoint
// both consume.

import { describe, expect, it } from "vitest";
import {
  auditSourceForKey,
  DIAGNOSTICS_SOURCES,
  isDiagnosticsSourceKey,
  toPublicSources,
} from "../src/lib/diagnosticsSources.js";
import { ALL_INGEST_SOURCES } from "../src/lib/ingestSources.js";

describe("DIAGNOSTICS_SOURCES — registry shape", () => {
  it("has at least one entry", () => {
    expect(DIAGNOSTICS_SOURCES.length).toBeGreaterThan(0);
  });

  it("every key is a non-empty URL-segment-safe string", () => {
    for (const s of DIAGNOSTICS_SOURCES) {
      expect(s.key).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("no duplicate URL-segment keys", () => {
    const keys = DIAGNOSTICS_SOURCES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("no duplicate audit-chain source strings", () => {
    const sources = DIAGNOSTICS_SOURCES.map((s) => s.auditSource);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("every entry has a non-empty label, iconName, description", () => {
    for (const s of DIAGNOSTICS_SOURCES) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.iconName.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it("every auditSource is registered in ingestSources.ts (no drift)", () => {
    const known = new Set<string>(ALL_INGEST_SOURCES);
    for (const s of DIAGNOSTICS_SOURCES) {
      expect(
        known.has(s.auditSource),
        `${s.key} → ${s.auditSource} not in ALL_INGEST_SOURCES`,
      ).toBe(true);
    }
  });
});

describe("isDiagnosticsSourceKey + auditSourceForKey", () => {
  it("recognises every registered key", () => {
    for (const s of DIAGNOSTICS_SOURCES) {
      expect(isDiagnosticsSourceKey(s.key)).toBe(true);
      expect(auditSourceForKey(s.key)).toBe(s.auditSource);
    }
  });

  it("rejects unknown / hostile / empty values", () => {
    for (const bad of [
      "",
      "unknown-source",
      "../etc/passwd",
      "secure-score/x",
      "SECURE-SCORE",
      "secure_score",
    ]) {
      expect(isDiagnosticsSourceKey(bad)).toBe(false);
      expect(auditSourceForKey(bad)).toBeNull();
    }
  });
});

describe("toPublicSources", () => {
  it("returns one entry per registered source", () => {
    expect(toPublicSources()).toHaveLength(DIAGNOSTICS_SOURCES.length);
  });

  it("strips the auditSource (server-internal)", () => {
    for (const s of toPublicSources()) {
      expect("auditSource" in s).toBe(false);
    }
  });

  it("preserves key + label + iconName + description verbatim", () => {
    const pub = toPublicSources();
    for (let i = 0; i < pub.length; i++) {
      const src = DIAGNOSTICS_SOURCES[i]!;
      expect(pub[i]).toEqual({
        key: src.key,
        label: src.label,
        iconName: src.iconName,
        description: src.description,
      });
    }
  });
});
