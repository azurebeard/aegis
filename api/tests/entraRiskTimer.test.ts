// Tests for entraRiskTimer.ts — SEC-M-STEP6-CODE-02 structured ConfigError
// handler (WS10 verdict 2026-04-19 step6-code). Mirrors the shape of
// dailyBriefTimer.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { runEntraRiskIngestOnceMock, resolveConfigMock } = vi.hoisted(() => ({
  runEntraRiskIngestOnceMock: vi.fn(),
  resolveConfigMock: vi.fn(),
}));

vi.mock("../src/lib/runEntraRiskIngest.js", () => ({
  runEntraRiskIngestOnce: runEntraRiskIngestOnceMock,
}));

vi.mock("../src/lib/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/config.js")>(
    "../src/lib/config.js",
  );
  return {
    ...actual,
    resolveEntraRiskIngestConfig: resolveConfigMock,
  };
});

// `app.timer` registration has a side effect at module load — stub it out so
// the import is side-effect-safe in tests.
vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: {
      ...actual.app,
      timer: vi.fn(),
    },
  };
});

import { entraRiskTimerHandler } from "../src/ingest/entraRiskTimer.js";
import { ConfigError } from "../src/lib/config.js";

function mockContext(): {
  invocationId: string;
  log: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  return {
    invocationId: "test-inv-1",
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

const TIMER = { isPastDue: false, scheduleStatus: {} };

describe("entraRiskTimerHandler — ConfigError swallow (SEC-M-STEP6-CODE-02)", () => {
  beforeEach(() => {
    runEntraRiskIngestOnceMock.mockReset();
    resolveConfigMock.mockReset();
  });

  it("logs structured entraRisk.config_error on ConfigError and does NOT re-throw", async () => {
    resolveConfigMock.mockImplementation(() => {
      throw new ConfigError("INGEST_MI_CLIENT_ID");
    });
    const ctx = mockContext();
    await expect(
      entraRiskTimerHandler(TIMER as never, ctx as never),
    ).resolves.toBeUndefined();
    expect(ctx.error).toHaveBeenCalledTimes(1);
    const firstArg = ctx.error.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(firstArg) as Record<string, unknown>;
    expect(parsed.event).toBe("entraRisk.config_error");
    expect(parsed.kind).toBe("config");
    expect(parsed.message).toContain("INGEST_MI_CLIENT_ID");
    expect(runEntraRiskIngestOnceMock).not.toHaveBeenCalled();
  });

  it("re-throws non-ConfigError failures (host records + ingest alert fires)", async () => {
    resolveConfigMock.mockReturnValue({ tenantId: "t1" });
    const boom = new Error("transient Graph 502");
    runEntraRiskIngestOnceMock.mockRejectedValue(boom);
    const ctx = mockContext();
    await expect(
      entraRiskTimerHandler(TIMER as never, ctx as never),
    ).rejects.toBe(boom);
  });

  it("re-throws when the orchestrator returns status=error (ADR-0015 chain-repair detection preserved)", async () => {
    resolveConfigMock.mockReturnValue({ tenantId: "t1" });
    runEntraRiskIngestOnceMock.mockResolvedValue({
      status: "error",
      error: { kind: "throttle", message: "429 persistent" },
    });
    const ctx = mockContext();
    await expect(
      entraRiskTimerHandler(TIMER as never, ctx as never),
    ).rejects.toThrow(/entraRisk\.timer\.fail/);
  });

  it("completes without logging an error on successful run", async () => {
    resolveConfigMock.mockReturnValue({ tenantId: "t1" });
    runEntraRiskIngestOnceMock.mockResolvedValue({
      status: "success",
      runId: "r1",
      licenceState: "present",
    });
    const ctx = mockContext();
    await entraRiskTimerHandler(TIMER as never, ctx as never);
    expect(ctx.error).not.toHaveBeenCalled();
    // Fire-log line with timer telemetry.
    expect(ctx.log).toHaveBeenCalled();
  });
});
