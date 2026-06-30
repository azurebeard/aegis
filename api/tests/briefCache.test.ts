// Tests for briefCache.ts (ADR-0022 cache-table + blob).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RestError } from "@azure/data-tables";

// `writeCache` reaches out to `BlobServiceClient` + `DefaultAzureCredential`.
// Mock both so the dispatch logic (first-write vs refresh) can be unit-tested
// without live endpoints. Declared BEFORE the module import so Vitest applies
// the mock at resolve time.
const blobUploadData = vi.fn();
const getBlockBlobClient = vi.fn(() => ({ uploadData: blobUploadData }));
const getContainerClient = vi.fn(() => ({ getBlockBlobClient }));

vi.mock("@azure/storage-blob", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/storage-blob")>(
      "@azure/storage-blob",
    );
  // Vitest 4: constructor mocks must be real functions (not arrow functions)
  // so they carry a `prototype` and can be invoked with `new`.
  return {
    ...actual,
    BlobServiceClient: vi.fn(function (this: unknown) {
      return { getContainerClient };
    }),
  };
});

vi.mock("@azure/identity", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/identity")>(
      "@azure/identity",
    );
  return {
    ...actual,
    DefaultAzureCredential: vi.fn(function (this: unknown) {
      return {};
    }),
  };
});

import {
  briefBlobPath,
  briefRowKey,
  classifyFreshness,
  sha256Hex,
  writeCache,
  type BriefCacheRow,
} from "../src/lib/briefCache.js";

describe("briefRowKey / briefBlobPath", () => {
  it("encodes the date in the row key", () => {
    expect(briefRowKey("2026-04-19")).toBe("brief.2026-04-19");
  });
  it("partitions the blob path by yyyy/mm/dd", () => {
    expect(briefBlobPath("2026-04-19", "tenant-1")).toBe(
      "2026/04/19/tenant-1.md",
    );
  });
  it("path-sanitises tenant ID slashes (periods are part of the allowlist)", () => {
    // The regex allows alphanumeric + `._-`, so `..` segments survive but the
    // path separators get replaced — the resulting path stays inside the
    // intended directory.
    expect(briefBlobPath("2026-04-19", "evil/segment\\bad")).toBe(
      "2026/04/19/evil_segment_bad.md",
    );
  });
  it("rejects malformed dates", () => {
    expect(() => briefBlobPath("nope", "t1")).toThrow();
  });
});

describe("classifyFreshness 4-state matrix (ADR-0022 §5)", () => {
  const now = new Date("2026-04-19T12:00:00.000Z");
  const fresh: BriefCacheRow = {
    tenantId: "t1",
    rowKey: "brief.2026-04-19", // gitleaks:allow
    briefDate: "2026-04-19",
    runId: "r1",
    blobPath: "2026/04/19/t1.md",
    outputSha256: "deadbeef",
    tokensIn: 0,
    tokensOut: 0,
    generatedAt: new Date(now.getTime() - 1 * 3_600_000).toISOString(), // 1h ago
    modelDeployment: "aegis-small",
    etag: "e1",
  };

  it("returns missing on null row", () => {
    expect(classifyFreshness(null, now, 26, 72)).toBe("missing");
  });
  it("returns fresh when age ≤ freshHours", () => {
    expect(classifyFreshness(fresh, now, 26, 72)).toBe("fresh");
  });
  it("returns stale_serviceable when fresh < age ≤ ceiling", () => {
    const old: BriefCacheRow = {
      ...fresh,
      generatedAt: new Date(now.getTime() - 30 * 3_600_000).toISOString(), // 30h
    };
    expect(classifyFreshness(old, now, 26, 72)).toBe("stale_serviceable");
  });
  it("returns stale_unservable when age > ceilingHours", () => {
    const ancient: BriefCacheRow = {
      ...fresh,
      generatedAt: new Date(now.getTime() - 80 * 3_600_000).toISOString(), // 80h
    };
    expect(classifyFreshness(ancient, now, 26, 72)).toBe("stale_unservable");
  });
});

describe("sha256Hex", () => {
  it("matches known sha256 of empty string", () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it("matches known sha256 of 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("produces different hashes for different inputs", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

// --- writeCache first-write vs refresh dispatch ---------------------------
// SEC-H-STEP5-CODE-02 (WS10 verdict 2026-04-19 step5-code): when a row
// already exists for the target date, the caller passes `priorEtag` and
// writeCache must take the refresh path — overwrite the blob unconditionally
// and `updateEntity` the row with `If-Match: priorEtag`. Without that, the
// admin force-refresh path always 409s on the blob and reports `superseded`
// against the same runId.

// Minimal TableClient mock — enough for writeCache's create/update/getEntity.
class TableMock {
  rows = new Map<string, Record<string, unknown>>();
  etagCounter = 0;
  private key(pk: string, rk: string): string {
    return `${pk}|${rk}`;
  }
  async createEntity(e: Record<string, unknown>): Promise<{ etag: string }> {
    const k = this.key(
      e.partitionKey as string,
      e.rowKey as string,
    );
    if (this.rows.has(k)) throw new RestError("exists", { statusCode: 409 });
    const etag = `e${++this.etagCounter}`;
    this.rows.set(k, { ...e, etag });
    return { etag };
  }
  async updateEntity(
    e: Record<string, unknown>,
    _mode: "Replace" | "Merge",
    options?: { etag?: string },
  ): Promise<{ etag: string }> {
    const k = this.key(
      e.partitionKey as string,
      e.rowKey as string,
    );
    const existing = this.rows.get(k);
    if (!existing) throw new RestError("not found", { statusCode: 404 });
    if (options?.etag && existing.etag !== options.etag) {
      throw new RestError("412", { statusCode: 412 });
    }
    const etag = `e${++this.etagCounter}`;
    this.rows.set(k, { ...e, etag });
    return { etag };
  }
  async getEntity<T>(pk: string, rk: string): Promise<T> {
    const e = this.rows.get(this.key(pk, rk));
    if (!e) throw new RestError("not found", { statusCode: 404 });
    return { ...e } as unknown as T;
  }
}

describe("writeCache first-write vs refresh (SEC-H-STEP5-CODE-02)", () => {
  beforeEach(() => {
    blobUploadData.mockReset();
    getBlockBlobClient.mockClear();
    getContainerClient.mockClear();
  });

  const baseArgs = () => ({
    table: new TableMock() as unknown as Parameters<
      typeof writeCache
    >[0]["table"],
    blobServiceEndpoint: "https://t.blob.core.windows.net",
    miClientId: "mi-1",
    container: "daily-briefs",
    tenantId: "tenant-1",
    yyyymmdd: "2026-04-19",
    body: "## hello\n",
    runId: "run-1",
    tokensIn: 100,
    tokensOut: 50,
    modelDeployment: "aegis-small",
    now: new Date("2026-04-19T10:00:00.000Z"),
  });

  it("first-write-of-day: no priorEtag -> blob ifNoneMatch:* + createEntity", async () => {
    blobUploadData.mockResolvedValue({});
    const args = baseArgs();
    const result = await writeCache(args);

    expect(result.status).toBe("committed");
    expect(result.outputSha256).toBe(
      sha256Hex(Buffer.from(args.body, "utf-8")),
    );
    expect(result.blobPath).toBe("2026/04/19/tenant-1.md");
    // Blob was invoked with ifNoneMatch:*.
    expect(blobUploadData).toHaveBeenCalledTimes(1);
    const blobOpts = blobUploadData.mock.calls[0]?.[1] as {
      conditions?: { ifNoneMatch?: string; ifMatch?: string };
    };
    expect(blobOpts?.conditions?.ifNoneMatch).toBe("*");
    expect(blobOpts?.conditions?.ifMatch).toBeUndefined();
  });

  it("refresh-stale: priorEtag supplied -> blob overwrite + updateEntity with If-Match", async () => {
    blobUploadData.mockResolvedValue({});
    const args = baseArgs();
    const table = args.table as unknown as TableMock;
    // Seed an existing row with a known etag.
    await table.createEntity({
      partitionKey: args.tenantId,
      rowKey: briefRowKey(args.yyyymmdd),
      RunId: "run-0",
      BlobPath: "2026/04/19/tenant-1.md",
      OutputSha256: "old-sha",
      TokensIn: 0,
      TokensOut: 0,
      GeneratedAt: "2026-04-19T05:00:00.000Z",
      ModelDeployment: "aegis-small",
    });
    const existingEtag = "e1";

    const result = await writeCache({ ...args, priorEtag: existingEtag });

    expect(result.status).toBe("committed");
    // Blob write did NOT carry an ifNoneMatch / ifMatch condition.
    const blobOpts = blobUploadData.mock.calls[0]?.[1] as {
      conditions?: Record<string, unknown>;
    };
    expect(blobOpts?.conditions).toBeUndefined();
    // Row was updated and the etag advanced.
    const row = await table.getEntity<{ RunId: string; etag: string }>(
      args.tenantId,
      briefRowKey(args.yyyymmdd),
    );
    expect(row.RunId).toBe(args.runId);
    expect(row.etag).not.toBe(existingEtag);
  });

  it("race-during-refresh: another writer replaced the row -> superseded with supersedingRunId", async () => {
    blobUploadData.mockResolvedValue({});
    const args = baseArgs();
    const table = args.table as unknown as TableMock;
    await table.createEntity({
      partitionKey: args.tenantId,
      rowKey: briefRowKey(args.yyyymmdd),
      RunId: "competing-run",
      BlobPath: "2026/04/19/tenant-1.md",
      OutputSha256: "other-sha",
      TokensIn: 0,
      TokensOut: 0,
      GeneratedAt: "2026-04-19T06:00:00.000Z",
      ModelDeployment: "aegis-small",
    });

    // Caller read the row earlier and got `e1`, but someone else updated it
    // to `e2` meanwhile. Pass the STALE etag — updateEntity must 412.
    // We simulate "someone else updated the row" by mutating the row etag.
    const k = `${args.tenantId}|${briefRowKey(args.yyyymmdd)}`;
    const current = table.rows.get(k);
    if (current) {
      current.etag = "e-new";
      current.RunId = "competing-run";
    }

    const result = await writeCache({ ...args, priorEtag: "e1" });
    expect(result.status).toBe("superseded");
    expect(result.supersedingRunId).toBe("competing-run");
  });
});
