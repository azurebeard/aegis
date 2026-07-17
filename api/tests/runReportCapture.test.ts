// ADR-0030 Phase B — capture-core orchestrator tests.
//
// Verifies the four behaviour-distinct branches:
//   - invalid_period   — rejects malformed explicitPeriodKey without writes
//   - skipped_already_captured — Timer mode bails when versions exist
//   - lease_contended  — IfMatch race-loss returns no-write
//   - success          — writes snapshot + audits + commits health
// + the version-increment + audit-line shape.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InvocationContext } from "@azure/functions";
import type { IngestConfig, ReportSnapshotConfig } from "../src/lib/config.js";
import type * as IngestHealthModule from "../src/lib/ingestHealth.js";
import type * as AuditModule from "../src/lib/audit.js";
import type * as ReportSnapshotStoreModule from "../src/lib/reportSnapshotStore.js";
import type * as TablesModule from "../src/lib/tables.js";

const mocks = vi.hoisted(() => ({
  getOrInitHealthRow: vi.fn(),
  commitHealthRow: vi.fn(),
  appendAuditLine: vi.fn(),
  assembleLiveEnvelope: vi.fn(),
  encodeEnvelope: vi.fn(),
  insertSnapshot: vi.fn(),
  listVersionsForPeriod: vi.fn(),
  trimVersionsForPeriod: vi.fn(),
  getTableClient: vi.fn(),
}));

vi.mock("../src/lib/ingestHealth.js", async () => {
  const actual = await vi.importActual<typeof IngestHealthModule>(
    "../src/lib/ingestHealth.js",
  );
  return {
    ...actual,
    getOrInitHealthRow: mocks.getOrInitHealthRow,
    commitHealthRow: mocks.commitHealthRow,
  };
});

vi.mock("../src/lib/audit.js", async () => {
  const actual = await vi.importActual<typeof AuditModule>("../src/lib/audit.js");
  return { ...actual, appendAuditLine: mocks.appendAuditLine };
});

vi.mock("../src/lib/reportEnvelope.js", async () => ({
  assembleLiveEnvelope: mocks.assembleLiveEnvelope,
}));

vi.mock("../src/lib/reportSnapshotStore.js", async () => {
  const actual = await vi.importActual<typeof ReportSnapshotStoreModule>(
    "../src/lib/reportSnapshotStore.js",
  );
  return {
    ...actual,
    encodeEnvelope: mocks.encodeEnvelope,
    insertSnapshot: mocks.insertSnapshot,
    listVersionsForPeriod: mocks.listVersionsForPeriod,
    trimVersionsForPeriod: mocks.trimVersionsForPeriod,
  };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual = await vi.importActual<typeof TablesModule>("../src/lib/tables.js");
  return { ...actual, getTableClient: mocks.getTableClient };
});

const { runReportCaptureOnce } = await import("../src/lib/runReportCapture.js");
const { LeaseContendedError } = await import("../src/lib/ingestHealth.js");

const INGEST_CONFIG: IngestConfig = {
  ingestMiClientId: "mi-ingest",
  auditMiClientId: "mi-audit",
  apiReaderMiClientId: "mi-api",
  opsTableEndpoint: "https://fake.table.core.windows.net",
  auditBlobEndpoint: "https://fake.blob.core.windows.net",
  auditContainerName: "audit",
  tenantId: "tenant-1",
  leaseWindowMs: 300_000,
  graphBaseUrl: "https://graph.microsoft.com/v1.0",
  graphApiTimeoutMs: 30_000,
  source: "graph.security.secureScores",
  hostMiClientId: "mi-host",
  deployAiAgents: true,
} as unknown as IngestConfig;

const REPORT_CONFIG: ReportSnapshotConfig = {
  versionsPerPeriod: 3,
  retentionDays: 2555,
  source: "report.snapshot",
};

function makeLogger(): InvocationContext {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as InvocationContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTableClient.mockReturnValue({});
  mocks.getOrInitHealthRow.mockResolvedValue({
    lastAuditSeq: 5,
    // Non-zero, non-empty hash — ADR-0015 §3 rejects sixty-four zeros as
    // malformed chain state. Any plausible 64-char lowercase hex works.
    lastLineSha256: "a".repeat(64),
    etag: "etag-1",
  });
  mocks.commitHealthRow.mockResolvedValue(undefined);
  mocks.appendAuditLine.mockResolvedValue(undefined);
  mocks.listVersionsForPeriod.mockResolvedValue([]);
  mocks.assembleLiveEnvelope.mockResolvedValue({
    schemaVersion: 1,
    period: { cadence: "monthly", periodKey: "2026-04", periodStart: "", periodEnd: "" },
    capturedAt: "2026-04-29T10:00:00Z",
    capturedBy: "u",
    version: 1,
    contentType: "application/json",
    derived: {},
    sections: {},
  });
  mocks.encodeEnvelope.mockReturnValue({
    base64Gzipped: "Zg==",
    compressedBytes: 8,
    rawBytes: 32,
  });
  mocks.insertSnapshot.mockResolvedValue(undefined);
  mocks.trimVersionsForPeriod.mockResolvedValue([]);
});

describe("runReportCaptureOnce — invalid_period branch", () => {
  it("returns invalid_period without leasing or writing when explicitPeriodKey malformed", async () => {
    const logger = makeLogger();
    const result = await runReportCaptureOnce({
      cadence: "monthly",
      explicitPeriodKey: "2026-13", // month 13 — periodFromKey rejects
      capturedBy: "u",
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    expect(result.status).toBe("invalid_period");
    expect(result.version).toBe(0);
    // No state-mutating call should have fired.
    expect(mocks.getOrInitHealthRow).not.toHaveBeenCalled();
    expect(mocks.commitHealthRow).not.toHaveBeenCalled();
    expect(mocks.appendAuditLine).not.toHaveBeenCalled();
    expect(mocks.insertSnapshot).not.toHaveBeenCalled();
  });
});

describe("runReportCaptureOnce — skip-if-exists (Timer mode)", () => {
  it("skips and writes nothing when skipIfPeriodHasVersions=true and existing>0", async () => {
    mocks.listVersionsForPeriod.mockResolvedValue([
      { Version: 1, CapturedAt: "2026-04-15T10:00:00Z" },
    ]);
    const logger = makeLogger();
    const result = await runReportCaptureOnce({
      cadence: "monthly",
      capturedBy: "system.timer",
      skipIfPeriodHasVersions: true,
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    expect(result.status).toBe("skipped_already_captured");
    expect(result.existingVersions).toBe(1);
    expect(mocks.getOrInitHealthRow).not.toHaveBeenCalled();
    expect(mocks.insertSnapshot).not.toHaveBeenCalled();
    expect(mocks.appendAuditLine).not.toHaveBeenCalled();
  });

  it("captures normally when skipIfPeriodHasVersions=true and existing=0", async () => {
    const logger = makeLogger();
    const result = await runReportCaptureOnce({
      cadence: "monthly",
      capturedBy: "system.timer",
      skipIfPeriodHasVersions: true,
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    expect(result.status).toBe("success");
    expect(result.version).toBe(1);
    expect(mocks.insertSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.appendAuditLine).toHaveBeenCalledTimes(1);
  });

  it("does NOT skip when skipIfPeriodHasVersions=false even with existing versions (HTTP recapture path)", async () => {
    mocks.listVersionsForPeriod.mockResolvedValue([
      { Version: 1, CapturedAt: "2026-04-15T10:00:00Z" },
      { Version: 2, CapturedAt: "2026-04-20T10:00:00Z" },
    ]);
    const logger = makeLogger();
    const result = await runReportCaptureOnce({
      cadence: "monthly",
      capturedBy: "u",
      skipIfPeriodHasVersions: false,
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    expect(result.status).toBe("success");
    expect(result.version).toBe(3); // max + 1
  });
});

describe("runReportCaptureOnce — lease contention", () => {
  it("returns lease_contended without appending audit when commitHealthRow loses race", async () => {
    mocks.commitHealthRow.mockRejectedValue(new LeaseContendedError("etag mismatch"));
    const logger = makeLogger();
    const result = await runReportCaptureOnce({
      cadence: "monthly",
      capturedBy: "u",
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    expect(result.status).toBe("lease_contended");
    // Snapshot row WAS written (insertSnapshot fired before commit) — that's
    // intentional, the audit chain is the integrity boundary, not the row.
    expect(mocks.appendAuditLine).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("runReportCaptureOnce — success path", () => {
  it("writes snapshot, commits health, appends one audit line per call", async () => {
    const logger = makeLogger();
    const result = await runReportCaptureOnce({
      cadence: "monthly",
      capturedBy: "operator-oid",
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    expect(result.status).toBe("success");
    expect(result.version).toBe(1);
    expect(mocks.insertSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.commitHealthRow).toHaveBeenCalledTimes(1);
    expect(mocks.appendAuditLine).toHaveBeenCalledTimes(1);

    const auditLine = mocks.appendAuditLine.mock.calls[0]![1];
    expect(auditLine.eventType).toBe("audit.report.capture");
    expect(auditLine.status).toBe("success");
    expect(auditLine.capturedBy).toBe("operator-oid");
    expect(auditLine.cadence).toBe("monthly");
    expect(auditLine.seq).toBe(6); // prev was 5
    expect(auditLine.lineSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("propagates capturedBy through to the audit line (Timer-vs-operator distinction)", async () => {
    const logger = makeLogger();
    await runReportCaptureOnce({
      cadence: "weekly",
      capturedBy: "system.timer",
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    const auditLine = mocks.appendAuditLine.mock.calls[0]![1];
    expect(auditLine.capturedBy).toBe("system.timer");
  });

  it("threads captureRunId + operatorNote through to assembleLiveEnvelope", async () => {
    const logger = makeLogger();
    await runReportCaptureOnce({
      cadence: "monthly",
      capturedBy: "operator-oid",
      operatorNote: "Onboarded customer X this month",
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    expect(mocks.assembleLiveEnvelope).toHaveBeenCalledTimes(1);
    const args = mocks.assembleLiveEnvelope.mock.calls[0]![0];
    expect(args.captureRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(args.operatorNote).toBe("Onboarded customer X this month");
  });

  it("omits operatorNote from assembler args when not supplied", async () => {
    const logger = makeLogger();
    await runReportCaptureOnce({
      cadence: "monthly",
      capturedBy: "operator-oid",
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    const args = mocks.assembleLiveEnvelope.mock.calls[0]![0];
    expect(args.operatorNote).toBeUndefined();
  });

  it("includes trimmedVersions on audit line when retention sweep fires", async () => {
    mocks.trimVersionsForPeriod.mockResolvedValue([
      { Version: 1, CapturedAt: "2026-04-01T10:00:00Z" },
      { Version: 2, CapturedAt: "2026-04-05T10:00:00Z" },
    ]);
    const logger = makeLogger();
    const result = await runReportCaptureOnce({
      cadence: "monthly",
      capturedBy: "u",
      ingestConfig: INGEST_CONFIG,
      reportConfig: REPORT_CONFIG,
      logger,
    });
    expect(result.retentionRowsDeleted).toBe(2);
    expect(result.trimmedVersions).toEqual([1, 2]);
    const auditLine = mocks.appendAuditLine.mock.calls[0]![1];
    expect(auditLine.retentionRowsDeleted).toBe(2);
    expect(auditLine.trimmedVersions).toEqual([1, 2]);
  });
});
