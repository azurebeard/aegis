// ADR-0037 follow-up — server-driven Ingest Diagnostics source list.
// Auth gate + happy-path + cache-headers + auditSource omission.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ClientPrincipalMod from "../src/lib/clientPrincipal.js";
import type * as AzFunctions from "@azure/functions";

const { readClientPrincipalMock } = vi.hoisted(() => ({
  readClientPrincipalMock: vi.fn(),
}));

vi.mock("../src/lib/clientPrincipal.js", async () => {
  const actual = await vi.importActual<typeof ClientPrincipalMod>(
    "../src/lib/clientPrincipal.js",
  );
  return { ...actual, readClientPrincipal: readClientPrincipalMock };
});

vi.mock("@azure/functions", async () => {
  const actual = await vi.importActual<typeof AzFunctions>("@azure/functions");
  return { ...actual, app: { ...actual.app, http: vi.fn(), timer: vi.fn() } };
});

const { getIngestSourcesHandler } = await import(
  "../src/functions/getIngestSources.js"
);

function mkReq() {
  return { headers: new Map<string, string>(), query: new URLSearchParams() };
}
function mkCtx() {
  return {
    invocationId: "inv-1",
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
}

beforeEach(() => {
  readClientPrincipalMock.mockReset();
});

describe("getIngestSources — auth gate", () => {
  it("returns 403 when no principal", async () => {
    readClientPrincipalMock.mockResolvedValue(null);
    const resp = await getIngestSourcesHandler(mkReq() as never, mkCtx() as never);
    expect(resp.status).toBe(403);
  });

  it("returns 403 when principal lacks admin role", async () => {
    readClientPrincipalMock.mockResolvedValue({
      identityProvider: "aad",
      userId: "u1",
      userDetails: "alice@example.com",
      userRoles: ["authenticated", "reader"],
    });
    const resp = await getIngestSourcesHandler(mkReq() as never, mkCtx() as never);
    expect(resp.status).toBe(403);
  });
});

describe("getIngestSources — happy path", () => {
  beforeEach(() => {
    readClientPrincipalMock.mockResolvedValue({
      identityProvider: "aad",
      userId: "u1",
      userDetails: "admin@example.com",
      userRoles: ["authenticated", "admin"],
    });
  });

  it("returns 200 with schemaVersion + sources array", async () => {
    const resp = await getIngestSourcesHandler(mkReq() as never, mkCtx() as never);
    expect(resp.status).toBe(200);
    const body = resp.jsonBody as {
      schemaVersion: number;
      sources: { key: string; label: string; iconName: string; description: string }[];
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.sources.length).toBeGreaterThan(0);
    for (const s of body.sources) {
      expect(typeof s.key).toBe("string");
      expect(typeof s.label).toBe("string");
      expect(typeof s.iconName).toBe("string");
      expect(typeof s.description).toBe("string");
      // auditSource is server-internal; must NOT leak to clients.
      expect("auditSource" in s).toBe(false);
    }
  });

  it("includes the ransomware-intel source (regression for the drift bug this endpoint exists to prevent)", async () => {
    const resp = await getIngestSourcesHandler(mkReq() as never, mkCtx() as never);
    const body = resp.jsonBody as { sources: { key: string }[] };
    const keys = body.sources.map((s) => s.key);
    expect(keys).toContain("ransomware-intel");
  });

  it("emits a private cache-control + Vary header", async () => {
    const resp = await getIngestSourcesHandler(mkReq() as never, mkCtx() as never);
    const headers = resp.headers as Record<string, string>;
    expect(headers["cache-control"]).toMatch(/private, max-age=\d+/);
    expect(headers["vary"]).toMatch(/Cookie/);
  });
});
