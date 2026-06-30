import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InvocationContext } from "@azure/functions";
import type { EntraRiskIngestConfig } from "../src/lib/config.js";

// Hoisted mocks — must use vi.hoisted() so they're available at module
// evaluation time (the orchestrator imports `graphClient`, `ingestHealth`,
// `entraRiskStore`, `audit` and we substitute each).
const mocks = vi.hoisted(() => ({
  fetchRiskyUsersPaged: vi.fn(),
  fetchOrganizationAssignedPlans: vi.fn(),
  hasEntraIdP2: vi.fn(),
  getOrInitHealthRow: vi.fn(),
  commitHealthRow: vi.fn(),
  upsertRiskyUser: vi.fn(),
  sweepExpiredRows: vi.fn(),
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
    fetchRiskyUsersPaged: mocks.fetchRiskyUsersPaged,
    fetchOrganizationAssignedPlans: mocks.fetchOrganizationAssignedPlans,
    hasEntraIdP2: mocks.hasEntraIdP2,
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

vi.mock("../src/lib/entraRiskStore.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/entraRiskStore.js")>(
    "../src/lib/entraRiskStore.js",
  );
  return {
    ...actual,
    upsertRiskyUser: mocks.upsertRiskyUser,
    sweepExpiredRows: mocks.sweepExpiredRows,
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

vi.mock("../src/lib/tables.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tables.js")>(
    "../src/lib/tables.js",
  );
  return {
    ...actual,
    getTableClient: mocks.getTableClient,
  };
});

const { runEntraRiskIngestOnce } = await import("../src/lib/runEntraRiskIngest.js");
const { GraphFetchError } = await import("../src/lib/graphClient.js");

const CONFIG: EntraRiskIngestConfig = {
  ingestMiClientId: "mi-ingest",
  auditMiClientId: "mi-audit",
  apiReaderMiClientId: "mi-api",
  opsTableEndpoint: "https://fake.table.core.windows.net",
  auditBlobEndpoint: "https://fake.blob.core.windows.net",
  auditContainerName: "audit",
  graphBaseUrl: "https://graph.microsoft.com/v1.0",
  graphApiTimeoutMs: 30_000,
  tenantId: "tenant-1",
  leaseWindowMs: 300_000,
  source: "graph.security.riskyUsers",
  entraRiskTimerCron: "0 0 */4 * * *",
  entraRiskRetentionDays: 180,
  cursorOverlapMs: 120_000,
  cursorWriteSkewAllowanceMs: 300_000,
  cursorReadCorruptThresholdMs: 3_600_000,
  firstRunSeedBackSeekMs: 86_400_000,
  pageSize: 500,
  adminDailyRunCeiling: 30,
};

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
    etag: "W/\"etag-1\"",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTableClient.mockReturnValue(mocks.healthTable);
  mocks.commitHealthRow.mockResolvedValue("healthy");
  mocks.appendAuditLine.mockResolvedValue(undefined);
  mocks.sweepExpiredRows.mockResolvedValue(0);
  mocks.upsertRiskyUser.mockResolvedValue(undefined);
  mocks.healthTable.updateEntity.mockResolvedValue(undefined);
});

describe("runEntraRiskIngestOnce — licence-probe branches (ADR-0023 §7)", () => {
  it("P2 present on first run → proceeds to fetch", async () => {
    mocks.getOrInitHealthRow.mockResolvedValue(healthRow({ lastSuccessAt: null }));
    mocks.fetchOrganizationAssignedPlans.mockResolvedValue({
      data: { value: [] },
      attempts: 1,
      finalHttpStatus: 200,
      retryEvents: [],
    });
    mocks.hasEntraIdP2.mockReturnValue(true);
    mocks.fetchRiskyUsersPaged.mockResolvedValue({
      rawPages: [{ value: [] }],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });

    const outcome = await runEntraRiskIngestOnce(CONFIG, ctx());
    expect(outcome.licenceState).toBe("present");
    expect(outcome.status).toBe("success");
    expect(mocks.fetchRiskyUsersPaged).toHaveBeenCalledTimes(1);
  });

  it("P2 absent on first run → licence_required sticky + no fetch", async () => {
    mocks.getOrInitHealthRow.mockResolvedValue(healthRow({ lastSuccessAt: null }));
    mocks.fetchOrganizationAssignedPlans.mockResolvedValue({
      data: { value: [] },
      attempts: 1,
      finalHttpStatus: 200,
      retryEvents: [],
    });
    mocks.hasEntraIdP2.mockReturnValue(false);

    const outcome = await runEntraRiskIngestOnce(CONFIG, ctx());
    expect(outcome.licenceState).toBe("licence_required");
    expect(mocks.fetchRiskyUsersPaged).not.toHaveBeenCalled();
    // Sticky-set went through updateEntity directly (not commitHealthRow).
    expect(mocks.healthTable.updateEntity).toHaveBeenCalled();
  });

  it("/organization 403 → license_probe_failed, no sticky set", async () => {
    mocks.getOrInitHealthRow.mockResolvedValue(healthRow({ lastSuccessAt: null }));
    mocks.fetchOrganizationAssignedPlans.mockRejectedValue(
      new GraphFetchError("4xx", "forbidden", 403, 1),
    );

    const outcome = await runEntraRiskIngestOnce(CONFIG, ctx());
    expect(outcome.status).toBe("error");
    expect(outcome.error?.kind).toBe("license_probe_failed");
    expect(outcome.licenceState).toBe("unknown");
    expect(mocks.fetchRiskyUsersPaged).not.toHaveBeenCalled();
    // No sticky set on inconclusive probe.
    expect(mocks.healthTable.updateEntity).not.toHaveBeenCalled();
  });

  it("Timer trigger with persisted licence_required → short-circuits", async () => {
    mocks.getOrInitHealthRow.mockResolvedValue(
      healthRow({ status: "licence_required" }),
    );
    const outcome = await runEntraRiskIngestOnce(CONFIG, ctx(), { trigger: "timer" });
    expect(outcome.licenceState).toBe("licence_required");
    expect(mocks.fetchOrganizationAssignedPlans).not.toHaveBeenCalled();
    expect(mocks.fetchRiskyUsersPaged).not.toHaveBeenCalled();
  });

  it("Admin trigger re-probes even when persisted licence_required", async () => {
    mocks.getOrInitHealthRow.mockResolvedValue(
      healthRow({ status: "licence_required" }),
    );
    mocks.fetchOrganizationAssignedPlans.mockResolvedValue({
      data: { value: [] },
      attempts: 1,
      finalHttpStatus: 200,
      retryEvents: [],
    });
    mocks.hasEntraIdP2.mockReturnValue(true);
    mocks.fetchRiskyUsersPaged.mockResolvedValue({
      rawPages: [{ value: [] }],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    const outcome = await runEntraRiskIngestOnce(CONFIG, ctx(), { trigger: "admin" });
    expect(mocks.fetchOrganizationAssignedPlans).toHaveBeenCalled();
    expect(outcome.licenceState).toBe("present");
  });
});

describe("runEntraRiskIngestOnce — fetch path", () => {
  beforeEach(() => {
    mocks.getOrInitHealthRow.mockResolvedValue(
      healthRow({ lastSuccessAt: "2026-04-19T00:00:00.000Z", lastCursor: "2026-04-18T23:00:00.000Z" }),
    );
  });

  it("processes parsed rows and advances cursor", async () => {
    const validUser = {
      id: "3f7da1c2-4e56-4a89-8b30-99e4a2c1d7e5",
      userPrincipalName: "alice@contoso.com",
      userDisplayName: "Alice",
      riskLevel: "high",
      riskState: "atRisk",
      riskDetail: "unfamiliarFeatures",
      riskLastUpdatedDateTime: "2026-04-19T02:30:00.000Z",
      isDeleted: false,
      isProcessing: true,
    };
    mocks.fetchRiskyUsersPaged.mockResolvedValue({
      rawPages: [{ value: [validUser] }],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    const outcome = await runEntraRiskIngestOnce(CONFIG, ctx());
    expect(outcome.status).toBe("success");
    expect(outcome.riskyUsersIngested).toBe(1);
    expect(outcome.riskyUsersProcessing).toBe(1);
    expect(mocks.upsertRiskyUser).toHaveBeenCalledTimes(1);
    expect(outcome.cursorAfter).not.toBeNull();
  });

  it("records skipped malformed rows without failing the run", async () => {
    mocks.fetchRiskyUsersPaged.mockResolvedValue({
      rawPages: [
        {
          value: [
            { id: "bad id", riskLastUpdatedDateTime: "2026-04-19T00:00:00.000Z" },
          ],
        },
      ],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    const outcome = await runEntraRiskIngestOnce(CONFIG, ctx());
    expect(outcome.status).toBe("success");
    expect(outcome.riskyUsersIngested).toBe(0);
    expect(outcome.riskyUsersSkipped).toBe(1);
  });

  it("calls retention sweep after successful fetch+upsert", async () => {
    mocks.fetchRiskyUsersPaged.mockResolvedValue({
      rawPages: [{ value: [] }],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    mocks.sweepExpiredRows.mockResolvedValue(3);
    const outcome = await runEntraRiskIngestOnce(CONFIG, ctx());
    expect(outcome.status).toBe("success");
    expect(outcome.retentionRowsDeleted).toBe(3);
    expect(mocks.sweepExpiredRows).toHaveBeenCalledTimes(1);
  });

  it("uses `ingest.run` audit eventType with licenceState field", async () => {
    mocks.fetchRiskyUsersPaged.mockResolvedValue({
      rawPages: [{ value: [] }],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    await runEntraRiskIngestOnce(CONFIG, ctx());
    const line = mocks.appendAuditLine.mock.calls[0]![1] as Record<string, unknown>;
    expect(line.eventType).toBe("ingest.run");
    expect(line.source).toBe(CONFIG.source);
    expect(line.licenceState).toBeDefined();
    expect(line).toHaveProperty("riskyUsersIngested");
    expect(line).toHaveProperty("riskyUsersSkipped");
    expect(line).toHaveProperty("riskyUsersProcessing");
  });
});
