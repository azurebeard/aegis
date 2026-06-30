// ADR-0032 §1 + §7 — config-load floor enforcement.

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
  vi.stubEnv("INGEST_MI_CLIENT_ID", "ingest-mi");
  vi.stubEnv("AUDIT_MI_CLIENT_ID", "audit-mi");
  vi.stubEnv("OPS_TABLE_ENDPOINT", "https://staegisops.table.core.windows.net");
  vi.stubEnv("AUDIT_BLOB_ENDPOINT", "https://staegisaudit.blob.core.windows.net");
  vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveKevIngestConfig", () => {
  it("returns documented defaults when env vars are absent", async () => {
    const { resolveKevIngestConfig } = await import("../src/lib/config.js");
    const c = resolveKevIngestConfig();
    expect(c.source).toBe("cisa.kev");
    expect(c.feedUrl).toBe(
      "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    );
    expect(c.feedTimeoutMs).toBe(30000);
    expect(c.feedMaxBytes).toBe(52428800);
  });

  it("rejects feedTimeoutMs below floor", async () => {
    const { resolveKevIngestConfig, ConfigError } = await import("../src/lib/config.js");
    vi.stubEnv("KEV_FEED_TIMEOUT_MS", "500");
    expect(() => resolveKevIngestConfig()).toThrow(ConfigError);
    vi.stubEnv("KEV_FEED_TIMEOUT_MS", "0");
    expect(() => resolveKevIngestConfig()).toThrow(ConfigError);
  });

  it("rejects feedMaxBytes below 1 MB", async () => {
    const { resolveKevIngestConfig, ConfigError } = await import("../src/lib/config.js");
    vi.stubEnv("KEV_FEED_MAX_BYTES", "1024");
    expect(() => resolveKevIngestConfig()).toThrow(ConfigError);
  });

  it("accepts overrides at the floor exactly", async () => {
    const { resolveKevIngestConfig } = await import("../src/lib/config.js");
    vi.stubEnv("KEV_FEED_TIMEOUT_MS", "1000");
    vi.stubEnv("KEV_FEED_MAX_BYTES", String(1024 * 1024));
    const c = resolveKevIngestConfig();
    expect(c.feedTimeoutMs).toBe(1000);
    expect(c.feedMaxBytes).toBe(1024 * 1024);
  });

  it("admits feedUrl override (sovereign-cloud / test)", async () => {
    const { resolveKevIngestConfig } = await import("../src/lib/config.js");
    vi.stubEnv("KEV_FEED_URL", "https://example.test/feed.json");
    const c = resolveKevIngestConfig();
    expect(c.feedUrl).toBe("https://example.test/feed.json");
  });
});
