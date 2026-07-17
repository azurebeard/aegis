// Tests for getIngestRunHistory endpoint helpers.
// Covers parseLimit + parseSource + projectLine. The audit-blob walk is
// covered by audit-related tests where AppendBlobClient is stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("getIngestRunHistory.parseLimit", () => {
  it("returns the default (20) when limit is unset", async () => {
    const { parseLimit } = await import(
      "../src/functions/getIngestRunHistory.js"
    );
    expect(parseLimit(null)).toEqual({ kind: "ok", value: 20 });
    expect(parseLimit("")).toEqual({ kind: "ok", value: 20 });
  });

  it("accepts integers in the valid range", async () => {
    const { parseLimit } = await import(
      "../src/functions/getIngestRunHistory.js"
    );
    expect(parseLimit("1")).toEqual({ kind: "ok", value: 1 });
    expect(parseLimit("100")).toEqual({ kind: "ok", value: 100 });
  });

  it("rejects values outside the [1, 100] range or non-integers", async () => {
    const { parseLimit } = await import(
      "../src/functions/getIngestRunHistory.js"
    );
    for (const bad of ["0", "-1", "101", "1000", "1.5", "abc", "5x"]) {
      const r = parseLimit(bad);
      expect(r.kind, `expected error for '${bad}'`).toBe("error");
    }
  });
});

describe("getIngestRunHistory.parseSource", () => {
  it("accepts every documented source", async () => {
    const { parseSource } = await import(
      "../src/functions/getIngestRunHistory.js"
    );
    expect(parseSource("secure-score")).toBe("secure-score");
    expect(parseSource("incidents")).toBe("incidents");
    expect(parseSource("entra-risk")).toBe("entra-risk");
    expect(parseSource("kev")).toBe("kev");
    expect(parseSource("user-dormancy")).toBe("user-dormancy");
    expect(parseSource("sign-ins")).toBe("sign-ins");
    expect(parseSource("conditional-access")).toBe("conditional-access");
    expect(parseSource("azure-secure-score")).toBe("azure-secure-score");
    expect(parseSource("ransomware-intel")).toBe("ransomware-intel");
  });

  it("rejects unknown / hostile / empty values", async () => {
    const { parseSource } = await import(
      "../src/functions/getIngestRunHistory.js"
    );
    for (const bad of [
      "",
      "agent.aegis.brief",
      "graph.security.secureScores",
      "../../../etc/passwd",
      "secure-score; rm -rf /",
      "SECURE-SCORE",
      // secureScoreControlProfiles deliberately not in the allow-list —
      // that timer doesn't write audit lines.
      "secure-score-control-profiles",
      "control-profiles",
      "cisa.kev",
    ]) {
      expect(parseSource(bad), `expected null for '${bad}'`).toBeNull();
    }
  });
});

describe("getIngestRunHistory.projectLine", () => {
  it("drops chain SHAs, error.message, and callerPrincipalMiClientId", async () => {
    const { projectLine } = await import(
      "../src/functions/getIngestRunHistory.js"
    );
    const projected = projectLine({
      schemaVersion: 2,
      eventType: "ingest.run",
      source: "graph.security.secureScores",
      seq: 42,
      runId: "run-1",
      tenantId: "tenant-1",
      startedAt: "2026-04-28T03:00:00Z",
      endedAt: "2026-04-28T03:00:05Z",
      status: "error",
      rowsWritten: 0,
      retentionRowsDeleted: 0,
      graphAttempts: 3,
      callerPrincipalMiClientId: "mi-client-id-secret",
      error: {
        kind: "4xx",
        message: "raw upstream message that may carry adversary text",
      },
      prevLineSha256: "prev-sha",
      lineSha256: "this-sha",
      day: "2026-04-28",
    });
    expect(projected).toEqual({
      runId: "run-1",
      startedAt: "2026-04-28T03:00:00Z",
      endedAt: "2026-04-28T03:00:05Z",
      status: "error",
      rowsWritten: 0,
      retentionRowsDeleted: 0,
      graphAttempts: 3,
      snapshotDate: null,
      currentScore: null,
      maxScore: null,
      errorKind: "4xx",
      day: "2026-04-28",
    });
    // Defence-in-depth: assert the SPA-leaky fields are absent. Cast
    // through unknown so we can inspect arbitrary keys.
    const asRecord = projected as unknown as Record<string, unknown>;
    expect(asRecord["lineSha256"]).toBeUndefined();
    expect(asRecord["prevLineSha256"]).toBeUndefined();
    expect(asRecord["callerPrincipalMiClientId"]).toBeUndefined();
    expect(asRecord["error"]).toBeUndefined();
  });

  // §10.60 INFO-1 — pin `subscriptionId` redaction. The ARM-plane secure-
  // score audit lines carry a `subscriptionId` field (GUID) on both
  // success + error shapes. `projectLine` already drops it by virtue of
  // not naming it in the projected shape, but this test makes the
  // redaction explicit so a future shape-additive change to
  // `IngestRunHistoryItem` (e.g. surfacing `subscriptionId` alongside
  // `snapshotDate` for multi-sub) is a deliberate, reviewable choice
  // rather than a silent regression.
  it("drops subscriptionId from azure.security.* audit lines", async () => {
    const { projectLine } = await import(
      "../src/functions/getIngestRunHistory.js"
    );
    const projected = projectLine({
      schemaVersion: 2,
      eventType: "ingest.run",
      source: "azure.security.defenderForCloud.secureScores",
      seq: 1,
      runId: "run-arm-success",
      tenantId: "tenant-1",
      startedAt: "2026-05-12T02:30:00Z",
      endedAt: "2026-05-12T02:30:03Z",
      status: "success",
      rowsWritten: 1,
      retentionRowsDeleted: 0,
      graphAttempts: 1,
      snapshotDate: "2026-05-12",
      currentScore: 51,
      maxScore: 60,
      // Cast through unknown to attach optional ARM-shape fields that
      // aren't part of the strict AuditLineRead type signature.
      ...({
        subscriptionId: "58ffe548-7d9e-4c50-9fb9-bcbd74d39fdd",
        percentage: 85,
      } as Record<string, unknown>),
      callerPrincipalMiClientId: "mi-client-id",
      prevLineSha256: "p",
      lineSha256: "l",
      day: "2026-05-12",
    });
    const asRecord = projected as unknown as Record<string, unknown>;
    expect(
      asRecord["subscriptionId"],
      "projectLine must not surface subscriptionId — ADR-0036 audit lines carry the subscription GUID but reader-facing run history does not",
    ).toBeUndefined();
    expect(asRecord["percentage"]).toBeUndefined();
    // Sanity: the line still projects normally.
    expect(projected.status).toBe("success");
    expect(projected.runId).toBe("run-arm-success");
  });

  it("surfaces snapshot fields on a success line", async () => {
    const { projectLine } = await import(
      "../src/functions/getIngestRunHistory.js"
    );
    const projected = projectLine({
      schemaVersion: 2,
      eventType: "ingest.run",
      source: "graph.security.secureScores",
      seq: 7,
      runId: "run-ok",
      tenantId: "tenant-1",
      startedAt: "2026-04-27T03:00:00Z",
      endedAt: "2026-04-27T03:00:02Z",
      status: "success",
      rowsWritten: 1,
      retentionRowsDeleted: 0,
      graphAttempts: 1,
      snapshotDate: "2026-04-27",
      currentScore: 59.19,
      maxScore: 74,
      callerPrincipalMiClientId: "mi-client-id",
      prevLineSha256: "p",
      lineSha256: "l",
      day: "2026-04-27",
    });
    expect(projected.status).toBe("success");
    expect(projected.snapshotDate).toBe("2026-04-27");
    expect(projected.currentScore).toBe(59.19);
    expect(projected.maxScore).toBe(74);
    expect(projected.errorKind).toBeNull();
  });
});
