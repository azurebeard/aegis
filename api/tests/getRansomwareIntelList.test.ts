// ADR-0037 Layer 4 — getRansomwareIntelList handler tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HttpRequest, InvocationContext } from "@azure/functions";
import type * as RIStore from "../src/lib/ransomwareIntelStore.js";
import type * as TablesMod from "../src/lib/tables.js";
import type * as ConfigMod from "../src/lib/config.js";
import type * as ClientPrincipalMod from "../src/lib/clientPrincipal.js";
import type * as AzFunctions from "@azure/functions";

const mocks = vi.hoisted(() => ({
  listAll: vi.fn(),
  listVictims: vi.fn(),
  listPress: vi.fn(),
  getTableClient: vi.fn(() => ({})),
  resolveRansomwareIntelApiConfig: vi.fn(),
  readClientPrincipal: vi.fn(),
}));

vi.mock("../src/lib/ransomwareIntelStore.js", async () => {
  const actual = await vi.importActual<typeof RIStore>(
    "../src/lib/ransomwareIntelStore.js",
  );
  return {
    ...actual,
    listAll: mocks.listAll,
    listVictims: mocks.listVictims,
    listPress: mocks.listPress,
  };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual = await vi.importActual<typeof TablesMod>(
    "../src/lib/tables.js",
  );
  return { ...actual, getTableClient: mocks.getTableClient };
});

vi.mock("../src/lib/config.js", async () => {
  const actual = await vi.importActual<typeof ConfigMod>("../src/lib/config.js");
  return {
    ...actual,
    resolveRansomwareIntelApiConfig: mocks.resolveRansomwareIntelApiConfig,
  };
});

vi.mock("../src/lib/clientPrincipal.js", async () => {
  const actual = await vi.importActual<typeof ClientPrincipalMod>(
    "../src/lib/clientPrincipal.js",
  );
  return { ...actual, readClientPrincipal: mocks.readClientPrincipal };
});

vi.mock("@azure/functions", async () => {
  const actual = await vi.importActual<typeof AzFunctions>("@azure/functions");
  return { ...actual, app: { ...actual.app, http: vi.fn(), timer: vi.fn() } };
});

const { getRansomwareIntelListHandler: handler, clampLimit } = await import(
  "../src/functions/getRansomwareIntelList.js"
);

function mkReq(query: Record<string, string> = {}): HttpRequest {
  const params = new URLSearchParams(query);
  return {
    headers: new Map<string, string>([["x-ms-client-principal", "x"]]),
    query: params,
  } as unknown as HttpRequest;
}

function mkCtx(): InvocationContext {
  return {
    invocationId: "inv-1",
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  } as unknown as InvocationContext;
}

const PRINCIPAL = Object.freeze({
  identityProvider: "aad",
  userId: "user-1",
  userDetails: "alice@example.com",
  userRoles: ["authenticated", "reader"],
});

const CONFIG = {
  apiReaderMiClientId: "api-mi",
  opsTableEndpoint: "https://fake.table.core.windows.net",
  opsBlobEndpoint: "https://fake.blob.core.windows.net",
  brandingAssetsContainer: "branding-assets",
  tenantId: "tenant-1",
  source: "external.ransomware.live",
  ransomwareIntelSource: "external.ransomware.live",
  deployAiAgents: true,
};

const VICTIM = {
  id: "v1",
  victim: "Acme",
  group: "lockbit3",
  attackDate: null,
  discoveredDate: "2026-06-20T00:00:00Z",
  country: "GB",
  sector: "",
  activity: "ransomed",
  website: "https://acme.example",
  permalink: "https://ransomware.live/p/v1",
  ingestedAt: "2026-06-25T13:00:00Z",
};

const PRESS = {
  id: "p1",
  title: "News headline",
  url: "https://news.example/1",
  publishedAt: "2026-06-22T08:00:00Z",
  source: "Example News",
  country: "GB",
  summary: "summary text",
  ingestedAt: "2026-06-25T13:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readClientPrincipal.mockResolvedValue({ ...PRINCIPAL });
  mocks.resolveRansomwareIntelApiConfig.mockReturnValue(CONFIG);
  mocks.listAll.mockResolvedValue([]);
  mocks.listVictims.mockResolvedValue([]);
  mocks.listPress.mockResolvedValue([]);
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getRansomwareIntelList — auth + rate-limit + input validation", () => {
  it("returns 401 without a client principal", async () => {
    mocks.readClientPrincipal.mockResolvedValueOnce(null);
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(401);
    expect(mocks.listAll).not.toHaveBeenCalled();
  });

  it("returns 400 when `kind` is not 'victim' or 'press'", async () => {
    const resp = await handler(mkReq({ kind: "bogus" }), mkCtx());
    expect(resp.status).toBe(400);
    expect((resp.jsonBody as { error: { code: string } }).error.code).toBe(
      "bad_request",
    );
  });
});

describe("getRansomwareIntelList — default behaviour", () => {
  it("calls listAll with the configured country (GB) when no kind filter is set", async () => {
    mocks.listAll.mockResolvedValueOnce([{ kind: "victim", ...VICTIM }]);
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(200);
    expect(mocks.listAll).toHaveBeenCalledWith(expect.anything(), CONFIG.tenantId, {
      country: "GB",
    });
  });

  it("returns 200 with an empty list when the store has no rows", async () => {
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(200);
    const body = resp.jsonBody as {
      rows: unknown[];
      page: { count: number; hasMore: boolean };
    };
    expect(body.rows).toEqual([]);
    expect(body.page.count).toBe(0);
    expect(body.page.hasMore).toBe(false);
  });

  it("maps a victim row through to the wire shape", async () => {
    mocks.listAll.mockResolvedValueOnce([{ kind: "victim", ...VICTIM }]);
    const resp = await handler(mkReq(), mkCtx());
    const body = resp.jsonBody as {
      rows: readonly {
        kind: string;
        headline: string;
        group: string;
        activity: string;
        permalink: string;
        url: string;
        summary: string;
      }[];
    };
    expect(body.rows[0]).toMatchObject({
      kind: "victim",
      headline: VICTIM.victim,
      group: VICTIM.group,
      activity: VICTIM.activity,
      permalink: VICTIM.permalink,
      // Press-only fields blank on victim rows
      url: "",
      summary: "",
    });
  });

  it("maps a press row through to the wire shape", async () => {
    mocks.listAll.mockResolvedValueOnce([{ kind: "press", ...PRESS }]);
    const resp = await handler(mkReq(), mkCtx());
    const body = resp.jsonBody as {
      rows: readonly {
        kind: string;
        headline: string;
        url: string;
        source: string;
        summary: string;
        group: string;
        activity: string;
      }[];
    };
    expect(body.rows[0]).toMatchObject({
      kind: "press",
      headline: PRESS.title,
      url: PRESS.url,
      source: PRESS.source,
      summary: PRESS.summary,
      // Victim-only fields blank on press rows
      group: "",
      activity: "",
    });
  });
});

describe("getRansomwareIntelList — kind filter dispatches to the per-kind store call", () => {
  it("kind=victim → listVictims (NOT listAll)", async () => {
    mocks.listVictims.mockResolvedValueOnce([VICTIM]);
    const resp = await handler(mkReq({ kind: "victim" }), mkCtx());
    expect(resp.status).toBe(200);
    expect(mocks.listVictims).toHaveBeenCalledTimes(1);
    expect(mocks.listAll).not.toHaveBeenCalled();
    const body = resp.jsonBody as { rows: readonly { kind: string }[] };
    expect(body.rows[0]?.kind).toBe("victim");
  });

  it("kind=press → listPress (NOT listAll)", async () => {
    mocks.listPress.mockResolvedValueOnce([PRESS]);
    const resp = await handler(mkReq({ kind: "press" }), mkCtx());
    expect(resp.status).toBe(200);
    expect(mocks.listPress).toHaveBeenCalledTimes(1);
    expect(mocks.listAll).not.toHaveBeenCalled();
    const body = resp.jsonBody as { rows: readonly { kind: string }[] };
    expect(body.rows[0]?.kind).toBe("press");
  });
});

describe("getRansomwareIntelList — pagination", () => {
  it("respects limit=N and reports hasMore=true when more rows existed", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      kind: "victim" as const,
      ...VICTIM,
      id: `v${i}`,
      discoveredDate: `2026-06-${20 - i}T00:00:00Z`,
    }));
    mocks.listAll.mockResolvedValueOnce(rows);
    const resp = await handler(mkReq({ limit: "2" }), mkCtx());
    const body = resp.jsonBody as {
      rows: unknown[];
      page: { count: number; limit: number; hasMore: boolean };
    };
    expect(body.page.limit).toBe(2);
    expect(body.page.count).toBe(2);
    expect(body.page.hasMore).toBe(true);
    expect(body.rows).toHaveLength(2);
  });

  it("hasMore=false when the store returns ≤ limit rows", async () => {
    mocks.listAll.mockResolvedValueOnce([{ kind: "victim", ...VICTIM }]);
    const resp = await handler(mkReq({ limit: "10" }), mkCtx());
    const body = resp.jsonBody as {
      page: { count: number; hasMore: boolean };
    };
    expect(body.page.count).toBe(1);
    expect(body.page.hasMore).toBe(false);
  });
});

describe("clampLimit — bounds + parsing", () => {
  it("defaults to 100 when limit is unset or empty", () => {
    expect(clampLimit(null)).toBe(100);
    expect(clampLimit("")).toBe(100);
  });
  it("defaults to 100 when limit is not numeric", () => {
    expect(clampLimit("abc")).toBe(100);
  });
  it("clamps a value above MAX (200) down to 200", () => {
    expect(clampLimit("500")).toBe(200);
  });
  it("clamps a value below MIN (1) up to 1", () => {
    expect(clampLimit("0")).toBe(1);
    expect(clampLimit("-10")).toBe(1);
  });
  it("preserves a value in range", () => {
    expect(clampLimit("50")).toBe(50);
  });
});

describe("getRansomwareIntelList — country + cache headers + store failure", () => {
  it("emits private, max-age=60 + Vary on 200", async () => {
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(200);
    const headers = resp.headers as Record<string, string>;
    expect(headers["cache-control"]).toMatch(/private, max-age=60/);
    expect(headers["vary"]).toMatch(/Cookie/);
  });

  it("returns 503 when the store throws — error detail not leaked", async () => {
    mocks.listAll.mockRejectedValueOnce(new Error("table 503"));
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(503);
    expect(JSON.stringify(resp.jsonBody)).not.toContain("table 503");
  });

  it("response country tracks THREAT_INTEL_COUNTRY env", async () => {
    vi.stubEnv("THREAT_INTEL_COUNTRY", "fr");
    const resp = await handler(mkReq(), mkCtx());
    const body = resp.jsonBody as { country: string };
    expect(body.country).toBe("FR");
    expect(mocks.listAll).toHaveBeenCalledWith(expect.anything(), CONFIG.tenantId, {
      country: "FR",
    });
  });
});
