// Unit tests for postureCache.ts pure helpers (ADR-0027 §Decision.5).
// Network-bound writeCache / readCache paths are exercised indirectly via
// the runPostureAgent adapter test; here we focus on freshness + key shape.

import { describe, expect, it } from "vitest";
import {
  classifyFreshness,
  postureBlobPath,
  postureRowKey,
  type PostureCacheRow,
} from "../src/lib/postureCache.js";

function rowAt(generatedAt: string): PostureCacheRow {
  return {
    tenantId: "tenant",
    rowKey: "posture.2026-W16",
    isoWeek: "2026-W16",
    runId: "run-id",
    blobPath: "2026/W16/tenant.md",
    outputSha256: "sha",
    tokensIn: 0,
    tokensOut: 0,
    generatedAt,
    modelDeployment: "aegis-small",
    etag: "etag",
  };
}

describe("postureRowKey", () => {
  it("produces `posture.<yyyy-Www>`", () => {
    expect(postureRowKey("2026-W16")).toBe("posture.2026-W16");
    expect(postureRowKey("1999-W52")).toBe("posture.1999-W52");
  });
});

describe("postureBlobPath", () => {
  it("produces `${yyyy}/${Www}/${tenantId}.md`", () => {
    expect(postureBlobPath("2026-W16", "tenant-guid")).toBe("2026/W16/tenant-guid.md");
  });

  it("sanitises tenantId against path-traversal characters", () => {
    expect(postureBlobPath("2026-W16", "a/b\\c..d")).toBe("2026/W16/a_b_c..d.md");
  });

  it("rejects malformed isoWeek", () => {
    expect(() => postureBlobPath("not-a-week", "t")).toThrow();
    expect(() => postureBlobPath("", "t")).toThrow();
  });
});

describe("classifyFreshness (ADR-0027 §Decision.5 — DAYS, not hours)", () => {
  const NOW = new Date("2026-04-20T12:00:00Z");

  it("returns missing when row is null", () => {
    expect(classifyFreshness(null, NOW, 7, 14)).toBe("missing");
  });

  it("returns fresh for a row generated < freshDays ago", () => {
    const row = rowAt("2026-04-17T00:00:00Z"); // ~3.5d ago
    expect(classifyFreshness(row, NOW, 7, 14)).toBe("fresh");
  });

  it("returns stale_serviceable between freshDays and ceilingDays", () => {
    const row = rowAt("2026-04-10T00:00:00Z"); // ~10.5d ago
    expect(classifyFreshness(row, NOW, 7, 14)).toBe("stale_serviceable");
  });

  it("returns stale_unservable past ceilingDays", () => {
    const row = rowAt("2026-04-01T00:00:00Z"); // ~19.5d ago
    expect(classifyFreshness(row, NOW, 7, 14)).toBe("stale_unservable");
  });

  it("returns stale_unservable when generatedAt is unparseable", () => {
    const row = rowAt("not-a-date");
    expect(classifyFreshness(row, NOW, 7, 14)).toBe("stale_unservable");
  });
});
