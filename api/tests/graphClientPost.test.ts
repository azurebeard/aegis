// ADR-0030 Phase C §C.17 — graphPostJsonWithRetry behaviour with mocked fetch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { graphPostJsonWithRetry, GraphFetchError } from "../src/lib/graphClient.js";

// Mock the token acquirer so tests don't try to call IMDS. graphClient uses
// `new DefaultAzureCredential(...)`, so the export must be a real constructor.
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    async getToken() {
      return { token: "fake-token", expiresOnTimestamp: Date.now() + 1_000_000 };
    }
  },
}));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fakeCtx() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    invocationId: "x",
    functionName: "x",
    extraInputs: { get: vi.fn(), set: vi.fn() },
    extraOutputs: { get: vi.fn(), set: vi.fn() },
    options: {},
    triggerMetadata: {},
  } as unknown as import("@azure/functions").InvocationContext;
}

const options = {
  managedIdentityClientId: "mi-1",
  graphBaseUrl: "https://graph.microsoft.com/v1.0",
  leaseWindowMs: 60_000,
};

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function emptyResponse(status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: extraHeaders });
}

describe("graphPostJsonWithRetry", () => {
  it("returns parsed body on 201", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "abc" }));
    const r = await graphPostJsonWithRetry<unknown, { id: string }>(
      "https://graph.microsoft.com/v1.0/test",
      { foo: 1 },
      options,
      fakeCtx(),
    );
    expect(r.data?.id).toBe("abc");
    expect(r.finalHttpStatus).toBe(201);
    expect(r.attempts).toBe(1);
  });

  it("returns null data on 202 (empty body — send-draft response)", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(202));
    const r = await graphPostJsonWithRetry<unknown, unknown>(
      "https://graph.microsoft.com/v1.0/test",
      {},
      options,
      fakeCtx(),
    );
    expect(r.data).toBeNull();
    expect(r.finalHttpStatus).toBe(202);
  });

  it("returns null data on 204", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    const r = await graphPostJsonWithRetry<unknown, unknown>(
      "https://graph.microsoft.com/v1.0/test",
      {},
      options,
      fakeCtx(),
    );
    expect(r.data).toBeNull();
  });

  it("throws GraphFetchError 4xx for 400/401/403/404 (terminal)", async () => {
    for (const status of [400, 401, 403, 404]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "Bad" } }), { status }),
      );
      try {
        await graphPostJsonWithRetry(
          "https://graph.microsoft.com/v1.0/test",
          {},
          options,
          fakeCtx(),
        );
        throw new Error(`expected throw for status ${status}`);
      } catch (err) {
        expect(err).toBeInstanceOf(GraphFetchError);
        expect((err as GraphFetchError).kind).toBe("4xx");
        expect((err as GraphFetchError).status).toBe(status);
      }
    }
  });

  it("retries on 429 with Retry-After", async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(429, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "after-retry" }));
    const r = await graphPostJsonWithRetry<unknown, { id: string }>(
      "https://graph.microsoft.com/v1.0/test",
      {},
      options,
      fakeCtx(),
    );
    expect(r.data?.id).toBe("after-retry");
    expect(r.attempts).toBe(2);
  });

  it("retries on 5xx then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(jsonResponse(201, { id: "k" }));
    const r = await graphPostJsonWithRetry<unknown, { id: string }>(
      "https://graph.microsoft.com/v1.0/test",
      {},
      options,
      fakeCtx(),
    );
    expect(r.data?.id).toBe("k");
    expect(r.attempts).toBe(2);
  });

  it("throws after MAX_ATTEMPTS for persistent 5xx", async () => {
    fetchMock.mockResolvedValue(emptyResponse(503));
    try {
      await graphPostJsonWithRetry(
        "https://graph.microsoft.com/v1.0/test",
        {},
        options,
        fakeCtx(),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphFetchError);
      expect((err as GraphFetchError).kind).toBe("5xx");
      expect((err as GraphFetchError).attempts).toBe(3);
    }
  });

  it("forwards extraHeaders verbatim (e.g. client-request-id)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "h" }));
    await graphPostJsonWithRetry(
      "https://graph.microsoft.com/v1.0/test",
      {},
      options,
      fakeCtx(),
      { extraHeaders: { "client-request-id": "test-uuid-123" } },
    );
    const call = fetchMock.mock.calls[0]!;
    const initArg = call[1] as RequestInit;
    const headers = initArg.headers as Record<string, string>;
    expect(headers["client-request-id"]).toBe("test-uuid-123");
  });

  it("sends Content-Type: application/json and serialised body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: "h" }));
    await graphPostJsonWithRetry(
      "https://graph.microsoft.com/v1.0/test",
      { hello: "world", n: 5 },
      options,
      fakeCtx(),
    );
    const call = fetchMock.mock.calls[0]!;
    const initArg = call[1] as RequestInit;
    expect((initArg.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(initArg.body).toBe(JSON.stringify({ hello: "world", n: 5 }));
    expect(initArg.method).toBe("POST");
  });

  // ─── Slice 1(b) WS10 MEDIUM #4 — coverage gaps ───────────────────────────

  it("does not retry on AbortError when retryOnTransport=false", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValue(abortErr);
    try {
      await graphPostJsonWithRetry(
        "https://graph.microsoft.com/v1.0/test",
        {},
        options,
        fakeCtx(),
        { retryOnTransport: false },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphFetchError);
      expect((err as GraphFetchError).kind).toBe("timeout");
      expect((err as GraphFetchError).attempts).toBe(1);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does retry on AbortError when retryOnTransport=true (default)", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(jsonResponse(201, { id: "after-retry" }));
    const r = await graphPostJsonWithRetry<unknown, { id: string }>(
      "https://graph.microsoft.com/v1.0/test",
      {},
      options,
      fakeCtx(),
    );
    expect(r.data?.id).toBe("after-retry");
    expect(r.attempts).toBe(2);
  });

  it("wraps non-JSON 2xx body in GraphFetchError (not raw SyntaxError)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not-json-at-all{{}", { status: 201 }),
    );
    try {
      await graphPostJsonWithRetry(
        "https://graph.microsoft.com/v1.0/test",
        {},
        options,
        fakeCtx(),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GraphFetchError);
      expect((err as GraphFetchError).kind).toBe("internal");
      expect((err as GraphFetchError).status).toBe(201);
    }
  });
});
