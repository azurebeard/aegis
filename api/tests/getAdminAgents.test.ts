// Tests for the agent observability endpoint helpers
// (HANDOVER §6.3 agent observability page).
//
// Coverage:
//   - readHealthOptional: returns null on 404 (read-only — must NOT
//     auto-create like the writer-path readHealth does, otherwise the
//     api-reader MI's read-only scope is breached).
//   - findLatestAnalysisRow: partition-scoped query, picks max-by-
//     generatedAt, tolerates non-incidents-analysis row keys, escapes
//     single-quotes in tenantId.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestError } from "@azure/data-tables";

function mkNotFoundRestError(): RestError {
  return new RestError("not found", { statusCode: 404 });
}

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

beforeEach(() => {
  vi.stubEnv("API_READER_MI_CLIENT_ID", "api-mi");
  vi.stubEnv("INGEST_MI_CLIENT_ID", "ingest-mi");
  vi.stubEnv("AUDIT_MI_CLIENT_ID", "audit-mi");
  vi.stubEnv(
    "OPS_TABLE_ENDPOINT",
    "https://staegisops.table.core.windows.net",
  );
  vi.stubEnv(
    "AUDIT_BLOB_ENDPOINT",
    "https://staegisaudit.blob.core.windows.net",
  );
  vi.stubEnv("GRAPH_BASE_URL", "https://graph.microsoft.com");
  vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agentHealth.readHealthOptional", () => {
  it("returns the row when the entity exists", async () => {
    const { readHealthOptional } = await import("../src/lib/agentHealth.js");
    const table = {
      getEntity: vi.fn().mockResolvedValue({
        partitionKey: "t1",
        rowKey: "agent.brief",
        State: "open",
        ConsecutiveFailures: 4,
        NextProbeAt: "2026-04-27T05:00:00Z",
        LastFailureKind: "throttle_429",
        LastFailureAt: "2026-04-27T04:50:00Z",
        UpdatedAt: "2026-04-27T04:50:00Z",
        etag: "W/\"abc\"",
      }),
    } as unknown as Parameters<typeof readHealthOptional>[0];
    const got = await readHealthOptional(table, "t1", "brief");
    expect(got?.state).toBe("open");
    expect(got?.consecutiveFailures).toBe(4);
  });

  it("returns null on 404 — does NOT auto-create like readHealth", async () => {
    const { readHealthOptional } = await import("../src/lib/agentHealth.js");
    const createEntity = vi.fn();
    const table = {
      getEntity: vi.fn().mockRejectedValue(mkNotFoundRestError()),
      createEntity,
    } as unknown as Parameters<typeof readHealthOptional>[0];
    const got = await readHealthOptional(table, "t1", "posture");
    expect(got).toBeNull();
    // The critical assertion — if api-reader MI hits this code path it must
    // NOT attempt a write. createEntity must never be called.
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("re-throws non-404 errors", async () => {
    const { readHealthOptional } = await import("../src/lib/agentHealth.js");
    const table = {
      getEntity: vi.fn().mockRejectedValue(
        new RestError("forbidden", { statusCode: 403 }),
      ),
    } as unknown as Parameters<typeof readHealthOptional>[0];
    await expect(readHealthOptional(table, "t1", "incidents-analysis")).rejects.toThrow(
      /forbidden/i,
    );
  });
});

describe("incidentAnalysisCache.findLatestAnalysisRow", () => {
  it("returns null when partition is empty", async () => {
    const { findLatestAnalysisRow } = await import(
      "../src/lib/incidentAnalysisCache.js"
    );
    const table = mkTableMock([]);
    const got = await findLatestAnalysisRow(table, "t1");
    expect(got).toBeNull();
  });

  it("picks the row with the greatest GeneratedAt", async () => {
    const { findLatestAnalysisRow } = await import(
      "../src/lib/incidentAnalysisCache.js"
    );
    const table = mkTableMock([
      mkAnalysisEntity("t1", "inc-A", "2026-04-25T10:00:00Z"),
      mkAnalysisEntity("t1", "inc-B", "2026-04-27T11:00:00Z"), // latest
      mkAnalysisEntity("t1", "inc-C", "2026-04-26T09:00:00Z"),
    ]);
    const got = await findLatestAnalysisRow(table, "t1");
    expect(got?.incidentId).toBe("inc-B");
  });

  it("filters out non-incidents.analysis row keys", async () => {
    const { findLatestAnalysisRow } = await import(
      "../src/lib/incidentAnalysisCache.js"
    );
    const table = mkTableMock([
      mkAnalysisEntity("t1", "inc-A", "2026-04-25T10:00:00Z"),
      // Stray row from some other partition usage — must not surface.
      {
        partitionKey: "t1",
        rowKey: "config.something",
        RunId: "x",
        BlobPath: "",
        OutputSha256: "",
        AnalysedContentSha256: "",
        AnalysedIncidentLastUpdateDateTime: "",
        RedactionLockUntil: "",
        RedactionLockRunCount: 0,
        TokensIn: 0,
        TokensOut: 0,
        GeneratedAt: "2099-12-31T23:59:59Z",
        ModelDeployment: "stray",
      },
    ]);
    const got = await findLatestAnalysisRow(table, "t1");
    expect(got?.incidentId).toBe("inc-A");
  });

  it("escapes single-quotes in tenantId for the OData filter", async () => {
    const { findLatestAnalysisRow } = await import(
      "../src/lib/incidentAnalysisCache.js"
    );
    const observed: { filter?: string }[] = [];
    const table = {
      listEntities: vi.fn((opts: { queryOptions?: { filter?: string } }) => {
        observed.push({ filter: opts.queryOptions?.filter ?? "(none)" });
        return mkAsyncIter([]);
      }),
    } as unknown as Parameters<typeof findLatestAnalysisRow>[0];
    await findLatestAnalysisRow(table, "evil'tenant");
    expect(observed[0]?.filter).toBe("PartitionKey eq 'evil''tenant'");
  });
});

// Test fixtures ---------------------------------------------------------------

function mkAnalysisEntity(tenantId: string, incidentId: string, generatedAt: string) {
  return {
    partitionKey: tenantId,
    rowKey: `incidents.analysis.${incidentId}`,
    RunId: `r-${incidentId}`,
    BlobPath: `${incidentId}.md`,
    OutputSha256: "deadbeef",
    AnalysedContentSha256: "cafef00d",
    AnalysedIncidentLastUpdateDateTime: generatedAt,
    RedactionLockUntil: "",
    RedactionLockRunCount: 0,
    TokensIn: 200,
    TokensOut: 100,
    GeneratedAt: generatedAt,
    ModelDeployment: "aegis-small",
  };
}

function mkAsyncIter<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let i = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (i >= items.length) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return Promise.resolve({ value: items[i++] as T, done: false });
        },
      };
    },
  };
}

function mkTableMock(entities: readonly unknown[]): never {
  return {
    listEntities: vi.fn(() => mkAsyncIter(entities)),
  } as never;
}

// ---------------------------------------------------------------------------
// SEC-H-D1-01 — handler-level auth gate. Pre-Phase-D1 the handler had a
// private legacy-only readClientPrincipal returning 403 even on missing-
// principal. Post-fix: 401 on missing principal (ASVS V2.5.1 — distinguish
// unauth from forbid). §10.66 Phase E retired the legacy header path
// entirely; this contract test still pins the no-auth → null → 401 mapping.
// ---------------------------------------------------------------------------
describe("getAdminAgents — auth gate", () => {
  it("returns 401 (NOT 403) when no Authorization header is present", async () => {
    const { readClientPrincipal } = await import("../src/lib/clientPrincipal.js");
    const headers = new Headers();
    const principal = await readClientPrincipal({ headers } as never);
    // Contract: no auth → null. Handler maps null → 401.
    expect(principal).toBeNull();
  });

  it("admin Bearer JWT path resolves to a principal with the admin role", async () => {
    // Phase C's authMiddleware.test.ts proves the JWT path end-to-end with
    // locally-signed v2.0 tokens. This case verifies the surface contract
    // (Bearer-precedence) at the clientPrincipal boundary used by getAdminAgents.
    const { generateKeyPair, SignJWT } = await import("jose");
    const { _setJwksResolverForTesting, _resetJwksCacheForTesting } = await import(
      "../src/lib/authMiddleware.js"
    );
    process.env.AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
    process.env.AEGIS_API_APP_ID = "22222222-2222-2222-2222-222222222222";

    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    _setJwksResolverForTesting(async () => publicKey);

    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      ver: "2.0",
      tid: "11111111-1111-1111-1111-111111111111",
      oid: "admin-user-oid",
      preferred_username: "admin@example.com",
      roles: ["admin"],
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0")
      .setAudience("22222222-2222-2222-2222-222222222222")
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const { readClientPrincipal } = await import("../src/lib/clientPrincipal.js");
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);
    const principal = await readClientPrincipal({ headers } as never);
    expect(principal).not.toBeNull();
    expect(principal!.userRoles).toContain("admin");

    _resetJwksCacheForTesting();
  });
});
