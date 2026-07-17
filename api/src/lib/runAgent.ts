// Thin-router agent orchestrator (ADR-0019 §Decision.2).
//
// Wraps a single Foundry single-turn call with:
//   1. Config resolution (caller pre-resolves; we receive config + spec).
//   2. AgentHealth circuit-breaker check (deny / probe / allow).
//   3. AgentBudget pessimistic reservation (token + run + manual ceilings).
//   4. Foundry runSingleTurn() call.
//   5. Settle / release reservation per outcome.
//   6. Spec.validateOutput on the raw model output.
//   7. AgentHealth recordSuccess / recordFailure (with classification).
//   8. Audit-line emit using the same chain primitives as ingest.run
//      (`scrubAgentLine` → `computeLineSha256` → `appendAuditLine`).
//
// Writer-singleton invariant (ADR-0019 §Decision.5): one writer per
// (tenantId, agentName) at a time. The IngestHealth row's ETag-lease serves
// double duty as the writer lease for the audit chain.

import type { InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { AIProjectClient } from "@azure/ai-projects";
import { emitAievent } from "./aievent.js";
import {
  appendAuditLine,
  sanitiseExtraAuditFields,
  scrubAgentLine,
  type AuditLineFields,
} from "./audit.js";
import {
  computeLineSha256,
  resolvePrevLineSha256,
} from "./auditChain.js";
import {
  classifyError,
  recordFailure,
  recordSuccess,
  readHealth,
  allowCall,
  startHalfOpenTrial,
  type AgentFetchErrorKind,
} from "./agentHealth.js";
import {
  AGENT_BUDGET_TABLE_NAME,
  releaseReservation,
  reserveTokens,
  settleReservation,
  type BudgetCeilings,
} from "./agentBudget.js";
import { AGENT_HEALTH_TABLE_NAME } from "./agentHealth.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import { runSingleTurn, AgentFetchError } from "./agentClient.js";
import type { BriefAgentConfig } from "./config.js";
import { getTableClient, OPS_TABLES } from "./tables.js";

export interface AgentSpec<TInputs, TOutput> {
  readonly agentName: string;
  readonly sourceChain: string; // e.g. "agent.aegis.brief"
  readonly buildPrompt: (inputs: TInputs) => {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly sourcesPresented: readonly string[];
  };
  readonly validateOutput: (
    raw: string,
    sourcesPresented: readonly string[],
  ) =>
    | { ok: true; parsed: TOutput }
    | { ok: false; kind: "output_schema" | "sources_not_subset"; detail: string };
  readonly reservedTokens: number;
  readonly maxOutputTokens: number;
}

export type AgentRunOutcome =
  | "success"
  | "skipped_budget_exhausted"
  | "skipped_run_ceiling"
  | "skipped_manual_ceiling"
  | "skipped_circuit_open"
  | "error";

export interface AgentRunResult<TOutput> {
  readonly outcome: AgentRunOutcome;
  readonly runId: string;
  readonly output?: TOutput;
  readonly rawOutput?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly latencyMs?: number;
  readonly modelDeployment?: string;
  readonly sourcesPresented?: readonly string[];
  readonly kind?: AgentFetchErrorKind;
  readonly message?: string;
  readonly auditSeq?: number;
}

export interface RunAgentOptions {
  readonly trigger: "timer" | "admin";
  readonly tenantId: string;
  readonly briefDate: string; // yyyy-mm-dd — also the budget partition
  readonly now?: Date;
  readonly context: InvocationContext;
  /**
   * ADR-0027 §Decision.7 — when the adapter has detected a degraded-input
   * condition (e.g. upstream ingest has been failing for N runs) and is
   * requesting the model to narrate that explicitly, relabel the
   * success-path audit-line `status` from `"success"` to `"degraded"`.
   * Does not change circuit-breaker accounting — the model run itself is
   * a successful turn. FD-B1-02 co-landing requires `verify-audit-chain`
   * to accept the new enum value.
   */
  readonly successStatusOverride?: "degraded";
  /**
   * Specialist-specific fields to merge onto the chained audit line
   * before scrub + hash. Keys MUST be in `AGENT_LINE_ALLOWED_KEYS` (see
   * `audit.ts`) — unknown keys are silently dropped by `scrubAgentLine`.
   * Values are shape-gated by `sanitiseExtraAuditFields` (SEC-OBS-B4-02
   * resolution): an allowlisted key with a wrong-typed value is dropped
   * rather than landed in the audit line, so an adapter bug can't
   * write malformed data into the hash-chained payload.
   * Used by ADR-0028 §Decision.7c to land `redactedFields` on the
   * incidents-agent audit line (SEC-OBS-B3-02 follow-up). Other
   * specialists may use this slot for their own audit-relevant fields
   * without forcing a `runAgent` schema change per specialist.
   */
  readonly extraAuditFields?: Record<string, unknown>;
}

/**
 * Execute one agent run end-to-end. Always emits exactly one audit line
 * (success, skip, or error) chained off the prior `agent.aegis.<name>` line.
 */
export async function runAgent<TInputs, TOutput>(
  spec: AgentSpec<TInputs, TOutput>,
  inputs: TInputs,
  opts: RunAgentOptions,
  config: BriefAgentConfig,
  ceilings: BudgetCeilings,
): Promise<AgentRunResult<TOutput>> {
  const runId = randomUUID();
  const now = opts.now ?? new Date();
  const startedAt = now.toISOString();

  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.agentMiClientId,
  };
  const budgetTable = getTableClient(opsCtx, AGENT_BUDGET_TABLE_NAME);
  const healthTable = getTableClient(opsCtx, AGENT_HEALTH_TABLE_NAME);
  const ingestHealthTable = getTableClient(opsCtx, OPS_TABLES.IngestHealth);

  // --- Build prompt up-front (no Foundry I/O yet). ---
  const built = spec.buildPrompt(inputs);

  // SEC-BUG-AGENT-TDZ — these locals are read by the closure inside
  // `emitAudit` (else branches around line ~447 of this file:
  // `{ tokensIn: tokensIn || 0 }`). Inner functions like
  // `finishWithoutFoundry` / `finishWithError` call `emitAudit` from the
  // early-exit paths below (circuit open, lease contended, budget
  // exhausted) which run BEFORE the Foundry block. Declaring these here
  // (rather than just above the Foundry call) keeps the closure capture
  // valid and avoids `ReferenceError: Cannot access tokensIn before
  // initialization` on any early-exit. The Foundry block reassigns these
  // on success.
  let rawOutput = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let latencyMs = 0;
  let kind: AgentFetchErrorKind | null = null;
  let errMessage: string | null = null;

  // --- Step 1: AgentHealth check. ---
  let health = await readHealth(healthTable, opts.tenantId, spec.agentName);
  const decision = allowCall(health, now);
  if (!decision.allow) {
    return finishWithoutFoundry({
      outcome: "skipped_circuit_open",
      reason: "circuit_open",
    });
  }
  // when the
  // breaker is in `open` and the probe-window has elapsed, `allowCall`
  // returns `{allow:true, trial:true}`. Persist the `half_open` state
  // BEFORE firing Foundry so a concurrent caller reading the row sees
  // `half_open` and is denied by the state-machine (`allowCall` returns
  // `{allow:false}` for `half_open`). On lease contention (412) another
  // caller won the trial-marker race — abort this run cleanly.
  if (decision.trial) {
    try {
      health = await startHalfOpenTrial(healthTable, health, now);
    } catch (err) {
      if (err instanceof LeaseContendedError) {
        return finishWithoutFoundry({
          outcome: "skipped_circuit_open",
          reason: "circuit_trial_raced",
        });
      }
      throw err;
    }
  }

  // --- Step 2: Reserve tokens. ---
  let reserved = false;
  const reserveResult = await reserveTokens(
    budgetTable,
    opts.tenantId,
    spec.agentName,
    opts.briefDate,
    runId,
    spec.reservedTokens,
    opts.trigger,
    ceilings,
    now,
  );
  if (!reserveResult.ok) {
    const reason = reserveResult.reason ?? "budget_exhausted";
    return finishWithoutFoundry({
      outcome:
        reason === "manual_ceiling"
          ? "skipped_manual_ceiling"
          : reason === "run_ceiling"
            ? "skipped_run_ceiling"
            : "skipped_budget_exhausted",
      reason,
    });
  }
  reserved = true;

  // --- Step 3: Foundry call. ---
  const projectClient = new AIProjectClient(
    config.foundryProjectEndpoint,
    new (await import("@azure/identity")).DefaultAzureCredential({
      managedIdentityClientId: config.agentMiClientId,
    }),
  );
  // (rawOutput / tokensIn / tokensOut / latencyMs / kind / errMessage are
  // declared at function top — see SEC-BUG-AGENT-TDZ note above.)
  try {
    const result = await runSingleTurn(projectClient, {
      deploymentName: config.briefModelDeployment,
      systemPrompt: built.systemPrompt,
      userPrompt: built.userPrompt,
      maxOutputTokens: spec.maxOutputTokens,
      timeoutMs: 60_000,
    });
    rawOutput = result.output;
    tokensIn = result.tokensIn;
    tokensOut = result.tokensOut;
    latencyMs = result.latencyMs;
  } catch (err) {
    kind = err instanceof AgentFetchError ? err.kind : classifyError(err);
    errMessage = err instanceof Error ? err.message : String(err);
  }

  // --- Step 4: Settle / release reservation per outcome. ---
  // If the model never responded, release; otherwise settle with actual usage.
  if (kind !== null) {
    // Foundry call failed before we got tokens — release the reservation.
    if (reserved) {
      try {
        await releaseReservation(
          budgetTable,
          opts.tenantId,
          spec.agentName,
          opts.briefDate,
          runId,
          now,
        );
      } catch (releaseErr) {
        opts.context.warn(
          `agent.run.release_failed runId=${runId} ${(releaseErr as Error).message}`,
        );
      }
    }
    await safeRecordFailure(healthTable, health, kind, opts);
    return finishWithError({
      kind,
      message: errMessage ?? "unknown error",
    });
  }

  // We got tokens — settle with the actual usage now.
  // Validate output BEFORE deciding success/failure; an output_schema error
  // still counts as a failure for both budget (settle as failure) and circuit.
  let validateOk = true;
  let validateKind: "output_schema" | "sources_not_subset" | null = null;
  let validateDetail = "";
  let parsed: TOutput | undefined;
  const validation = spec.validateOutput(rawOutput, built.sourcesPresented);
  if (validation.ok) {
    parsed = validation.parsed;
  } else {
    validateOk = false;
    validateKind = validation.kind;
    validateDetail = validation.detail;
  }

  if (reserved) {
    try {
      await settleReservation(
        budgetTable,
        opts.tenantId,
        spec.agentName,
        opts.briefDate,
        runId,
        tokensIn + tokensOut,
        validateOk ? "success" : "failure",
        now,
      );
    } catch (settleErr) {
      opts.context.warn(
        `agent.run.settle_failed runId=${runId} ${(settleErr as Error).message}`,
      );
    }
  }

  if (!validateOk) {
    // Map validation kinds onto the AgentFetchErrorKind set — output_schema
    // is already in the enum; sources_not_subset maps to output_schema for
    // the typed kind (the discriminating detail lives in `message`).
    const errKind: AgentFetchErrorKind =
      validateKind === "sources_not_subset" ? "output_schema" : "output_schema";
    await safeRecordFailure(healthTable, health, errKind, opts);
    return finishWithError({
      kind: errKind,
      message: validateDetail,
      tokensIn,
      tokensOut,
      latencyMs,
    });
  }

  // Success path.
  try {
    await recordSuccess(healthTable, health, now);
  } catch (sErr) {
    opts.context.warn(
      `agent.run.record_success_failed ${(sErr as Error).message}`,
    );
  }

  const auditSeq = await emitAudit({
    status: opts.successStatusOverride ?? "success",
    runOutcome: "committed",
  });

  const successResult: AgentRunResult<TOutput> = {
    outcome: "success",
    runId,
    rawOutput,
    tokensIn,
    tokensOut,
    latencyMs,
    modelDeployment: config.briefModelDeployment,
    sourcesPresented: built.sourcesPresented,
    ...(parsed !== undefined ? { output: parsed } : {}),
    ...(auditSeq !== undefined ? { auditSeq } : {}),
  };
  return successResult;

  // --- helpers (closures over runId / now / config / spec) ---

  async function finishWithoutFoundry(args: {
    outcome: AgentRunOutcome;
    reason: string;
  }): Promise<AgentRunResult<TOutput>> {
    // L12-FT-05 — both circuit-class exit reasons map to the
    // `circuit_open` audit-line status so a SIEM query on
    // `status="circuit_open"` catches BOTH the cold-deny path (breaker
    // open, no trial window) AND the half-open-trial lost-race path.
    // Pre-fix `circuit_trial_raced` mis-routed to `budget_exhausted`,
    // hiding circuit races from a status-only SIEM projection.
    const status: "circuit_open" | "budget_exhausted" =
      args.reason === "circuit_open" || args.reason === "circuit_trial_raced"
        ? "circuit_open"
        : "budget_exhausted";
    const auditSeq = await emitAudit({
      status,
      reason: args.reason,
    });
    return {
      outcome: args.outcome,
      runId,
      sourcesPresented: built.sourcesPresented,
      ...(auditSeq !== undefined ? { auditSeq } : {}),
    };
  }

  async function finishWithError(args: {
    kind: AgentFetchErrorKind;
    message: string;
    tokensIn?: number;
    tokensOut?: number;
    latencyMs?: number;
  }): Promise<AgentRunResult<TOutput>> {
    const auditSeq = await emitAudit({
      status: "error",
      errorKind: args.kind,
      errorMessage: args.message,
      ...(args.tokensIn !== undefined ? { tokensIn: args.tokensIn } : {}),
      ...(args.tokensOut !== undefined ? { tokensOut: args.tokensOut } : {}),
      ...(args.latencyMs !== undefined ? { latencyMs: args.latencyMs } : {}),
    });
    return {
      outcome: "error",
      runId,
      kind: args.kind,
      message: args.message,
      ...(args.tokensIn !== undefined ? { tokensIn: args.tokensIn } : {}),
      ...(args.tokensOut !== undefined ? { tokensOut: args.tokensOut } : {}),
      ...(args.latencyMs !== undefined ? { latencyMs: args.latencyMs } : {}),
      modelDeployment: config.briefModelDeployment,
      sourcesPresented: built.sourcesPresented,
      ...(auditSeq !== undefined ? { auditSeq } : {}),
    };
  }

  async function emitAudit(args: {
    status:
      | "success"
      | "error"
      | "circuit_open"
      | "budget_exhausted"
      | "cache_hit"
      | "degraded";
    reason?: string;
    errorKind?: string;
    errorMessage?: string;
    tokensIn?: number;
    tokensOut?: number;
    latencyMs?: number;
    runOutcome?: "committed" | "discarded";
    outputSha256?: string;
    supersedingRunId?: string;
  }): Promise<number | undefined> {
    try {
      const prev = await getOrInitHealthRow(
        ingestHealthTable,
        opts.tenantId,
        spec.sourceChain,
      );
      const seq = prev.lastAuditSeq + 1;
      const endedAt = new Date().toISOString();
      const lineRaw: Record<string, unknown> = {
        schemaVersion: 2,
        eventType: "agent.run",
        source: spec.sourceChain,
        seq,
        runId,
        tenantId: opts.tenantId,
        startedAt,
        endedAt,
        status: args.status,
        // Adapter-supplied audit-line extras (e.g. ADR-0028 §Decision.7c
        // `redactedFields` for incidents-agent). Spread BEFORE the
        // canonical fields below so any accidental key collision is
        // overridden by the trusted canonical value, not the adapter
        // input. Double-gated: (1) `sanitiseExtraAuditFields` shape-
        // checks each key (SEC-OBS-B4-02 resolution — e.g. redactedFields
        // MUST be readonly string[]); (2) `scrubAgentLine` later strips
        // anything outside `AGENT_LINE_ALLOWED_KEYS`. Values that fail
        // either gate fall through as absent-fields rather than landing
        // malformed on the hash-chained line.
        ...sanitiseExtraAuditFields(opts.extraAuditFields),
        modelDeployment: config.briefModelDeployment,
        ...(args.tokensIn !== undefined ? { tokensIn: args.tokensIn } : { tokensIn: tokensIn || 0 }),
        ...(args.tokensOut !== undefined ? { tokensOut: args.tokensOut } : { tokensOut: tokensOut || 0 }),
        ...(args.latencyMs !== undefined ? { latencyMs: args.latencyMs } : { latencyMs: latencyMs || 0 }),
        ...(args.outputSha256 ? { outputSha256: args.outputSha256 } : {}),
        sourcesUsed: built.sourcesPresented,
        briefDate: opts.briefDate,
        trigger: opts.trigger,
        ...(args.supersedingRunId ? { supersedingRunId: args.supersedingRunId } : {}),
        ...(args.runOutcome ? { runOutcome: args.runOutcome } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
        callerPrincipalMiClientId: config.agentMiClientId,
        ...(args.errorKind && args.errorMessage
          ? {
              error: {
                kind: args.errorKind,
                message: args.errorMessage.slice(0, 2000),
              },
            }
          : {}),
        prevLineSha256: resolvePrevLineSha256(
          prev.lastLineSha256,
          spec.sourceChain,
          opts.tenantId,
        ),
      };
      // Scrub BEFORE hashing — the on-disk bytes (post-scrub) must match the
      // hash bound on the chain (ADR-0021 §scrubAgentLine precedent).
      const scrubbed = scrubAgentLine(lineRaw);
      const lineSha256 = computeLineSha256(scrubbed);
      const finalLine = { ...scrubbed, lineSha256 } as unknown as AuditLineFields;

      try {
        await commitHealthRow(ingestHealthTable, prev, {
          outcome: args.status === "error" ? "error" : "success",
          runId,
          now: endedAt,
          auditSeq: seq,
          lineSha256,
        });
      } catch (commitErr) {
        if (commitErr instanceof LeaseContendedError) {
          opts.context.warn(
            `agent.run.audit_lease_contended runId=${runId} — concurrent writer; skipping audit append.`,
          );
          return undefined;
        }
        throw commitErr;
      }

      await appendAuditLine(
        {
          blobEndpoint: config.auditBlobEndpoint,
          auditContainerName: config.auditContainerName,
          managedIdentityClientId: config.auditMiClientId,
        },
        finalLine,
      );
      return seq;
    } catch (auditErr) {
      // re-throw on
      // audit-write failure, consistent with ingest-path precedent
      // (runIncidentsIngest.ts / runSecureScoreIngest.ts). The IngestHealth
      // row's commit may have already advanced LastAuditSeq + LastLineSha256;
      // if we swallow here the on-disk chain diverges silently from the
      // row-state and the next run's chain-repair detection cannot trigger
      // (ADR-0015 §Negative "audit-write-gap"). Emit the AuditWriteFailed
      // structured signal and propagate.
      opts.context.error(
        `agent.run.audit_write_failed runId=${runId} ${(auditErr as Error).message}`,
      );
      emitAievent(opts.context, "AuditWriteFailed", {
        source: spec.sourceChain,
        tenantId: opts.tenantId,
        runId,
      });
      throw auditErr;
    }
  }
}

async function safeRecordFailure(
  healthTable: ReturnType<typeof getTableClient>,
  row: Awaited<ReturnType<typeof readHealth>>,
  kind: AgentFetchErrorKind,
  opts: RunAgentOptions,
): Promise<void> {
  try {
    await recordFailure(healthTable, row, kind, opts.now ?? new Date());
  } catch (rErr) {
    opts.context.warn(
      `agent.run.record_failure_failed kind=${kind} ${(rErr as Error).message}`,
    );
  }
}
