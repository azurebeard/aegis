// ADR-0030 §3 — config-load floor enforcement.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

beforeEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveReportSnapshotConfig", () => {
  it("returns documented defaults when env vars are absent", async () => {
    const { resolveReportSnapshotConfig } = await import("../src/lib/config.js");
    const config = resolveReportSnapshotConfig();
    expect(config.versionsPerPeriod).toBe(3);
    expect(config.retentionDays).toBe(2555);
    expect(config.source).toBe("report.snapshot");
  });

  it("rejects versions-per-period below floor", async () => {
    const { resolveReportSnapshotConfig, ConfigError } = await import("../src/lib/config.js");
    vi.stubEnv("REPORT_SNAPSHOT_VERSIONS_PER_PERIOD", "2");
    expect(() => resolveReportSnapshotConfig()).toThrow(ConfigError);
    vi.stubEnv("REPORT_SNAPSHOT_VERSIONS_PER_PERIOD", "0");
    expect(() => resolveReportSnapshotConfig()).toThrow(ConfigError);
  });

  it("rejects retention-days below floor", async () => {
    const { resolveReportSnapshotConfig, ConfigError } = await import("../src/lib/config.js");
    vi.stubEnv("REPORT_SNAPSHOT_RETENTION_DAYS", "10");
    expect(() => resolveReportSnapshotConfig()).toThrow(ConfigError);
  });

  it("accepts values at the floor exactly", async () => {
    const { resolveReportSnapshotConfig } = await import("../src/lib/config.js");
    vi.stubEnv("REPORT_SNAPSHOT_VERSIONS_PER_PERIOD", "3");
    vi.stubEnv("REPORT_SNAPSHOT_RETENTION_DAYS", "30");
    const config = resolveReportSnapshotConfig();
    expect(config.versionsPerPeriod).toBe(3);
    expect(config.retentionDays).toBe(30);
  });

  it("rejects garbage values", async () => {
    const { resolveReportSnapshotConfig, ConfigError } = await import("../src/lib/config.js");
    vi.stubEnv("REPORT_SNAPSHOT_VERSIONS_PER_PERIOD", "not-a-number");
    expect(() => resolveReportSnapshotConfig()).toThrow(ConfigError);
  });
});
