// Handler-level integration tests for GET /api/reports/share/{token}.
// Token verification primitives are unit-tested at reportShareToken.test.ts;
// this file pins the wire shape (status / body / headers) for each branch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

const KEY = randomBytes(32);

const mocks = vi.hoisted(() => ({
  loadReportShareSigningKey: vi.fn(),
  readLatestSnapshot: vi.fn(),
  renderEnvelopeHtml: vi.fn(),
  emitReportHtmlShareReadAudit: vi.fn(),
}));

vi.mock("../src/lib/reportShareSigningKey.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/reportShareSigningKey.js")
  >("../src/lib/reportShareSigningKey.js");
  return {
    ...actual,
    loadReportShareSigningKey: mocks.loadReportShareSigningKey,
  };
});

vi.mock("../src/lib/reportSnapshotStore.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/reportSnapshotStore.js")
  >("../src/lib/reportSnapshotStore.js");
  return { ...actual, readLatestSnapshot: mocks.readLatestSnapshot };
});

vi.mock("../src/lib/reportHtml.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/reportHtml.js")>(
      "../src/lib/reportHtml.js",
    );
  return { ...actual, renderEnvelopeHtml: mocks.renderEnvelopeHtml };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/tables.js")>(
      "../src/lib/tables.js",
    );
  return { ...actual, getTableClient: vi.fn(() => ({}) as never) };
});

vi.mock("../src/lib/reportHtmlShareAudit.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/reportHtmlShareAudit.js")
  >("../src/lib/reportHtmlShareAudit.js");
  return {
    ...actual,
    emitReportHtmlShareReadAudit: mocks.emitReportHtmlShareReadAudit,
  };
});

import { getReportShareHandler } from "../src/functions/getReportShare.js";
import { signReportShareToken } from "../src/lib/reportShareToken.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const PERIOD = "2026-05";

beforeEach(() => {
  vi.stubEnv("API_READER_MI_CLIENT_ID", "api-mi");
  vi.stubEnv("INGEST_MI_CLIENT_ID", "ingest-mi");
  vi.stubEnv("AUDIT_MI_CLIENT_ID", "audit-mi");
  vi.stubEnv("OPS_TABLE_ENDPOINT", "https://staegisops.table.core.windows.net");
  vi.stubEnv("AUDIT_BLOB_ENDPOINT", "https://staegisaudit.blob.core.windows.net");
  vi.stubEnv("GRAPH_BASE_URL", "https://graph.microsoft.com");
  vi.stubEnv("AZURE_TENANT_ID", TENANT);
  vi.stubEnv("REPORT_SNAPSHOT_VERSIONS_PER_PERIOD", "3");
  vi.stubEnv("REPORT_SNAPSHOT_RETENTION_DAYS", "30");
  for (const k of Object.keys(mocks) as Array<keyof typeof mocks>) {
    mocks[k].mockReset();
  }
  // Default: key is available + snapshot exists. Individual tests override.
  mocks.loadReportShareSigningKey.mockResolvedValue({ key: KEY });
  mocks.readLatestSnapshot.mockResolvedValue({
    schemaVersion: 1,
    tenantId: TENANT,
    periodKey: PERIOD,
    cadence: "monthly",
    capturedAt: "2026-05-31T00:00:00Z",
    capturedBy: "system",
    blobName: "envelope.json",
    contentSha256: "x",
    sourcesUsed: [],
    sections: {},
  });
  mocks.renderEnvelopeHtml.mockReturnValue("<!doctype html><html><body>ok</body></html>");
  // Default: audit emit succeeds. Individual tests override for fail-soft + races.
  mocks.emitReportHtmlShareReadAudit.mockResolvedValue({
    outcome: "emitted",
    seq: 1,
    lineSha256: "a".repeat(64),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function mkRequest(token: string) {
  return {
    headers: { get: () => null },
    params: { token },
  } as unknown as Parameters<typeof getReportShareHandler>[0];
}

function mkContext(invocationId = "inv-share-1") {
  return {
    invocationId,
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof getReportShareHandler>[1];
}

function freshToken(opts?: { tenantId?: string; periodKey?: string; expiresAtMs?: number }) {
  return signReportShareToken(
    {
      tenantId: opts?.tenantId ?? TENANT,
      periodKey: opts?.periodKey ?? PERIOD,
      expiresAtMs: opts?.expiresAtMs ?? Date.now() + 14 * 24 * 60 * 60 * 1000,
    },
    KEY,
  );
}

describe("getReportShare handler", () => {
  it("400 invalid_token when the path token fails the cheap shape regex", async () => {
    const res = await getReportShareHandler(mkRequest("!!!"), mkContext());
    expect(res.status).toBe(400);
    const body = res.jsonBody as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_token");
    expect(mocks.loadReportShareSigningKey).not.toHaveBeenCalled();
  });

  it("503 share_link_unavailable when the signing key cannot be loaded", async () => {
    mocks.loadReportShareSigningKey.mockResolvedValue({
      key: null,
      fallbackReason: "kv_read_failed",
      errorDetail: "RestError 503",
    });
    const res = await getReportShareHandler(mkRequest(freshToken()), mkContext());
    expect(res.status).toBe(503);
    const body = res.jsonBody as { error?: { code?: string } };
    expect(body.error?.code).toBe("share_link_unavailable");
  });

  it("410 link_expired when the token's exp has passed", async () => {
    const expired = freshToken({ expiresAtMs: Date.now() - 1_000 });
    const res = await getReportShareHandler(mkRequest(expired), mkContext());
    expect(res.status).toBe(410);
    const body = res.jsonBody as { error?: { code?: string } };
    expect(body.error?.code).toBe("link_expired");
  });

  it("400 invalid_token when the signature is bad", async () => {
    const token = freshToken();
    const [body, sig] = token.split(".");
    const tamperedChar = sig[0] === "A" ? "B" : "A";
    const tampered = `${body}.${tamperedChar}${sig.slice(1)}`;
    const res = await getReportShareHandler(mkRequest(tampered), mkContext());
    expect(res.status).toBe(400);
    const responseBody = res.jsonBody as { error?: { code?: string } };
    expect(responseBody.error?.code).toBe("invalid_token");
  });

  it("400 invalid_token when the token tenantId doesn't match the FA tenant", async () => {
    const token = freshToken({ tenantId: "22222222-2222-2222-2222-222222222222" });
    const res = await getReportShareHandler(mkRequest(token), mkContext());
    expect(res.status).toBe(400);
    const body = res.jsonBody as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_token");
    // Snapshot read MUST NOT happen for a tenant-mismatch token.
    expect(mocks.readLatestSnapshot).not.toHaveBeenCalled();
  });

  it("404 snapshot_not_found when the periodKey has no snapshot", async () => {
    mocks.readLatestSnapshot.mockResolvedValue(null);
    const res = await getReportShareHandler(mkRequest(freshToken()), mkContext());
    expect(res.status).toBe(404);
    const body = res.jsonBody as { error?: { code?: string } };
    expect(body.error?.code).toBe("snapshot_not_found");
  });

  it("200 HTML with security headers on the happy path", async () => {
    const res = await getReportShareHandler(mkRequest(freshToken()), mkContext());
    expect(res.status).toBe(200);
    expect(res.body).toBe("<!doctype html><html><body>ok</body></html>");
    expect(res.headers).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    const csp = (res.headers as Record<string, string>)["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toContain("script-src");
    // No JS — the CSP without script-src defaults to default-src 'none'.
  });

  it("error responses also carry the security headers (no-store, referrer-policy, nosniff)", async () => {
    const res = await getReportShareHandler(mkRequest("!!!"), mkContext());
    expect(res.headers).toMatchObject({
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  });

  // ADR-0030 §C.22 — privacy-tracking audit emission.

  it("emits exactly one audit line on the happy-path read with the right (tenantId, periodKey, jti)", async () => {
    const res = await getReportShareHandler(mkRequest(freshToken()), mkContext());
    expect(res.status).toBe(200);

    expect(mocks.emitReportHtmlShareReadAudit).toHaveBeenCalledTimes(1);
    const callArgs = mocks.emitReportHtmlShareReadAudit.mock.calls[0]!;
    const eventArg = callArgs[1] as Record<string, unknown>;
    expect(eventArg.tenantId).toBe(TENANT);
    expect(eventArg.periodKey).toBe(PERIOD);
    expect(typeof eventArg.tokenJti).toBe("string");
    expect((eventArg.tokenJti as string).length).toBeGreaterThan(0);
    expect(typeof eventArg.readAt).toBe("string");
  });

  it("does NOT emit an audit line on token-shape failure (no snapshot was read)", async () => {
    const res = await getReportShareHandler(mkRequest("!!!"), mkContext());
    expect(res.status).toBe(400);
    expect(mocks.emitReportHtmlShareReadAudit).not.toHaveBeenCalled();
  });

  it("does NOT emit an audit line on signing-key unavailability (503)", async () => {
    mocks.loadReportShareSigningKey.mockResolvedValue({
      key: null,
      fallbackReason: "kv_read_failed",
      errorDetail: "RestError 503",
    });
    const res = await getReportShareHandler(mkRequest(freshToken()), mkContext());
    expect(res.status).toBe(503);
    expect(mocks.emitReportHtmlShareReadAudit).not.toHaveBeenCalled();
  });

  it("does NOT emit an audit line on expired tokens (410)", async () => {
    const expired = freshToken({ expiresAtMs: Date.now() - 1_000 });
    const res = await getReportShareHandler(mkRequest(expired), mkContext());
    expect(res.status).toBe(410);
    expect(mocks.emitReportHtmlShareReadAudit).not.toHaveBeenCalled();
  });

  it("does NOT emit an audit line on tenant mismatch (no snapshot was read)", async () => {
    const token = freshToken({ tenantId: "22222222-2222-2222-2222-222222222222" });
    const res = await getReportShareHandler(mkRequest(token), mkContext());
    expect(res.status).toBe(400);
    expect(mocks.emitReportHtmlShareReadAudit).not.toHaveBeenCalled();
  });

  it("does NOT emit an audit line on missing-snapshot (404)", async () => {
    mocks.readLatestSnapshot.mockResolvedValue(null);
    const res = await getReportShareHandler(mkRequest(freshToken()), mkContext());
    expect(res.status).toBe(404);
    expect(mocks.emitReportHtmlShareReadAudit).not.toHaveBeenCalled();
  });

  it("returns 200 HTML even when the audit emit throws (fail-soft, warn-only)", async () => {
    mocks.emitReportHtmlShareReadAudit.mockRejectedValue(
      new Error("blob 503 transient"),
    );
    const ctx = mkContext();
    const res = await getReportShareHandler(mkRequest(freshToken()), ctx);
    expect(res.status).toBe(200);
    expect(res.body).toBe("<!doctype html><html><body>ok</body></html>");
    // Surfaced as a warn breadcrumb so the SOC verifier can correlate
    // the chain gap to a specific correlationId + jti.
    const warnFn = ctx.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warnFn).toHaveBeenCalled();
    const warnMsg = String(warnFn.mock.calls[0]?.[0] ?? "");
    expect(warnMsg).toContain("audit_write_failed");
    expect(warnMsg).toContain("blob 503 transient");
  });

  it("logs a warn (but still serves 200) when the audit emit signals lease_contended", async () => {
    mocks.emitReportHtmlShareReadAudit.mockResolvedValue({
      outcome: "lease_contended",
    });
    const ctx = mkContext();
    const res = await getReportShareHandler(mkRequest(freshToken()), ctx);
    expect(res.status).toBe(200);
    const warnFn = ctx.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warnFn).toHaveBeenCalled();
    const warnMsg = String(warnFn.mock.calls[0]?.[0] ?? "");
    expect(warnMsg).toContain("audit_lease_contended");
  });
});
