// ADR-0037 Option B (HANDOVER §6.3) — admin key-rotation handler tests.
// Mirrors runRansomwareIntelIngestHandler.test.ts shape.
//
// Coverage:
//   * Auth gate (401 on missing principal).
//   * Body / query / size hygiene (400 / 413).
//   * apiKey schema (string required, non-empty, ≤ 256 bytes).
//   * Rate limit (429 with retry-after header).
//   * Rotation lib outcomes mapped to correct HTTP status:
//      - rotated → 200 with JSON envelope
//      - validation_failed → 502 + scrubbed message (no key echo)
//      - env_unset → 502 not_configured
//      - kv_403 / kv_write_failed → 503 dependency_unavailable
//   * AIEVENT emission on success + failure (no key material in props).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RansomwareIntelIngestConfig } from "../src/lib/config.js";
import type * as ClientPrincipalMod from "../src/lib/clientPrincipal.js";
import type * as ConfigMod from "../src/lib/config.js";
import type * as RateLimitMod from "../src/lib/rateLimit.js";
import type * as AievntMod from "../src/lib/aievent.js";
import type * as AzFunctions from "@azure/functions";

const {
  rotateMock,
  resolveConfigMock,
  rateLimiterCheckMock,
  readClientPrincipalMock,
  emitAieventMock,
} = vi.hoisted(() => ({
  rotateMock: vi.fn(),
  resolveConfigMock: vi.fn(),
  rateLimiterCheckMock: vi.fn(),
  readClientPrincipalMock: vi.fn(),
  emitAieventMock: vi.fn(),
}));

vi.mock("../src/lib/rotateRansomwareLiveApiKey.js", () => ({
  rotateRansomwareLiveApiKey: rotateMock,
}));

vi.mock("../src/lib/clientPrincipal.js", async () => {
  const actual = await vi.importActual<typeof ClientPrincipalMod>(
    "../src/lib/clientPrincipal.js",
  );
  return { ...actual, readClientPrincipal: readClientPrincipalMock };
});

vi.mock("../src/lib/config.js", async () => {
  const actual = await vi.importActual<typeof ConfigMod>("../src/lib/config.js");
  return { ...actual, resolveRansomwareIntelIngestConfig: resolveConfigMock };
});

vi.mock("../src/lib/rateLimit.js", async () => {
  const actual = await vi.importActual<typeof RateLimitMod>("../src/lib/rateLimit.js");
  return {
    ...actual,
    ransomwareIntelKeyRotateRateLimiter: { check: rateLimiterCheckMock },
  };
});

vi.mock("../src/lib/aievent.js", async () => {
  const actual = await vi.importActual<typeof AievntMod>("../src/lib/aievent.js");
  return { ...actual, emitAievent: emitAieventMock };
});

vi.mock("@azure/functions", async () => {
  const actual = await vi.importActual<typeof AzFunctions>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

import { rotateRansomwareIntelKeyHandler } from "../src/functions/rotateRansomwareIntelKey.js";

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
    set: (k: string, v: string) => store.set(k.toLowerCase(), v),
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
  rotateMock.mockReset();
  resolveConfigMock.mockReset();
  rateLimiterCheckMock.mockReset();
  readClientPrincipalMock.mockReset();
  emitAieventMock.mockReset();
  resolveConfigMock.mockReturnValue(CONFIG);
  rateLimiterCheckMock.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  rotateMock.mockResolvedValue({
    status: "rotated",
    rotatedAt: "2026-06-29T20:00:00.000Z",
    version: "v-12345",
    validateStatus: 200,
  });
  readClientPrincipalMock.mockResolvedValue({ ...ADMIN_PRINCIPAL });
});

describe("rotateRansomwareIntelKeyHandler — auth gate", () => {
  it("returns 401 when no client principal", async () => {
    readClientPrincipalMock.mockResolvedValueOnce(null);
    const req = buildRequest({ body: JSON.stringify({ apiKey: "valid" }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(401);
    expect(rotateMock).not.toHaveBeenCalled();
  });
});

describe("rotateRansomwareIntelKeyHandler — request hygiene", () => {
  it("400 on non-empty query string", async () => {
    const req = buildRequest({ body: "", queryKeys: ["foo"] });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(400);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("413 on Content-Length > 1024", async () => {
    const req = buildRequest({ body: "x".repeat(2000) });
    req.headers.set("content-length", "2000");
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(413);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const req = buildRequest({ body: "not-json" });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(400);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("400 when apiKey is missing", async () => {
    const req = buildRequest({ body: JSON.stringify({}) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(400);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("400 when apiKey is not a string", async () => {
    const req = buildRequest({ body: JSON.stringify({ apiKey: 123 }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(400);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("400 when apiKey is empty / whitespace", async () => {
    const req = buildRequest({ body: JSON.stringify({ apiKey: "   " }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(400);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("400 when apiKey > 256 bytes", async () => {
    const req = buildRequest({ body: JSON.stringify({ apiKey: "x".repeat(300) }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(400);
    expect(rotateMock).not.toHaveBeenCalled();
  });
});

describe("rotateRansomwareIntelKeyHandler — rate limit", () => {
  it("429 when limiter denies, with retry-after header", async () => {
    rateLimiterCheckMock.mockReturnValueOnce({ allowed: false, retryAfterMs: 7200_000 });
    const req = buildRequest({ body: JSON.stringify({ apiKey: "valid-key" }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(429);
    expect((res.headers as Record<string, string>)["retry-after"]).toBe("7200");
    expect(rotateMock).not.toHaveBeenCalled();
  });
});

describe("rotateRansomwareIntelKeyHandler — outcome mapping", () => {
  it("200 + envelope on rotated; emits RansomwareIntelKeyRotated AIEVENT (no key material)", async () => {
    const req = buildRequest({ body: JSON.stringify({ apiKey: "valid-key" }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { status: string; version: string };
    expect(body.status).toBe("rotated");
    expect(body.version).toBe("v-12345");
    expect(emitAieventMock).toHaveBeenCalledWith(
      expect.anything(),
      "RansomwareIntelKeyRotated",
      expect.objectContaining({
        tenantId: "tenant-1",
        source: "external.ransomware.live",
        version: "v-12345",
      }),
    );
    // Defense in depth: the emitted props must NEVER include the api key.
    const props = (emitAieventMock.mock.calls[0]?.[2] ?? {}) as Record<string, unknown>;
    expect(Object.values(props)).not.toContain("valid-key");
  });

  it("502 validation_failed when ransomware.live rejects the key", async () => {
    rotateMock.mockResolvedValueOnce({
      status: "failed",
      kind: "validation_failed",
      validateStatus: 401,
    });
    const req = buildRequest({ body: JSON.stringify({ apiKey: "bad-key" }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(502);
    expect((res.jsonBody as { error: { code: string; message: string } }).error.code).toBe(
      "validation_failed",
    );
    // Defense in depth: the response message must NEVER echo the key.
    const msg = (res.jsonBody as { error: { message: string } }).error.message;
    expect(msg).not.toContain("bad-key");
    expect(emitAieventMock).toHaveBeenCalledWith(
      expect.anything(),
      "RansomwareIntelKeyRotateFailed",
      expect.objectContaining({ kind: "validation_failed", validateStatus: 401 }),
    );
  });

  it("502 not_configured when env_unset", async () => {
    rotateMock.mockResolvedValueOnce({ status: "failed", kind: "env_unset" });
    const req = buildRequest({ body: JSON.stringify({ apiKey: "valid-key" }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(502);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe("not_configured");
  });

  it("503 dependency_unavailable on kv_403", async () => {
    rotateMock.mockResolvedValueOnce({
      status: "failed",
      kind: "kv_403",
      errorDetail: "RestError 403",
    });
    const req = buildRequest({ body: JSON.stringify({ apiKey: "valid-key" }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(503);
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe(
      "dependency_unavailable",
    );
  });

  it("503 dependency_unavailable on kv_write_failed", async () => {
    rotateMock.mockResolvedValueOnce({
      status: "failed",
      kind: "kv_write_failed",
      errorDetail: "RestError 500",
    });
    const req = buildRequest({ body: JSON.stringify({ apiKey: "valid-key" }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(503);
  });

  it("500 internal_error when rotation library throws", async () => {
    rotateMock.mockRejectedValueOnce(new Error("boom"));
    const req = buildRequest({ body: JSON.stringify({ apiKey: "valid-key" }) });
    const res = await rotateRansomwareIntelKeyHandler(req as never, mockContext() as never);
    expect(res.status).toBe(500);
  });
});
