// Tests for the notifications endpoint helpers.
// Coverage:
//   - listIngestHealth (ingestHealth.ts) — partition-scoped query enumerates
//     every row, OData escape on tenantId.

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

describe("ingestHealth.listHealthRows", () => {
  it("enumerates every row in the tenant partition", async () => {
    const { listHealthRows } = await import("../src/lib/ingestHealth.js");
    const table = mkTableMock([
      mkIngestRow("t1", "graph.security.secureScores", "healthy", 0),
      mkIngestRow("t1", "graph.security.incidents", "failing", 5),
      mkIngestRow("t1", "graph.identityProtection.riskyUsers", "degrading", 2),
    ]);
    const rows = await listHealthRows(table, "t1");
    expect(rows).toHaveLength(3);
    const sources = rows.map((r) => r.source);
    expect(sources).toContain("graph.security.secureScores");
    expect(sources).toContain("graph.security.incidents");
    expect(sources).toContain("graph.identityProtection.riskyUsers");
  });

  it("escapes single-quotes in tenantId via the odata template tag", async () => {
    const { listHealthRows } = await import("../src/lib/ingestHealth.js");
    const observed: string[] = [];
    const table = {
      listEntities: vi.fn((opts: { queryOptions?: { filter?: string } }) => {
        observed.push(opts.queryOptions?.filter ?? "(none)");
        return mkAsyncIter([]);
      }),
    } as unknown as Parameters<typeof listHealthRows>[0];
    await listHealthRows(table, "evil'tenant");
    expect(observed[0]).toContain("evil''tenant");
  });

  it("returns an empty list when the partition has no rows", async () => {
    const { listHealthRows } = await import("../src/lib/ingestHealth.js");
    const table = mkTableMock([]);
    const rows = await listHealthRows(table, "t1");
    expect(rows).toEqual([]);
  });
});

// Test fixtures ---------------------------------------------------------------

function mkIngestRow(
  tenantId: string,
  source: string,
  status: string,
  failures: number,
) {
  return {
    partitionKey: tenantId,
    rowKey: source,
    Status: status,
    LastSuccessAt: "2026-04-27T03:00:00Z",
    LastFailureAt: failures > 0 ? "2026-04-27T03:05:00Z" : null,
    ConsecutiveFailureCount: failures,
    LastRunId: "r-test",
    LastAuditSeq: 1,
    LastLineSha256: "",
    LastCursor: "",
    UpdatedAt: "2026-04-27T03:05:00Z",
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
