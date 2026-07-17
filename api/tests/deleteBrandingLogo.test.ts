// Handler tests for DELETE /api/ingest/branding/logo (ADR-0029 Phase B).
// Focus: the admin-gate + principal-presence check. Idempotent clear behaviour
// is covered at the `clearBrandingLogo` store-helper level in
// tenantSettingsStore.test.ts.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

vi.mock("@azure/storage-blob", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/storage-blob")>(
      "@azure/storage-blob",
    );
  return {
    ...actual,
    BlobServiceClient: vi.fn(function (this: unknown) {
      return { getContainerClient: vi.fn() };
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

import { deleteBrandingLogoHandler } from "../src/functions/deleteBrandingLogo.js";

function mkRequest(principalBase64?: string) {
  const headers = new Map<string, string>();
  if (principalBase64) {
    headers.set("x-ms-client-principal", principalBase64);
  }
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    params: {},
  } as unknown as Parameters<typeof deleteBrandingLogoHandler>[0];
}

function mkContext() {
  return {
    invocationId: "test-inv",
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof deleteBrandingLogoHandler>[1];
}

beforeEach(() => {
  process.env.INGEST_MI_CLIENT_ID = "ingest-mi";
  process.env.AUDIT_MI_CLIENT_ID = "audit-mi";
  process.env.API_READER_MI_CLIENT_ID = "api-mi";
  process.env.OPS_TABLE_ENDPOINT = "https://staegisops.table.core.windows.net";
  process.env.AUDIT_BLOB_ENDPOINT = "https://staegisaudit.blob.core.windows.net";
  process.env.GRAPH_BASE_URL = "https://graph.microsoft.com";
  process.env.AZURE_TENANT_ID = "tenant-1";
});

describe("deleteBrandingLogo — pre-I/O gates", () => {
  it("401 when x-ms-client-principal is absent", async () => {
    const res = await deleteBrandingLogoHandler(mkRequest(), mkContext());
    expect(res.status).toBe(401);
    expect(res.jsonBody).toMatchObject({
      error: expect.objectContaining({ code: "unauthenticated" }),
    });
  });
});
