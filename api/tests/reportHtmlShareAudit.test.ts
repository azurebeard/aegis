// Unit tests for reportHtmlShareAudit.emitReportHtmlShareReadAudit
// (ADR-0030 §C.22). Pins the commit-first-then-append concurrency
// contract — on ETag lease contention the line MUST NOT be written to
// the blob, so a concurrent read race cannot produce a duplicate-seq
// chain.

import { describe, it, expect, vi, beforeEach } from "vitest";

import type * as IngestHealthModule from "../src/lib/ingestHealth.js";
import type * as AuditModule from "../src/lib/audit.js";

const {
  getOrInitHealthRowMock,
  commitHealthRowMock,
  appendAuditLineMock,
} = vi.hoisted(() => ({
  getOrInitHealthRowMock: vi.fn(),
  commitHealthRowMock: vi.fn(),
  appendAuditLineMock: vi.fn(),
}));

vi.mock("../src/lib/ingestHealth.js", async () => {
  const actual = await vi.importActual<typeof IngestHealthModule>(
    "../src/lib/ingestHealth.js",
  );
  return {
    ...actual,
    getOrInitHealthRow: getOrInitHealthRowMock,
    commitHealthRow: commitHealthRowMock,
  };
});

vi.mock("../src/lib/audit.js", async () => {
  const actual = await vi.importActual<typeof AuditModule>(
    "../src/lib/audit.js",
  );
  return {
    ...actual,
    appendAuditLine: appendAuditLineMock,
  };
});

import {
  emitReportHtmlShareReadAudit,
  REPORT_HTML_SHARE_SOURCE,
} from "../src/lib/reportHtmlShareAudit.js";
import { LeaseContendedError } from "../src/lib/ingestHealth.js";

const TENANT = "tenant-aaa";
const PERIOD = "2026-06";
const JTI = "01HKQ8Y7Z6S5R4Q3P2N1M0L9K8";
const READ_AT = "2026-06-22T11:00:00.000Z";
const CALLER_MI = "audit-mi-client-id";

function deps() {
  return {
    healthTable: {} as never,
    auditCtx: {
      blobEndpoint: "https://audit.blob.invalid",
      auditContainerName: "audit",
      managedIdentityClientId: CALLER_MI,
    },
  };
}

function event() {
  return {
    tenantId: TENANT,
    periodKey: PERIOD,
    tokenJti: JTI,
    readAt: READ_AT,
    callerPrincipalMiClientId: CALLER_MI,
  };
}

function freshHead(lastAuditSeq = 0, lastLineSha256 = "") {
  return {
    tenantId: TENANT,
    source: REPORT_HTML_SHARE_SOURCE,
    status: "healthy",
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailureCount: 0,
    lastRunId: null,
    lastAuditSeq,
    lastLineSha256,
    lastCursor: "",
    updatedAt: READ_AT,
    etag: "etag-head-1",
  };
}

beforeEach(() => {
  getOrInitHealthRowMock.mockReset();
  commitHealthRowMock.mockReset();
  appendAuditLineMock.mockReset();
  commitHealthRowMock.mockResolvedValue("healthy");
  appendAuditLineMock.mockResolvedValue(undefined);
});

describe("emitReportHtmlShareReadAudit — happy path", () => {
  it("writes a chained line on a fresh chain (seq=1) and returns emitted result", async () => {
    getOrInitHealthRowMock.mockResolvedValue(freshHead(0, ""));

    const r = await emitReportHtmlShareReadAudit(deps(), event());

    expect(r.outcome).toBe("emitted");
    expect(r).toMatchObject({ outcome: "emitted", seq: 1 });

    // Commit happens BEFORE append (commit-first race-safety contract).
    expect(commitHealthRowMock).toHaveBeenCalledTimes(1);
    expect(appendAuditLineMock).toHaveBeenCalledTimes(1);
    expect(commitHealthRowMock.mock.invocationCallOrder[0]!).toBeLessThan(
      appendAuditLineMock.mock.invocationCallOrder[0]!,
    );

    // commitHealthRow signature: (table, previous, update). Position 2 (0-indexed) is the update.
    const commitCall = commitHealthRowMock.mock.calls[0]!;
    expect(commitCall[2]).toMatchObject({
      outcome: "success",
      now: READ_AT,
      auditSeq: 1,
    });

    const [, line] = appendAuditLineMock.mock.calls[0]!;
    expect(line).toMatchObject({
      schemaVersion: 2,
      eventType: "report.html.share.read",
      source: REPORT_HTML_SHARE_SOURCE,
      seq: 1,
      tenantId: TENANT,
      startedAt: READ_AT,
      endedAt: READ_AT,
      status: "success",
      periodKey: PERIOD,
      tokenJti: JTI,
      callerPrincipalMiClientId: CALLER_MI,
    });
    expect(typeof line.runId).toBe("string");
    expect(line.runId.length).toBeGreaterThan(0);
    expect(typeof line.prevLineSha256).toBe("string");
    expect(line.prevLineSha256.length).toBe(64); // sha256 hex
    expect(typeof line.lineSha256).toBe("string");
    expect(line.lineSha256.length).toBe(64);
  });

  it("advances seq from the existing chain head + carries forward prevLineSha256", async () => {
    getOrInitHealthRowMock.mockResolvedValue(freshHead(7, "a".repeat(64)));

    const r = await emitReportHtmlShareReadAudit(deps(), event());

    expect(r).toMatchObject({ outcome: "emitted", seq: 8 });

    const [, line] = appendAuditLineMock.mock.calls[0]!;
    expect(line.seq).toBe(8);
    expect(line.prevLineSha256).toBe("a".repeat(64));
  });
});

describe("emitReportHtmlShareReadAudit — concurrency", () => {
  it("returns lease_contended WITHOUT appending the blob line when commit hits ETag 412", async () => {
    getOrInitHealthRowMock.mockResolvedValue(freshHead(3, "b".repeat(64)));
    commitHealthRowMock.mockRejectedValue(
      new LeaseContendedError("etag drifted — concurrent reader won"),
    );

    const r = await emitReportHtmlShareReadAudit(deps(), event());

    expect(r).toEqual({ outcome: "lease_contended" });
    // Critical race-safety assertion: the blob append MUST NOT run when
    // the lease commit lost. Otherwise the chain ends up with two
    // seq=N lines and the head pointing at one of them — a verifier
    // chain-walk failure that's hard to reconcile.
    expect(appendAuditLineMock).not.toHaveBeenCalled();
  });

  it("propagates non-LeaseContendedError commit failures up to the caller", async () => {
    getOrInitHealthRowMock.mockResolvedValue(freshHead(0, ""));
    commitHealthRowMock.mockRejectedValue(new Error("table 503"));

    await expect(
      emitReportHtmlShareReadAudit(deps(), event()),
    ).rejects.toThrow("table 503");

    // Same as above: never append on a failed commit, regardless of the
    // failure mode. The caller's fail-soft wrapper sees the throw and
    // logs the warn breadcrumb without affecting the HTTP response.
    expect(appendAuditLineMock).not.toHaveBeenCalled();
  });

  it("propagates appendAuditLine failures (commit already moved the head — chain forward-only invariant)", async () => {
    getOrInitHealthRowMock.mockResolvedValue(freshHead(0, ""));
    appendAuditLineMock.mockRejectedValue(new Error("blob 503"));

    await expect(
      emitReportHtmlShareReadAudit(deps(), event()),
    ).rejects.toThrow("blob 503");

    // The head moved (commit succeeded) before the append failed. The
    // chain is now temporarily ahead of the blob — ingest-repair
    // detection on the next emit surfaces the gap. The throw bubbles
    // up so the caller can log a structured warn.
    expect(commitHealthRowMock).toHaveBeenCalledTimes(1);
    expect(appendAuditLineMock).toHaveBeenCalledTimes(1);
  });
});

describe("emitReportHtmlShareReadAudit — line shape pinning", () => {
  it("emits a v2 line with status=success and no unknown fields", async () => {
    getOrInitHealthRowMock.mockResolvedValue(freshHead(0, ""));

    await emitReportHtmlShareReadAudit(deps(), event());

    const [, line] = appendAuditLineMock.mock.calls[0]!;
    expect(line.schemaVersion).toBe(2);
    expect(line.status).toBe("success");
    // The line MUST carry the chain fields — without prevLineSha256 +
    // lineSha256 the verifier rejects the line as malformed.
    expect(line.prevLineSha256).toBeDefined();
    expect(line.lineSha256).toBeDefined();

    // Identity fields that pivot to SOC tooling.
    expect(line.tokenJti).toBe(JTI);
    expect(line.periodKey).toBe(PERIOD);
  });
});
