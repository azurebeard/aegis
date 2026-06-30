// Tests for runDailyBrief.ts — SEC-M-STEP5-CODE-05 body-cap on chunked
// transfer encoding (WS10 verdict 2026-04-19 step5-code).

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted() is required — vi.mock is hoisted above top-level bindings.
const { runBriefAgentMock, readClientPrincipalMock } = vi.hoisted(() => ({
  runBriefAgentMock: vi.fn(),
  // §10.66 Phase E — legacy x-ms-client-principal header retired.
  readClientPrincipalMock: vi.fn(),
}));

vi.mock("../src/lib/runBriefAgent.js", () => ({
  runBriefAgent: runBriefAgentMock,
}));

vi.mock("../src/lib/clientPrincipal.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/clientPrincipal.js")>(
      "../src/lib/clientPrincipal.js",
    );
  return { ...actual, readClientPrincipal: readClientPrincipalMock };
});

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>(
      "@azure/functions",
    );
  return {
    ...actual,
    app: {
      ...actual.app,
      http: vi.fn(),
      timer: vi.fn(),
    },
  };
});

import { runDailyBriefHandler } from "../src/functions/runDailyBrief.js";

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

/** §10.66 — sentinel for legacy call sites; auth is now driven by
 *  readClientPrincipalMock (defaults to ADMIN_PRINCIPAL via beforeEach). */
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
    text: async () => opts.body ?? "",
  };
}

describe("runDailyBriefHandler body cap (SEC-M-STEP5-CODE-05)", () => {
  beforeEach(() => {
    runBriefAgentMock.mockReset();
    runBriefAgentMock.mockResolvedValue({
      status: "committed",
      briefDate: "2026-04-19",
      runId: "r1",
    });
    // §10.66 — default to authenticated admin. Tests that want the 401
    // path override with mockResolvedValueOnce(null).
    readClientPrincipalMock.mockReset();
    readClientPrincipalMock.mockResolvedValue({ ...ADMIN_PRINCIPAL });
  });

  it("rejects with 413 when Content-Length header exceeds cap (polite early reject)", async () => {
    const req = buildRequest({ body: "x".repeat(2000) });
    // Override content-length to declare 2000 > 1024.
    req.headers.set("content-length", "2000");
    const result = await runDailyBriefHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(413);
    expect(runBriefAgentMock).not.toHaveBeenCalled();
  });

  it("rejects with 413 when chunked body (no Content-Length) exceeds cap — closes the bypass", async () => {
    const oversized = "x".repeat(2000);
    const req = buildRequest({
      body: oversized,
      declareContentLength: false,
    });
    // Explicitly ensure no content-length header.
    req.headers.delete("content-length");
    const result = await runDailyBriefHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(413);
    expect(runBriefAgentMock).not.toHaveBeenCalled();
  });

  it("accepts a well-formed small body and dispatches the run", async () => {
    const req = buildRequest({
      body: JSON.stringify({ yyyymmdd: "2026-04-18" }),
    });
    const result = await runDailyBriefHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(202);
    expect(runBriefAgentMock).toHaveBeenCalledTimes(1);
    const args = runBriefAgentMock.mock.calls[0]?.[0] as {
      yyyymmdd?: string;
      trigger: string;
    };
    expect(args.yyyymmdd).toBe("2026-04-18");
    expect(args.trigger).toBe("admin");
  });

  it("accepts a zero-length POST (runs for today)", async () => {
    const req = buildRequest({ body: "" });
    const result = await runDailyBriefHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(202);
    expect(runBriefAgentMock).toHaveBeenCalledTimes(1);
    const args = runBriefAgentMock.mock.calls[0]?.[0] as {
      yyyymmdd?: string;
    };
    expect(args.yyyymmdd).toBeUndefined();
  });

  it("rejects with 401 when no client principal", async () => {
    readClientPrincipalMock.mockResolvedValueOnce(null);
    const req = buildRequest({ body: "" });
    const result = await runDailyBriefHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(401);
  });

  it("rejects with 400 when body is not valid JSON", async () => {
    const req = buildRequest({ body: "not-json" });
    const result = await runDailyBriefHandler(
      req as never,
      mockContext() as never,
    );
    expect(result.status).toBe(400);
  });
});
