// ADR-0030 Phase C §C.7 — audit-hooks unit tests.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  buildReportEmailAuditHooks,
  INTENT_SOURCE,
  SENT_SOURCE,
} from "../src/lib/reportEmailAuditHooks.js";

// Mock the audit + health primitives so the hook tests don't need real Azure.
const appendAuditLineMock = vi.fn();
vi.mock("../src/lib/audit.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/audit.js")>("../src/lib/audit.js");
  return { ...actual, appendAuditLine: (...a: unknown[]) => appendAuditLineMock(...a) };
});

const getOrInitHealthRowMock = vi.fn();
const commitHealthRowMock = vi.fn();
vi.mock("../src/lib/ingestHealth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/ingestHealth.js")>(
      "../src/lib/ingestHealth.js",
    );
  return {
    ...actual,
    getOrInitHealthRow: (...a: unknown[]) => getOrInitHealthRowMock(...a),
    commitHealthRow: (...a: unknown[]) => commitHealthRowMock(...a),
  };
});

const upsertReportEmailSendMock = vi.fn();
vi.mock("../src/lib/tenantSettingsStore.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/tenantSettingsStore.js")>(
      "../src/lib/tenantSettingsStore.js",
    );
  return {
    ...actual,
    upsertReportEmailSend: (...a: unknown[]) => upsertReportEmailSendMock(...a),
  };
});

const fakeTable = {} as import("@azure/data-tables").TableClient;
const fakeAuditCtx = {
  blobEndpoint: "https://x.blob.core.windows.net",
  auditContainerName: "audit",
  managedIdentityClientId: "audit-mi",
};
const logger = { warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  appendAuditLineMock.mockReset().mockResolvedValue(undefined);
  getOrInitHealthRowMock.mockReset();
  commitHealthRowMock.mockReset().mockResolvedValue(undefined);
  upsertReportEmailSendMock.mockReset().mockResolvedValue(undefined);
  logger.warn.mockReset();
  logger.error.mockReset();
});

function intentHealthRow(tenantId = "tenant-x"): unknown {
  return {
    tenantId,
    source: INTENT_SOURCE,
    lastAuditSeq: 41,
    lastLineSha256: "a".repeat(64),
    etag: 'W/"x"',
    consecutiveFailureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastRunId: null,
    lastCursor: "",
    status: "healthy",
    updatedAt: "2026-05-11T08:00:00Z",
  };
}
function sentHealthRow(tenantId = "tenant-x"): unknown {
  return { ...intentHealthRow(tenantId), source: SENT_SOURCE, lastAuditSeq: 87 };
}

function buildHooks() {
  return buildReportEmailAuditHooks({
    healthTable: fakeTable,
    tenantSettingsTable: fakeTable,
    auditCtx: fakeAuditCtx,
    logger,
  });
}

const baseIntentEvent = {
  periodKey: "2026-W19",
  tenantId: "tenant-x",
  capturedAtOfSnapshot: "2026-05-11T08:00:00Z",
  renderedAt: "2026-05-12T09:00:00Z",
  senderMailbox: "noreply@picnic-dev.co.uk",
  recipientCount: 1,
  externalRecipientCount: 0,
  recipientHashSalted: "h".repeat(64),
  bodySha256: "b".repeat(64),
  bodyBytes: 1234,
  subjectSha256: "s".repeat(64),
  callerPrincipalMiClientId: "mi-1",
  triggeredBy: "admin" as const,
  operatorPrincipal: "admin@picnic-dev.co.uk",
  intentAt: "2026-05-12T09:00:01Z",
};

describe("buildReportEmailAuditHooks — onIntent", () => {
  it("writes a schemaVersion:2 line with chain binding + commits health", async () => {
    getOrInitHealthRowMock.mockResolvedValueOnce(intentHealthRow());
    const hooks = buildHooks();
    await hooks.onIntent(baseIntentEvent);

    expect(appendAuditLineMock).toHaveBeenCalledTimes(1);
    const line = appendAuditLineMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(line.schemaVersion).toBe(2);
    expect(line.eventType).toBe("report.email.intent");
    expect(line.source).toBe(INTENT_SOURCE);
    expect(line.seq).toBe(42); // lastAuditSeq 41 + 1
    expect(line.tenantId).toBe("tenant-x");
    expect(line.periodKey).toBe("2026-W19");
    expect(line.bodySha256).toBe("b".repeat(64));
    expect(line.recipientHashSalted).toBe("h".repeat(64));
    expect(line.prevLineSha256).toBe("a".repeat(64));
    expect(typeof line.lineSha256).toBe("string");
    expect((line.lineSha256 as string).length).toBe(64);

    expect(commitHealthRowMock).toHaveBeenCalledTimes(1);
    const commitUpdate = commitHealthRowMock.mock.calls[0]![2];
    expect(commitUpdate.outcome).toBe("success");
    expect(commitUpdate.auditSeq).toBe(42);
    expect(commitUpdate.lineSha256).toBe(line.lineSha256);
  });

  it("uses the genesis sentinel when the chain head is empty", async () => {
    getOrInitHealthRowMock.mockResolvedValueOnce({
      ...intentHealthRow(),
      lastAuditSeq: 0,
      lastLineSha256: "",
    });
    const hooks = buildHooks();
    await hooks.onIntent(baseIntentEvent);
    const line = appendAuditLineMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(line.seq).toBe(1);
    // Genesis sentinel is sha256(`genesis:${source}:${tenantId}`) — not empty.
    expect((line.prevLineSha256 as string).length).toBe(64);
    expect(line.prevLineSha256).not.toBe("0".repeat(64));
  });
});

describe("buildReportEmailAuditHooks — onSent → onHistoryWrite", () => {
  it("writes the outcome line with intentLineSeq back-ref and the history row with audit pair", async () => {
    getOrInitHealthRowMock
      .mockResolvedValueOnce(intentHealthRow()) // intent
      .mockResolvedValueOnce(sentHealthRow()); // outcome
    const hooks = buildHooks();
    await hooks.onIntent(baseIntentEvent);
    await hooks.onSent({
      periodKey: "2026-W19",
      tenantId: "tenant-x",
      graphMessageId: "AAMkAGI2-fake",
      graphClientRequestId: "00000000-0000-0000-0000-000000000001",
      internetMessageId: "<aaa@picnic-dev.co.uk>",
      sentAt: "2026-05-12T09:00:02Z",
      callerPrincipalMiClientId: "mi-1",
    });
    await hooks.onHistoryWrite({
      tenantId: "tenant-x",
      periodKey: "2026-W19",
      graphMessageId: "AAMkAGI2-fake",
      sentAt: "2026-05-12T09:00:02Z",
      senderMailbox: "noreply@picnic-dev.co.uk",
      recipients: ["alice@picnic-dev.co.uk"],
      operatorPrincipal: "admin@picnic-dev.co.uk",
      internetMessageId: "<aaa@picnic-dev.co.uk>",
      clientRequestId: "00000000-0000-0000-0000-000000000001",
    });

    // Two audit lines: intent + sent
    expect(appendAuditLineMock).toHaveBeenCalledTimes(2);
    const sentLine = appendAuditLineMock.mock.calls[1]![1] as Record<string, unknown>;
    expect(sentLine.eventType).toBe("report.email.sent");
    expect(sentLine.source).toBe(SENT_SOURCE);
    expect(sentLine.seq).toBe(88); // sentHealthRow.lastAuditSeq 87 + 1
    expect(sentLine.intentLineSeq).toBe(42); // intent line's seq
    expect(sentLine.graphMessageId).toBe("AAMkAGI2-fake");
    expect(sentLine.status).toBe("success");

    // History row written with auditLineSeq + auditLineSha256 from outcome
    expect(upsertReportEmailSendMock).toHaveBeenCalledTimes(1);
    const histRow = upsertReportEmailSendMock.mock.calls[0]![1];
    expect(histRow.auditLineSeq).toBe(88);
    expect(histRow.auditLineSha256).toBe(sentLine.lineSha256);
    expect(histRow.graphMessageId).toBe("AAMkAGI2-fake");
  });
});

describe("buildReportEmailAuditHooks — onFailed", () => {
  it("writes a failure-variant line sharing the sent partition", async () => {
    getOrInitHealthRowMock
      .mockResolvedValueOnce(intentHealthRow())
      .mockResolvedValueOnce(sentHealthRow());
    const hooks = buildHooks();
    await hooks.onIntent(baseIntentEvent);
    await hooks.onFailed({
      periodKey: "2026-W19",
      tenantId: "tenant-x",
      graphClientRequestId: "00000000-0000-0000-0000-000000000002",
      internetMessageId: "<fail@picnic-dev.co.uk>",
      errorKind: "4xx",
      errorMessage: "invalid recipient",
      attempt: 1,
      failedAt: "2026-05-12T09:00:03Z",
      callerPrincipalMiClientId: "mi-1",
    });

    expect(appendAuditLineMock).toHaveBeenCalledTimes(2);
    const failLine = appendAuditLineMock.mock.calls[1]![1] as Record<string, unknown>;
    expect(failLine.eventType).toBe("report.email.failed");
    expect(failLine.source).toBe(SENT_SOURCE); // same partition as success
    expect(failLine.status).toBe("error");
    expect(failLine.errorKind).toBe("4xx");
    expect(failLine.errorMessage).toBe("invalid recipient");
    expect(failLine.attempt).toBe(1);
    expect(failLine.intentLineSeq).toBe(42);

    const commit = commitHealthRowMock.mock.calls[1]![2];
    expect(commit.outcome).toBe("error");
  });
});

describe("buildReportEmailAuditHooks — error message length cap", () => {
  it("truncates errorMessage to 2000 chars", async () => {
    getOrInitHealthRowMock
      .mockResolvedValueOnce(intentHealthRow())
      .mockResolvedValueOnce(sentHealthRow());
    const hooks = buildHooks();
    await hooks.onIntent(baseIntentEvent);
    const longMsg = "x".repeat(5000);
    await hooks.onFailed({
      periodKey: "2026-W19",
      tenantId: "tenant-x",
      graphClientRequestId: "00000000-0000-0000-0000-000000000003",
      internetMessageId: "<long@picnic-dev.co.uk>",
      errorKind: "5xx",
      errorMessage: longMsg,
      attempt: 3,
      failedAt: "2026-05-12T09:00:04Z",
      callerPrincipalMiClientId: "mi-1",
    });
    const line = appendAuditLineMock.mock.calls[1]![1] as Record<string, unknown>;
    expect((line.errorMessage as string).length).toBe(2000);
  });
});
