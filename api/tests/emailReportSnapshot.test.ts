// Handler-level integration tests for POST /api/reports/snapshots/{periodKey}/email.
// Covers the security-relevant gates introduced across Phase C:
//   - 403: non-admin principals (§C.4)
//   - 400: malformed periodKey / Idempotency-Key (§C.5.1)
//   - 503: inert deployment (no mailSender MI configured)
//   - 409: Idempotency-Key replayed with a different periodKey (§C.5.1 WS10 MED #1)
//   - 429: send rate-limit exhausted (§C.5)
//   - 200: idempotency replay with matching periodKey (§C.5.1)
//
// Happy-path Graph send is covered at the orchestrator level
// (reportEmail.test.ts). This file exercises the HTTP-handler entry.

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
  readReportEmailIdempotency: vi.fn(),
  readReportEmailConfig: vi.fn(),
  readLatestSnapshot: vi.fn(),
  sendReportSnapshotEmail: vi.fn(),
  buildReportEmailAuditHooks: vi.fn(() => ({})),
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
  return {
    ...actual,
    readReportEmailIdempotency: mocks.readReportEmailIdempotency,
    readReportEmailConfig: mocks.readReportEmailConfig,
    upsertReportEmailIdempotency: vi.fn(),
  };
});

vi.mock("../src/lib/reportSnapshotStore.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/reportSnapshotStore.js")>(
      "../src/lib/reportSnapshotStore.js",
    );
  return { ...actual, readLatestSnapshot: mocks.readLatestSnapshot };
});

vi.mock("../src/lib/reportEmail.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/reportEmail.js")>(
      "../src/lib/reportEmail.js",
    );
  return { ...actual, sendReportSnapshotEmail: mocks.sendReportSnapshotEmail };
});

vi.mock("../src/lib/reportEmailAuditHooks.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/reportEmailAuditHooks.js")>(
      "../src/lib/reportEmailAuditHooks.js",
    );
  return {
    ...actual,
    buildReportEmailAuditHooks: mocks.buildReportEmailAuditHooks,
  };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/tables.js")>(
      "../src/lib/tables.js",
    );
  return { ...actual, getTableClient: vi.fn(() => ({}) as never) };
});

import { emailReportSnapshotHandler } from "../src/functions/emailReportSnapshot.js";
import { reportEmailSendRateLimiter } from "../src/lib/rateLimit.js";
import { RecipientHashPepperRequiredError } from "../src/lib/recipientHashPepper.js";
import { ReportShareUrlRequiredError } from "../src/lib/reportEmail.js";

beforeEach(() => {
  vi.stubEnv("API_READER_MI_CLIENT_ID", "api-mi");
  vi.stubEnv("INGEST_MI_CLIENT_ID", "ingest-mi");
  vi.stubEnv("AUDIT_MI_CLIENT_ID", "audit-mi");
  vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mail-sender-mi");
  vi.stubEnv("OPS_TABLE_ENDPOINT", "https://staegisops.table.core.windows.net");
  vi.stubEnv("AUDIT_BLOB_ENDPOINT", "https://staegisaudit.blob.core.windows.net");
  vi.stubEnv("GRAPH_BASE_URL", "https://graph.microsoft.com");
  vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
  vi.stubEnv("AZURE_MAIL_SENDER_UPN", "noreply@example.com");
  vi.stubEnv("REPORT_SNAPSHOT_VERSIONS_PER_PERIOD", "3");
  vi.stubEnv("REPORT_SNAPSHOT_RETENTION_DAYS", "30");
  for (const k of Object.keys(mocks) as Array<keyof typeof mocks>) {
    const m = mocks[k];
    if (typeof m === "function" && "mockReset" in m) m.mockReset();
  }
  mocks.buildReportEmailAuditHooks.mockReturnValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function mkRequest(opts: {
  readonly periodKey?: string;
  readonly idempotencyKey?: string;
}) {
  const headers = new Map<string, string>();
  if (opts.idempotencyKey !== undefined) {
    headers.set("idempotency-key", opts.idempotencyKey);
  }
  return {
    headers: {
      get: (k: string) => headers.get(k.toLowerCase()) ?? null,
    },
    params: opts.periodKey !== undefined ? { periodKey: opts.periodKey } : {},
  } as unknown as Parameters<typeof emailReportSnapshotHandler>[0];
}

function mkContext(invocationId = "inv-1") {
  return {
    invocationId,
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof emailReportSnapshotHandler>[1];
}

const ADMIN_PRINCIPAL = { userId: "admin@example.com", userRoles: ["admin"] };

describe("emailReportSnapshot handler — gates", () => {
  it("403 when the principal lacks the admin role", async () => {
    mocks.readClientPrincipal.mockResolvedValue({
      userId: "guest@example.com",
      userRoles: ["authenticated"],
    });
    const res = await emailReportSnapshotHandler(
      mkRequest({ periodKey: "2026-05" }),
      mkContext(),
    );
    expect(res.status).toBe(403);
    expect(mocks.readReportEmailIdempotency).not.toHaveBeenCalled();
  });

  it("400 when periodKey path parameter is missing", async () => {
    mocks.readClientPrincipal.mockResolvedValue(ADMIN_PRINCIPAL);
    const res = await emailReportSnapshotHandler(mkRequest({}), mkContext());
    expect(res.status).toBe(400);
    const body = res.jsonBody as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/periodKey/i);
  });

  it("400 when periodKey shape doesn't match any cadence", async () => {
    mocks.readClientPrincipal.mockResolvedValue(ADMIN_PRINCIPAL);
    const res = await emailReportSnapshotHandler(
      mkRequest({ periodKey: "not-a-period" }),
      mkContext(),
    );
    expect(res.status).toBe(400);
    const body = res.jsonBody as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/cadence/i);
  });

  it("400 when Idempotency-Key contains illegal characters", async () => {
    mocks.readClientPrincipal.mockResolvedValue(ADMIN_PRINCIPAL);
    const res = await emailReportSnapshotHandler(
      mkRequest({ periodKey: "2026-05", idempotencyKey: "has spaces" }),
      mkContext(),
    );
    expect(res.status).toBe(400);
    const body = res.jsonBody as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/Idempotency-Key/);
  });

  it("503 when MAIL_SENDER_MI_CLIENT_ID is not set (Phase C inert)", async () => {
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "");
    mocks.readClientPrincipal.mockResolvedValue(ADMIN_PRINCIPAL);
    const res = await emailReportSnapshotHandler(
      mkRequest({ periodKey: "2026-05" }),
      mkContext(),
    );
    expect(res.status).toBe(503);
    const body = res.jsonBody as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_configured");
  });

  it("409 idempotency_key_mismatch when the cached key was bound to a different periodKey", async () => {
    mocks.readClientPrincipal.mockResolvedValue(ADMIN_PRINCIPAL);
    // Cache hit for a DIFFERENT periodKey than the request — §C.5.1 WS10 MED #1.
    mocks.readReportEmailIdempotency.mockResolvedValue({
      idempotencyKey: "abcdef12345",
      periodKey: "2026-04", // bound to April
      responseBody: { schemaVersion: 1 },
      cachedAt: "2026-04-30T10:00:00Z",
      expiresAt: "2026-05-01T10:00:00Z",
    });
    const res = await emailReportSnapshotHandler(
      mkRequest({ periodKey: "2026-05", idempotencyKey: "abcdef12345" }),
      mkContext("inv-409-mismatch"),
    );
    expect(res.status).toBe(409);
    const body = res.jsonBody as {
      error?: { code?: string; cachedPeriodKey?: string; cachedAt?: string };
    };
    expect(body.error?.code).toBe("idempotency_key_mismatch");
    expect(body.error?.cachedPeriodKey).toBe("2026-04");
    expect(body.error?.cachedAt).toBe("2026-04-30T10:00:00Z");
  });

  it("200 idempotency replay when the cached key matches the periodKey", async () => {
    mocks.readClientPrincipal.mockResolvedValue(ADMIN_PRINCIPAL);
    const cachedBody = {
      schemaVersion: 1,
      status: "sent",
      graphMessageId: "msg-cached",
    };
    mocks.readReportEmailIdempotency.mockResolvedValue({
      idempotencyKey: "abcdef99999",
      periodKey: "2026-05",
      responseBody: cachedBody,
      cachedAt: "2026-05-01T10:00:00Z",
      expiresAt: "2026-05-02T10:00:00Z",
    });
    const res = await emailReportSnapshotHandler(
      mkRequest({ periodKey: "2026-05", idempotencyKey: "abcdef99999" }),
      mkContext("inv-200-replay"),
    );
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual(cachedBody);
    expect(res.headers).toMatchObject({
      "idempotency-replayed": "true",
    });
    // Replay must NOT have invoked Graph.
    expect(mocks.sendReportSnapshotEmail).not.toHaveBeenCalled();
  });

  it("429 when the send rate-limit is exhausted (WS10 §C.5)", async () => {
    mocks.readClientPrincipal.mockResolvedValue(ADMIN_PRINCIPAL);
    mocks.readReportEmailIdempotency.mockResolvedValue(null);
    // Pre-burn the per-tenant 10/24h budget so the handler's check() lands
    // the 11th request which the limiter denies.
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      reportEmailSendRateLimiter.check("tenant-1", now + i);
    }
    const res = await emailReportSnapshotHandler(
      mkRequest({ periodKey: "2026-05" }),
      mkContext("inv-429"),
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
    // Rate-limit gate fires BEFORE Graph send.
    expect(mocks.sendReportSnapshotEmail).not.toHaveBeenCalled();
    expect(mocks.readReportEmailConfig).not.toHaveBeenCalled();
  });

  // SEC-L-L12-01 — RECIPIENT_HASH_PEPPER_REQUIRED hard-fail mapping.
  it("502 recipient_hash_pepper_required when the orchestrator throws RecipientHashPepperRequiredError", async () => {
    // Use a distinct tenant id so the prior 429 test's pre-burn of the
    // sliding-window rate limiter (per-tenant module-scope state) doesn't
    // pre-empt this test's path to the orchestrator.
    vi.stubEnv("AZURE_TENANT_ID", "tenant-l12-01");
    mocks.readClientPrincipal.mockResolvedValue(ADMIN_PRINCIPAL);
    mocks.readReportEmailIdempotency.mockResolvedValue(null);
    mocks.readReportEmailConfig.mockResolvedValue({
      enabled: true,
      recipients: ["board@example.com"],
      externalRecipientDomains: [],
      allowExternalRecipients: false,
      subjectPrefix: undefined,
    });
    mocks.readLatestSnapshot.mockResolvedValue({
      schemaVersion: 1,
      tenantId: "tenant-1",
      periodKey: "2026-05",
      cadence: "monthly",
      capturedAt: "2026-05-31T00:00:00Z",
      capturedBy: "system",
      blobName: "envelope.json",
      contentSha256: "x",
      sourcesUsed: [],
      sections: {},
    });
    mocks.sendReportSnapshotEmail.mockRejectedValue(
      new RecipientHashPepperRequiredError("kv_read_failed", "RestError 503"),
    );

    const res = await emailReportSnapshotHandler(
      mkRequest({ periodKey: "2026-05" }),
      mkContext("inv-l12-01"),
    );

    expect(res.status).toBe(502);
    const body = res.jsonBody as {
      error?: { code?: string; message?: string; fallbackReason?: string; correlationId?: string };
    };
    expect(body.error?.code).toBe("recipient_hash_pepper_required");
    expect(body.error?.fallbackReason).toBe("kv_read_failed");
    expect(body.error?.correlationId).toBe("inv-l12-01");
    // WS10 M-1 — the scrubbed errorDetail (`RestError 503`) MUST NOT leak
    // into the response body. The body message references the fallback
    // reason ONLY; dependency-error metadata stays on the warn log.
    expect(body.error?.message).toBe(
      "Recipient-hash pepper is required but unavailable: kv_read_failed",
    );
    expect(body.error?.message).not.toContain("RestError");
    expect(body.error?.message).not.toContain("503");
    expect(res.headers).toMatchObject({ "cache-control": "no-store" });
  });

  // SEC-L-L12-02 — REPORT_SHARE_URL_REQUIRED hard-fail mapping. Sibling
  // of the L12-01 test above; pins the wire shape for the share-URL
  // hard-fail surface (distinct `code` string so SPA telemetry can pivot).
  it("502 report_share_url_required when the orchestrator throws ReportShareUrlRequiredError", async () => {
    vi.stubEnv("AZURE_TENANT_ID", "tenant-l12-02");
    mocks.readClientPrincipal.mockResolvedValue(ADMIN_PRINCIPAL);
    mocks.readReportEmailIdempotency.mockResolvedValue(null);
    mocks.readReportEmailConfig.mockResolvedValue({
      enabled: true,
      recipients: ["board@example.com"],
      externalRecipientDomains: [],
      allowExternalRecipients: false,
      subjectPrefix: undefined,
    });
    mocks.readLatestSnapshot.mockResolvedValue({
      schemaVersion: 1,
      tenantId: "tenant-1",
      periodKey: "2026-05",
      cadence: "monthly",
      capturedAt: "2026-05-31T00:00:00Z",
      capturedBy: "system",
      blobName: "envelope.json",
      contentSha256: "x",
      sourcesUsed: [],
      sections: {},
    });
    mocks.sendReportSnapshotEmail.mockRejectedValue(
      new ReportShareUrlRequiredError("kv_read_failed", "RestError 503"),
    );

    const res = await emailReportSnapshotHandler(
      mkRequest({ periodKey: "2026-05" }),
      mkContext("inv-l12-02"),
    );

    expect(res.status).toBe(502);
    const body = res.jsonBody as {
      error?: { code?: string; message?: string; fallbackReason?: string; correlationId?: string };
    };
    expect(body.error?.code).toBe("report_share_url_required");
    expect(body.error?.fallbackReason).toBe("kv_read_failed");
    expect(body.error?.correlationId).toBe("inv-l12-02");
    // Same body/log split as the L12-01 case: the scrubbed `errorDetail`
    // (`RestError 503`) MUST stay on the warn log only, NEVER on the
    // admin-facing wire payload.
    expect(body.error?.message).toBe(
      "Share URL is required but unavailable: kv_read_failed",
    );
    expect(body.error?.message).not.toContain("RestError");
    expect(body.error?.message).not.toContain("503");
    expect(res.headers).toMatchObject({ "cache-control": "no-store" });
  });
});
