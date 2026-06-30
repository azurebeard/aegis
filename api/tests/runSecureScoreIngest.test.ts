import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InvocationContext } from "@azure/functions";
import type { IngestConfig } from "../src/lib/config.js";

// Hoisted mocks per the runEntraRiskIngest pattern.
const mocks = vi.hoisted(() => ({
  fetchLatestSecureScore: vi.fn(),
  getOrInitHealthRow: vi.fn(),
  commitHealthRow: vi.fn(),
  upsertSecureScoreSnapshot: vi.fn(),
  trimSnapshotRetention: vi.fn(),
  appendAuditLine: vi.fn(),
  getTableClient: vi.fn(),
  healthTable: { updateEntity: vi.fn() },
}));

vi.mock("../src/lib/graphClient.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/graphClient.js")>(
    "../src/lib/graphClient.js",
  );
  return {
    ...actual,
    fetchLatestSecureScore: mocks.fetchLatestSecureScore,
  };
});

vi.mock("../src/lib/ingestHealth.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ingestHealth.js")>(
    "../src/lib/ingestHealth.js",
  );
  return {
    ...actual,
    getOrInitHealthRow: mocks.getOrInitHealthRow,
    commitHealthRow: mocks.commitHealthRow,
  };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tables.js")>(
    "../src/lib/tables.js",
  );
  return {
    ...actual,
    getTableClient: mocks.getTableClient,
    upsertSecureScoreSnapshot: mocks.upsertSecureScoreSnapshot,
    trimSnapshotRetention: mocks.trimSnapshotRetention,
  };
});

vi.mock("../src/lib/audit.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/audit.js")>(
    "../src/lib/audit.js",
  );
  return {
    ...actual,
    appendAuditLine: mocks.appendAuditLine,
  };
});

const { runSecureScoreIngestOnce } = await import("../src/lib/runSecureScoreIngest.js");
const { GraphFetchError } = await import("../src/lib/graphClient.js");

const CONFIG: IngestConfig = {
  ingestMiClientId: "mi-ingest",
  auditMiClientId: "mi-audit",
  opsTableEndpoint: "https://fake.table.core.windows.net",
  auditBlobEndpoint: "https://fake.blob.core.windows.net",
  auditContainerName: "audit",
  graphBaseUrl: "https://graph.microsoft.com/v1.0",
  graphApiTimeoutMs: 30_000,
  tenantId: "tenant-1",
  leaseWindowMs: 300_000,
  source: "graph.security.secureScores",
  retentionCap: 400,
  adminDailyRunCeiling: 30,
} as unknown as IngestConfig;

function ctx(): InvocationContext {
  return {
    invocationId: "test-inv",
    log: vi.fn() as unknown as InvocationContext["log"],
    warn: vi.fn() as unknown as InvocationContext["warn"],
    error: vi.fn() as unknown as InvocationContext["error"],
    info: vi.fn() as unknown as InvocationContext["info"],
  } as unknown as InvocationContext;
}

function healthRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: CONFIG.tenantId,
    source: CONFIG.source,
    status: "healthy" as const,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailureCount: 0,
    lastRunId: null,
    lastAuditSeq: 0,
    lastLineSha256: "",
    lastCursor: "",
    updatedAt: "2026-04-19T00:00:00.000Z",
    etag: 'W/"etag-1"',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTableClient.mockReturnValue(mocks.healthTable);
  mocks.commitHealthRow.mockResolvedValue("healthy");
  mocks.appendAuditLine.mockResolvedValue(undefined);
  mocks.upsertSecureScoreSnapshot.mockResolvedValue(undefined);
  mocks.trimSnapshotRetention.mockResolvedValue(0);
  mocks.getOrInitHealthRow.mockResolvedValue(healthRow());
});

describe("runSecureScoreIngestOnce — graphAttempts telemetry on error", () => {
  it("surfaces err.attempts on the outcome when Graph fetch fails after retries", async () => {
    // Mirrors the live failure mode: 3 attempts × ~30s timeout = err.attempts=3.
    mocks.fetchLatestSecureScore.mockRejectedValue(
      new GraphFetchError("timeout", "graph fetch timeout", null, 3),
    );
    const outcome = await runSecureScoreIngestOnce(CONFIG, ctx());
    expect(outcome.status).toBe("error");
    expect(outcome.error?.kind).toBe("timeout");
    // Pre-fix this was 0 — now reflects the actual retry count.
    expect(outcome.graphAttempts).toBe(3);
  });

  it("surfaces err.attempts via audit-line emission on error", async () => {
    mocks.fetchLatestSecureScore.mockRejectedValue(
      new GraphFetchError("5xx", "graph 503", 503, 3),
    );
    await runSecureScoreIngestOnce(CONFIG, ctx());
    // The audit line is the single argument to appendAuditLine — graphAttempts
    // must reflect the actual retries, not 0.
    expect(mocks.appendAuditLine).toHaveBeenCalled();
    const call = mocks.appendAuditLine.mock.calls[0];
    const auditLine = call?.[1] as { readonly graphAttempts: number; readonly status: string } | undefined;
    expect(auditLine?.status).toBe("error");
    expect(auditLine?.graphAttempts).toBe(3);
  });

  it("graphAttempts is 0 when the error is non-Graph (internal)", async () => {
    // Pre-Graph internal error path (e.g. config / table init) — no retries
    // were attempted, so graphAttempts SHOULD be 0.
    mocks.fetchLatestSecureScore.mockRejectedValue(new Error("config blew up"));
    const outcome = await runSecureScoreIngestOnce(CONFIG, ctx());
    expect(outcome.status).toBe("error");
    expect(outcome.error?.kind).toBe("internal");
    expect(outcome.graphAttempts).toBe(0);
  });

  it("graphAttempts mirrors graphResult.attempts on the success path (unchanged behaviour)", async () => {
    mocks.fetchLatestSecureScore.mockResolvedValue({
      data: {
        id: "score-1",
        currentScore: 47,
        maxScore: 100,
        createdDateTime: "2026-04-29T00:00:00Z",
        averageComparativeScores: [],
        controlScores: [],
        enabledServices: [],
        activeUserCount: 100,
        licensedUserCount: 100,
      },
      attempts: 2,
      finalHttpStatus: 200,
      retryEvents: [],
    });
    const outcome = await runSecureScoreIngestOnce(CONFIG, ctx());
    expect(outcome.status).toBe("success");
    expect(outcome.graphAttempts).toBe(2);
  });
});
