// Handler tests for GET /api/branding/{tenantId}/logo (ADR-0029 Phase B
// §Decision.3). Focus: the IDOR gate (WS10 SEC-I-ADR29-02 resolution).
// URL `<tenantId>` MUST equal the authenticated principal's tenant. The
// handler rejects mismatches with 403 before any blob I/O.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

// vi.mock factories are hoisted to the top of the file, BEFORE any
// `const` declarations. `vi.hoisted()` lets us lift the shared spy
// variables to the same hoist scope so factories can reference them.
const mocks = vi.hoisted(() => ({
  blobDownloadToBuffer: vi.fn(),
  readBranding: vi.fn(),
  // §10.66 Phase E — legacy x-ms-client-principal header retired; auth tests
  // now seed a mock principal directly via this hoisted spy.
  readClientPrincipal: vi.fn(),
}));
const { blobDownloadToBuffer, readBranding: mockReadBranding } = mocks;

// §10.66 — replace readClientPrincipal at the module boundary. Tests that
// expect 401 supply mockResolvedValue(null); tests that expect the IDOR-pass
// path supply a principal with the right userDetails / tenant suffix.
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
            downloadToBuffer: mocks.blobDownloadToBuffer,
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

// Stub readBranding so SEC-OBS-ADR29-PHASEB-03 happy-path + 304 tests
// control the row shape directly without wiring a TableClient.
vi.mock("../src/lib/tenantSettingsStore.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/tenantSettingsStore.js")>(
      "../src/lib/tenantSettingsStore.js",
    );
  return { ...actual, readBranding: mocks.readBranding };
});

// `getTableClient` is called before `readBranding` — stub to a no-op
// client since the mocked readBranding doesn't use the table.
vi.mock("../src/lib/tables.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/tables.js")>(
      "../src/lib/tables.js",
    );
  return {
    ...actual,
    getTableClient: vi.fn(() => ({}) as never),
  };
});

import { getBrandingLogoHandler } from "../src/functions/getBrandingLogo.js";

interface MockRequestInit {
  headers?: Record<string, string>;
  principalBase64?: string | undefined;
  params?: Record<string, string> | undefined;
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
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    params: init.params ?? {},
  } as unknown as Parameters<typeof getBrandingLogoHandler>[0];
}

function mkContext() {
  return {
    invocationId: "test-inv",
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof getBrandingLogoHandler>[1];
}

const READER_PRINCIPAL = Object.freeze({
  identityProvider: "aad",
  userId: "oid-123",
  userDetails: "reader@contoso.com",
  userRoles: ["authenticated", "reader"],
});

/** Returned for back-compat with call sites that still pass a header marker;
 *  the value is no longer meaningful post-Phase-E (mocked principal is what
 *  authenticates). Kept as a sentinel so test diff stays minimal. */
function principalHeader(): string {
  return "PHASE_E_PRINCIPAL_VIA_MOCK";
}

beforeEach(() => {
  process.env.API_READER_MI_CLIENT_ID = "api-mi";
  process.env.OPS_TABLE_ENDPOINT = "https://staegisops.table.core.windows.net";
  process.env.AZURE_TENANT_ID = "tenant-1";
  mockReadBranding.mockReset();
  blobDownloadToBuffer.mockReset();
  // §10.66 — default to authenticated reader; the `401 when absent` test
  // overrides with mockResolvedValueOnce(null).
  mocks.readClientPrincipal.mockReset();
  mocks.readClientPrincipal.mockResolvedValue({ ...READER_PRINCIPAL });
});

const FAKE_SHA = "a".repeat(64);
const POPULATED_BRANDING = {
  productName: "Acme",
  primaryHex: "#112233",
  footerText: "",
  defaultTheme: "system",
  logoSha256: FAKE_SHA,
  logoContentType: "image/png",
  logoSize: 1234,
  logoUrl: `/api/branding/tenant-1/logo?v=${FAKE_SHA}`,
  updatedAt: "2026-04-21T10:00:00.000Z",
  updatedBy: "alice@contoso.com",
  source: "tenant" as const,
};

describe("getBrandingLogo — IDOR + input-shape gates", () => {
  it("401 when no authenticated principal is present", async () => {
    mocks.readClientPrincipal.mockResolvedValueOnce(null);
    const res = await getBrandingLogoHandler(
      mkRequest({ params: { tenantId: "tenant-1" } }),
      mkContext(),
    );
    expect(res.status).toBe(401);
  });

  it("400 when path param fails the sanity-shape regex (e.g. slashes)", async () => {
    const res = await getBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader(),
        params: { tenantId: "tenant/evil" },
      }),
      mkContext(),
    );
    expect(res.status).toBe(400);
  });

  it("400 when tenantId is empty", async () => {
    const res = await getBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader(),
        params: { tenantId: "" },
      }),
      mkContext(),
    );
    expect(res.status).toBe(400);
  });

  it("403 when URL tenantId does not match the authoritative tenant (IDOR gate)", async () => {
    // Caller's principal is bound to `tenant-1` via AZURE_TENANT_ID. A
    // legitimate-shape-but-different tenantId in the URL path must 403
    // BEFORE any blob I/O — single-tenant today, multi-tenant-hardened
    // ahead of time.
    const res = await getBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader(),
        params: { tenantId: "tenant-2" },
      }),
      mkContext(),
    );
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({
      error: expect.objectContaining({
        code: "forbidden",
        message: "tenantId mismatch",
      }),
    });
  });

  it("403 even when URL tenantId differs only in case", async () => {
    // The comparison is case-sensitive. Important because some tenants
    // may have mixed-case GUIDs and a caller's downstream code should
    // not be allowed to vary case to probe for alternate identity.
    const res = await getBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader(),
        params: { tenantId: "Tenant-1" },
      }),
      mkContext(),
    );
    expect(res.status).toBe(403);
  });
});

describe("getBrandingLogo — SEC-OBS-ADR29-PHASEB-03 happy-path + 304", () => {
  it("200 — response headers match the ADR contract (content-type, cache-control, nosniff, etag)", async () => {
    mockReadBranding.mockResolvedValue(POPULATED_BRANDING);
    blobDownloadToBuffer.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await getBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader(),
        params: { tenantId: "tenant-1" },
      }),
      mkContext(),
    );
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      "content-type": "image/png",
      "cache-control": "private, max-age=3600, stale-while-revalidate=86400",
      "x-content-type-options": "nosniff",
      etag: `"${FAKE_SHA}"`,
    });
    // Body is the buffer from the blob client.
    expect(res.body).toBeInstanceOf(Buffer);
  });

  it("304 — If-None-Match matches the row ETag → short-circuit BEFORE blob download", async () => {
    // SEC-OBS-ADR29-PHASEB-02 — conditional-request resolution.
    mockReadBranding.mockResolvedValue(POPULATED_BRANDING);
    const res = await getBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader(),
        params: { tenantId: "tenant-1" },
        headers: { "if-none-match": `"${FAKE_SHA}"` },
      }),
      mkContext(),
    );
    expect(res.status).toBe(304);
    expect(res.headers).toMatchObject({
      etag: `"${FAKE_SHA}"`,
      "cache-control": "private, max-age=3600, stale-while-revalidate=86400",
      "x-content-type-options": "nosniff",
    });
    // Crucially: no blob download happened. That's the whole point of 304.
    expect(blobDownloadToBuffer).not.toHaveBeenCalled();
  });

  it("200 — If-None-Match with a stale sha does NOT match → full response", async () => {
    mockReadBranding.mockResolvedValue(POPULATED_BRANDING);
    blobDownloadToBuffer.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await getBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader(),
        params: { tenantId: "tenant-1" },
        headers: { "if-none-match": '"stale-sha-value"' },
      }),
      mkContext(),
    );
    expect(res.status).toBe(200);
    expect(blobDownloadToBuffer).toHaveBeenCalledOnce();
  });

  it("200 — absent If-None-Match header does NOT match the empty-string edge case", async () => {
    // Defensive: a row with an empty logoSha256 (impossible under the
    // no-logo guard above, but belt-and-braces) must NOT 304 on a
    // request that sends `If-None-Match: ""`.
    mockReadBranding.mockResolvedValue(POPULATED_BRANDING);
    blobDownloadToBuffer.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await getBrandingLogoHandler(
      mkRequest({
        principalBase64: principalHeader(),
        params: { tenantId: "tenant-1" },
        // No If-None-Match header.
      }),
      mkContext(),
    );
    expect(res.status).toBe(200);
  });
});
