// Handler tests for POST /api/ingest/branding/logo (ADR-0029 Phase B).
// Focus: the validation gates that fire BEFORE any blob / table I/O — the
// security-critical path where prompt-injection shaped bodies + masqueraded
// content-types get rejected. Happy-path blob + row write is covered at the
// store-helper level in tenantSettingsStore.test.ts and at the lib level in
// brandingLogo.test.ts; the orchestration line is thin.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

// vi.hoisted() lifts shared spies so the vi.mock factories can reference
// them. These back the happy-path test (SEC-OBS-ADR29-PHASEB-03) and the
// compensating-delete test (SEC-OBS-ADR29-PHASEB-01).
const mocks = vi.hoisted(() => ({
  uploadData: vi.fn(),
  blobDelete: vi.fn(),
  upsertBrandingLogo: vi.fn(),
  buildFullSettingsResponse: vi.fn(),
  // §10.66 Phase E — legacy x-ms-client-principal header retired.
  readClientPrincipal: vi.fn(),
}));

vi.mock("../src/lib/clientPrincipal.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/clientPrincipal.js")>(
      "../src/lib/clientPrincipal.js",
    );
  return { ...actual, readClientPrincipal: mocks.readClientPrincipal };
});

vi.mock("@azure/storage-blob", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/storage-blob")>(
      "@azure/storage-blob",
    );
  return {
    ...actual,
    BlobServiceClient: vi.fn(function (this: unknown) {
      return {
        getContainerClient: () => ({
          getBlockBlobClient: () => ({
            uploadData: mocks.uploadData,
            delete: mocks.blobDelete,
          }),
        }),
      };
    }),
  };
});
vi.mock("@azure/identity", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/identity")>(
      "@azure/identity",
    );
  return {
    ...actual,
    DefaultAzureCredential: vi.fn(function (this: unknown) {
      return {};
    }),
  };
});

// Stub the row-write helper + settings-response builder so the happy
// path doesn't require a live TableClient. The control flow — including
// the compensating-delete branch — is still exercised end-to-end.
vi.mock("../src/lib/tenantSettingsStore.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/tenantSettingsStore.js")>(
      "../src/lib/tenantSettingsStore.js",
    );
  return { ...actual, upsertBrandingLogo: mocks.upsertBrandingLogo };
});
vi.mock("../src/lib/settingsResponse.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/settingsResponse.js")>(
      "../src/lib/settingsResponse.js",
    );
  return { ...actual, buildFullSettingsResponse: mocks.buildFullSettingsResponse };
});
vi.mock("../src/lib/tables.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/tables.js")>(
      "../src/lib/tables.js",
    );
  return { ...actual, getTableClient: vi.fn(() => ({}) as never) };
});

import { uploadBrandingLogoHandler } from "../src/functions/uploadBrandingLogo.js";

// Minimal stand-ins for Azure Functions v4 types — only the fields the
// handler reads.
interface MockRequestInit {
  headers?: Record<string, string>;
  principalBase64?: string | undefined;
  body?: Uint8Array | undefined;
}

function mkRequest(init: MockRequestInit = {}) {
  const headers = new Map<string, string>();
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    headers.set(k.toLowerCase(), v);
  }
  if (init.principalBase64) {
    headers.set("x-ms-client-principal", init.principalBase64);
  }
  return {
    headers: {
      get: (k: string) => headers.get(k.toLowerCase()) ?? null,
    },
    params: {},
    arrayBuffer: async () => {
      if (!init.body) return new ArrayBuffer(0);
      // Return a fresh ArrayBuffer slice so the handler's Buffer.from()
      // gets the declared bytes.
      return init.body.buffer.slice(
        init.body.byteOffset,
        init.body.byteOffset + init.body.byteLength,
      ) as ArrayBuffer;
    },
  } as unknown as Parameters<typeof uploadBrandingLogoHandler>[0];
}

function mkContext() {
  return {
    invocationId: "test-inv-1",
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof uploadBrandingLogoHandler>[1];
}

/** §10.66 — sets the next mock principal call AND returns the legacy
 *  header sentinel so call sites can keep the existing principalBase64
 *  parameter shape (minimises test diff). The userDetails parameter is
 *  routed into the mocked principal. */
function principalHeader(userDetails: string): string {
  mocks.readClientPrincipal.mockResolvedValueOnce({
    identityProvider: "aad",
    userId: "oid-123",
    userDetails,
    userRoles: ["admin", "authenticated", "reader"],
  });
  return "PHASE_E_PRINCIPAL_VIA_MOCK";
}

// A minimal valid PNG magic-byte body + some filler.
const VALID_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_AS_PNG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.uploadData.mockReset();
  mocks.blobDelete.mockReset();
  mocks.upsertBrandingLogo.mockReset();
  mocks.buildFullSettingsResponse.mockReset();
  mocks.readClientPrincipal.mockReset();
  // §10.66 — default to unauthenticated. Tests that need a principal call
  // principalHeader() which queues a mockResolvedValueOnce for that call.
  mocks.readClientPrincipal.mockResolvedValue(null);
  // Provide the minimum env the config resolver touches — even for gate
  // tests that short-circuit before the resolver runs, a defensive set
  // keeps the signal from environment leaks between test runs.
  process.env.INGEST_MI_CLIENT_ID = "ingest-mi";
  process.env.AUDIT_MI_CLIENT_ID = "audit-mi";
  process.env.API_READER_MI_CLIENT_ID = "api-mi";
  process.env.AGENT_MI_CLIENT_ID = "agent-mi";
  process.env.OPS_TABLE_ENDPOINT = "https://staegisopsdevweu.table.core.windows.net";
  process.env.AUDIT_BLOB_ENDPOINT = "https://staegisaudit.blob.core.windows.net";
  process.env.GRAPH_BASE_URL = "https://graph.microsoft.com";
  process.env.FOUNDRY_PROJECT_ENDPOINT = "https://foundry.example.com";
  process.env.FOUNDRY_PROJECT_NAME = "test-project";
  process.env.FOUNDRY_REGION = "westeurope";
  process.env.BRIEF_MODEL_DEPLOYMENT = "aegis-small";
  process.env.BRIEF_CACHE_CONTAINER = "daily-briefs";
  process.env.INCIDENTS_DETAIL_CONTAINER_NAME = "incidents-detail";
  process.env.AZURE_TENANT_ID = "tenant-1";
});

describe("uploadBrandingLogo — validation gates (pre-I/O)", () => {
  it("401 when no authenticated principal is present", async () => {
    const res = await uploadBrandingLogoHandler(
      mkRequest({ headers: { "content-type": "image/png" }, body: VALID_PNG }),
      mkContext(),
    );
    expect(res.status).toBe(401);
  });

  it("413 when Content-Length declares over the 1 MB cap (polite-client reject)", async () => {
    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: {
          "content-type": "image/png",
          "content-length": String(2 * 1_048_576),
        },
      }),
      mkContext(),
    );
    expect(res.status).toBe(413);
  });

  it("415 when Content-Type is not in the allowlist", async () => {
    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: { "content-type": "image/gif" },
        body: new Uint8Array([0x47, 0x49, 0x46, 0x38]),
      }),
      mkContext(),
    );
    expect(res.status).toBe(415);
    expect(res.jsonBody).toMatchObject({
      error: expect.objectContaining({ code: "unsupported_media_type" }),
    });
  });

  it("415 when Content-Type is image/svg+xml (§Decision.5 — SVG deliberately excluded)", async () => {
    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: { "content-type": "image/svg+xml" },
        body: new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
      }),
      mkContext(),
    );
    expect(res.status).toBe(415);
  });

  it("400 when body is empty despite a valid Content-Type", async () => {
    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: { "content-type": "image/png" },
        body: new Uint8Array(0),
      }),
      mkContext(),
    );
    expect(res.status).toBe(400);
  });

  it("415 when declared Content-Type is image/png but body is JPEG (magic-byte mismatch)", async () => {
    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: { "content-type": "image/png" },
        body: JPEG_AS_PNG,
      }),
      mkContext(),
    );
    expect(res.status).toBe(415);
    expect(res.jsonBody).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("magic bytes rejected"),
      }),
    });
  });

  it("strips `; charset=...` suffix from Content-Type when matching the allowlist", async () => {
    // A polite client occasionally attaches a charset parameter to an
    // image MIME type. The allowlist match must still succeed; the
    // magic-byte gate will then be the authoritative check.
    // We use JPEG-as-PNG to isolate the Content-Type parsing logic —
    // this proves the Content-Type gate passed (not 415) and the magic-
    // byte gate rejected (415 with "magic bytes rejected" message).
    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: { "content-type": "image/png; charset=binary" },
        body: JPEG_AS_PNG,
      }),
      mkContext(),
    );
    expect(res.status).toBe(415);
    expect(res.jsonBody).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("magic bytes rejected"),
      }),
    });
  });
});

describe("uploadBrandingLogo — SEC-OBS-ADR29-PHASEB-03 happy-path headers", () => {
  it("200 — uploads a valid PNG and returns no-store cache header + settings response body", async () => {
    // Mock the downstream writes + settings-response builder so the
    // handler's orchestration is exercised end-to-end without needing
    // a live Table/Blob service.
    mocks.uploadData.mockResolvedValue(undefined);
    mocks.upsertBrandingLogo.mockResolvedValue({
      productName: "Acme",
      primaryHex: "#112233",
      footerText: "",
      defaultTheme: "system",
      logoSha256: "x",
      logoContentType: "image/png",
      logoSize: VALID_PNG.byteLength,
      logoUrl: "/api/branding/tenant-1/logo?v=x",
      updatedAt: "2026-04-21T10:00:00.000Z",
      updatedBy: "alice@contoso.com",
      source: "tenant",
    });
    mocks.buildFullSettingsResponse.mockResolvedValue({
      tileVisibility: { secureScore: true, incidents: true, brief: true, riskyUsers: true, posture: true, stack: true, kev: true },
      branding: {
        productName: "Acme",
        logoSha256: "x",
        logoUrl: "/api/branding/tenant-1/logo?v=x",
      },
      updatedAt: "2026-04-21T10:00:00.000Z",
      updatedBy: "alice@contoso.com",
    });

    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: { "content-type": "image/png" },
        body: VALID_PNG,
      }),
      mkContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ "cache-control": "no-store" });
    expect(res.jsonBody).toMatchObject({
      branding: expect.objectContaining({ logoSha256: "x" }),
    });
    // Blob was written exactly once; row was written exactly once;
    // compensating-delete was NOT invoked on the happy path.
    expect(mocks.uploadData).toHaveBeenCalledOnce();
    expect(mocks.upsertBrandingLogo).toHaveBeenCalledOnce();
    expect(mocks.blobDelete).not.toHaveBeenCalled();
  });
});

describe("uploadBrandingLogo — SEC-OBS-ADR29-PHASEB-01 compensating blob-delete", () => {
  it("503 — row-write failure triggers compensating blob-delete (no orphan)", async () => {
    mocks.uploadData.mockResolvedValue(undefined);
    mocks.upsertBrandingLogo.mockRejectedValue(new Error("table throttle"));
    mocks.blobDelete.mockResolvedValue(undefined);

    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: { "content-type": "image/png" },
        body: VALID_PNG,
      }),
      mkContext(),
    );
    expect(res.status).toBe(503);
    expect(res.jsonBody).toMatchObject({
      error: expect.objectContaining({ code: "dependency_unavailable" }),
    });
    // The blob was written, the row write failed, and the compensating
    // delete fired — net effect: no orphan.
    expect(mocks.uploadData).toHaveBeenCalledOnce();
    expect(mocks.upsertBrandingLogo).toHaveBeenCalledOnce();
    expect(mocks.blobDelete).toHaveBeenCalledOnce();
  });

  it("503 — blob-write failure does NOT trigger compensating delete (nothing to clean)", async () => {
    mocks.uploadData.mockRejectedValue(new Error("blob upstream error"));

    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: { "content-type": "image/png" },
        body: VALID_PNG,
      }),
      mkContext(),
    );
    expect(res.status).toBe(503);
    // No blob was successfully written → no compensating delete.
    expect(mocks.blobDelete).not.toHaveBeenCalled();
    // The row was never written because the blob-write failed first.
    expect(mocks.upsertBrandingLogo).not.toHaveBeenCalled();
  });

  it("503 — compensating-delete failure does not change the response", async () => {
    // If the compensating delete itself fails, the operator is alerted
    // via context.error but the response shape is unchanged. The next
    // successful upload will overwrite the orphan via blob versioning.
    mocks.uploadData.mockResolvedValue(undefined);
    mocks.upsertBrandingLogo.mockRejectedValue(new Error("table throttle"));
    mocks.blobDelete.mockRejectedValue(new Error("blob delete denied"));

    const res = await uploadBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader("alice@contoso.com"),
        headers: { "content-type": "image/png" },
        body: VALID_PNG,
      }),
      mkContext(),
    );
    expect(res.status).toBe(503);
    expect(mocks.blobDelete).toHaveBeenCalledOnce();
  });
});
