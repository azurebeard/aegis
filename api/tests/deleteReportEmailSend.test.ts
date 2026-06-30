// Handler-level integration tests for DELETE /api/reports/email/sends/{graphMessageId}.
// Covers the 403 / 400 / 429 / 503 gates introduced across Phase C Slice
// 1(c)/B3 + the per-admin rate-limit added in the Lows-batch (WS10 Slice
// 1(c)/B3). Happy-path Table deletion is covered at the store-helper level.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

const mocks = vi.hoisted(() => ({
  readClientPrincipal: vi.fn(),
  deleteReportEmailSend: vi.fn(),
  emitAievent: vi.fn(),
}));

vi.mock("../src/lib/clientPrincipal.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/clientPrincipal.js")>(
      "../src/lib/clientPrincipal.js",
    );
  return { ...actual, readClientPrincipal: mocks.readClientPrincipal };
});

vi.mock("../src/lib/tenantSettingsStore.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/tenantSettingsStore.js")>(
      "../src/lib/tenantSettingsStore.js",
    );
  return { ...actual, deleteReportEmailSend: mocks.deleteReportEmailSend };
});

vi.mock("../src/lib/aievent.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/aievent.js")>(
      "../src/lib/aievent.js",
    );
  return { ...actual, emitAievent: mocks.emitAievent };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/tables.js")>(
      "../src/lib/tables.js",
    );
  return { ...actual, getTableClient: vi.fn(() => ({}) as never) };
});

import { deleteReportEmailSendHandler } from "../src/functions/deleteReportEmailSend.js";
import { reportEmailDeleteRateLimiter } from "../src/lib/rateLimit.js";

beforeEach(() => {
  vi.stubEnv("API_READER_MI_CLIENT_ID", "api-mi");
  vi.stubEnv("INGEST_MI_CLIENT_ID", "ingest-mi");
  vi.stubEnv("AUDIT_MI_CLIENT_ID", "audit-mi");
  vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mail-sender-mi");
  vi.stubEnv("OPS_TABLE_ENDPOINT", "https://staegisops.table.core.windows.net");
  vi.stubEnv("AUDIT_BLOB_ENDPOINT", "https://staegisaudit.blob.core.windows.net");
  vi.stubEnv("GRAPH_BASE_URL", "https://graph.microsoft.com");
  vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
  mocks.readClientPrincipal.mockReset();
  mocks.deleteReportEmailSend.mockReset();
  mocks.emitAievent.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function mkRequest(graphMessageId: string) {
  return {
    headers: { get: (_k: string) => null },
    params: { graphMessageId },
  } as unknown as Parameters<typeof deleteReportEmailSendHandler>[0];
}

function mkContext(invocationId = "inv-1") {
  return {
    invocationId,
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof deleteReportEmailSendHandler>[1];
}

describe("deleteReportEmailSend handler — gates", () => {
  it("403 when the principal lacks the admin role", async () => {
    mocks.readClientPrincipal.mockResolvedValue({
      userId: "non-admin@example.com",
      userRoles: ["authenticated"],
    });
    const res = await deleteReportEmailSendHandler(
      mkRequest("abc123"),
      mkContext(),
    );
    expect(res.status).toBe(403);
    const body = res.jsonBody as { error?: { code?: string } };
    expect(body.error?.code).toBe("forbidden");
    expect(mocks.deleteReportEmailSend).not.toHaveBeenCalled();
  });

  it("400 when graphMessageId is empty", async () => {
    mocks.readClientPrincipal.mockResolvedValue({
      userId: "admin@example.com",
      userRoles: ["admin"],
    });
    const res = await deleteReportEmailSendHandler(mkRequest(""), mkContext());
    expect(res.status).toBe(400);
    const body = res.jsonBody as { error?: { code?: string } };
    expect(body.error?.code).toBe("bad_request");
  });

  it("400 when graphMessageId contains illegal characters", async () => {
    mocks.readClientPrincipal.mockResolvedValue({
      userId: "admin@example.com",
      userRoles: ["admin"],
    });
    // Path with `/` is excluded by the regex (and is also Table-key illegal).
    const res = await deleteReportEmailSendHandler(
      mkRequest("bad/key"),
      mkContext(),
    );
    expect(res.status).toBe(400);
    const body = res.jsonBody as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/[A-Za-z0-9_\-=.@:+]/);
  });

  it("503 not_configured when MAIL_SENDER_MI_CLIENT_ID is missing", async () => {
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "");
    mocks.readClientPrincipal.mockResolvedValue({
      userId: "admin@example.com",
      userRoles: ["admin"],
    });
    const res = await deleteReportEmailSendHandler(
      mkRequest("validmsgid001"),
      mkContext(),
    );
    expect(res.status).toBe(503);
    const body = res.jsonBody as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_configured");
  });

  it("429 when the per-admin rate-limit is exhausted (WS10 Slice 1(c)/B3 — L8)", async () => {
    const principalUserId = "admin-burning-budget@example.com";
    mocks.readClientPrincipal.mockResolvedValue({
      userId: principalUserId,
      userRoles: ["admin"],
    });
    mocks.deleteReportEmailSend.mockResolvedValue(true);
    // Saturate this principal's bucket directly so the test doesn't depend on
    // 30 invocations of the handler. The handler's check() call lands the
    // 31st request which the limiter denies.
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      reportEmailDeleteRateLimiter.check(principalUserId, now + i);
    }
    const res = await deleteReportEmailSendHandler(
      mkRequest("validmsgid002"),
      mkContext("inv-rate-limit"),
    );
    expect(res.status).toBe(429);
    const body = res.jsonBody as {
      error?: { code?: string; retryAfterSeconds?: number };
    };
    expect(body.error?.code).toBe("rate_limited");
    expect(body.error?.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers).toMatchObject({
      "retry-after": expect.stringMatching(/^\d+$/),
    });
    // The rate-limit gate fires AFTER the auth + bad-request + 503 checks
    // but BEFORE the table delete — no Table I/O should have happened.
    expect(mocks.deleteReportEmailSend).not.toHaveBeenCalled();
    // No erasure-action telemetry either (we never reached the emit).
    expect(mocks.emitAievent).not.toHaveBeenCalled();
  });

  it("200 happy path: principal is admin, rate-limit ok, deletion proceeds + aievent emitted", async () => {
    const principalUserId = "happy-admin@example.com";
    mocks.readClientPrincipal.mockResolvedValue({
      userId: principalUserId,
      userRoles: ["admin"],
    });
    mocks.deleteReportEmailSend.mockResolvedValue(true);
    const res = await deleteReportEmailSendHandler(
      mkRequest("validmsgid003"),
      mkContext("inv-happy"),
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as {
      schemaVersion?: number;
      deleted?: boolean;
      graphMessageId?: string;
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.deleted).toBe(true);
    expect(body.graphMessageId).toBe("validmsgid003");
    expect(mocks.deleteReportEmailSend).toHaveBeenCalledTimes(1);
    expect(mocks.emitAievent).toHaveBeenCalledWith(
      expect.anything(),
      "report.email.historyRowDeleted",
      expect.objectContaining({
        graphMessageId: "validmsgid003",
        operatorPrincipal: principalUserId,
        rowFound: true,
      }),
    );
  });
});
