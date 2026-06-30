// Posture-agent adapter (ADR-0027 §Decision.4 / §Decision.7).
//
// Sequence mirrors `runBriefAgent` with three deltas:
//   1. Weekly ISO-week RowKey instead of yyyy-mm-dd; freshness is day-scale.
//   2. Inputs are SecureScore-only (plus IngestHealth for that single source).
//   3. Degraded-input short-circuit: when SecureScore ingest has been failing
//      ≥ 3 consecutive runs, flag the builder + re-label the audit status to
//      `degraded` via `RunAgentOptions.successStatusOverride`.

import type { InvocationContext } from "@azure/functions";
import {
  appendAuditLine,
  scrubAgentLine,
  type AuditLineFields,
} from "./audit.js";
import {
  computeLineSha256,
  resolvePrevLineSha256,
} from "./auditChain.js";
import { emitAievent } from "./aievent.js";
import { resolveBriefAgentConfig, type BriefAgentConfig } from "./config.js";
import {
  classifyFreshness,
  readCacheForWeek,
  writeCache,
  type PostureFreshness,
} from "./postureCache.js";
import {
  buildPosturePrompt,
  isoWeekOf,
  postureEnvelopeToMarkdown,
  validatePostureOutput,
  type PostureEnvelope,
  type PosturePromptInputs,
  type PostureSourceKey,
} from "./posturePromptBuilder.js";
import { runAgent, type AgentSpec } from "./runAgent.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
  readHealthRow,
} from "./ingestHealth.js";
import {
  getLatestSnapshot,
  getSnapshotForDate,
  getTableClient,
  getTrendSnapshots,
  OPS_TABLES,
} from "./tables.js";
import { readTenantDirectory } from "./tenantDirectoryStore.js";
import {
  readAgentBudget,
  type AgentBudgetDefaults,
} from "./tenantSettingsStore.js";

const POSTURE_AGENT_NAME = "posture";
const DEGRADED_FAILURE_THRESHOLD = 3; // ADR-0027 §Decision.7

export type PostureRunStatus =
  | "committed"
  | "cache_hit"
  | "superseded"
  | "budget_exhausted"
  | "circuit_open"
  | "error";

export interface RunPostureAgentResult {
  readonly status: PostureRunStatus;
  readonly runId?: string;
  readonly outputSha256?: string;
  readonly reason?: string;
  readonly isoWeek: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly supersedingRunId?: string;
  readonly degraded?: boolean;
}

export interface RunPostureAgentOptions {
  readonly trigger: "timer" | "admin";
  readonly isoWeek?: string;
  readonly now?: Date;
  readonly context: InvocationContext;
}

export async function runPostureAgent(
  opts: RunPostureAgentOptions,
): Promise<RunPostureAgentResult> {
  const config = resolveBriefAgentConfig();
  const now = opts.now ?? new Date();
  const isoWeek = opts.isoWeek ?? isoWeekOf(now);

  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.agentMiClientId,
  };
  const postureCacheTable = getTableClient(opsCtx, OPS_TABLES.PostureCache);

  // --- Step 1: cache check ---
  const existing = await readCacheForWeek(postureCacheTable, config.tenantId, isoWeek);
  const freshness: PostureFreshness = classifyFreshness(
    existing,
    now,
    config.postureStalenessFreshDays,
    config.postureStalenessCeilingDays,
  );
  if (freshness === "fresh" && existing) {
    await emitCacheHitAudit(config, opts, isoWeek, existing.runId, existing.outputSha256);
    return {
      status: "cache_hit",
      isoWeek,
      runId: existing.runId,
      outputSha256: existing.outputSha256,
    };
  }

  // --- Step 1.5: resolve tenant-scoped overrides (ADR-0025 §9.5 pattern). ---
  const settingsTable = getTableClient(opsCtx, OPS_TABLES.TenantSettings);
  const budgetDefaults: AgentBudgetDefaults = {
    briefManualRunCeiling: config.briefDailyManualRunCeiling,
    briefDailyTokenBudget: config.briefDailyTokenBudget,
    postureManualRunCeiling: config.postureWeeklyManualRunCeiling,
    postureWeeklyTokenBudget: config.postureWeeklyTokenBudget,
    incidentsAnalysisManualRunCeiling: config.incidentsAnalysisDailyManualRunCeiling,
    incidentsAnalysisDailyTokenBudget: config.incidentsAnalysisDailyTokenBudget,
  };
  let agentBudgetCeilings = {
    postureManualRunCeiling: budgetDefaults.postureManualRunCeiling,
    postureWeeklyTokenBudget: budgetDefaults.postureWeeklyTokenBudget,
  };
  try {
    const ab = await readAgentBudget(settingsTable, config.tenantId, budgetDefaults);
    agentBudgetCeilings = {
      postureManualRunCeiling: ab.postureManualRunCeiling,
      postureWeeklyTokenBudget: ab.postureWeeklyTokenBudget,
    };
  } catch (settingsErr) {
    const rawMessage = String((settingsErr as Error).message ?? settingsErr);
    const scrubbedMessage = rawMessage
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .slice(0, 512);
    const errorType = (settingsErr as Error)?.constructor?.name ?? "Error";
    opts.context.warn(
      `tenantSettings.read_failed tenantId=${config.tenantId} message=${scrubbedMessage} — falling back to env defaults`,
    );
    emitAievent(opts.context, "PostureAgentSettingsFallback", {
      tenantId: config.tenantId,
      trigger: opts.trigger,
      isoWeek,
      errorType,
      errorMessage: scrubbedMessage,
    });
  }

  // --- Step 2: fetch context sources ---
  const inputs = await fetchPostureInputs(config, opts.context);

  let tenantDisplayName: string | undefined;
  try {
    const dir = await readTenantDirectory(
      getTableClient(opsCtx, OPS_TABLES.TenantDirectory),
      config.tenantId,
    );
    if (dir) tenantDisplayName = dir.displayName;
  } catch (dirErr) {
    opts.context.warn(
      `tenantDirectory.read_failed tenantId=${config.tenantId} message=${String((dirErr as Error).message ?? dirErr)} — falling back to GUID`,
    );
  }

  const degradedIngest =
    typeof inputs.secureScoreHealth?.consecutiveFailureCount === "number" &&
    inputs.secureScoreHealth.consecutiveFailureCount >= DEGRADED_FAILURE_THRESHOLD;
  const promptInputs: PosturePromptInputs = degradedIngest
    ? {
        ...inputs,
        degradedIngestFailureCount:
          inputs.secureScoreHealth?.consecutiveFailureCount ??
          DEGRADED_FAILURE_THRESHOLD,
      }
    : inputs;

  // --- Step 3: build spec + invoke runAgent ---
  const promptOptions = tenantDisplayName ? { tenantDisplayName } : {};
  const spec: AgentSpec<PosturePromptInputs, PostureEnvelope> = {
    agentName: POSTURE_AGENT_NAME,
    sourceChain: config.agentPostureSource,
    buildPrompt: (i) =>
      buildPosturePrompt(i, config.tenantId, isoWeek, promptOptions),
    validateOutput: (raw, presented) =>
      validatePostureOutput(raw, presented as readonly PostureSourceKey[]),
    reservedTokens: estimateReservedTokens(),
    maxOutputTokens: 1500,
  };

  const runResult = await runAgent(
    spec,
    promptInputs,
    {
      trigger: opts.trigger,
      tenantId: config.tenantId,
      briefDate: isoWeek, // budget row partition — ADR-0019 §Decision.4 uses this as the daily key
      context: opts.context,
      now,
      ...(degradedIngest ? { successStatusOverride: "degraded" as const } : {}),
    },
    config,
    {
      dailyTokenBudget: agentBudgetCeilings.postureWeeklyTokenBudget,
      dailyRunCeiling: config.postureWeeklyRunCeiling,
      dailyManualRunCeiling: agentBudgetCeilings.postureManualRunCeiling,
    },
  );

  if (
    runResult.outcome === "skipped_budget_exhausted" ||
    runResult.outcome === "skipped_run_ceiling" ||
    runResult.outcome === "skipped_manual_ceiling"
  ) {
    return {
      status: "budget_exhausted",
      isoWeek,
      runId: runResult.runId,
      reason: runResult.outcome.replace("skipped_", ""),
    };
  }
  if (runResult.outcome === "skipped_circuit_open") {
    return { status: "circuit_open", isoWeek, runId: runResult.runId };
  }
  if (runResult.outcome === "error") {
    return {
      status: "error",
      isoWeek,
      runId: runResult.runId,
      reason: runResult.kind ?? "internal",
    };
  }

  // --- Step 4: write cache ---
  if (!runResult.output) {
    return {
      status: "error",
      isoWeek,
      runId: runResult.runId,
      reason: "missing_output",
    };
  }
  const body = postureEnvelopeToMarkdown(runResult.output);
  const writeResult = await writeCache({
    table: postureCacheTable,
    blobServiceEndpoint: config.opsBlobEndpoint,
    miClientId: config.agentMiClientId,
    container: config.postureCacheContainer,
    tenantId: config.tenantId,
    isoWeek,
    body,
    runId: runResult.runId,
    tokensIn: runResult.tokensIn ?? 0,
    tokensOut: runResult.tokensOut ?? 0,
    modelDeployment: config.briefModelDeployment,
    ...(existing ? { priorEtag: existing.etag } : {}),
    now,
  });

  if (writeResult.status === "superseded") {
    await emitDiscardedAudit(
      config,
      opts,
      isoWeek,
      runResult.runId,
      writeResult.supersedingRunId,
      runResult.tokensIn ?? 0,
      runResult.tokensOut ?? 0,
      runResult.latencyMs ?? 0,
    );
    const supersededResult: RunPostureAgentResult = {
      status: "superseded",
      isoWeek,
      runId: runResult.runId,
      supersedingRunId: writeResult.supersedingRunId ?? "",
    };
    return supersededResult;
  }

  const committed: RunPostureAgentResult = {
    status: "committed",
    isoWeek,
    runId: runResult.runId,
    ...(writeResult.outputSha256 ? { outputSha256: writeResult.outputSha256 } : {}),
    ...(runResult.tokensIn !== undefined ? { tokensIn: runResult.tokensIn } : {}),
    ...(runResult.tokensOut !== undefined ? { tokensOut: runResult.tokensOut } : {}),
    ...(degradedIngest ? { degraded: true } : {}),
  };
  return committed;
}

/**
 * Fetch the SecureScore-domain inputs: latest snapshot, 14-day trend, and
 * the ~14-day-ago anchor snapshot for top-mover derivation (ADR-0027
 * §Decision.2). A table read failure on any single source drops that key
 * from the inputs — the prompt builder handles the missing-key case.
 */
async function fetchPostureInputs(
  config: BriefAgentConfig,
  context: InvocationContext,
): Promise<PosturePromptInputs> {
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.agentMiClientId,
  };
  const secureScoreTable = getTableClient(opsCtx, OPS_TABLES.SecureScore);
  const ingestHealthTable = getTableClient(opsCtx, OPS_TABLES.IngestHealth);
  const out: Partial<{
    latest: NonNullable<PosturePromptInputs["latest"]>;
    prior: NonNullable<PosturePromptInputs["prior"]>;
    trend14d: NonNullable<PosturePromptInputs["trend14d"]>;
    secureScoreHealth: NonNullable<PosturePromptInputs["secureScoreHealth"]>;
  }> = {};

  await safe(context, "secureScore.latest+trend+prior", async () => {
    const [latest, trend] = await Promise.all([
      getLatestSnapshot(secureScoreTable),
      getTrendSnapshots(secureScoreTable, 14),
    ]);
    if (latest) out.latest = latest;
    if (trend.length > 0) out.trend14d = trend;
    if (latest) {
      // Find a trend-row snapshotDate closest to 14 days ago; fall back to
      // the oldest trend row if no entry is older than 14d.
      const fourteenDaysAgoMs = new Date(latest.snapshotDate).getTime() - 14 * 86_400_000;
      const olderRow = trend
        .filter((t) => Date.parse(t.snapshotDate) <= fourteenDaysAgoMs)
        .sort((a, b) => (a.snapshotDate > b.snapshotDate ? -1 : 1))[0];
      const anchorDate = olderRow?.snapshotDate ?? trend[0]?.snapshotDate;
      if (anchorDate && anchorDate !== latest.snapshotDate) {
        const prior = await getSnapshotForDate(secureScoreTable, anchorDate);
        if (prior) out.prior = prior;
      }
    }
  });

  await safe(context, "ingestHealth.secureScore", async () => {
    const row = await readHealthRow(
      ingestHealthTable,
      config.tenantId,
      config.secureScoreSource,
    );
    if (row) {
      out.secureScoreHealth = {
        status: row.status,
        lastSuccessAt: row.lastSuccessAt ?? null,
        consecutiveFailureCount: row.consecutiveFailureCount ?? 0,
      };
    }
  });

  return out;
}

async function safe(
  context: InvocationContext,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    context.warn(
      `posture.context_fetch_failed source=${label} ${(err as Error).message}`,
    );
  }
}

function estimateReservedTokens(): number {
  // Pessimistic upper bound for one posture turn: ~2K context + 1.5K output
  // headroom × 1.2 fudge = 4200 → round to 5000. Smaller than brief's 6000
  // because posture's input set is narrower.
  return 5000;
}

// --- audit emitters for cache_hit and superseded paths ----------------------

async function emitCacheHitAudit(
  config: BriefAgentConfig,
  opts: RunPostureAgentOptions,
  isoWeek: string,
  runId: string,
  outputSha256: string,
): Promise<void> {
  await emitStandaloneAuditLine(config, opts, {
    status: "cache_hit",
    isoWeek,
    runId,
    outputSha256,
  });
}

async function emitDiscardedAudit(
  config: BriefAgentConfig,
  opts: RunPostureAgentOptions,
  isoWeek: string,
  runId: string,
  supersedingRunId: string | undefined,
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
): Promise<void> {
  await emitStandaloneAuditLine(config, opts, {
    status: "success",
    isoWeek,
    runId,
    runOutcome: "discarded",
    ...(supersedingRunId ? { supersedingRunId } : {}),
    tokensIn,
    tokensOut,
    latencyMs,
  });
}

interface StandaloneAuditArgs {
  readonly status: "success" | "error" | "cache_hit" | "budget_exhausted" | "circuit_open";
  readonly isoWeek: string;
  readonly runId: string;
  readonly outputSha256?: string;
  readonly runOutcome?: "committed" | "discarded";
  readonly supersedingRunId?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly latencyMs?: number;
}

async function emitStandaloneAuditLine(
  config: BriefAgentConfig,
  opts: RunPostureAgentOptions,
  args: StandaloneAuditArgs,
): Promise<void> {
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.agentMiClientId,
  };
  const ingestHealthTable = getTableClient(opsCtx, OPS_TABLES.IngestHealth);
  try {
    const prev = await getOrInitHealthRow(
      ingestHealthTable,
      config.tenantId,
      config.agentPostureSource,
    );
    const seq = prev.lastAuditSeq + 1;
    const now = (opts.now ?? new Date()).toISOString();
    const lineRaw: Record<string, unknown> = {
      schemaVersion: 2,
      eventType: "agent.run",
      source: config.agentPostureSource,
      seq,
      runId: args.runId,
      tenantId: config.tenantId,
      startedAt: now,
      endedAt: now,
      status: args.status,
      modelDeployment: config.briefModelDeployment,
      tokensIn: args.tokensIn ?? 0,
      tokensOut: args.tokensOut ?? 0,
      latencyMs: args.latencyMs ?? 0,
      ...(args.outputSha256 ? { outputSha256: args.outputSha256 } : {}),
      briefDate: args.isoWeek, // re-uses briefDate slot for the ISO-week key
      trigger: opts.trigger,
      ...(args.supersedingRunId ? { supersedingRunId: args.supersedingRunId } : {}),
      ...(args.runOutcome ? { runOutcome: args.runOutcome } : {}),
      callerPrincipalMiClientId: config.agentMiClientId,
      prevLineSha256: resolvePrevLineSha256(
        prev.lastLineSha256,
        config.agentPostureSource,
        config.tenantId,
      ),
    };
    const scrubbed = scrubAgentLine(lineRaw);
    const lineSha256 = computeLineSha256(scrubbed);
    try {
      await commitHealthRow(ingestHealthTable, prev, {
        outcome: args.status === "error" ? "error" : "success",
        runId: args.runId,
        now,
        auditSeq: seq,
        lineSha256,
      });
    } catch (err) {
      if (err instanceof LeaseContendedError) {
        opts.context.warn(
          `posture.audit_lease_contended runId=${args.runId} — concurrent writer; skipping standalone audit append.`,
        );
        return;
      }
      throw err;
    }
    await appendAuditLine(
      {
        blobEndpoint: config.auditBlobEndpoint,
        auditContainerName: config.auditContainerName,
        managedIdentityClientId: config.auditMiClientId,
      },
      { ...scrubbed, lineSha256 } as unknown as AuditLineFields,
    );
  } catch (err) {
    opts.context.error(
      `posture.audit_write_failed runId=${args.runId} ${(err as Error).message}`,
    );
    emitAievent(opts.context, "AuditWriteFailed", {
      source: config.agentPostureSource,
      tenantId: config.tenantId,
      runId: args.runId,
    });
    throw err;
  }
}
