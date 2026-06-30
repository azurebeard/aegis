// Tests for dailyBriefTimer.ts — SEC-M-STEP5-CODE-04 structured ConfigError
// handler (WS10 verdict 2026-04-19 step5-code).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock runBriefAgent so we can throw specific error shapes without spinning
// up live table/blob endpoints. vi.hoisted() is required because vi.mock is
// hoisted to the top of the file and cannot reference regular top-level
// bindings.
const { runBriefAgentMock } = vi.hoisted(() => ({
  runBriefAgentMock: vi.fn(),
}));
vi.mock("../src/lib/runBriefAgent.js", () => ({
  runBriefAgent: runBriefAgentMock,
}));

// `app.timer` registration has a side effect at module load — stub it out so
// the import is side-effect-safe in tests.
vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>(
      "@azure/functions",
    );
  return {
    ...actual,
    app: {
      ...actual.app,
      timer: vi.fn(),
    },
  };
});

import { dailyBriefTimerHandler } from "../src/functions/dailyBriefTimer.js";
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

describe("dailyBriefTimerHandler — ConfigError swallow (SEC-M-STEP5-CODE-04)", () => {
  beforeEach(() => {
    runBriefAgentMock.mockReset();
  });

  it("logs structured brief.config_error on ConfigError and does NOT re-throw", async () => {
    runBriefAgentMock.mockRejectedValue(new ConfigError("FOUNDRY_REGION"));
    const ctx = mockContext();
    await expect(
      dailyBriefTimerHandler(
        { isPastDue: false } as never,
        ctx as never,
      ),
    ).resolves.toBeUndefined();
    // Error-level log carries the structured JSON payload.
    expect(ctx.error).toHaveBeenCalledTimes(1);
    const firstArg = ctx.error.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(firstArg) as Record<string, unknown>;
    expect(parsed.event).toBe("brief.config_error");
    expect(parsed.kind).toBe("config");
    expect(parsed.message).toContain("FOUNDRY_REGION");
  });

  it("re-throws non-ConfigError failures (host records + AgentRun alert fires)", async () => {
    const boom = new Error("transient Foundry 502");
    runBriefAgentMock.mockRejectedValue(boom);
    const ctx = mockContext();
    await expect(
      dailyBriefTimerHandler(
        { isPastDue: false } as never,
        ctx as never,
      ),
    ).rejects.toBe(boom);
  });

  it("logs the normal status line on successful run", async () => {
    runBriefAgentMock.mockResolvedValue({
      status: "committed",
      briefDate: "2026-04-19",
      runId: "r1",
    });
    const ctx = mockContext();
    await dailyBriefTimerHandler(
      { isPastDue: false } as never,
      ctx as never,
    );
    expect(ctx.log).toHaveBeenCalledTimes(1);
    const msg = ctx.log.mock.calls[0]?.[0] as string;
    expect(msg).toContain("status=committed");
    expect(msg).toContain("runId=r1");
    expect(ctx.error).not.toHaveBeenCalled();
  });
});
