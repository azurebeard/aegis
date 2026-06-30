// Tests for runEntraRiskIngest.ts (the HTTP handler) —
// SEC-M-STEP6-CODE-01 body-cap on chunked transfer encoding (WS10 verdict
// 2026-04-19 step6-code). Mirrors the runDailyBrief handler-test shape.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EntraRiskIngestConfig } from "../src/lib/config.js";

const {
  runEntraRiskIngestOnceMock,
  resolveConfigMock,
  rateLimiterCheckMock,
  readClientPrincipalMock,
} = vi.hoisted(() => ({
  runEntraRiskIngestOnceMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  rateLimiterCheckMock: vi.fn(),
  // §10.66 Phase E — legacy x-ms-client-principal header retired.
  readClientPrincipalMock: vi.fn(),
}));

vi.mock("../src/lib/runEntraRiskIngest.js", () => ({
  runEntraRiskIngestOnce: runEntraRiskIngestOnceMock,
}));

vi.mock("../src/lib/clientPrincipal.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/clientPrincipal.js")>(
      "../src/lib/clientPrincipal.js",
    );
  return { ...actual, readClientPrincipal: readClientPrincipalMock };
});

vi.mock("../src/lib/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/config.js")>(
    "../src/lib/config.js",
  );
  return {
    ...actual,
    resolveEntraRiskIngestConfig: resolveConfigMock,
  };
});

vi.mock("../src/lib/rateLimit.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/rateLimit.js")>(
    "../src/lib/rateLimit.js",
  );
  return {
    ...actual,
    entraRiskAdminRunRateLimiter: { check: rateLimiterCheckMock },
  };
});

// `app.http` registration has a side effect at module load — stub it out so
// the import is side-effect-safe in tests.
vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: {
      ...actual.app,
      http: vi.fn(),
      timer: vi.fn(),
    },
  };
});

import { runEntraRiskIngestHandler } from "../src/functions/runEntraRiskIngest.js";

const CONFIG: EntraRiskIngestConfig = {
  ingestMiClientId: "mi-ingest",
  auditMiClientId: "mi-audit",
  apiReaderMiClientId: "mi-api",
  opsTableEndpoint: "https://fake.table.core.windows.net",
  auditBlobEndpoint: "https://fake.blob.core.windows.net",
  auditContainerName: "audit",
  graphBaseUrl: "https://graph.microsoft.com/v1.0",
  graphApiTimeoutMs: 30_000,
  tenantId: "tenant-1",
  leaseWindowMs: 300_000,
  source: "graph.security.riskyUsers",
  entraRiskTimerCron: "0 0 */4 * * *",
  entraRiskRetentionDays: 180,
  cursorOverlapMs: 120_000,
  cursorWriteSkewAllowanceMs: 300_000,
  cursorReadCorruptThresholdMs: 3_600_000,
  firstRunSeedBackSeekMs: 86_400_000,
  pageSize: 500,
  adminDailyRunCeiling: 30,
};

function mockContext(): {
  invocationId: string;
  log: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return {
    invocationId: "test-inv-1",
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

/** §10.66 sentinel; auth driven by readClientPrincipalMock. */
function principalHeader(): string {
  return "PHASE_E_PRINCIPAL_VIA_MOCK";
}

interface HeaderStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

function buildRequest(opts: {
  body?: string;
  declareContentLength?: boolean;
}): {
  headers: HeaderStore;
  query: { keys(): Iterable<string> };
  text: () => Promise<string>;
} {
  const store = new Map<string, string>();
  store.set("x-ms-client-principal", principalHeader());
  if (opts.body !== undefined && opts.declareContentLength !== false) {
    store.set(
      "content-length",
      Buffer.byteLength(opts.body, "utf-8").toString(),
    );
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
  return {
    headers,
    query: { keys: () => [][Symbol.iterator]() },
    text: async () => opts.body ?? "",
  };
}

describe("runEntraRiskIngestHandler body cap (SEC-M-STEP6-CODE-01)", () => {
  beforeEach(() => {
    runEntraRiskIngestOnceMock.mockReset();
    resolveConfigMock.mockReset();
    rateLimiterCheckMock.mockReset();
    readClientPrincipalMock.mockReset();
    resolveConfigMock.mockReturnValue(CONFIG);
    rateLimiterCheckMock.mockReturnValue({ allowed: true, retryAfterMs: 0 });
    runEntraRiskIngestOnceMock.mockResolvedValue({
      status: "success",
      runId: "r1",
      startedAt: "2026-04-19T00:00:00.000Z",
      riskyUsersIngested: 0,
      riskyUsersProcessing: 0,
      licenceState: "present",
    });
    // §10.66 — default to authenticated admin.
    readClientPrincipalMock.mockResolvedValue({ ...ADMIN_PRINCIPAL });
  });

  it("rejects with 413 when Content-Length header exceeds cap (polite early reject)", async () => {
    const req = buildRequest({ body: "x".repeat(2000) });
    // Override content-length to declare 2000 > 1024.
    req.headers.set("content-length", "2000");
    const result = await runEntraRiskIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(413);
    expect(runEntraRiskIngestOnceMock).not.toHaveBeenCalled();
  });

  it("rejects with 413 when chunked body (no Content-Length) exceeds cap — closes the bypass", async () => {
    const oversized = "x".repeat(2000);
    const req = buildRequest({
      body: oversized,
      declareContentLength: false,
    });
    // Explicitly ensure no content-length header.
    req.headers.delete("content-length");
    const result = await runEntraRiskIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(413);
    expect(runEntraRiskIngestOnceMock).not.toHaveBeenCalled();
  });

  it("accepts an empty body and dispatches the run", async () => {
    const req = buildRequest({ body: "" });
    const result = await runEntraRiskIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(202);
    expect(runEntraRiskIngestOnceMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with 401 when no client principal", async () => {
    readClientPrincipalMock.mockResolvedValueOnce(null);
    const req = buildRequest({ body: "" });
    const result = await runEntraRiskIngestHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(401);
  });
});
