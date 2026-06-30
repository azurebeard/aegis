// ADR-0037 Layer 3c — admin handler tests for runRansomwareIntelIngest.
// Mirrors runEntraRiskIngestHandler.test.ts shape.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RansomwareIntelIngestConfig } from "../src/lib/config.js";
import type * as ClientPrincipalMod from "../src/lib/clientPrincipal.js";
import type * as ConfigMod from "../src/lib/config.js";
import type * as RateLimitMod from "../src/lib/rateLimit.js";
import type * as AzFunctions from "@azure/functions";

const {
  runOnceMock,
  resolveConfigMock,
  rateLimiterCheckMock,
  readClientPrincipalMock,
} = vi.hoisted(() => ({
  runOnceMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  rateLimiterCheckMock: vi.fn(),
  readClientPrincipalMock: vi.fn(),
}));

vi.mock("../src/lib/runRansomwareIntelIngest.js", () => ({
  runRansomwareIntelIngestOnce: runOnceMock,
}));

vi.mock("../src/lib/clientPrincipal.js", async () => {
  const actual = await vi.importActual<typeof ClientPrincipalMod>(
    "../src/lib/clientPrincipal.js",
  );
  return { ...actual, readClientPrincipal: readClientPrincipalMock };
});

vi.mock("../src/lib/config.js", async () => {
  const actual = await vi.importActual<typeof ConfigMod>(
    "../src/lib/config.js",
  );
  return { ...actual, resolveRansomwareIntelIngestConfig: resolveConfigMock };
});

vi.mock("../src/lib/rateLimit.js", async () => {
  const actual = await vi.importActual<typeof RateLimitMod>(
    "../src/lib/rateLimit.js",
  );
  return {
    ...actual,
    ransomwareIntelAdminRunRateLimiter: { check: rateLimiterCheckMock },
  };
});

vi.mock("@azure/functions", async () => {
  const actual = await vi.importActual<typeof AzFunctions>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

import { runRansomwareIntelIngestHandler } from "../src/functions/runRansomwareIntelIngest.js";

const CONFIG: RansomwareIntelIngestConfig = {
  threatIntelMiClientId: "mi-threat-intel",
  auditMiClientId: "mi-audit",
  opsTableEndpoint: "https://fake.table.core.windows.net",
  auditBlobEndpoint: "https://fake.blob.core.windows.net",
  auditContainerName: "audit",
  tenantId: "tenant-1",
  source: "external.ransomware.live",
  country: "GB",
  retentionDays: 14,
  adminDailyRunCeiling: 30,
};

function mockContext() {
  return {
    invocationId: "test-inv",
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

const ADMIN_PRINCIPAL = Object.freeze({
  identityProvider: "aad",
  userId: "u1",
  userDetails: "admin@example.com",
  userRoles: ["authenticated", "admin", "reader"],
});

interface HeaderStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

function buildRequest(opts: {
  body?: string;
  declareContentLength?: boolean;
  queryKeys?: readonly string[];
}): {
  headers: HeaderStore;
  query: { keys(): Iterable<string> };
  text: () => Promise<string>;
} {
  const store = new Map<string, string>();
  store.set("x-ms-client-principal", "PHASE_E_PRINCIPAL_VIA_MOCK");
  if (opts.body !== undefined && opts.declareContentLength !== false) {
    store.set("content-length", Buffer.byteLength(opts.body, "utf-8").toString());
  }
  const headers: HeaderStore = {
    get: (k: string) => store.get(k.toLowerCase()) ?? store.get(k) ?? null,
    set: (k: string, v: string) => {
      store.set(k.toLowerCase(), v);
    },
    delete: (k: string) => {
      store.delete(k.toLowerCase());
      store.delete(k);
    },
  };
  const keys = opts.queryKeys ?? [];
  return {
    headers,
    query: { keys: () => keys[Symbol.iterator]() },
    text: async () => opts.body ?? "",
  };
}

beforeEach(() => {
  runOnceMock.mockReset();
  resolveConfigMock.mockReset();
  rateLimiterCheckMock.mockReset();
  readClientPrincipalMock.mockReset();
  resolveConfigMock.mockReturnValue(CONFIG);
  rateLimiterCheckMock.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  runOnceMock.mockResolvedValue({
    status: "success",
    runId: "r1",
    startedAt: "2026-06-25T13:00:00.000Z",
    victimsIngested: 3,
    pressIngested: 2,
    retentionRowsDeleted: 0,
    country: "GB",
    period: "2026-06",
  });
  readClientPrincipalMock.mockResolvedValue({ ...ADMIN_PRINCIPAL });
});

describe("runRansomwareIntelIngestHandler — auth gate", () => {
  it("rejects with 401 when no client principal", async () => {
    readClientPrincipalMock.mockResolvedValueOnce(null);
    const req = buildRequest({ body: "" });
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(401);
    expect(runOnceMock).not.toHaveBeenCalled();
  });
});

describe("runRansomwareIntelIngestHandler — request hygiene", () => {
  it("rejects with 400 when query string is non-empty", async () => {
    const req = buildRequest({ body: "", queryKeys: ["foo"] });
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(400);
    expect(runOnceMock).not.toHaveBeenCalled();
  });

  it("rejects with 413 when Content-Length declares > 1024 bytes", async () => {
    const req = buildRequest({ body: "x".repeat(2000) });
    req.headers.set("content-length", "2000");
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(413);
    expect(runOnceMock).not.toHaveBeenCalled();
  });

  it("rejects with 413 when chunked body (no Content-Length) exceeds cap", async () => {
    const oversized = "x".repeat(2000);
    const req = buildRequest({ body: oversized, declareContentLength: false });
    req.headers.delete("content-length");
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(413);
    expect(runOnceMock).not.toHaveBeenCalled();
  });

  it("accepts an empty body and dispatches the run", async () => {
    const req = buildRequest({ body: "" });
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(202);
    expect(runOnceMock).toHaveBeenCalledTimes(1);
  });
});

describe("runRansomwareIntelIngestHandler — rate limit", () => {
  it("returns 429 with retry-after when budget exhausted", async () => {
    rateLimiterCheckMock.mockReturnValueOnce({ allowed: false, retryAfterMs: 60_000 });
    const req = buildRequest({ body: "" });
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(429);
    expect(result.headers?.["retry-after"]).toBe("60");
    expect(runOnceMock).not.toHaveBeenCalled();
  });
});

describe("runRansomwareIntelIngestHandler — orchestrator outcome dispatch", () => {
  it("returns 202 with outcome JSON on success", async () => {
    const req = buildRequest({ body: "" });
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(202);
    expect(result.jsonBody).toMatchObject({
      schemaVersion: 1,
      runId: "r1",
      status: "success",
      victimsIngested: 3,
      pressIngested: 2,
      country: "GB",
      period: "2026-06",
    });
    // Always passes trigger=admin to the orchestrator so the audit line
    // records who ran it.
    expect(runOnceMock).toHaveBeenCalledWith(CONFIG, expect.anything(), {
      trigger: "admin",
    });
  });

  it("returns 503 with code='not_configured' when error.kind=auth_unavailable", async () => {
    runOnceMock.mockResolvedValueOnce({
      status: "error",
      runId: "r1",
      startedAt: "2026-06-25T13:00:00.000Z",
      victimsIngested: 0,
      pressIngested: 0,
      retentionRowsDeleted: 0,
      country: "GB",
      period: "2026-06",
      error: { kind: "auth_unavailable", message: "API key not configured" },
    });
    const req = buildRequest({ body: "" });
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(503);
    expect((result.jsonBody as { error: { code: string } }).error.code).toBe(
      "not_configured",
    );
  });

  it("returns 503 with code='dependency_unavailable' on generic upstream failure", async () => {
    runOnceMock.mockResolvedValueOnce({
      status: "error",
      runId: "r1",
      startedAt: "2026-06-25T13:00:00.000Z",
      victimsIngested: 0,
      pressIngested: 0,
      retentionRowsDeleted: 0,
      country: "GB",
      period: "2026-06",
      error: { kind: "5xx", message: "upstream down" },
    });
    const req = buildRequest({ body: "" });
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(503);
    expect((result.jsonBody as { error: { code: string } }).error.code).toBe(
      "dependency_unavailable",
    );
  });

  it("returns 500 when the orchestrator throws", async () => {
    runOnceMock.mockRejectedValueOnce(new Error("audit blob append failed"));
    const req = buildRequest({ body: "" });
    const result = await runRansomwareIntelIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(500);
    expect((result.jsonBody as { error: { code: string } }).error.code).toBe(
      "internal_error",
    );
  });
});
