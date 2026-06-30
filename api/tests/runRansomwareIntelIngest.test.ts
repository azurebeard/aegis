// ADR-0037 Layer 3c — runRansomwareIntelIngestOnce unit tests.
//
// Mocks the four hard boundaries (HTTP client, IngestHealth, store,
// audit-blob) and asserts:
//   - happy path: both endpoints succeed → upserts called, retention trim
//     called, IngestHealth committed, audit line emitted
//   - no_data: both endpoints return empty → status="no_data"
//   - auth_unavailable: client throws RansomwareLiveFetchError{kind:
//     "auth_unavailable"} → status="error", error.kind="auth_unavailable",
//     NO upserts, NO retention trim
//   - schema_invalid: client throws schema_invalid → same treatment as
//     any other terminal upstream failure
//   - http throttle/5xx/timeout: surfaces err.kind + err.attempts on the
//     outcome AND on the audit line
//   - LeaseContendedError on commit: returns lease_contended error
//     outcome, does NOT write an audit line
//   - audit-line write failure: rethrows (so AppInsights sees the failure)
//   - admin trigger vs timer trigger: audit line gets `reason: "admin"`
//     when the orchestrator is called with trigger="admin"

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InvocationContext } from "@azure/functions";
import type { RansomwareIntelIngestConfig } from "../src/lib/config.js";
import type * as RLClient from "../src/lib/ransomwareLiveClient.js";
import type * as IngestHealthMod from "../src/lib/ingestHealth.js";
import type * as RIStore from "../src/lib/ransomwareIntelStore.js";
import type * as AuditMod from "../src/lib/audit.js";
import type * as TablesMod from "../src/lib/tables.js";

const mocks = vi.hoisted(() => ({
  fetchVictims: vi.fn(),
  fetchPress: vi.fn(),
  getOrInitHealthRow: vi.fn(),
  commitHealthRow: vi.fn(),
  upsertVictim: vi.fn(),
  upsertPress: vi.fn(),
  trimRansomwareIntelRetention: vi.fn(),
  appendAuditLine: vi.fn(),
  getTableClient: vi.fn(),
}));

vi.mock("../src/lib/ransomwareLiveClient.js", async () => {
  const actual = await vi.importActual<typeof RLClient>(
    "../src/lib/ransomwareLiveClient.js",
  );
  return {
    ...actual,
    fetchRansomwareLiveVictims: mocks.fetchVictims,
    fetchRansomwareLivePress: mocks.fetchPress,
  };
});

vi.mock("../src/lib/ingestHealth.js", async () => {
  const actual = await vi.importActual<typeof IngestHealthMod>(
    "../src/lib/ingestHealth.js",
  );
  return {
    ...actual,
    getOrInitHealthRow: mocks.getOrInitHealthRow,
    commitHealthRow: mocks.commitHealthRow,
  };
});

vi.mock("../src/lib/ransomwareIntelStore.js", async () => {
  const actual = await vi.importActual<typeof RIStore>(
    "../src/lib/ransomwareIntelStore.js",
  );
  return {
    ...actual,
    upsertVictim: mocks.upsertVictim,
    upsertPress: mocks.upsertPress,
    trimRansomwareIntelRetention: mocks.trimRansomwareIntelRetention,
  };
});

vi.mock("../src/lib/audit.js", async () => {
  const actual = await vi.importActual<typeof AuditMod>(
    "../src/lib/audit.js",
  );
  return {
    ...actual,
    appendAuditLine: mocks.appendAuditLine,
  };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual = await vi.importActual<typeof TablesMod>(
    "../src/lib/tables.js",
  );
  return {
    ...actual,
    getTableClient: mocks.getTableClient,
  };
});

const { runRansomwareIntelIngestOnce } = await import(
  "../src/lib/runRansomwareIntelIngest.js"
);
const { RansomwareLiveFetchError } = await import(
  "../src/lib/ransomwareLiveClient.js"
);
const { LeaseContendedError } = await import("../src/lib/ingestHealth.js");

const CONFIG: RansomwareIntelIngestConfig = {
  threatIntelMiClientId: "mi-threat-intel",
  auditMiClientId: "mi-audit",
  opsTableEndpoint: "https://fake.table.core.windows.net",
  auditBlobEndpoint: "https://fake.blob.core.windows.net",
  auditContainerName: "audit",
  tenantId: "tenant-1",
  source: "external.ransomware.live",
  country: "GB",
  retentionDays: 14,
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
    lastAuditSeq: 7,
    lastLineSha256: "deadbeef".padEnd(64, "f"),
    lastCursor: "",
    updatedAt: "2026-06-25T00:00:00.000Z",
    etag: 'W/"etag-1"',
    ...overrides,
  };
}

function victimResult(rows: unknown[]) {
  return {
    data: rows,
    attempts: 1,
    finalHttpStatus: 200,
    retryEvents: [],
  };
}

function pressResult(rows: unknown[]) {
  return {
    data: rows,
    attempts: 1,
    finalHttpStatus: 200,
    retryEvents: [],
  };
}

const SAMPLE_VICTIM = {
  id: "abc-1",
  victim: "Acme",
  group: "lockbit3",
  attackDate: null,
  discoveredDate: "2026-06-20T00:00:00Z",
  country: "GB",
  sector: "",
  activity: "",
  website: "",
  permalink: "",
  ingestedAt: "2026-06-25T13:00:00Z",
};

const SAMPLE_PRESS = {
  id: "",
  title: "News",
  url: "https://news.example/1",
  publishedAt: "2026-06-22T08:00:00Z",
  source: "News",
  country: "GB",
  summary: "",
  ingestedAt: "2026-06-25T13:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTableClient.mockReturnValue({});
  mocks.getOrInitHealthRow.mockResolvedValue(healthRow());
  mocks.commitHealthRow.mockResolvedValue("healthy");
  mocks.appendAuditLine.mockResolvedValue(undefined);
  mocks.upsertVictim.mockResolvedValue(undefined);
  mocks.upsertPress.mockResolvedValue(undefined);
  mocks.trimRansomwareIntelRetention.mockResolvedValue(0);
});

describe("runRansomwareIntelIngestOnce — happy path", () => {
  it("upserts every row, trims retention, commits IngestHealth, writes audit line", async () => {
    mocks.fetchVictims.mockResolvedValue(victimResult([SAMPLE_VICTIM, { ...SAMPLE_VICTIM, id: "abc-2" }]));
    mocks.fetchPress.mockResolvedValue(pressResult([SAMPLE_PRESS]));
    mocks.trimRansomwareIntelRetention.mockResolvedValue(5);

    const outcome = await runRansomwareIntelIngestOnce(CONFIG, ctx());

    expect(outcome.status).toBe("success");
    expect(outcome.victimsIngested).toBe(2);
    expect(outcome.pressIngested).toBe(1);
    expect(outcome.rowsWritten).toBe(3);
    expect(outcome.retentionRowsDeleted).toBe(5);
    expect(outcome.country).toBe("GB");
    expect(outcome.period).toMatch(/^\d{4}-\d{2}$/);
    expect(outcome.graphAttempts).toBe(2); // 1 victim + 1 press
    expect(outcome.error).toBeUndefined();

    expect(mocks.upsertVictim).toHaveBeenCalledTimes(2);
    expect(mocks.upsertPress).toHaveBeenCalledTimes(1);
    expect(mocks.trimRansomwareIntelRetention).toHaveBeenCalledWith(
      expect.anything(),
      CONFIG.tenantId,
      CONFIG.retentionDays,
      expect.any(Date),
    );
    expect(mocks.commitHealthRow).toHaveBeenCalledTimes(1);
    const commitArg = mocks.commitHealthRow.mock.calls[0]?.[2];
    expect(commitArg).toMatchObject({ outcome: "success", auditSeq: 8 });
    expect(mocks.appendAuditLine).toHaveBeenCalledTimes(1);
  });

  it("returns status=no_data when both endpoints return empty arrays", async () => {
    mocks.fetchVictims.mockResolvedValue(victimResult([]));
    mocks.fetchPress.mockResolvedValue(pressResult([]));

    const outcome = await runRansomwareIntelIngestOnce(CONFIG, ctx());

    expect(outcome.status).toBe("no_data");
    expect(outcome.victimsIngested).toBe(0);
    expect(outcome.pressIngested).toBe(0);
    expect(mocks.upsertVictim).not.toHaveBeenCalled();
    expect(mocks.upsertPress).not.toHaveBeenCalled();
    // Retention trim STILL runs on no_data so a tail of stale rows doesn't
    // hang around forever just because the upstream had a slow week.
    expect(mocks.trimRansomwareIntelRetention).toHaveBeenCalled();
    // Health commits as success — no_data is a healthy state.
    const commitArg = mocks.commitHealthRow.mock.calls[0]?.[2];
    expect(commitArg).toMatchObject({ outcome: "success" });
  });

  it("audit line carries the chain link + counts + filter context", async () => {
    mocks.fetchVictims.mockResolvedValue(victimResult([SAMPLE_VICTIM]));
    mocks.fetchPress.mockResolvedValue(pressResult([]));
    await runRansomwareIntelIngestOnce(CONFIG, ctx());

    const auditLine = mocks.appendAuditLine.mock.calls[0]?.[1] as {
      readonly source: string;
      readonly seq: number;
      readonly status: string;
      readonly rowsWritten: number;
      readonly prevLineSha256: string;
      readonly lineSha256: string;
      readonly tenantId: string;
    };
    expect(auditLine.source).toBe("external.ransomware.live");
    expect(auditLine.seq).toBe(8);
    expect(auditLine.status).toBe("success");
    expect(auditLine.rowsWritten).toBe(1);
    expect(auditLine.tenantId).toBe(CONFIG.tenantId);
    expect(auditLine.prevLineSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(auditLine.lineSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("admin trigger surfaces reason='admin' on the audit line", async () => {
    mocks.fetchVictims.mockResolvedValue(victimResult([]));
    mocks.fetchPress.mockResolvedValue(pressResult([]));

    await runRansomwareIntelIngestOnce(CONFIG, ctx(), { trigger: "admin" });

    const auditLine = mocks.appendAuditLine.mock.calls[0]?.[1] as {
      readonly reason?: string;
    };
    expect(auditLine.reason).toBe("admin");
  });

  it("timer trigger omits the reason field", async () => {
    mocks.fetchVictims.mockResolvedValue(victimResult([]));
    mocks.fetchPress.mockResolvedValue(pressResult([]));

    await runRansomwareIntelIngestOnce(CONFIG, ctx(), { trigger: "timer" });

    const auditLine = mocks.appendAuditLine.mock.calls[0]?.[1] as {
      readonly reason?: string;
    };
    expect(auditLine.reason).toBeUndefined();
  });
});

describe("runRansomwareIntelIngestOnce — auth_unavailable short-circuit", () => {
  it("does NOT upsert or trim retention when client throws auth_unavailable", async () => {
    mocks.fetchVictims.mockRejectedValue(
      new RansomwareLiveFetchError(
        "auth_unavailable",
        "ransomware.live API key unavailable: env_unset",
        null,
        0,
        "env_unset",
      ),
    );
    const outcome = await runRansomwareIntelIngestOnce(CONFIG, ctx());

    expect(outcome.status).toBe("error");
    expect(outcome.error?.kind).toBe("auth_unavailable");
    expect(mocks.fetchPress).not.toHaveBeenCalled(); // short-circuit at first fetch
    expect(mocks.upsertVictim).not.toHaveBeenCalled();
    expect(mocks.upsertPress).not.toHaveBeenCalled();
    expect(mocks.trimRansomwareIntelRetention).not.toHaveBeenCalled();
    // IngestHealth STILL commits + audit STILL writes, so the dashboard
    // surfaces "not configured" via the latest audit line's error.kind.
    expect(mocks.commitHealthRow).toHaveBeenCalledTimes(1);
    expect(mocks.appendAuditLine).toHaveBeenCalledTimes(1);
    const auditLine = mocks.appendAuditLine.mock.calls[0]?.[1] as {
      readonly status: string;
      readonly error?: { kind: string };
    };
    expect(auditLine.status).toBe("error");
    expect(auditLine.error?.kind).toBe("auth_unavailable");
  });
});

describe("runRansomwareIntelIngestOnce — terminal upstream failures", () => {
  it.each(["4xx", "5xx", "timeout", "throttle", "network", "schema_invalid"] as const)(
    "surfaces err.kind=%s + err.attempts on outcome AND audit line",
    async (kind) => {
      mocks.fetchVictims.mockRejectedValue(
        new RansomwareLiveFetchError(kind, `simulated ${kind}`, 503, 3),
      );
      const outcome = await runRansomwareIntelIngestOnce(CONFIG, ctx());

      expect(outcome.status).toBe("error");
      expect(outcome.error?.kind).toBe(kind);
      expect(outcome.graphAttempts).toBe(3);
      expect(mocks.upsertVictim).not.toHaveBeenCalled();
      expect(mocks.upsertPress).not.toHaveBeenCalled();

      const auditLine = mocks.appendAuditLine.mock.calls[0]?.[1] as {
        readonly status: string;
        readonly graphAttempts: number;
        readonly error?: { kind: string };
      };
      expect(auditLine.status).toBe("error");
      expect(auditLine.graphAttempts).toBe(3);
      expect(auditLine.error?.kind).toBe(kind);
    },
  );

  it("classifies non-RansomwareLiveFetchError as 'internal'", async () => {
    mocks.fetchVictims.mockRejectedValue(new Error("table init blew up"));
    const outcome = await runRansomwareIntelIngestOnce(CONFIG, ctx());
    expect(outcome.error?.kind).toBe("internal");
  });

  it("press failure after victims success → no upserts persist (atomicity)", async () => {
    mocks.fetchVictims.mockResolvedValue(victimResult([SAMPLE_VICTIM]));
    mocks.fetchPress.mockRejectedValue(
      new RansomwareLiveFetchError("5xx", "press down", 503, 3),
    );
    const outcome = await runRansomwareIntelIngestOnce(CONFIG, ctx());
    expect(outcome.status).toBe("error");
    expect(outcome.error?.kind).toBe("5xx");
    expect(mocks.upsertVictim).not.toHaveBeenCalled();
    expect(mocks.upsertPress).not.toHaveBeenCalled();
  });
});

describe("runRansomwareIntelIngestOnce — lease + audit failures", () => {
  it("returns lease_contended error when commitHealthRow throws LeaseContendedError; does NOT write audit", async () => {
    mocks.fetchVictims.mockResolvedValue(victimResult([SAMPLE_VICTIM]));
    mocks.fetchPress.mockResolvedValue(pressResult([SAMPLE_PRESS]));
    mocks.commitHealthRow.mockRejectedValue(new LeaseContendedError("etag drift"));

    const outcome = await runRansomwareIntelIngestOnce(CONFIG, ctx());

    expect(outcome.status).toBe("error");
    expect(outcome.error?.kind).toBe("lease_contended");
    expect(mocks.appendAuditLine).not.toHaveBeenCalled();
  });

  it("rethrows audit-write failure so AppInsights marks the invocation failed", async () => {
    mocks.fetchVictims.mockResolvedValue(victimResult([]));
    mocks.fetchPress.mockResolvedValue(pressResult([]));
    mocks.appendAuditLine.mockRejectedValue(new Error("blob append 503"));

    await expect(
      runRansomwareIntelIngestOnce(CONFIG, ctx()),
    ).rejects.toThrow(/blob append 503/);
    // Health row STILL committed before the audit attempt — we own the
    // seq. The gap shows up to a verifier walking the audit blob.
    expect(mocks.commitHealthRow).toHaveBeenCalledTimes(1);
  });
});
