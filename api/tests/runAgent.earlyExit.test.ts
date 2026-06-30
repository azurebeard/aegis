// Regression tests for runAgent.ts early-exit branches (SEC-BUG-AGENT-TDZ).
//
// Background: the inner `emitAudit` closure inside runAgent reads
// `tokensIn` / `tokensOut` / `latencyMs` from the enclosing function scope.
// Pre-fix, those `let` declarations sat just before the Foundry call block.
// The three early-exit paths (circuit_open / circuit_trial_raced /
// budget_exhausted) call `emitAudit` BEFORE the Foundry block ran, hitting
// a TDZ ReferenceError and surfacing to the handler as a generic 500
// `agent_error` rather than the intended skip outcome.
//
// These tests drive each early-exit branch end-to-end with mocked Foundry
// + table primitives and assert:
//   1. The correct AgentRunOutcome is returned (no throw).
//   2. `runSingleTurn` was NOT invoked — Foundry must not be touched on
//      a denied / contended / exhausted run.
//   3. The audit-line written through `appendAuditLine` carries
//      `tokensIn:0` / `tokensOut:0` / `latencyMs:0` — proves the closure
//      captured the hoisted defaults rather than blowing up.
// Locks in the fix at runAgent.ts:167-172 (the hoisted let block with
// SEC-BUG-AGENT-TDZ comment).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Namespace type-only imports for the modules we'll partial-mock — keeps
// the `vi.importActual<typeof Foo>(…)` calls free of inline `import()`
// type annotations (forbidden by @typescript-eslint/consistent-type-imports).
import type * as AgentHealthModule from "../src/lib/agentHealth.js";
import type * as AgentBudgetModule from "../src/lib/agentBudget.js";
import type * as IngestHealthModule from "../src/lib/ingestHealth.js";
import type * as AuditModule from "../src/lib/audit.js";
import type * as AgentClientModule from "../src/lib/agentClient.js";
import type * as TablesModule from "../src/lib/tables.js";

// ---------------------------------------------------------------------------
// Hoisted mocks. vi.mock is hoisted above all imports, so the shared `vi.fn()`
// handles must be created via vi.hoisted() to survive module evaluation order.
// ---------------------------------------------------------------------------
const {
  readHealthMock,
  allowCallMock,
  startHalfOpenTrialMock,
  recordFailureMock,
  recordSuccessMock,
  classifyErrorMock,
  reserveTokensMock,
  releaseReservationMock,
  settleReservationMock,
  getOrInitHealthRowMock,
  commitHealthRowMock,
  appendAuditLineMock,
  runSingleTurnMock,
  getTableClientMock,
  emitAieventMock,
} = vi.hoisted(() => ({
  readHealthMock: vi.fn(),
  allowCallMock: vi.fn(),
  startHalfOpenTrialMock: vi.fn(),
  recordFailureMock: vi.fn(),
  recordSuccessMock: vi.fn(),
  classifyErrorMock: vi.fn(),
  reserveTokensMock: vi.fn(),
  releaseReservationMock: vi.fn(),
  settleReservationMock: vi.fn(),
  getOrInitHealthRowMock: vi.fn(),
  commitHealthRowMock: vi.fn(),
  appendAuditLineMock: vi.fn(),
  runSingleTurnMock: vi.fn(),
  getTableClientMock: vi.fn(),
  emitAieventMock: vi.fn(),
}));

vi.mock("../src/lib/agentHealth.js", async () => {
  const actual = await vi.importActual<typeof AgentHealthModule>(
    "../src/lib/agentHealth.js",
  );
  return {
    ...actual,
    readHealth: readHealthMock,
    allowCall: allowCallMock,
    startHalfOpenTrial: startHalfOpenTrialMock,
    recordFailure: recordFailureMock,
    recordSuccess: recordSuccessMock,
    classifyError: classifyErrorMock,
  };
});

vi.mock("../src/lib/agentBudget.js", async () => {
  const actual = await vi.importActual<typeof AgentBudgetModule>(
    "../src/lib/agentBudget.js",
  );
  return {
    ...actual,
    reserveTokens: reserveTokensMock,
    releaseReservation: releaseReservationMock,
    settleReservation: settleReservationMock,
  };
});

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

vi.mock("../src/lib/agentClient.js", async () => {
  const actual = await vi.importActual<typeof AgentClientModule>(
    "../src/lib/agentClient.js",
  );
  return {
    ...actual,
    runSingleTurn: runSingleTurnMock,
  };
});

vi.mock("../src/lib/tables.js", async () => {
  const actual = await vi.importActual<typeof TablesModule>(
    "../src/lib/tables.js",
  );
  return {
    ...actual,
    getTableClient: getTableClientMock,
  };
});

vi.mock("../src/lib/aievent.js", () => ({
  emitAievent: emitAieventMock,
}));

// `AIProjectClient` is constructed up-front by runAgent only on the Foundry
// path. Stub the SDK so the import is side-effect free in test runs.
vi.mock("@azure/ai-projects", () => ({
  AIProjectClient: vi.fn(),
}));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(),
}));

import { runAgent, type AgentSpec } from "../src/lib/runAgent.js";
import { LeaseContendedError } from "../src/lib/ingestHealth.js";
import type { AgentHealthRow } from "../src/lib/agentHealth.js";
import type { BriefAgentConfig } from "../src/lib/config.js";
import type { BudgetCeilings } from "../src/lib/agentBudget.js";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------
const TENANT = "tenant-aaa";
const AGENT = "incidents";
const SOURCE_CHAIN = "agent.aegis.incidents";
const BRIEF_DATE = "2026-06-22";

function makeSpec(): AgentSpec<{ x: number }, { y: string }> {
  return {
    agentName: AGENT,
    sourceChain: SOURCE_CHAIN,
    buildPrompt: () => ({
      systemPrompt: "sys",
      userPrompt: "usr",
      sourcesPresented: ["src.a", "src.b"],
    }),
    validateOutput: () => ({ ok: true, parsed: { y: "ok" } }),
    reservedTokens: 3000,
    maxOutputTokens: 1500,
  };
}

function makeConfig(): BriefAgentConfig {
  return {
    agentMiClientId: "mi-agent",
    auditMiClientId: "mi-audit",
    apiReaderMiClientId: "mi-reader",
    opsTableEndpoint: "https://ops.table.core.windows.net",
    opsBlobEndpoint: "https://ops.blob.core.windows.net",
    auditBlobEndpoint: "https://audit.blob.core.windows.net",
    auditContainerName: "audit",
    briefCacheContainer: "brief-cache",
    postureCacheContainer: "posture-narratives",
    incidentsDetailContainerName: "incidents-detail",
    tenantId: TENANT,
    foundryProjectEndpoint: "https://foundry.invalid",
    foundryProjectName: "fp",
    foundryRegion: "uksouth",
    briefModelDeployment: "gpt-4.1-mini",
    briefDailyTokenBudget: 60_000,
    briefDailyRunCeiling: 5,
    briefDailyManualRunCeiling: 3,
    briefTimerCron: "0 0 7 * * *",
    briefRetentionDays: 30,
    briefStalenessFreshHours: 24,
    briefStalenessCeilingHours: 48,
    agentBriefSource: "agent.aegis.brief",
    postureWeeklyTokenBudget: 60_000,
    postureWeeklyRunCeiling: 5,
    postureWeeklyManualRunCeiling: 3,
    postureTimerCron: "0 0 7 * * 1",
    postureRetentionDays: 60,
    postureStalenessFreshDays: 7,
    postureStalenessCeilingDays: 14,
    agentPostureSource: "agent.aegis.posture",
    incidentsAnalysisDailyTokenBudget: 60_000,
    incidentsAnalysisDailyRunCeiling: 20,
    incidentsAnalysisDailyManualRunCeiling: 20,
    incidentsAnalysisRedactionLockHours: 24,
    incidentsAnalysisCacheContainer: "incident-analysis-cache",
    incidentsAnalysisRetentionDays: 30,
    agentIncidentsSource: SOURCE_CHAIN,
    leaseWindowMs: 300_000,
    incidentsSource: "incidents",
    secureScoreSource: "secure_score",
  };
}

const CEILINGS: BudgetCeilings = {
  dailyTokenBudget: 60_000,
  dailyRunCeiling: 20,
  dailyManualRunCeiling: 20,
};

function makeContext(): {
  invocationId: string;
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    invocationId: "inv-test",
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function freshHealthRow(state: AgentHealthRow["state"] = "closed"): AgentHealthRow {
  return {
    tenantId: TENANT,
    rowKey: `agent.${AGENT}`,
    state,
    consecutiveFailures: state === "closed" ? 0 : 3,
    nextProbeAt: null,
    lastFailureKind: null,
    lastFailureAt: null,
    updatedAt: new Date("2026-06-22T10:00:00.000Z").toISOString(),
    etag: "etag-health-1",
  };
}

// Helper: extract the audit-line payload that runAgent emitted via
// `appendAuditLine`. There is exactly one call on every early-exit.
function singleAuditLine(): Record<string, unknown> {
  expect(appendAuditLineMock).toHaveBeenCalledTimes(1);
  const args = appendAuditLineMock.mock.calls[0];
  if (!args) throw new Error("appendAuditLine was not called");
  return args[1] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Common defaults applied before every test. Each test overrides the bits
// it needs to drive a specific early-exit branch.
// ---------------------------------------------------------------------------
beforeEach(() => {
  for (const m of [
    readHealthMock,
    allowCallMock,
    startHalfOpenTrialMock,
    recordFailureMock,
    recordSuccessMock,
    classifyErrorMock,
    reserveTokensMock,
    releaseReservationMock,
    settleReservationMock,
    getOrInitHealthRowMock,
    commitHealthRowMock,
    appendAuditLineMock,
    runSingleTurnMock,
    getTableClientMock,
    emitAieventMock,
  ]) {
    m.mockReset();
  }

  getTableClientMock.mockReturnValue({} as never);
  getOrInitHealthRowMock.mockResolvedValue({
    tenantId: TENANT,
    source: SOURCE_CHAIN,
    status: "healthy",
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailureCount: 0,
    lastRunId: null,
    lastAuditSeq: 0,
    lastLineSha256: "",
    lastCursor: "",
    updatedAt: new Date("2026-06-22T10:00:00.000Z").toISOString(),
    etag: "etag-ingesthealth-1",
  });
  commitHealthRowMock.mockResolvedValue("healthy");
  appendAuditLineMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
describe("runAgent — circuit_open early exit (SEC-BUG-AGENT-TDZ)", () => {
  it("returns skipped_circuit_open and emits a chained audit line without calling Foundry", async () => {
    readHealthMock.mockResolvedValue(freshHealthRow("open"));
    allowCallMock.mockReturnValue({ allow: false, trial: false });

    const ctx = makeContext();
    const result = await runAgent(
      makeSpec(),
      { x: 1 },
      {
        trigger: "admin",
        tenantId: TENANT,
        briefDate: BRIEF_DATE,
        context: ctx as never,
        now: new Date("2026-06-22T10:00:00.000Z"),
      },
      makeConfig(),
      CEILINGS,
    );

    expect(result.outcome).toBe("skipped_circuit_open");
    expect(runSingleTurnMock).not.toHaveBeenCalled();
    expect(reserveTokensMock).not.toHaveBeenCalled();

    const line = singleAuditLine();
    expect(line.status).toBe("circuit_open");
    expect(line.reason).toBe("circuit_open");
    // SEC-BUG-AGENT-TDZ pin: the closure read the hoisted defaults
    // rather than throwing on uninitialised let bindings.
    expect(line.tokensIn).toBe(0);
    expect(line.tokensOut).toBe(0);
    expect(line.latencyMs).toBe(0);
    expect(line.source).toBe(SOURCE_CHAIN);
    expect(line.eventType).toBe("agent.run");
    expect(line.seq).toBe(1);
  });
});

describe("runAgent — circuit half-open trial contention (SEC-BUG-AGENT-TDZ)", () => {
  it("returns skipped_circuit_open with reason=circuit_trial_raced when startHalfOpenTrial loses the race", async () => {
    readHealthMock.mockResolvedValue(freshHealthRow("open"));
    allowCallMock.mockReturnValue({ allow: true, trial: true });
    startHalfOpenTrialMock.mockRejectedValue(
      new LeaseContendedError("etag drifted — peer won the trial"),
    );

    const ctx = makeContext();
    const result = await runAgent(
      makeSpec(),
      { x: 1 },
      {
        trigger: "timer",
        tenantId: TENANT,
        briefDate: BRIEF_DATE,
        context: ctx as never,
        now: new Date("2026-06-22T10:00:00.000Z"),
      },
      makeConfig(),
      CEILINGS,
    );

    expect(result.outcome).toBe("skipped_circuit_open");
    expect(runSingleTurnMock).not.toHaveBeenCalled();
    expect(reserveTokensMock).not.toHaveBeenCalled();

    const line = singleAuditLine();
    // L12-FT-05 closure — `finishWithoutFoundry` (runAgent.ts:373) now
    // maps BOTH `circuit_open` and `circuit_trial_raced` reasons to
    // status `"circuit_open"`. A SIEM query on `status="circuit_open"`
    // catches the half-open-trial lost-race exit (this test) AND the
    // cold-deny path. Reason discriminates the two; status is the
    // unified circuit-class signal.
    expect(line.status).toBe("circuit_open");
    expect(line.reason).toBe("circuit_trial_raced");
    expect(line.tokensIn).toBe(0);
    expect(line.tokensOut).toBe(0);
    expect(line.latencyMs).toBe(0);
  });

  it("propagates non-LeaseContendedError failures from startHalfOpenTrial", async () => {
    readHealthMock.mockResolvedValue(freshHealthRow("open"));
    allowCallMock.mockReturnValue({ allow: true, trial: true });
    startHalfOpenTrialMock.mockRejectedValue(new Error("table 500"));

    const ctx = makeContext();
    await expect(
      runAgent(
        makeSpec(),
        { x: 1 },
        {
          trigger: "timer",
          tenantId: TENANT,
          briefDate: BRIEF_DATE,
          context: ctx as never,
          now: new Date("2026-06-22T10:00:00.000Z"),
        },
        makeConfig(),
        CEILINGS,
      ),
    ).rejects.toThrow("table 500");
    expect(runSingleTurnMock).not.toHaveBeenCalled();
    expect(appendAuditLineMock).not.toHaveBeenCalled();
  });
});

describe("runAgent — budget_exhausted early exit (SEC-BUG-AGENT-TDZ)", () => {
  it("returns skipped_budget_exhausted and emits an audit line without calling Foundry", async () => {
    readHealthMock.mockResolvedValue(freshHealthRow("closed"));
    allowCallMock.mockReturnValue({ allow: true, trial: false });
    reserveTokensMock.mockResolvedValue({ ok: false, reason: "budget_exhausted" });

    const ctx = makeContext();
    const result = await runAgent(
      makeSpec(),
      { x: 1 },
      {
        trigger: "admin",
        tenantId: TENANT,
        briefDate: BRIEF_DATE,
        context: ctx as never,
        now: new Date("2026-06-22T10:00:00.000Z"),
      },
      makeConfig(),
      CEILINGS,
    );

    expect(result.outcome).toBe("skipped_budget_exhausted");
    expect(runSingleTurnMock).not.toHaveBeenCalled();
    expect(releaseReservationMock).not.toHaveBeenCalled();
    expect(settleReservationMock).not.toHaveBeenCalled();

    const line = singleAuditLine();
    expect(line.status).toBe("budget_exhausted");
    expect(line.reason).toBe("budget_exhausted");
    expect(line.tokensIn).toBe(0);
    expect(line.tokensOut).toBe(0);
    expect(line.latencyMs).toBe(0);
    expect(line.trigger).toBe("admin");
  });

  it("returns skipped_manual_ceiling when the manual-ceiling reason fires", async () => {
    readHealthMock.mockResolvedValue(freshHealthRow("closed"));
    allowCallMock.mockReturnValue({ allow: true, trial: false });
    reserveTokensMock.mockResolvedValue({ ok: false, reason: "manual_ceiling" });

    const ctx = makeContext();
    const result = await runAgent(
      makeSpec(),
      { x: 1 },
      {
        trigger: "admin",
        tenantId: TENANT,
        briefDate: BRIEF_DATE,
        context: ctx as never,
        now: new Date("2026-06-22T10:00:00.000Z"),
      },
      makeConfig(),
      CEILINGS,
    );

    expect(result.outcome).toBe("skipped_manual_ceiling");
    expect(runSingleTurnMock).not.toHaveBeenCalled();
    const line = singleAuditLine();
    expect(line.status).toBe("budget_exhausted");
    expect(line.reason).toBe("manual_ceiling");
  });

  it("returns skipped_run_ceiling when the run-ceiling reason fires", async () => {
    readHealthMock.mockResolvedValue(freshHealthRow("closed"));
    allowCallMock.mockReturnValue({ allow: true, trial: false });
    reserveTokensMock.mockResolvedValue({ ok: false, reason: "run_ceiling" });

    const ctx = makeContext();
    const result = await runAgent(
      makeSpec(),
      { x: 1 },
      {
        trigger: "timer",
        tenantId: TENANT,
        briefDate: BRIEF_DATE,
        context: ctx as never,
        now: new Date("2026-06-22T10:00:00.000Z"),
      },
      makeConfig(),
      CEILINGS,
    );

    expect(result.outcome).toBe("skipped_run_ceiling");
    expect(runSingleTurnMock).not.toHaveBeenCalled();
    const line = singleAuditLine();
    expect(line.status).toBe("budget_exhausted");
    expect(line.reason).toBe("run_ceiling");
  });
});
