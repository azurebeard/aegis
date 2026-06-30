// ADR-0034 §1, §6 — orchestrator tests focus on the licence_required +
// short-circuit + delete-not-found reconciliation paths. The hoisted-mocks
// pattern mirrors runEntraRiskIngest.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvocationContext } from "@azure/functions";
import type { UserDormancyIngestConfig } from "../src/lib/config.js";

const mocks = vi.hoisted(() => ({
  fetchUsersPaged: vi.fn(),
  getOrInitHealthRow: vi.fn(),
  commitHealthRow: vi.fn(),
  upsertUserDormancyRow: vi.fn(),
  listUserDormancyRows: vi.fn(),
  deleteUserDormancyRow: vi.fn(),
  appendAuditLine: vi.fn(),
  getTableClient: vi.fn(),
  healthTable: { updateEntity: vi.fn() },
}));

vi.mock("../src/lib/graphClient.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/graphClient.js")>(
    "../src/lib/graphClient.js",
  );
  return { ...actual, fetchUsersPaged: mocks.fetchUsersPaged };
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

vi.mock("../src/lib/userDormancyStore.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/userDormancyStore.js")
  >("../src/lib/userDormancyStore.js");
  return {
    ...actual,
    upsertUserDormancyRow: mocks.upsertUserDormancyRow,
    listUserDormancyRows: mocks.listUserDormancyRows,
    deleteUserDormancyRow: mocks.deleteUserDormancyRow,
  };
});

vi.mock("../src/lib/audit.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/audit.js")>(
    "../src/lib/audit.js",
  );
  return { ...actual, appendAuditLine: mocks.appendAuditLine };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tables.js")>(
    "../src/lib/tables.js",
  );
  return { ...actual, getTableClient: mocks.getTableClient };
});

const { runUserDormancyIngestOnce } = await import(
  "../src/lib/runUserDormancyIngest.js"
);

const CONFIG: UserDormancyIngestConfig = {
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
  source: "graph.users.dormancy",
  userDormancyTimerCron: "0 30 1 * * *",
  userDormancyDefaultThresholdDays: 30,
  pageSize: 999,
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
    updatedAt: "2026-04-30T01:30:00.000Z",
    etag: 'W/"etag-1"',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTableClient.mockReturnValue(mocks.healthTable);
  mocks.commitHealthRow.mockResolvedValue("healthy");
  mocks.appendAuditLine.mockResolvedValue(undefined);
  mocks.upsertUserDormancyRow.mockResolvedValue(undefined);
  mocks.deleteUserDormancyRow.mockResolvedValue(undefined);
  mocks.listUserDormancyRows.mockResolvedValue([]);
  mocks.healthTable.updateEntity.mockResolvedValue(undefined);
  mocks.getOrInitHealthRow.mockResolvedValue(healthRow());
});

describe("runUserDormancyIngestOnce — licence_required path", () => {
  it("sets sticky licence_required when every row has all signInActivity null", async () => {
    mocks.fetchUsersPaged.mockResolvedValue({
      rawPages: [
        {
          value: [
            {
              id: "u1",
              userPrincipalName: "a@x.com",
              displayName: "A",
              accountEnabled: true,
              // No signInActivity property → all three null after parse.
            },
            {
              id: "u2",
              userPrincipalName: "b@x.com",
              displayName: "B",
              accountEnabled: true,
            },
          ],
        },
      ],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });

    const outcome = await runUserDormancyIngestOnce(CONFIG, ctx());
    expect(outcome.licenceState).toBe("licence_required");
    expect(outcome.status).toBe("no_data");
    // Sticky-set went via updateEntity, not commitHealthRow.
    expect(mocks.healthTable.updateEntity).toHaveBeenCalled();
    expect(mocks.commitHealthRow).not.toHaveBeenCalled();
    // No rows written when licence_required (avoid polluting the table with
    // uniformly-null data).
    expect(mocks.upsertUserDormancyRow).not.toHaveBeenCalled();
  });

  it("does NOT set licence_required on legitimately-empty tenant (value: [])", async () => {
    mocks.fetchUsersPaged.mockResolvedValue({
      rawPages: [{ value: [] }],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    const outcome = await runUserDormancyIngestOnce(CONFIG, ctx());
    expect(outcome.licenceState).toBe("present");
    expect(outcome.status).toBe("success");
  });

  it("Timer trigger short-circuits when persisted licence_required", async () => {
    mocks.getOrInitHealthRow.mockResolvedValue(
      healthRow({ status: "licence_required" }),
    );
    const outcome = await runUserDormancyIngestOnce(CONFIG, ctx(), {
      trigger: "timer",
    });
    expect(outcome.licenceState).toBe("licence_required");
    expect(mocks.fetchUsersPaged).not.toHaveBeenCalled();
  });

  it("Admin trigger re-probes even when persisted licence_required", async () => {
    mocks.getOrInitHealthRow.mockResolvedValue(
      healthRow({ status: "licence_required" }),
    );
    mocks.fetchUsersPaged.mockResolvedValue({
      rawPages: [
        {
          value: [
            {
              id: "u1",
              userPrincipalName: "a@x.com",
              displayName: "A",
              accountEnabled: true,
              signInActivity: { lastSignInDateTime: "2026-04-15T08:00:00Z" },
            },
          ],
        },
      ],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    const outcome = await runUserDormancyIngestOnce(CONFIG, ctx(), {
      trigger: "admin",
    });
    expect(mocks.fetchUsersPaged).toHaveBeenCalled();
    expect(outcome.licenceState).toBe("present");
  });
});

describe("runUserDormancyIngestOnce — delete-not-found reconciliation", () => {
  it("deletes rows whose RowKey wasn't observed in the current run", async () => {
    mocks.fetchUsersPaged.mockResolvedValue({
      rawPages: [
        {
          value: [
            {
              id: "u1",
              userPrincipalName: "a@x.com",
              displayName: "A",
              accountEnabled: true,
              signInActivity: { lastSignInDateTime: "2026-04-15T08:00:00Z" },
            },
          ],
        },
      ],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    // Existing table has u1 + u2 (u2 no longer in the directory).
    mocks.listUserDormancyRows.mockResolvedValue([
      {
        id: "u1",
        userPrincipalName: "a@x.com",
        displayName: "A",
        accountEnabled: true,
        lastInteractiveSignIn: null,
        lastNonInteractiveSignIn: null,
        lastSuccessfulSignIn: null,
        ingestedAt: "",
        ingestRunId: "",
      },
      {
        id: "u2",
        userPrincipalName: "b@x.com",
        displayName: "B",
        accountEnabled: true,
        lastInteractiveSignIn: null,
        lastNonInteractiveSignIn: null,
        lastSuccessfulSignIn: null,
        ingestedAt: "",
        ingestRunId: "",
      },
    ]);
    const outcome = await runUserDormancyIngestOnce(CONFIG, ctx());
    expect(outcome.status).toBe("success");
    expect(outcome.usersIngested).toBe(1);
    // u2 must be deleted; u1 must NOT be deleted (still observed).
    expect(mocks.deleteUserDormancyRow).toHaveBeenCalledTimes(1);
    expect(mocks.deleteUserDormancyRow).toHaveBeenCalledWith(
      mocks.healthTable, // mocked getTableClient returns the same object for all callers
      "tenant-1",
      "u2",
    );
    expect(outcome.usersDeleted).toBe(1);
  });

  it("swallows 404 on concurrent delete (race-loss)", async () => {
    mocks.fetchUsersPaged.mockResolvedValue({
      rawPages: [{ value: [] }],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    mocks.listUserDormancyRows.mockResolvedValue([
      {
        id: "u1",
        userPrincipalName: "a@x.com",
        displayName: "A",
        accountEnabled: true,
        lastInteractiveSignIn: null,
        lastNonInteractiveSignIn: null,
        lastSuccessfulSignIn: null,
        ingestedAt: "",
        ingestRunId: "",
      },
    ]);
    const e = new Error("not found");
    (e as { statusCode?: number }).statusCode = 404;
    mocks.deleteUserDormancyRow.mockRejectedValueOnce(e);
    await expect(runUserDormancyIngestOnce(CONFIG, ctx())).resolves.toBeDefined();
  });

  it("propagates non-404 delete errors", async () => {
    mocks.fetchUsersPaged.mockResolvedValue({
      rawPages: [{ value: [] }],
      pagesFetched: 1,
      attempts: 1,
      retryEvents: [],
    });
    mocks.listUserDormancyRows.mockResolvedValue([
      {
        id: "u1",
        userPrincipalName: "a@x.com",
        displayName: "A",
        accountEnabled: true,
        lastInteractiveSignIn: null,
        lastNonInteractiveSignIn: null,
        lastSuccessfulSignIn: null,
        ingestedAt: "",
        ingestRunId: "",
      },
    ]);
    const e = new Error("internal");
    (e as { statusCode?: number }).statusCode = 500;
    mocks.deleteUserDormancyRow.mockRejectedValueOnce(e);
    await expect(runUserDormancyIngestOnce(CONFIG, ctx())).rejects.toThrow();
  });
});
