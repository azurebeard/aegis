// Tests for the brief / posture history endpoints (HANDOVER §6.3 history view).
//
// Coverage:
//   - `parseLimit` (separate copies in getBriefHistory + getPostureHistory):
//     defaults, integer/range validation, max-limit divergence (brief 60 vs
//     posture 26).
//   - `listCacheRows` (briefCache + postureCache): partition-scoped query,
//     row-key shape filter (skip non-`brief.` / non-`posture.` rows so a
//     misuse of the same partition can't leak into the list), descending
//     sort order, limit slicing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `app.http` registration in the handler modules has a side effect at module
// load — stub it out so the test file can import the parseLimit helper.
vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

beforeEach(() => {
  // Minimal env so the brief/posture handlers' module-load resolveBriefAgentConfig
  // (called inside the handler itself, NOT at module load — but be defensive)
  // doesn't hit a missing env. Values aren't dereferenced by parseLimit.
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

describe("getBriefHistory.parseLimit (default 14, max 60)", () => {
  it("returns the default when limit is unset", async () => {
    const { parseLimit } = await import("../src/functions/getBriefHistory.js");
    expect(parseLimit(null)).toEqual({ kind: "ok", value: 14 });
    expect(parseLimit("")).toEqual({ kind: "ok", value: 14 });
  });

  it("accepts integers in the valid range", async () => {
    const { parseLimit } = await import("../src/functions/getBriefHistory.js");
    expect(parseLimit("1")).toEqual({ kind: "ok", value: 1 });
    expect(parseLimit("14")).toEqual({ kind: "ok", value: 14 });
    expect(parseLimit("60")).toEqual({ kind: "ok", value: 60 });
  });

  it("trims whitespace before parsing", async () => {
    const { parseLimit } = await import("../src/functions/getBriefHistory.js");
    expect(parseLimit("  21  ")).toEqual({ kind: "ok", value: 21 });
  });

  it("rejects out-of-range, non-integer, and garbage values", async () => {
    const { parseLimit } = await import("../src/functions/getBriefHistory.js");
    for (const bad of ["0", "-5", "61", "100", "1.5", "abc", "5x", "0x10"]) {
      const r = parseLimit(bad);
      expect(r.kind, `expected error for '${bad}'`).toBe("error");
      if (r.kind === "error") {
        expect(r.response.status).toBe(400);
      }
    }
  });
});

describe("getPostureHistory.parseLimit (default 12, max 26)", () => {
  it("returns the default when limit is unset", async () => {
    const { parseLimit } = await import("../src/functions/getPostureHistory.js");
    expect(parseLimit(null)).toEqual({ kind: "ok", value: 12 });
  });

  it("rejects values above 26 (the posture-specific cap)", async () => {
    const { parseLimit } = await import("../src/functions/getPostureHistory.js");
    const r = parseLimit("27");
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.response.status).toBe(400);
  });

  it("accepts the max boundary", async () => {
    const { parseLimit } = await import("../src/functions/getPostureHistory.js");
    expect(parseLimit("26")).toEqual({ kind: "ok", value: 26 });
  });
});

describe("briefCache.listCacheRows", () => {
  it("filters to brief.YYYY-MM-DD rows, sorts descending by date, slices to limit", async () => {
    const { listCacheRows } = await import("../src/lib/briefCache.js");
    // Mixed-shape entities — verify the row-key shape filter rejects everything
    // that isn't `brief.YYYY-MM-DD` (defensive even though the partition is
    // single-purpose today). Order returned by the iterator is intentionally
    // unsorted so the sort-after-fetch is exercised.
    const entities = [
      mkBriefEntity("t1", "2026-04-15", "r-15"),
      mkBriefEntity("t1", "2026-04-20", "r-20"),
      { partitionKey: "t1", rowKey: "config.something", RunId: "x", BlobPath: "", OutputSha256: "", TokensIn: 0, TokensOut: 0, GeneratedAt: "", ModelDeployment: "" },
      mkBriefEntity("t1", "2026-04-18", "r-18"),
      // Bad date shape — should be filtered.
      { partitionKey: "t1", rowKey: "brief.not-a-date", RunId: "x", BlobPath: "", OutputSha256: "", TokensIn: 0, TokensOut: 0, GeneratedAt: "", ModelDeployment: "" },
    ];
    const table = mkTableMock(entities);
    const rows = await listCacheRows(table, "t1", 10);
    expect(rows.map((r) => r.briefDate)).toEqual(["2026-04-20", "2026-04-18", "2026-04-15"]);
    expect(rows.map((r) => r.runId)).toEqual(["r-20", "r-18", "r-15"]);
  });

  it("respects the limit by truncating after the sort", async () => {
    const { listCacheRows } = await import("../src/lib/briefCache.js");
    const entities = ["2026-04-15", "2026-04-20", "2026-04-18", "2026-04-22", "2026-04-10"]
      .map((d) => mkBriefEntity("t1", d, `r-${d}`));
    const table = mkTableMock(entities);
    const rows = await listCacheRows(table, "t1", 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.briefDate)).toEqual(["2026-04-22", "2026-04-20"]);
  });

  it("escapes single-quotes in tenantId for the OData filter", async () => {
    const { listCacheRows } = await import("../src/lib/briefCache.js");
    const observed: { filter?: string }[] = [];
    const table = {
      listEntities: vi.fn((opts: { queryOptions?: { filter?: string } }) => {
        observed.push({ filter: opts.queryOptions?.filter ?? "(none)" });
        return mkAsyncIter([]);
      }),
    } as unknown as Parameters<typeof listCacheRows>[0];
    await listCacheRows(table, "evil'tenant", 5);
    // OData escapes ' as '' (doubled). A naïve interpolation would yield
    // `PartitionKey eq 'evil'tenant'` which truncates the filter at the
    // unescaped quote — letting the filter return any partition.
    expect(observed[0]?.filter).toBe("PartitionKey eq 'evil''tenant'");
  });
});

describe("postureCache.listCacheRows", () => {
  it("filters to posture.YYYY-Www rows, sorts descending by week, slices to limit", async () => {
    const { listCacheRows } = await import("../src/lib/postureCache.js");
    const entities = [
      mkPostureEntity("t1", "2026-W14", "r-14"),
      mkPostureEntity("t1", "2026-W17", "r-17"),
      { partitionKey: "t1", rowKey: "config.x", RunId: "x", BlobPath: "", OutputSha256: "", TokensIn: 0, TokensOut: 0, GeneratedAt: "", ModelDeployment: "" },
      mkPostureEntity("t1", "2026-W15", "r-15"),
      // Bad week shape (3-digit) — filtered.
      { partitionKey: "t1", rowKey: "posture.2026-W123", RunId: "x", BlobPath: "", OutputSha256: "", TokensIn: 0, TokensOut: 0, GeneratedAt: "", ModelDeployment: "" },
    ];
    const table = mkTableMock(entities);
    const rows = await listCacheRows(table, "t1", 10);
    expect(rows.map((r) => r.isoWeek)).toEqual(["2026-W17", "2026-W15", "2026-W14"]);
  });
});

// Test fixtures ---------------------------------------------------------------

function mkBriefEntity(tenantId: string, yyyymmdd: string, runId: string) {
  return {
    partitionKey: tenantId,
    rowKey: `brief.${yyyymmdd}`,
    RunId: runId,
    BlobPath: `2026/04/${yyyymmdd.slice(-2)}/${tenantId}.md`,
    OutputSha256: "deadbeef",
    TokensIn: 100,
    TokensOut: 50,
    GeneratedAt: `${yyyymmdd}T03:00:00.000Z`,
    ModelDeployment: "aegis-small",
  };
}

function mkPostureEntity(tenantId: string, isoWeek: string, runId: string) {
  return {
    partitionKey: tenantId,
    rowKey: `posture.${isoWeek}`,
    RunId: runId,
    BlobPath: `${isoWeek.replace("-", "/")}/${tenantId}.md`,
    OutputSha256: "deadbeef",
    TokensIn: 200,
    TokensOut: 100,
    GeneratedAt: `2026-04-21T06:00:00.000Z`,
    ModelDeployment: "aegis-small",
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
