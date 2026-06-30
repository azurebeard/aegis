// Tests for the incidents trends helper + endpoint param parser.

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

describe("getIncidentsTrends.parseDays", () => {
  it("returns the default when days is unset", async () => {
    const { parseDays } = await import("../src/functions/getIncidentsTrends.js");
    expect(parseDays(null)).toEqual({ kind: "ok", value: 30 });
    expect(parseDays("")).toEqual({ kind: "ok", value: 30 });
  });

  it("accepts integers in the valid range", async () => {
    const { parseDays } = await import("../src/functions/getIncidentsTrends.js");
    expect(parseDays("1")).toEqual({ kind: "ok", value: 1 });
    expect(parseDays("90")).toEqual({ kind: "ok", value: 90 });
  });

  it("rejects values outside the range or non-integers", async () => {
    const { parseDays } = await import("../src/functions/getIncidentsTrends.js");
    for (const bad of ["0", "-1", "91", "100", "1.5", "abc", "5x"]) {
      const r = parseDays(bad);
      expect(r.kind, `expected error for '${bad}'`).toBe("error");
    }
  });
});

describe("incidentsStore.readIncidentsTrends", () => {
  it("seeds N empty buckets so empty days render zero", async () => {
    const { readIncidentsTrends } = await import("../src/lib/incidentsStore.js");
    const table = mkTableMock([]);
    const buckets = await readIncidentsTrends(table, "t1", "2026-04-01T00:00:00Z", 7);
    expect(buckets).toHaveLength(7);
    for (const b of buckets) {
      expect(b.total).toBe(0);
      expect(b.bySeverity.high).toBe(0);
      expect(b.bySeverity.medium).toBe(0);
      expect(b.bySeverity.low).toBe(0);
      expect(b.bySeverity.informational).toBe(0);
      expect(b.bySeverity.unknown).toBe(0);
    }
  });

  it("counts incidents into the correct day bucket by CreatedDateTime", async () => {
    const { readIncidentsTrends } = await import("../src/lib/incidentsStore.js");
    // Pin "today" so the seeded bucket window is deterministic.
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    const yesterdayKey = new Date(today.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);

    const table = mkTableMock([
      mkIncidentEntity("t1", "i-1", "high", `${todayKey}T10:00:00Z`),
      mkIncidentEntity("t1", "i-2", "high", `${todayKey}T15:00:00Z`),
      mkIncidentEntity("t1", "i-3", "medium", `${yesterdayKey}T08:00:00Z`),
    ]);
    const buckets = await readIncidentsTrends(table, "t1", "2026-04-01T00:00:00Z", 30);
    const todayB = buckets.find((b) => b.day === todayKey);
    const yB = buckets.find((b) => b.day === yesterdayKey);
    expect(todayB).toBeDefined();
    expect(todayB!.total).toBe(2);
    expect(todayB!.bySeverity.high).toBe(2);
    expect(yB!.total).toBe(1);
    expect(yB!.bySeverity.medium).toBe(1);
  });

  it("ignores incidents that fall outside the seeded window", async () => {
    const { readIncidentsTrends } = await import("../src/lib/incidentsStore.js");
    // 2-day window — anything older than 2 days (relative to today) must not
    // be counted, even if the OData filter rounded it in.
    const ancient = "2024-01-01T00:00:00Z";
    const table = mkTableMock([mkIncidentEntity("t1", "i-old", "high", ancient)]);
    const buckets = await readIncidentsTrends(table, "t1", ancient, 2);
    expect(buckets).toHaveLength(2);
    expect(buckets.every((b) => b.total === 0)).toBe(true);
  });

  it("escapes single-quotes in tenantId for the OData filter", async () => {
    const { readIncidentsTrends } = await import("../src/lib/incidentsStore.js");
    const observed: string[] = [];
    const table = {
      listEntities: vi.fn((opts: { queryOptions?: { filter?: string } }) => {
        observed.push(opts.queryOptions?.filter ?? "(none)");
        return mkAsyncIter([]);
      }),
    } as unknown as Parameters<typeof readIncidentsTrends>[0];
    await readIncidentsTrends(table, "evil'tenant", "2026-04-01T00:00:00Z", 7);
    // odata`...` template tag uses '' to escape — same convention as the
    // hand-written escapes elsewhere in the store.
    expect(observed[0]).toContain("evil''tenant");
  });
});

// Test fixtures ---------------------------------------------------------------

function mkIncidentEntity(
  tenantId: string,
  id: string,
  severity: string,
  createdDateTime: string,
) {
  return {
    partitionKey: tenantId,
    rowKey: id,
    Status: "active",
    Severity: severity,
    Classification: "unknown",
    Determination: "unknown",
    PriorityScore: 50,
    DisplayName: `Incident ${id}`,
    AssignedTo: null,
    CreatedDateTime: createdDateTime,
    LastUpdateDateTime: createdDateTime,
    AlertCount: 1,
    HasRedirect: false,
    RedirectIncidentId: null,
    IncidentWebUrl: "",
    CustomTagsJson: "[]",
    SystemTagsJson: "[]",
    DetailBlobPath: "",
    IngestedAt: createdDateTime,
    IngestRunId: "r-test",
  };
}

function mkAsyncIter<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let i = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (i >= items.length) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return Promise.resolve({ value: items[i++] as T, done: false });
        },
      };
    },
  };
}

function mkTableMock(entities: readonly unknown[]): never {
  return {
    listEntities: vi.fn(() => mkAsyncIter(entities)),
  } as never;
}
