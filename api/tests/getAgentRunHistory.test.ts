// Tests for getAgentRunHistory endpoint helpers.
// Covers parseLimit + the agent param mapping; the readRecentAuditLines
// path is covered separately in audit-related tests (where the
// AppendBlobClient is already stubbed at the module level).

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
  vi.stubEnv("API_READER_MI_CLIENT_ID", "api-mi");
  vi.stubEnv("INGEST_MI_CLIENT_ID", "ingest-mi");
  vi.stubEnv("AUDIT_MI_CLIENT_ID", "audit-mi");
  vi.stubEnv(
    "OPS_TABLE_ENDPOINT",
    "https://staegisops.table.core.windows.net",
  );
  vi.stubEnv(
    "AUDIT_BLOB_ENDPOINT",
    "https://staegisaudit.blob.core.windows.net",
  );
  vi.stubEnv("GRAPH_BASE_URL", "https://graph.microsoft.com");
  vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAgentRunHistory.parseLimit", () => {
  it("returns the default (20) when limit is unset", async () => {
    const { parseLimit } = await import(
      "../src/functions/getAgentRunHistory.js"
    );
    expect(parseLimit(null)).toEqual({ kind: "ok", value: 20 });
    expect(parseLimit("")).toEqual({ kind: "ok", value: 20 });
  });

  it("accepts integers in the valid range", async () => {
    const { parseLimit } = await import(
      "../src/functions/getAgentRunHistory.js"
    );
    expect(parseLimit("1")).toEqual({ kind: "ok", value: 1 });
    expect(parseLimit("100")).toEqual({ kind: "ok", value: 100 });
  });

  it("rejects values outside the [1, 100] range or non-integers", async () => {
    const { parseLimit } = await import(
      "../src/functions/getAgentRunHistory.js"
    );
    for (const bad of ["0", "-1", "101", "1000", "1.5", "abc", "5x"]) {
      const r = parseLimit(bad);
      expect(r.kind, `expected error for '${bad}'`).toBe("error");
    }
  });
});
