// ADR-0030 §7 — read endpoint helpers (parseVersion + listReportSnapshots
// parseLimit + getReportCurrent parseCadence). Pure tests — Table I/O
// covered separately by the capture-handler integration test.

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
  vi.stubEnv("OPS_TABLE_ENDPOINT", "https://staegisops.table.core.windows.net");
  vi.stubEnv("AUDIT_BLOB_ENDPOINT", "https://staegisaudit.blob.core.windows.net");
  vi.stubEnv("GRAPH_BASE_URL", "https://graph.microsoft.com");
  vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getReportSnapshot.parseVersion", () => {
  it("returns null when version is unset", async () => {
    const { parseVersion } = await import("../src/functions/getReportSnapshot.js");
    expect(parseVersion(null)).toEqual({ kind: "ok", value: null });
    expect(parseVersion("")).toEqual({ kind: "ok", value: null });
  });

  it("accepts positive integers", async () => {
    const { parseVersion } = await import("../src/functions/getReportSnapshot.js");
    expect(parseVersion("1")).toEqual({ kind: "ok", value: 1 });
    expect(parseVersion("99")).toEqual({ kind: "ok", value: 99 });
  });

  it("rejects zero / negative / non-integer / hostile", async () => {
    const { parseVersion } = await import("../src/functions/getReportSnapshot.js");
    // Note: leading/trailing whitespace is tolerated (.trim()); the
    // hostile path is the trailing-junk case.
    for (const bad of ["0", "-1", "1.5", "abc", "1; DROP TABLE", "1abc"]) {
      expect(parseVersion(bad).kind, `expected error for '${bad}'`).toBe("error");
    }
  });
});

describe("listReportSnapshots.parseLimit", () => {
  it("returns the default (12) when unset", async () => {
    const { parseLimit } = await import("../src/functions/listReportSnapshots.js");
    expect(parseLimit(null)).toEqual({ kind: "ok", value: 12 });
    expect(parseLimit("")).toEqual({ kind: "ok", value: 12 });
  });

  it("accepts integers in [1, 50]", async () => {
    const { parseLimit } = await import("../src/functions/listReportSnapshots.js");
    expect(parseLimit("1")).toEqual({ kind: "ok", value: 1 });
    expect(parseLimit("50")).toEqual({ kind: "ok", value: 50 });
  });

  it("rejects out-of-range / non-integer / hostile", async () => {
    const { parseLimit } = await import("../src/functions/listReportSnapshots.js");
    for (const bad of ["0", "-1", "51", "1000", "1.5", "abc", "../../../etc"]) {
      expect(parseLimit(bad).kind, `expected error for '${bad}'`).toBe("error");
    }
  });
});

describe("getReportCurrent.parseCadence", () => {
  it("accepts the three documented cadences", async () => {
    const { parseCadence } = await import("../src/functions/getReportCurrent.js");
    expect(parseCadence("weekly")).toBe("weekly");
    expect(parseCadence("monthly")).toBe("monthly");
    expect(parseCadence("quarterly")).toBe("quarterly");
  });

  it("rejects unknown / hostile / empty values", async () => {
    const { parseCadence } = await import("../src/functions/getReportCurrent.js");
    for (const bad of ["", "WEEKLY", "daily", "../../etc/passwd", "weekly; sleep 5"]) {
      expect(parseCadence(bad)).toBeNull();
    }
  });
});
