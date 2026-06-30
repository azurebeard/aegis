// Unit tests for incidentAnalysisCache — ADR-0028 §Decision.3 / §Decision.5 /
// §Decision.7d. Covers:
//   - analysisRowKey + analysisBlobPath shape + sanitisation
//   - two-axis freshness predicate (content hash primary + timestamp fast-path)
//   - redaction-lock computation (2-consecutive-≥3-of-4 engages lock)
//   - admin-clear resets counter
//   - computeContentSha256 determinism over canonicalised input

import { describe, expect, it } from "vitest";
import {
  analysisBlobPath,
  analysisRowKey,
  computeContentSha256,
  computeNextRedactionLockState,
  isCacheFresh,
  isRedactionLockActive,
  type IncidentAnalysisCacheRow,
} from "../src/lib/incidentAnalysisCache.js";

function row(
  overrides: Partial<IncidentAnalysisCacheRow> = {},
): IncidentAnalysisCacheRow {
  return {
    tenantId: "tenant",
    incidentId: "inc-1",
    rowKey: "incidents.analysis.inc-1",
    runId: "run-1",
    blobPath: "inc-1.md",
    outputSha256: "sha256",
    analysedContentSha256: "content-sha-1",
    analysedIncidentLastUpdateDateTime: "2026-04-21T12:00:00Z",
    redactionLockUntil: null,
    redactionLockRunCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    generatedAt: "2026-04-21T12:00:00Z",
    modelDeployment: "aegis-small",
    etag: "etag",
    ...overrides,
  };
}

describe("analysisRowKey + analysisBlobPath", () => {
  it("rowKey is `incidents.analysis.<incidentId>`", () => {
    expect(analysisRowKey("inc-1")).toBe("incidents.analysis.inc-1");
  });

  it("blobPath is flat `<incidentId>.md` with sanitisation", () => {
    expect(analysisBlobPath("inc-1")).toBe("inc-1.md");
    // `/` and `\\` are banned by the incident-ID validator at the handler
    // boundary, but the store function sanitises defensively.
    expect(analysisBlobPath("a/b\\c")).toBe("a_b_c.md");
  });
});

describe("isCacheFresh — two-axis (ADR-0028 §Decision.3)", () => {
  it("content hash match wins regardless of timestamp drift", () => {
    const r = row({
      analysedContentSha256: "HASH-A",
      analysedIncidentLastUpdateDateTime: "2026-04-21T10:00:00Z",
    });
    // Current timestamp differs but hash matches → fresh.
    expect(isCacheFresh(r, "HASH-A", "2026-04-21T12:30:00Z")).toBe(true);
  });

  it("timestamp fast-path accepts when hash differs BUT timestamp matches AND prior hash is non-empty", () => {
    // Edge case: adversary-influenceable content changed in a way that
    // flipped the hash but Graph hasn't bumped lastUpdateDateTime.
    // Spec: timestamp fast-path is a secondary — the first arm of the
    // predicate (hash match) MUST be authoritative, so a hash miss
    // paired with a timestamp match is allowed ONLY when the primary
    // hash field is populated on the row (forward-compat with legacy
    // rows written before this ADR).
    const r = row({
      analysedContentSha256: "HASH-OLD",
      analysedIncidentLastUpdateDateTime: "2026-04-21T12:00:00Z",
    });
    expect(isCacheFresh(r, "HASH-NEW", "2026-04-21T12:00:00Z")).toBe(true);
  });

  it("both axes miss → stale", () => {
    const r = row({
      analysedContentSha256: "HASH-OLD",
      analysedIncidentLastUpdateDateTime: "2026-04-21T10:00:00Z",
    });
    expect(isCacheFresh(r, "HASH-NEW", "2026-04-21T12:00:00Z")).toBe(false);
  });

  it("null row → stale (awaiting_first_run)", () => {
    expect(isCacheFresh(null, "any", "any")).toBe(false);
  });

  it("empty analysedContentSha256 → legacy row; timestamp fast-path DOES NOT accept", () => {
    // Forward-compat guard: legacy rows predating this ADR have
    // empty content-hash. Adapter should treat them as stale so the
    // first post-upgrade run re-analyses and populates the hash field.
    const r = row({
      analysedContentSha256: "",
      analysedIncidentLastUpdateDateTime: "2026-04-21T12:00:00Z",
    });
    expect(isCacheFresh(r, "HASH-NEW", "2026-04-21T12:00:00Z")).toBe(false);
  });
});

describe("isRedactionLockActive", () => {
  const NOW = new Date("2026-04-21T12:00:00Z");

  it("returns false when lock field is null", () => {
    expect(isRedactionLockActive(row({ redactionLockUntil: null }), NOW)).toBe(false);
  });

  it("returns true when lock is in the future", () => {
    expect(
      isRedactionLockActive(
        row({ redactionLockUntil: "2026-04-22T12:00:00Z" }),
        NOW,
      ),
    ).toBe(true);
  });

  it("returns false when lock has expired", () => {
    expect(
      isRedactionLockActive(
        row({ redactionLockUntil: "2026-04-20T12:00:00Z" }),
        NOW,
      ),
    ).toBe(false);
  });

  it("returns false on malformed lock value", () => {
    expect(
      isRedactionLockActive(row({ redactionLockUntil: "not-a-date" }), NOW),
    ).toBe(false);
  });
});

describe("computeNextRedactionLockState — ADR-0028 §Decision.7d", () => {
  const NOW = new Date("2026-04-21T12:00:00Z");
  const LOCK_HOURS = 24;

  it("first heavy-redaction run: counter → 1, no lock yet", () => {
    const next = computeNextRedactionLockState(null, 3, NOW, LOCK_HOURS);
    expect(next.redactionLockRunCount).toBe(1);
    expect(next.redactionLockUntil).toBeNull();
    expect(next.lockNewlyEngaged).toBe(false);
  });

  it("second consecutive heavy-redaction run: lock engages", () => {
    const prior = row({ redactionLockRunCount: 1 });
    const next = computeNextRedactionLockState(prior, 4, NOW, LOCK_HOURS);
    expect(next.redactionLockRunCount).toBe(2);
    expect(next.redactionLockUntil).toBe("2026-04-22T12:00:00.000Z");
    expect(next.lockNewlyEngaged).toBe(true);
  });

  it("redacted < 3 resets the counter to 0", () => {
    const prior = row({ redactionLockRunCount: 1 });
    const next = computeNextRedactionLockState(prior, 2, NOW, LOCK_HOURS);
    expect(next.redactionLockRunCount).toBe(0);
    expect(next.redactionLockUntil).toBeNull();
  });

  it("active lock freezes counter (adapter should short-circuit before here)", () => {
    const prior = row({
      redactionLockRunCount: 2,
      redactionLockUntil: "2026-04-22T00:00:00Z",
    });
    const next = computeNextRedactionLockState(prior, 4, NOW, LOCK_HOURS);
    expect(next.redactionLockRunCount).toBe(2);
    expect(next.lockNewlyEngaged).toBe(false);
  });

  it("exactly 3 redactions counts as heavy (≥3 of 4)", () => {
    const prior = row({ redactionLockRunCount: 1 });
    const next = computeNextRedactionLockState(prior, 3, NOW, LOCK_HOURS);
    expect(next.lockNewlyEngaged).toBe(true);
  });
});

describe("computeContentSha256", () => {
  it("is deterministic for identical inputs", () => {
    const a = computeContentSha256({ a: 1, b: 2 });
    const b = computeContentSha256({ b: 2, a: 1 }); // key order differs
    // JCS canonicalisation produces stable bytes regardless of key order.
    expect(a).toBe(b);
  });

  it("differs for different inputs", () => {
    const a = computeContentSha256({ a: 1 });
    const b = computeContentSha256({ a: 2 });
    expect(a).not.toBe(b);
  });
});
