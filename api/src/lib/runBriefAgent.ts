// Brief-agent adapter (ADR-0019 §brief-agent + ADR-0020 §contract +
// ADR-0022 §cache contract).
//
// Sequence:
//   1. Resolve config + decide briefDate (UTC today, or caller-supplied).
//   2. Read BriefCache for that date. If `fresh`, short-circuit:
//      emit audit `status: "cache_hit"` and return without a Foundry call.
//   3. Otherwise fetch the 5 allowed context sources via the agent MI's
//      Table-Data-Reader role (ADR-0017 §3 — agent MI on the data-plane).
//   4. Call runAgent() with the brief spec.
//   5. On success: render the JSON envelope to markdown, writeCache().
//      If writeCache reports `superseded`, emit audit with
//      runOutcome:"discarded" + supersedingRunId.
//   6. On error / skip: runAgent already emitted the audit line.

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
  readCacheForDate,
  writeCache,
  type BriefFreshness,
} from "./briefCache.js";
import {
  buildBriefPrompt,
  envelopeToMarkdown,
  validateBriefOutput,
  type AllowedSourceKey,
  type BriefEnvelope,
  type BriefPromptInputs,
} from "./briefPromptBuilder.js";
import { runAgent, type AgentSpec } from "./runAgent.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
  readHealthRow,
} from "./ingestHealth.js";
import {
  getLatestSnapshot,
  getTableClient,
  getTrendSnapshots,
  OPS_TABLES,
} from "./tables.js";
import { readTenantDirectory } from "./tenantDirectoryStore.js";
import {
  readAgentBudget,
  readUserIdentifierStrategy,
  maskDisplayName,
  type UserIdentifierStrategy,
} from "./tenantSettingsStore.js";
import {
  ENTRA_RISK_TABLE_NAME,
  readRiskyUsersForBrief,
  readRiskyUsersCounts,
} from "./entraRiskStore.js";
import {
  INCIDENTS_TABLE_NAME,
  listIncidents,
  readIncidentsCounts,
} from "./incidentsStore.js";
import {
  AGENT_BUDGET_TABLE_NAME,
} from "./agentBudget.js";

const BRIEF_AGENT_NAME = "brief";

export type BriefRunStatus =
  | "committed"
  | "cache_hit"
  | "superseded"
  | "budget_exhausted"
  | "circuit_open"
  | "error";

export interface RunBriefAgentResult {
  readonly status: BriefRunStatus;
  readonly runId?: string;
  readonly outputSha256?: string;
  readonly reason?: string;
  readonly briefDate: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly supersedingRunId?: string;
}

export interface RunBriefAgentOptions {
  readonly trigger: "timer" | "admin";
  readonly yyyymmdd?: string;
  readonly now?: Date;
  readonly context: InvocationContext;
}

export async function runBriefAgent(
  opts: RunBriefAgentOptions,
): Promise<RunBriefAgentResult> {
  const config = resolveBriefAgentConfig();
  const now = opts.now ?? new Date();
  const briefDate = opts.yyyymmdd ?? isoDate(now);

  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.agentMiClientId,
  };
  const briefCacheTable = getTableClient(opsCtx, "BriefCache");

  // --- Step 1: cache check ---
  const existing = await readCacheForDate(briefCacheTable, config.tenantId, briefDate);
  const freshness: BriefFreshness = classifyFreshness(
    existing,
    now,
    config.briefStalenessFreshHours,
    config.briefStalenessCeilingHours,
  );
  if (freshness === "fresh" && existing) {
    await emitCacheHitAudit(config, opts, briefDate, existing.runId, existing.outputSha256);
    return {
      status: "cache_hit",
      briefDate,
      runId: existing.runId,
      outputSha256: existing.outputSha256,
    };
  }

  // --- Step 1.5: resolve tenant-scoped overrides (ADR-0025 §9.5) -----------
  // Read TenantSettings once up-front: agent-budget row (ceilings override)
  // + user-identifier-strategy row (brief risky-users projection). Both are
  // best-effort reads — a failure here falls back to env defaults + objectId
  // strategy. Uses the agent MI's account-scope Table Reader role (no new
  // RBAC; see ADR-0025 §9.7 on the ABAC tightening that lands alongside).
  const settingsTable = getTableClient(opsCtx, OPS_TABLES.TenantSettings);
  const budgetDefaults = {
    briefManualRunCeiling: config.briefDailyManualRunCeiling,
    briefDailyTokenBudget: config.briefDailyTokenBudget,
    postureManualRunCeiling: config.postureWeeklyManualRunCeiling,
    postureWeeklyTokenBudget: config.postureWeeklyTokenBudget,
    incidentsAnalysisManualRunCeiling: config.incidentsAnalysisDailyManualRunCeiling,
    incidentsAnalysisDailyTokenBudget: config.incidentsAnalysisDailyTokenBudget,
  };
  let agentBudgetCeilings: {
    briefManualRunCeiling: number;
    briefDailyTokenBudget: number;
  } = {
    briefManualRunCeiling: budgetDefaults.briefManualRunCeiling,
    briefDailyTokenBudget: budgetDefaults.briefDailyTokenBudget,
  };
  let userIdentifierStrategy: UserIdentifierStrategy = "objectId";
  try {
    const [ab, uis] = await Promise.all([
      readAgentBudget(settingsTable, config.tenantId, budgetDefaults),
      readUserIdentifierStrategy(settingsTable, config.tenantId),
    ]);
    agentBudgetCeilings = {
      briefManualRunCeiling: ab.briefManualRunCeiling,
      briefDailyTokenBudget: ab.briefDailyTokenBudget,
    };
    userIdentifierStrategy = uis.strategy;
  } catch (settingsErr) {
    // OBS-P3-01 (Option D): warn + emit BriefAgentSettingsFallback
    // customEvent so Log Analytics can alert on repeated fallback. 404s are
    // already absorbed by readAgentBudget/readUserIdentifierStrategy, so this
    // catch only fires on genuine anomalies (RBAC drift, transport errors).
    const rawMessage = String((settingsErr as Error).message ?? settingsErr);
    const scrubbedMessage = rawMessage
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .slice(0, 512);
    const errorType =
      (settingsErr as Error)?.constructor?.name ?? "Error";
    opts.context.warn(
      `tenantSettings.read_failed tenantId=${config.tenantId} message=${scrubbedMessage} — falling back to env defaults + objectId strategy`,
    );
    emitAievent(opts.context, "BriefAgentSettingsFallback", {
      tenantId: config.tenantId,
      trigger: opts.trigger,
      briefDate,
      errorType,
      errorMessage: scrubbedMessage,
    });
  }

  // --- Step 2: fetch context sources ---
  const inputs = await fetchBriefInputs(config, opts.context, userIdentifierStrategy);

  // Resolve tenant displayName (populated by runEntraRiskIngest's licence
  // probe — see tenantDirectoryStore.ts). Falls back to the GUID when the
  // row is missing (fresh tenant or probe hasn't fired yet).
  const directoryTable = getTableClient(opsCtx, OPS_TABLES.TenantDirectory);
  let tenantDisplayName: string | undefined;
  try {
    const dir = await readTenantDirectory(directoryTable, config.tenantId);
    if (dir) tenantDisplayName = dir.displayName;
  } catch (dirErr) {
    opts.context.warn(
      `tenantDirectory.read_failed tenantId=${config.tenantId} message=${String((dirErr as Error).message ?? dirErr)} — falling back to GUID`,
    );
  }

  // --- Step 3: build spec + invoke runAgent ---
  const promptOptions = tenantDisplayName ? { tenantDisplayName } : {};
  const spec: AgentSpec<BriefPromptInputs, BriefEnvelope> = {
    agentName: BRIEF_AGENT_NAME,
    sourceChain: config.agentBriefSource,
    buildPrompt: (i) =>
      buildBriefPrompt(i, config.tenantId, briefDate, promptOptions),
    validateOutput: (raw, presented) =>
      validateBriefOutput(raw, presented as readonly AllowedSourceKey[]),
    reservedTokens: estimateReservedTokens(),
    maxOutputTokens: 1500,
  };

  const runResult = await runAgent(spec, inputs, {
    trigger: opts.trigger,
    tenantId: config.tenantId,
    briefDate,
    context: opts.context,
    now,
  }, config, {
    // Token budget + manual-run ceiling apply the operator override (falls
    // back to env defaults when no row exists — ADR-0025 §9.2). Total-runs
    // ceiling stays at env (not exposed in Phase 3; it's a safety net, not
    // a spend control).
    dailyTokenBudget: agentBudgetCeilings.briefDailyTokenBudget,
    dailyRunCeiling: config.briefDailyRunCeiling,
    dailyManualRunCeiling: agentBudgetCeilings.briefManualRunCeiling,
  });

  if (runResult.outcome === "skipped_budget_exhausted" ||
      runResult.outcome === "skipped_run_ceiling" ||
      runResult.outcome === "skipped_manual_ceiling") {
    return {
      status: "budget_exhausted",
      briefDate,
      runId: runResult.runId,
      reason: runResult.outcome.replace("skipped_", ""),
    };
  }
  if (runResult.outcome === "skipped_circuit_open") {
    return { status: "circuit_open", briefDate, runId: runResult.runId };
  }
  if (runResult.outcome === "error") {
    return {
      status: "error",
      briefDate,
      runId: runResult.runId,
      reason: runResult.kind ?? "internal",
    };
  }

  // --- Step 4: write cache ---
  if (!runResult.output) {
    return {
      status: "error",
      briefDate,
      runId: runResult.runId,
      reason: "missing_output",
    };
  }
  const body = envelopeToMarkdown(runResult.output);
  // If a row for this date already exists (stale_serviceable /
  // stale_unservable refresh path — ADR-0022 §ETag-lease), pass its etag to
  // writeCache so the blob + row are OVERWRITTEN atomically rather than
  // taking the first-write ifNoneMatch:* branch (which would otherwise 409
  // the whole refresh and misreport it as `superseded`). Resolves
  // SEC-H-STEP5-CODE-02 from WS10-verdict-2026-04-19-step5-code.
  const writeResult = await writeCache({
    table: briefCacheTable,
    blobServiceEndpoint: config.opsBlobEndpoint,
    miClientId: config.agentMiClientId,
    container: config.briefCacheContainer,
    tenantId: config.tenantId,
    yyyymmdd: briefDate,
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
      briefDate,
      runResult.runId,
      writeResult.supersedingRunId,
      runResult.tokensIn ?? 0,
      runResult.tokensOut ?? 0,
      runResult.latencyMs ?? 0,
    );
    const supersededResult: RunBriefAgentResult = {
      status: "superseded",
      briefDate,
      runId: runResult.runId,
      supersedingRunId: writeResult.supersedingRunId ?? "",
    };
    return supersededResult;
  }

  // The runAgent path already emitted a `success` audit line for the run
  // itself (chain-bound). The cache-commit specifically is implicit in
  // status:"success" + outputSha256 — we do not double-emit here.
  // Mark unused-var on AGENT_BUDGET_TABLE_NAME — exported by agentBudget but
  // the table is bound inside runAgent.
  void AGENT_BUDGET_TABLE_NAME;

  const committed: RunBriefAgentResult = {
    status: "committed",
    briefDate,
    runId: runResult.runId,
    ...(writeResult.outputSha256 ? { outputSha256: writeResult.outputSha256 } : {}),
    ...(runResult.tokensIn !== undefined ? { tokensIn: runResult.tokensIn } : {}),
    ...(runResult.tokensOut !== undefined ? { tokensOut: runResult.tokensOut } : {}),
  };
  return committed;
}

/**
 * Fetch the five allowed context sources via the agent MI on the ops Table /
 * Blob endpoints. Each source is rendered to a compact JSON-as-string block
 * for the prompt builder.
 *
 * If a source is unavailable (table error, no row), it's omitted from inputs
 * — the prompt builder simply doesn't present that key.
 */
async function fetchBriefInputs(
  config: BriefAgentConfig,
  context: InvocationContext,
  userIdentifierStrategy: UserIdentifierStrategy,
): Promise<BriefPromptInputs> {
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.agentMiClientId,
  };
  const secureScoreTable = getTableClient(opsCtx, OPS_TABLES.SecureScore);
  const incidentsTable = getTableClient(opsCtx, INCIDENTS_TABLE_NAME);
  const ingestHealthTable = getTableClient(opsCtx, OPS_TABLES.IngestHealth);
  const riskyUsersTable = getTableClient(opsCtx, ENTRA_RISK_TABLE_NAME);

  const out: Record<string, string> = {};

  await safe(context, "secureScore.latest", async () => {
    const snap = await getLatestSnapshot(secureScoreTable);
    if (snap) {
      out["secureScore.latest"] = JSON.stringify({
        snapshotDate: snap.snapshotDate,
        currentScore: snap.currentScore,
        maxScore: snap.maxScore,
        percentage: snap.percentage,
      });
    }
  });
  await safe(context, "secureScore.trend14d", async () => {
    const trend = await getTrendSnapshots(secureScoreTable, 14);
    if (trend.length > 0) {
      out["secureScore.trend14d"] = JSON.stringify(trend);
    }
  });
  await safe(context, "incidents.summary", async () => {
    const counts = await readIncidentsCounts(incidentsTable, config.tenantId);
    out["incidents.summary"] = JSON.stringify({
      total: counts.total,
      bySeverity: counts.bySeverity,
      byStatus: counts.byStatus,
      byClassification: counts.byClassification,
    });
  });
  await safe(context, "incidents.highSeverity.active", async () => {
    const list = await listIncidents(incidentsTable, config.tenantId, {
      severity: ["high"],
      status: ["active", "inProgress", "awaitingAction"],
      limit: 10,
    });
    out["incidents.highSeverity.active"] = JSON.stringify(
      list.incidents.map((i) => ({
        id: i.id,
        displayName: i.displayName,
        severity: i.severity,
        status: i.status,
        lastUpdateDateTime: i.lastUpdateDateTime,
      })),
    );
  });
  await safe(context, "ingestHealth.all", async () => {
    const sources = [config.secureScoreSource, config.incidentsSource];
    const rows = await Promise.all(
      sources.map(async (s) => {
        try {
          const r = await readHealthRow(ingestHealthTable, config.tenantId, s);
          return r
            ? {
                source: s,
                status: r.status,
                lastSuccessAt: r.lastSuccessAt,
                consecutiveFailures: r.consecutiveFailureCount,
              }
            : null;
        } catch {
          return null;
        }
      }),
    );
    const filtered = rows.filter((r): r is NonNullable<typeof r> => r !== null);
    if (filtered.length > 0) {
      out["ingestHealth.all"] = JSON.stringify(filtered);
    }
  });

  await safe(context, "riskyUsers.summary", async () => {
    const counts = await readRiskyUsersCounts(riskyUsersTable, config.tenantId);
    if (counts.total > 0) {
      out["riskyUsers.summary"] = JSON.stringify({
        total: counts.total,
        byRiskLevel: counts.byRiskLevel,
        byRiskState: counts.byRiskState,
      });
    }
  });
  await safe(context, "riskyUsers.recent", async () => {
    // ADR-0025 §9.6 — projection shape follows the operator's
    // `userIdentifierStrategy`. objectId strategy drops user-identifying
    // fields entirely (ADR-0020 Step-6 zero-PII default); partial_mask
    // emits `displayNameMasked`; display_name emits `displayName`.
    //
    // SEC-L-ADR25-P3-01 parity-with-incidents-agent:
    // `onRedaction` fires per row whose name fails the 4-layer screen.
    // Aggregate by field and emit a single context.warn so the redaction
    // signal lands in App Insights without spamming one log line per row.
    const redactionCounts = { displayName: 0, displayNameMasked: 0 };
    const rows = await readRiskyUsersForBrief(
      riskyUsersTable,
      config.tenantId,
      new Date(),
      {
        strategy: userIdentifierStrategy,
        maskFn: maskDisplayName,
        onRedaction: (field) => {
          redactionCounts[field] += 1;
        },
      },
    );
    const totalRedacted =
      redactionCounts.displayName + redactionCounts.displayNameMasked;
    if (totalRedacted > 0) {
      context.warn(
        `brief.riskyUsers.displayNameRedacted strategy=${userIdentifierStrategy} displayName=${redactionCounts.displayName} displayNameMasked=${redactionCounts.displayNameMasked} total=${totalRedacted} rowsConsidered=${rows.length}`,
      );
    }
    if (rows.length > 0) {
      out["riskyUsers.recent"] = JSON.stringify(rows);
    }
  });

  return out as BriefPromptInputs;
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
      `brief.context_fetch_failed source=${label} ${(err as Error).message}`,
    );
  }
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function estimateReservedTokens(): number {
  // Pessimistic upper bound for one brief turn: ~3K context + 1.5K output
  // headroom × 1.2 fudge = 5400 → round to 6000.
  return 6000;
}

// --- audit emitters for cache_hit and superseded paths -----------------------

async function emitCacheHitAudit(
  config: BriefAgentConfig,
  opts: RunBriefAgentOptions,
  briefDate: string,
  runId: string,
  outputSha256: string,
): Promise<void> {
  await emitStandaloneAuditLine(config, opts, {
    status: "cache_hit",
    briefDate,
    runId,
    outputSha256,
  });
}

async function emitDiscardedAudit(
  config: BriefAgentConfig,
  opts: RunBriefAgentOptions,
  briefDate: string,
  runId: string,
  supersedingRunId: string | undefined,
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
): Promise<void> {
  await emitStandaloneAuditLine(config, opts, {
    status: "success",
    briefDate,
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
  readonly briefDate: string;
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
  opts: RunBriefAgentOptions,
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
      config.agentBriefSource,
    );
    const seq = prev.lastAuditSeq + 1;
    const now = (opts.now ?? new Date()).toISOString();
    const lineRaw: Record<string, unknown> = {
      schemaVersion: 2,
      eventType: "agent.run",
      source: config.agentBriefSource,
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
      briefDate: args.briefDate,
      trigger: opts.trigger,
      ...(args.supersedingRunId ? { supersedingRunId: args.supersedingRunId } : {}),
      ...(args.runOutcome ? { runOutcome: args.runOutcome } : {}),
      callerPrincipalMiClientId: config.agentMiClientId,
      prevLineSha256: resolvePrevLineSha256(
        prev.lastLineSha256,
        config.agentBriefSource,
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
          `brief.audit_lease_contended runId=${args.runId} — concurrent writer; skipping standalone audit append.`,
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
    // re-throw on
    // audit-write failure, consistent with ingest-path precedent. The
    // IngestHealth row commit may have already advanced the chain-state; if
    // we swallow here the on-disk chain diverges from the row-state and the
    // next run's chain-repair detection cannot trigger (ADR-0015 §Negative
    // "audit-write-gap"). Emit AuditWriteFailed + propagate.
    opts.context.error(
      `brief.audit_write_failed runId=${args.runId} ${(err as Error).message}`,
    );
    emitAievent(opts.context, "AuditWriteFailed", {
      source: config.agentBriefSource,
      tenantId: config.tenantId,
      runId: args.runId,
    });
    throw err;
  }
}
