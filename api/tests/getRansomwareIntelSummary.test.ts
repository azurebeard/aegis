// ADR-0037 Layer 4 — getRansomwareIntelSummary handler tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HttpRequest, InvocationContext } from "@azure/functions";
import type * as IngestHealthMod from "../src/lib/ingestHealth.js";
import type * as RIStore from "../src/lib/ransomwareIntelStore.js";
import type * as TablesMod from "../src/lib/tables.js";
import type * as ConfigMod from "../src/lib/config.js";
import type * as ClientPrincipalMod from "../src/lib/clientPrincipal.js";
import type * as AzFunctions from "@azure/functions";

const mocks = vi.hoisted(() => ({
  readHealthRow: vi.fn(),
  listAll: vi.fn(),
  getTableClient: vi.fn(() => ({})),
  resolveRansomwareIntelApiConfig: vi.fn(),
  readClientPrincipal: vi.fn(),
}));

vi.mock("../src/lib/ingestHealth.js", async () => {
  const actual = await vi.importActual<typeof IngestHealthMod>(
    "../src/lib/ingestHealth.js",
  );
  return { ...actual, readHealthRow: mocks.readHealthRow };
});

vi.mock("../src/lib/ransomwareIntelStore.js", async () => {
  const actual = await vi.importActual<typeof RIStore>(
    "../src/lib/ransomwareIntelStore.js",
  );
  return { ...actual, listAll: mocks.listAll };
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

const { getRansomwareIntelSummaryHandler: handler } = await import(
  "../src/functions/getRansomwareIntelSummary.js"
);

function mkReq(): HttpRequest {
  return {
    headers: new Map<string, string>([["x-ms-client-principal", "x"]]),
    query: new URLSearchParams(),
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

const HEALTHY_ROW = {
  tenantId: "tenant-1",
  source: "external.ransomware.live",
  status: "healthy",
  lastSuccessAt: "2026-06-25T13:00:00.000Z",
  lastFailureAt: null,
  consecutiveFailureCount: 0,
  lastRunId: "run-1",
  lastAuditSeq: 8,
  lastLineSha256: "deadbeef".padEnd(64, "f"),
  lastCursor: "",
  updatedAt: "2026-06-25T13:00:00.000Z",
  etag: 'W/"e1"',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readClientPrincipal.mockResolvedValue({ ...PRINCIPAL });
  mocks.resolveRansomwareIntelApiConfig.mockReturnValue(CONFIG);
  mocks.listAll.mockResolvedValue([]);
  mocks.readHealthRow.mockResolvedValue(HEALTHY_ROW);
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getRansomwareIntelSummary — auth gate", () => {
  it("returns 401 without a client principal", async () => {
    mocks.readClientPrincipal.mockResolvedValueOnce(null);
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(401);
    expect(mocks.listAll).not.toHaveBeenCalled();
  });
});

describe("getRansomwareIntelSummary — empty / new tenant states", () => {
  it("awaiting_first_run when IngestHealth is null", async () => {
    mocks.readHealthRow.mockResolvedValueOnce(null);
    mocks.listAll.mockResolvedValueOnce([]);
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(200);
    const body = resp.jsonBody as { health: { status: string }; counts: { victimsThisMonth: number } };
    expect(body.health.status).toBe("awaiting_first_run");
    expect(body.counts.victimsThisMonth).toBe(0);
  });

  it("no_data when health is healthy but month is empty", async () => {
    mocks.listAll.mockResolvedValueOnce([]);
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(200);
    const body = resp.jsonBody as { health: { status: string } };
    expect(body.health.status).toBe("no_data");
  });

  it("surfaces the underlying health.status (degrading) verbatim when month has rows", async () => {
    // ADR-0037 Layer 3c: auth_unavailable → IngestHealth degrading on the
    // first failure. Even with no rows this month, we want the underlying
    // status surfaced (not masked behind 'no_data') so the SPA's tile
    // hint can route the operator to admin.
    mocks.readHealthRow.mockResolvedValueOnce({ ...HEALTHY_ROW, status: "degrading", consecutiveFailureCount: 1 });
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    mocks.listAll.mockResolvedValueOnce([
      {
        kind: "victim",
        id: "x",
        victim: "Acme",
        group: "lockbit3",
        attackDate: null,
        discoveredDate: `${yyyy}-${mm}-15T00:00:00Z`,
        country: "GB",
        sector: "",
        activity: "",
        website: "",
        permalink: "",
        ingestedAt: `${yyyy}-${mm}-15T13:00:00Z`,
      },
    ]);
    const resp = await handler(mkReq(), mkCtx());
    const body = resp.jsonBody as { health: { status: string; consecutiveFailures: number } };
    expect(body.health.status).toBe("degrading");
    expect(body.health.consecutiveFailures).toBe(1);
  });
});

describe("getRansomwareIntelSummary — counts + mostRecentVictim derivation", () => {
  it("aggregates current-month counts + surfaces most recent victim", async () => {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    mocks.listAll.mockResolvedValueOnce([
      {
        kind: "victim",
        id: "v1",
        victim: "Earlier Co",
        group: "lockbit3",
        attackDate: null,
        discoveredDate: `${yyyy}-${mm}-05T00:00:00Z`,
        country: "GB",
        sector: "",
        activity: "",
        website: "",
        permalink: "",
        ingestedAt: `${yyyy}-${mm}-05T13:00:00Z`,
      },
      {
        kind: "victim",
        id: "v2",
        victim: "Latest Co",
        group: "blackbasta",
        attackDate: null,
        discoveredDate: `${yyyy}-${mm}-20T00:00:00Z`,
        country: "GB",
        sector: "",
        activity: "",
        website: "",
        permalink: "",
        ingestedAt: `${yyyy}-${mm}-20T13:00:00Z`,
      },
      {
        kind: "press",
        id: "p1",
        title: "News",
        url: "https://news.example/1",
        publishedAt: `${yyyy}-${mm}-10T00:00:00Z`,
        source: "News",
        country: "GB",
        summary: "",
        ingestedAt: `${yyyy}-${mm}-10T13:00:00Z`,
      },
    ]);
    const resp = await handler(mkReq(), mkCtx());
    const body = resp.jsonBody as {
      counts: {
        victimsThisMonth: number;
        pressThisMonth: number;
        distinctGroupsThisMonth: number;
      };
      mostRecentVictim: { victim: string; group: string } | null;
    };
    expect(body.counts.victimsThisMonth).toBe(2);
    expect(body.counts.pressThisMonth).toBe(1);
    expect(body.counts.distinctGroupsThisMonth).toBe(2);
    expect(body.mostRecentVictim?.victim).toBe("Latest Co");
    expect(body.mostRecentVictim?.group).toBe("blackbasta");
  });
});

describe("getRansomwareIntelSummary — country + cache headers", () => {
  it("surfaces the configured country (GB default)", async () => {
    const resp = await handler(mkReq(), mkCtx());
    const body = resp.jsonBody as { country: string };
    expect(body.country).toBe("GB");
    // listAll called with country filter
    expect(mocks.listAll).toHaveBeenCalledWith(expect.anything(), CONFIG.tenantId, { country: "GB" });
  });

  it("upper-cases a lower-case THREAT_INTEL_COUNTRY env var", async () => {
    vi.stubEnv("THREAT_INTEL_COUNTRY", "us");
    const resp = await handler(mkReq(), mkCtx());
    expect((resp.jsonBody as { country: string }).country).toBe("US");
  });

  it("emits private, max-age=30 + Vary on 200", async () => {
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(200);
    const cc = resp.headers as Record<string, string>;
    expect(cc["cache-control"]).toMatch(/private, max-age=30/);
    expect(cc["vary"]).toMatch(/Cookie/);
  });
});

describe("getRansomwareIntelSummary — store failure", () => {
  it("returns 503 + dependency_unavailable when listAll throws", async () => {
    mocks.listAll.mockRejectedValueOnce(new Error("table 503"));
    const resp = await handler(mkReq(), mkCtx());
    expect(resp.status).toBe(503);
    expect((resp.jsonBody as { error: { code: string } }).error.code).toBe(
      "dependency_unavailable",
    );
    // The raw upstream message must NOT leak through to the response body.
    expect(JSON.stringify(resp.jsonBody)).not.toContain("table 503");
  });
});
