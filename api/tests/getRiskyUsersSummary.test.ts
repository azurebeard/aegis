import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HttpRequest, InvocationContext } from "@azure/functions";

// Mock deps BEFORE importing the handler (hoisted via vi.hoisted()).
const mocks = vi.hoisted(() => ({
  readHealthRow: vi.fn(),
  readRiskyUsersCounts: vi.fn(),
  getTableClient: vi.fn(() => ({})),
  resolveEntraRiskApiConfig: vi.fn(() => ({
    apiReaderMiClientId: "api-mi",
    opsTableEndpoint: "https://fake.table.core.windows.net",
    tenantId: "tenant-1",
    source: "graph.security.riskyUsers",
    entraRiskSource: "graph.security.riskyUsers",
  })),
  readClientPrincipal: vi.fn(),
}));

vi.mock("../src/lib/ingestHealth.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ingestHealth.js")>(
    "../src/lib/ingestHealth.js",
  );
  return { ...actual, readHealthRow: mocks.readHealthRow };
});

vi.mock("../src/lib/entraRiskStore.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/entraRiskStore.js")>(
    "../src/lib/entraRiskStore.js",
  );
  return { ...actual, readRiskyUsersCounts: mocks.readRiskyUsersCounts };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tables.js")>(
    "../src/lib/tables.js",
  );
  return { ...actual, getTableClient: mocks.getTableClient };
});

vi.mock("../src/lib/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/config.js")>(
    "../src/lib/config.js",
  );
  return { ...actual, resolveEntraRiskApiConfig: mocks.resolveEntraRiskApiConfig };
});

vi.mock("../src/lib/clientPrincipal.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/clientPrincipal.js")>(
    "../src/lib/clientPrincipal.js",
  );
  return { ...actual, readClientPrincipal: mocks.readClientPrincipal };
});

// Stub the @azure/functions app.http registration so importing the handler
// doesn't try to register with a live Functions runtime.
vi.mock("@azure/functions", async () => {
  const actual = await vi.importActual<typeof import("@azure/functions")>(
    "@azure/functions",
  );
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

// Import after mocks.
const handlerModule = await import("../src/functions/getRiskyUsersSummary.js");
const app = await import("@azure/functions");
// Extract the handler: app.http is called in the module body with ("getRiskyUsersSummary", {handler}).
const [, opts] = (app.app.http as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
  (c) => c[0] === "getRiskyUsersSummary",
) as [string, { handler: (req: HttpRequest, ctx: InvocationContext) => Promise<unknown> }];
const summaryHandler = opts.handler;
void handlerModule;

function mkReq(): HttpRequest {
  return {
    headers: new Map<string, string>([["x-ms-client-principal", "x"]]),
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

function mkCtx(): InvocationContext {
  return {
    invocationId: "inv-1",
    log: vi.fn() as unknown as InvocationContext["log"],
    warn: vi.fn() as unknown as InvocationContext["warn"],
    error: vi.fn() as unknown as InvocationContext["error"],
    info: vi.fn() as unknown as InvocationContext["info"],
  } as unknown as InvocationContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readClientPrincipal.mockReturnValue({
    identityProvider: "aad",
    userId: "user-1",
    userDetails: "alice",
    userRoles: ["authenticated", "reader"],
  });
});

describe("getRiskyUsersSummary", () => {
  it("returns 401 without a client principal", async () => {
    mocks.readClientPrincipal.mockReturnValue(null);
    const resp = (await summaryHandler(mkReq(), mkCtx())) as {
      status: number;
    };
    expect(resp.status).toBe(401);
  });

  it("empty tenant → awaiting_first_run", async () => {
    mocks.readHealthRow.mockResolvedValue(null);
    mocks.readRiskyUsersCounts.mockResolvedValue({
      total: 0,
      byRiskLevel: { low: 0, medium: 0, high: 0, hidden: 0, none: 0, unknown: 0 },
      byRiskState: {
        none: 0,
        atRisk: 0,
        confirmedSafe: 0,
        confirmedCompromised: 0,
        remediated: 0,
        dismissed: 0,
        unknown: 0,
      },
      processing: 0,
      softDeleted: 0,
      mostRecent: null,
      latestIngestedAt: null,
    });
    const resp = (await summaryHandler(mkReq(), mkCtx())) as {
      status: number;
      jsonBody: { health: { status: string } };
      headers: Record<string, string>;
    };
    expect(resp.status).toBe(200);
    expect(resp.jsonBody.health.status).toBe("awaiting_first_run");
    expect(resp.headers["cache-control"]).toMatch(/max-age=60/);
  });

  it("licence_required → 200 + null counts + 1h cache-control (WS10 SEC-M-ADR-24-01)", async () => {
    mocks.readHealthRow.mockResolvedValue({
      tenantId: "tenant-1",
      source: "graph.security.riskyUsers",
      status: "licence_required",
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailureCount: 0,
      lastRunId: null,
      lastAuditSeq: 1,
      lastLineSha256: "",
      lastCursor: "",
      updatedAt: "2026-04-19T00:00:00.000Z",
      etag: "e",
    });
    const resp = (await summaryHandler(mkReq(), mkCtx())) as {
      status: number;
      jsonBody: { counts: unknown; mostRecent: unknown; health: { status: string } };
      headers: Record<string, string>;
    };
    expect(resp.status).toBe(200);
    expect(resp.jsonBody.counts).toBeNull();
    expect(resp.jsonBody.mostRecent).toBeNull();
    expect(resp.jsonBody.health.status).toBe("licence_required");
    expect(resp.headers["cache-control"]).toMatch(/max-age=3600/);
    // Counts should NOT have been queried when licence_required.
    expect(mocks.readRiskyUsersCounts).not.toHaveBeenCalled();
  });

  it("healthy path → counts + mostRecent + 60s cache-control", async () => {
    mocks.readHealthRow.mockResolvedValue({
      tenantId: "tenant-1",
      source: "graph.security.riskyUsers",
      status: "healthy",
      lastSuccessAt: "2026-04-19T00:00:00.000Z",
      lastFailureAt: null,
      consecutiveFailureCount: 0,
      lastRunId: "r",
      lastAuditSeq: 1,
      lastLineSha256: "hash",
      lastCursor: "2026-04-18T22:00:00.000Z",
      updatedAt: "2026-04-19T00:00:00.000Z",
      etag: "e",
    });
    mocks.readRiskyUsersCounts.mockResolvedValue({
      total: 3,
      byRiskLevel: { low: 1, medium: 1, high: 1, hidden: 0, none: 0, unknown: 0 },
      byRiskState: {
        none: 0,
        atRisk: 3,
        confirmedSafe: 0,
        confirmedCompromised: 0,
        remediated: 0,
        dismissed: 0,
        unknown: 0,
      },
      processing: 0,
      softDeleted: 0,
      mostRecent: {
        id: "u1",
        userPrincipalName: "alice@contoso.com",
        userDisplayName: "Alice",
        riskLevel: "high",
        riskState: "atRisk",
        riskDetail: "unfamiliarFeatures",
        riskLastUpdatedDateTime: "2026-04-19T00:00:00.000Z",
        isDeleted: false,
        isProcessing: false,
      },
      latestIngestedAt: "2026-04-19T00:05:00.000Z",
    });
    const resp = (await summaryHandler(mkReq(), mkCtx())) as {
      status: number;
      jsonBody: {
        counts: { total: number };
        mostRecent: { id: string } | null;
        health: { status: string };
      };
      headers: Record<string, string>;
    };
    expect(resp.status).toBe(200);
    expect(resp.jsonBody.counts.total).toBe(3);
    expect(resp.jsonBody.mostRecent?.id).toBe("u1");
    expect(resp.jsonBody.health.status).toBe("healthy");
    expect(resp.headers["cache-control"]).toMatch(/max-age=60/);
  });
});
