// ADR-0037 Layer 3b — ransomware.live HTTP client tests.
// Covers: URL construction, auth-key header, retry policy, terminal error
// classification, schema-validation failure path, AIEVENT emission.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvocationContext } from "@azure/functions";
import {
  applyRetryAfterClamp,
  fetchRansomwareLivePress,
  fetchRansomwareLiveVictims,
  internals,
  RansomwareLiveFetchError,
} from "../src/lib/ransomwareLiveClient.js";

function fakeCtx(): InvocationContext {
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
  } as unknown as InvocationContext;
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function textResponse(
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers: extraHeaders });
}

const VICTIM_FIXTURE = {
  id: "QWJjLWNvcnAtMUBsb2NrYml0Mw",
  victim: "Acme Corp",
  group: "lockbit3",
  attackdate: "2026-06-15T00:00:00Z",
  discovered: "2026-06-20T00:00:00Z",
  country: "GB",
  activity: "Healthcare provider",
  website: "https://acme.example",
  permalink: "https://ransomware.live/p/abc",
};

const PRESS_FIXTURE = {
  title: "Manufacturer ransomware attack",
  url: "https://news.example/article-1",
  published: "2026-06-22T08:00:00Z",
  source: "Example News",
  country: "GB",
  summary: "Brief summary of the attack",
};

const FILTER = { country: "GB", year: 2026, month: 6 } as const;

const INGESTED_AT = "2026-06-25T13:00:00.000Z";

function liveLoader() {
  return vi.fn().mockResolvedValue({ key: "test-api-key" });
}

beforeEach(() => {
  // No global state to reset; each test wires its own injected fetch + loader.
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchRansomwareLiveVictims — URL + headers", () => {
  it("calls /victims/ with zero-padded month + query params + X-API-KEY header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, [VICTIM_FIXTURE]));
    await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
      loadApiKey: liveLoader(),
      fetchImpl,
      ingestedAtIso: INGESTED_AT,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api-pro.ransomware.live/victims/?country=GB&year=2026&month=06",
    );
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-API-KEY"]).toBe("test-api-key");
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["User-Agent"]).toContain("aegis-xdr-hub");
  });

  it("respects the baseUrl override", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, []));
    await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
      baseUrl: "https://mirror.example",
      loadApiKey: liveLoader(),
      fetchImpl,
      ingestedAtIso: INGESTED_AT,
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("https://mirror.example/victims/");
  });

  it("zero-pads single-digit month (e.g. month=3 → '03')", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, []));
    await fetchRansomwareLiveVictims(
      { country: "GB", year: 2026, month: 3 },
      fakeCtx(),
      { loadApiKey: liveLoader(), fetchImpl, ingestedAtIso: INGESTED_AT },
    );
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("month=03");
  });
});

describe("fetchRansomwareLiveVictims — happy path parsing", () => {
  it("returns schema-validated victim rows + retry stats", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, [VICTIM_FIXTURE]));
    const out = await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
      loadApiKey: liveLoader(),
      fetchImpl,
      ingestedAtIso: INGESTED_AT,
    });
    expect(out.attempts).toBe(1);
    expect(out.finalHttpStatus).toBe(200);
    expect(out.retryEvents).toHaveLength(0);
    expect(out.data).toHaveLength(1);
    expect(out.data[0]!.victim).toBe("Acme Corp");
    expect(out.data[0]!.ingestedAt).toBe(INGESTED_AT);
  });

  it("uses default ingestedAtIso when not supplied", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, [VICTIM_FIXTURE]));
    const before = Date.now();
    const out = await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
      loadApiKey: liveLoader(),
      fetchImpl,
    });
    const after = Date.now();
    const stamped = Date.parse(out.data[0]!.ingestedAt);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});

describe("fetchRansomwareLivePress — happy path parsing", () => {
  it("returns schema-validated press rows", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, [PRESS_FIXTURE]));
    const out = await fetchRansomwareLivePress(FILTER, fakeCtx(), {
      loadApiKey: liveLoader(),
      fetchImpl,
      ingestedAtIso: INGESTED_AT,
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/press/all?country=GB&year=2026&month=06");
    expect(out.data).toHaveLength(1);
    expect(out.data[0]!.title).toBe("Manufacturer ransomware attack");
    expect(out.data[0]!.publishedAt).toBe("2026-06-22T08:00:00Z");
  });
});

describe("auth-unavailable — KV loader returns null", () => {
  it.each<["env_unset" | "secret_unavailable" | "kv_403" | "kv_timeout" | "kv_read_failed"]>([
    ["env_unset"],
    ["secret_unavailable"],
    ["kv_403"],
    ["kv_timeout"],
    ["kv_read_failed"],
  ])("throws auth_unavailable carrying fallbackReason=%s — no fetch attempted", async (reason) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const loadApiKey = vi.fn().mockResolvedValue({ key: null, fallbackReason: reason });
    try {
      await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
        loadApiKey,
        fetchImpl,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RansomwareLiveFetchError);
      const e = err as RansomwareLiveFetchError;
      expect(e.kind).toBe("auth_unavailable");
      expect(e.fallbackReason).toBe(reason);
      expect(e.status).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("defaults fallbackReason to env_unset when loader returns null without one", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const loadApiKey = vi.fn().mockResolvedValue({ key: null });
    try {
      await fetchRansomwareLiveVictims(FILTER, fakeCtx(), { loadApiKey, fetchImpl });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as RansomwareLiveFetchError).fallbackReason).toBe("env_unset");
    }
  });
});

describe("terminal 4xx statuses (no retry)", () => {
  it.each([400, 401, 403, 404])(
    "throws 4xx terminal on %i (no retry, no rate-limit waste)",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(textResponse(status, "denied"));
      try {
        await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
          loadApiKey: liveLoader(),
          fetchImpl,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RansomwareLiveFetchError);
        const e = err as RansomwareLiveFetchError;
        expect(e.kind).toBe("4xx");
        expect(e.status).toBe(status);
        expect(e.attempts).toBe(1);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
});

describe("retryable statuses (backoff up to MAX_ATTEMPTS)", () => {
  it("retries on 429 then succeeds on attempt 2", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(textResponse(429, "rate-limited", { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(200, [VICTIM_FIXTURE]));
    const out = await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
      loadApiKey: liveLoader(),
      fetchImpl,
    });
    expect(out.attempts).toBe(2);
    expect(out.retryEvents).toHaveLength(1);
    expect(out.retryEvents[0]!.statusCode).toBe(429);
    expect(out.data).toHaveLength(1);
  });

  it(
    "throws throttle after MAX_ATTEMPTS of 429",
    async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(textResponse(429, "rate-limited", { "Retry-After": "0" }));
      try {
        await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
          loadApiKey: liveLoader(),
          fetchImpl,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as RansomwareLiveFetchError).kind).toBe("throttle");
        expect((err as RansomwareLiveFetchError).attempts).toBe(internals.MAX_ATTEMPTS);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(internals.MAX_ATTEMPTS);
    },
    20_000,
  );

  it(
    "throws 5xx after MAX_ATTEMPTS of 503",
    async () => {
      // 503 without Retry-After triggers the computeBackoffMs path
      // (up to 4s on attempt 2 + 8s clamped to 30s on attempt 3 — the
      // backoff is jittered so the total can exceed vitest's 5s default).
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(textResponse(503, "down"));
      try {
        await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
          loadApiKey: liveLoader(),
          fetchImpl,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as RansomwareLiveFetchError).kind).toBe("5xx");
      }
    },
    20_000,
  );

  it(
    "classifies 408 as timeout (retryable)",
    async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(textResponse(408, "slow"));
      try {
        await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
          loadApiKey: liveLoader(),
          fetchImpl,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as RansomwareLiveFetchError).kind).toBe("timeout");
      }
    },
    20_000,
  );
});

describe("network errors", () => {
  it(
    "retries on a network error then succeeds",
    async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { name: "TypeError" }))
        .mockResolvedValueOnce(jsonResponse(200, [VICTIM_FIXTURE]));
      const out = await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
        loadApiKey: liveLoader(),
        fetchImpl,
      });
      expect(out.attempts).toBe(2);
    },
    20_000,
  );

  it(
    "throws timeout when AbortError is raised on every attempt",
    async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
      try {
        await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
          loadApiKey: liveLoader(),
          fetchImpl,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as RansomwareLiveFetchError).kind).toBe("timeout");
      }
    },
    20_000,
  );

  it(
    "throws network when a transport error persists past MAX_ATTEMPTS",
    async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValue(Object.assign(new Error("ECONNRESET"), { name: "TypeError" }));
      try {
        await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
          loadApiKey: liveLoader(),
          fetchImpl,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as RansomwareLiveFetchError).kind).toBe("network");
      }
    },
    20_000,
  );
});

describe("schema invalidation (200 + bad shape)", () => {
  it("throws schema_invalid when the upstream returns an object envelope", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { value: [] }));
    try {
      await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
        loadApiKey: liveLoader(),
        fetchImpl,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as RansomwareLiveFetchError).kind).toBe("schema_invalid");
    }
  });

  it("throws schema_invalid when a victim row is missing the required id field", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, [{ victim: "no-id" }]));
    try {
      await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
        loadApiKey: liveLoader(),
        fetchImpl,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as RansomwareLiveFetchError).kind).toBe("schema_invalid");
    }
  });

  it("throws internal when the 200 body is not valid JSON", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not-json{", { status: 200 }));
    try {
      await fetchRansomwareLiveVictims(FILTER, fakeCtx(), {
        loadApiKey: liveLoader(),
        fetchImpl,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as RansomwareLiveFetchError).kind).toBe("internal");
    }
  });
});

describe("applyRetryAfterClamp", () => {
  it("returns appliedMs=0 when no header", () => {
    const r = applyRetryAfterClamp(null, 1);
    expect(r.appliedMs).toBe(0);
    expect(r.clamped).toBe(false);
  });

  it("returns appliedMs=0 when header is not a valid integer", () => {
    const r = applyRetryAfterClamp("Wed, 21 Oct 2025 07:28:00 GMT", 1);
    expect(r.appliedMs).toBe(0);
  });

  it("clamps an oversized retry-after to RETRY_AFTER_HARD_CAP_MS", () => {
    const r = applyRetryAfterClamp("600", 1); // 600s requested
    expect(r.appliedMs).toBe(internals.RETRY_AFTER_HARD_CAP_MS);
    expect(r.clamped).toBe(true);
  });

  it("honours a small retry-after verbatim", () => {
    const r = applyRetryAfterClamp("3", 1);
    expect(r.appliedMs).toBe(3000);
    expect(r.clamped).toBe(false);
  });
});
