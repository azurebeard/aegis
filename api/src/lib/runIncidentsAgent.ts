// Incidents-agent adapter (ADR-0028 §Decision.3 / §Decision.5 / §Decision.7).
//
// Sequence:
//   1. Resolve config + read cache row for (tenantId, incidentId).
//   2. If redaction-lock active → return cached "withheld" envelope without
//      spending a run (§Decision.7d).
//   3. Build prompt inputs (summary row + detail blob fields + alerts +
//      IngestHealth). Compute `analysedContentSha256` over the canonicalised
//      freshness-hash input. If the cache row's content hash matches (or
//      fast-path timestamp matches), short-circuit with `cache_hit` audit.
//   4. Invoke runAgent with degraded-input override if the ingest is failing
//      ≥ 3 consecutive runs OR all four adversary-influenceable fields were
//      redacted.
//   5. On success: compute next redaction-lock state; render envelope to
//      markdown; write cache. Emit audit with `redactedFields` + possible
//      `RedactionLockActivated` AIEVENT.

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
  computeContentSha256,
  computeNextRedactionLockState,
  INCIDENT_ANALYSIS_CACHE_TABLE_NAME,
  isCacheFresh,
  isRedactionLockActive,
  readCache,
  writeCache,
} from "./incidentAnalysisCache.js";
import {
  buildFreshnessHashInput,
  buildIncidentsPrompt,
  incidentAnalysisToMarkdown,
  validateIncidentsOutput,
  type IncidentAnalysisEnvelope,
  type IncidentAlertInput,
  type IncidentsPromptInputs,
  type RedactableField,
} from "./incidentsPromptBuilder.js";
import { runAgent, type AgentSpec } from "./runAgent.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
  readHealthRow,
} from "./ingestHealth.js";
import {
  getIncidentById,
  INCIDENTS_TABLE_NAME,
  readLatestDetailBlob,
} from "./incidentsStore.js";
import { getTableClient, OPS_TABLES } from "./tables.js";
import { readTenantDirectory } from "./tenantDirectoryStore.js";
import {
  readAgentBudget,
  type AgentBudgetDefaults,
} from "./tenantSettingsStore.js";
import type { IncidentSummary } from "./types.js";
import { sanitiseLog } from "./sanitiseLog.js";

const INCIDENTS_AGENT_NAME = "incidents";
const DEGRADED_FAILURE_THRESHOLD = 3;
const DETAIL_WALK_BACK_DAYS = 7;

export type IncidentsRunStatus =
  | "committed"
  | "cache_hit"
  | "redaction_locked"
  | "not_found"
  | "superseded"
  | "budget_exhausted"
  | "circuit_open"
  | "error";

export interface RunIncidentsAgentResult {
  readonly status: IncidentsRunStatus;
  readonly incidentId: string;
  readonly runId?: string;
  readonly outputSha256?: string;
  readonly reason?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly supersedingRunId?: string;
  readonly degraded?: boolean;
  readonly redactedFields?: readonly RedactableField[];
  readonly redactionLockUntil?: string | null;
}

export interface RunIncidentsAgentOptions {
  readonly trigger: "admin";
  readonly incidentId: string;
  readonly now?: Date;
  readonly context: InvocationContext;
}

export async function runIncidentsAgent(
  opts: RunIncidentsAgentOptions,
): Promise<RunIncidentsAgentResult> {
  const config = resolveBriefAgentConfig();
  const now = opts.now ?? new Date();
  // ADR-0028 §Decision.6 compensating control — adapter asserts the
  // incidentId is drawn from authoritative run context and is the ONLY
  // value threaded into detail-blob reads. `opts.incidentId` is the HTTP
  // handler's path param; model-provided IDs never reach this adapter.
  // The explicit invariant below is tautological
  // today but guards against a future refactor that accidentally threads
  // a second ID source into the adapter — the assertion is the contract.
  const incidentId = opts.incidentId;
  if (incidentId !== opts.incidentId || typeof incidentId !== "string" || incidentId === "") {
    throw new Error(
      "runIncidentsAgent: incidentId invariant violation — opts.incidentId must be the single authoritative source",
    );
  }

  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.agentMiClientId,
  };
  const analysisTable = getTableClient(
    opsCtx,
    INCIDENT_ANALYSIS_CACHE_TABLE_NAME,
  );
  const incidentsTable = getTableClient(opsCtx, INCIDENTS_TABLE_NAME);
  const ingestHealthTable = getTableClient(opsCtx, OPS_TABLES.IngestHealth);

  // --- Step 1: read cache row first for redaction-lock check ---
  const existing = await readCache(analysisTable, config.tenantId, incidentId);

  if (isRedactionLockActive(existing, now)) {
    await emitStandaloneAuditLine(config, opts, {
      status: "success",
      runId: existing!.runId,
      runOutcome: "discarded",
      reason: "redaction_lock",
    });
    return {
      status: "redaction_locked",
      incidentId,
      runId: existing!.runId,
      redactionLockUntil: existing!.redactionLockUntil,
      outputSha256: existing!.outputSha256,
    };
  }

  // --- Step 2: fetch the incident summary + detail blob ---
  const summary = await getIncidentById(
    incidentsTable,
    config.tenantId,
    incidentId,
  );
  if (!summary) {
    return {
      status: "not_found",
      incidentId,
      reason: "incident_not_found",
    };
  }

  const anchor = summary.ingestedAt ?? new Date().toISOString();
  const detailLookup = await readLatestDetailBlob(
    {
      blobEndpoint: config.opsBlobEndpoint,
      containerName: config.incidentsDetailContainerName,
      managedIdentityClientId: config.agentMiClientId,
    },
    incidentId,
    anchor,
    DETAIL_WALK_BACK_DAYS,
  );

  const detailBody = (detailLookup.found && detailLookup.body !== null
    ? (detailLookup.body as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  // --- Step 3: resolve tenant-scoped budget overrides ---
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
    manualRunCeiling: budgetDefaults.incidentsAnalysisManualRunCeiling,
    dailyTokenBudget: budgetDefaults.incidentsAnalysisDailyTokenBudget,
  };
  try {
    const ab = await readAgentBudget(settingsTable, config.tenantId, budgetDefaults);
    agentBudgetCeilings = {
      manualRunCeiling: ab.incidentsAnalysisManualRunCeiling,
      dailyTokenBudget: ab.incidentsAnalysisDailyTokenBudget,
    };
  } catch (settingsErr) {
    const rawMessage = String((settingsErr as Error).message ?? settingsErr);
    const scrubbedMessage = rawMessage.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512);
    opts.context.warn(
      `tenantSettings.read_failed tenantId=${config.tenantId} message=${scrubbedMessage} — falling back to env defaults`,
    );
    emitAievent(opts.context, "IncidentsAgentSettingsFallback", {
      tenantId: config.tenantId,
      trigger: opts.trigger,
      incidentId,
      errorType: (settingsErr as Error)?.constructor?.name ?? "Error",
      errorMessage: scrubbedMessage,
    });
  }

  // --- Step 4: fetch ingest-health for incidents ---
  let incidentsHealth: IncidentsPromptInputs["incidentsHealth"];
  let consecutiveFailures = 0;
  try {
    const row = await readHealthRow(
      ingestHealthTable,
      config.tenantId,
      config.incidentsSource,
    );
    if (row) {
      consecutiveFailures = row.consecutiveFailureCount ?? 0;
      incidentsHealth = {
        status: row.status,
        lastSuccessAt: row.lastSuccessAt ?? null,
        consecutiveFailureCount: consecutiveFailures,
      };
    }
  } catch (err) {
    opts.context.warn(
      `incidents.ingest_health_read_failed incidentId=${sanitiseLog(incidentId)} ${sanitiseLog((err as Error).message)}`,
    );
  }

  // --- Step 5: tenant displayName + alerts normalisation ---
  let tenantDisplayName: string | undefined;
  try {
    const dir = await readTenantDirectory(
      getTableClient(opsCtx, OPS_TABLES.TenantDirectory),
      config.tenantId,
    );
    if (dir) tenantDisplayName = dir.displayName;
  } catch {
    /* fall back to GUID — same pattern as brief/posture */
  }

  const alerts = normaliseAlerts(detailBody);
  const promptInputs: IncidentsPromptInputs = {
    summary,
    ...(typeof detailBody.description === "string"
      ? { description: detailBody.description }
      : {}),
    ...(typeof detailBody.summary === "string"
      ? { incidentSummaryText: detailBody.summary }
      : {}),
    ...(typeof detailBody.resolvingComment === "string"
      ? { resolvingComment: detailBody.resolvingComment }
      : {}),
    alerts,
    ...(incidentsHealth ? { incidentsHealth } : {}),
    ...(consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD
      ? { degradedIngestFailureCount: consecutiveFailures }
      : {}),
  };

  // --- Step 6: content-addressable freshness check (§Decision.3) ---
  const contentHash = computeContentSha256(buildFreshnessHashInput(promptInputs));
  if (isCacheFresh(existing, contentHash, summary.lastUpdateDateTime)) {
    await emitStandaloneAuditLine(config, opts, {
      status: "cache_hit",
      runId: existing!.runId,
      outputSha256: existing!.outputSha256,
    });
    return {
      status: "cache_hit",
      incidentId,
      runId: existing!.runId,
      outputSha256: existing!.outputSha256,
    };
  }

  // --- Step 7: build spec + invoke runAgent ---
  const promptCtx = {
    tenantId: config.tenantId,
    incidentId,
    ...(tenantDisplayName ? { tenantDisplayName } : {}),
  };

  // Capture the redacted-field set the builder will produce so we can
  // reference it in the audit line + lock computation. The builder is
  // deterministic so running it twice is safe; validateOutput is the
  // spec callback, and we want the SAME screening result in both paths.
  const dryBuild = buildIncidentsPrompt(promptInputs, promptCtx);
  const redactedFields = dryBuild.redactedFields;
  const degradedByIngest = consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD;
  const degradedByRedaction =
    redactedFields.includes("description") &&
    redactedFields.includes("summary") &&
    redactedFields.includes("resolvingComment") &&
    redactedFields.includes("alerts.titles");
  const degraded = degradedByIngest || degradedByRedaction;

  const spec: AgentSpec<IncidentsPromptInputs, IncidentAnalysisEnvelope> = {
    agentName: INCIDENTS_AGENT_NAME,
    sourceChain: config.agentIncidentsSource,
    buildPrompt: (i) => buildIncidentsPrompt(i, promptCtx),
    validateOutput: (raw, presented) =>
      validateIncidentsOutput(
        raw,
        presented as readonly string[] as never,
        // SEC-OBS-B3-01 — pass the authoritative incidentId so the
        // validator can route dynamic-key suffixes through
        // `isCanonicalSourceKey` formally, not just the
        // presented-set membership.
        { incidentId },
      ),
    reservedTokens: estimateReservedTokens(),
    maxOutputTokens: 1500,
  };

  const runResult = await runAgent(
    spec,
    promptInputs,
    {
      trigger: opts.trigger,
      tenantId: config.tenantId,
      // AgentBudget keys by `agent.incidents.<yyyy-mm-dd>` (the underlying
      // `briefDate` slot is the budget partition key for the daily bucket).
      briefDate: isoDate(now),
      context: opts.context,
      now,
      ...(degraded ? { successStatusOverride: "degraded" as const } : {}),
      // ADR-0028 §Decision.7c — `redactedFields` lands on the chained
      // `agent.run` audit line for sustained-attack detection by the
      // audit-chain verifier (SEC-OBS-B3-02 follow-up). Empty arrays
      // are omitted so a benign run produces an unchanged line shape.
      // Lexicographic sort makes the audit
      // chain hash invariant under future changes to the prompt-builder
      // iteration order — without the sort, a refactor that re-orders
      // the four field checks would change the per-line hash even when
      // the redaction set is unchanged. The verifier compares the
      // post-scrub canonical bytes; a stable element order is the
      // load-bearing contract.
      ...(redactedFields.length > 0
        ? { extraAuditFields: { redactedFields: [...redactedFields].sort() } }
        : {}),
    },
    config,
    {
      dailyTokenBudget: agentBudgetCeilings.dailyTokenBudget,
      dailyRunCeiling: config.incidentsAnalysisDailyRunCeiling,
      dailyManualRunCeiling: agentBudgetCeilings.manualRunCeiling,
    },
  );

  if (
    runResult.outcome === "skipped_budget_exhausted" ||
    runResult.outcome === "skipped_run_ceiling" ||
    runResult.outcome === "skipped_manual_ceiling"
  ) {
    return {
      status: "budget_exhausted",
      incidentId,
      runId: runResult.runId,
      reason: runResult.outcome.replace("skipped_", ""),
    };
  }
  if (runResult.outcome === "skipped_circuit_open") {
    return { status: "circuit_open", incidentId, runId: runResult.runId };
  }
  if (runResult.outcome === "error") {
    return {
      status: "error",
      incidentId,
      runId: runResult.runId,
      reason: runResult.kind ?? "internal",
    };
  }

  // --- Step 8: write cache + compute next redaction-lock state ---
  if (!runResult.output) {
    return {
      status: "error",
      incidentId,
      runId: runResult.runId,
      reason: "missing_output",
    };
  }
  const body = incidentAnalysisToMarkdown(runResult.output);
  const lockState = computeNextRedactionLockState(
    existing,
    redactedFields.length,
    now,
    config.incidentsAnalysisRedactionLockHours,
  );

  const writeResult = await writeCache({
    table: analysisTable,
    blobServiceEndpoint: config.opsBlobEndpoint,
    miClientId: config.agentMiClientId,
    container: config.incidentsAnalysisCacheContainer,
    tenantId: config.tenantId,
    incidentId,
    body,
    runId: runResult.runId,
    tokensIn: runResult.tokensIn ?? 0,
    tokensOut: runResult.tokensOut ?? 0,
    modelDeployment: config.briefModelDeployment,
    analysedContentSha256: contentHash,
    analysedIncidentLastUpdateDateTime: summary.lastUpdateDateTime,
    redactionLockUntil: lockState.redactionLockUntil,
    redactionLockRunCount: lockState.redactionLockRunCount,
    ...(existing ? { priorEtag: existing.etag } : {}),
    now,
  });

  if (writeResult.status === "superseded") {
    await emitStandaloneAuditLine(config, opts, {
      status: "success",
      runId: runResult.runId,
      runOutcome: "discarded",
      ...(writeResult.supersedingRunId
        ? { supersedingRunId: writeResult.supersedingRunId }
        : {}),
      tokensIn: runResult.tokensIn ?? 0,
      tokensOut: runResult.tokensOut ?? 0,
      latencyMs: runResult.latencyMs ?? 0,
    });
    return {
      status: "superseded",
      incidentId,
      runId: runResult.runId,
      supersedingRunId: writeResult.supersedingRunId ?? "",
    };
  }

  if (lockState.lockNewlyEngaged) {
    emitAievent(opts.context, "RedactionLockActivated", {
      tenantId: config.tenantId,
      incidentId,
      runCount: lockState.redactionLockRunCount,
      lockUntil: lockState.redactionLockUntil,
    });
  }

  // SEC-OBS-B3-02 — `redactedFields` now lands on the chained
  // `agent.run` audit line via `extraAuditFields` (above). The
  // App Insights AIEVENT path is removed to avoid double-emission;
  // operators query the audit chain (or the verifier output) for
  // sustained-redaction patterns.

  const committed: RunIncidentsAgentResult = {
    status: "committed",
    incidentId,
    runId: runResult.runId,
    ...(writeResult.outputSha256 ? { outputSha256: writeResult.outputSha256 } : {}),
    ...(runResult.tokensIn !== undefined ? { tokensIn: runResult.tokensIn } : {}),
    ...(runResult.tokensOut !== undefined ? { tokensOut: runResult.tokensOut } : {}),
    ...(degraded ? { degraded: true } : {}),
    ...(redactedFields.length > 0 ? { redactedFields } : {}),
    ...(lockState.redactionLockUntil !== null
      ? { redactionLockUntil: lockState.redactionLockUntil }
      : {}),
  };
  return committed;
}

/**
 * Normalise the detail-blob `alerts[]` into the builder's input shape.
 * Defensive against missing / wrong-typed fields.
 */
function normaliseAlerts(
  detailBody: Record<string, unknown>,
): readonly IncidentAlertInput[] {
  const alerts = detailBody.alerts;
  if (!Array.isArray(alerts)) return [];
  const out: IncidentAlertInput[] = [];
  for (const raw of alerts) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const id = typeof a.id === "string" ? a.id : null;
    if (!id) continue;
    out.push({
      id,
      ...(typeof a.title === "string" ? { title: a.title } : {}),
      ...(typeof a.severity === "string" ? { severity: a.severity } : {}),
      ...(typeof a.status === "string" ? { status: a.status } : {}),
      ...(typeof a.category === "string" ? { category: a.category } : {}),
      ...(typeof a.serviceSource === "string"
        ? { serviceSource: a.serviceSource }
        : {}),
      ...(typeof a.providerName === "string"
        ? { providerName: a.providerName }
        : {}),
      ...(typeof a.createdDateTime === "string"
        ? { createdDateTime: a.createdDateTime }
        : {}),
    });
  }
  return out;
}

void ("compile-time" as unknown as IncidentSummary);

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function estimateReservedTokens(): number {
  // Empirical fit: 2026-06 observed actuals across the incidents-agent's
  // sibling agents (brief, posture) cluster at ~900-1200 tokens per run.
  // Even pessimistic incidents (multi-alert rich detail) hit the
  // gpt-4.1-mini `maxOutputTokens: 1500` ceiling on output and rarely push
  // input past ~2K tokens because the prompt builder caps each free-text
  // field. Reservation of 3K = 3× the observed peak with safety margin;
  // genuinely-pathological incidents will fail at the model boundary
  // rather than silently consuming the daily budget.
  //
  // Pre-2026-06-22 this was 12_000 — a worst-case ceiling that turned out
  // to be ~12× over-conservative for typical traffic. The high reservation
  // combined with SEC-BUG-BUDGET-SETTLE-RELEASE (settleReservation not
  // releasing the hold) capped operators at `floor(cap / 12_000)` runs
  // even when actual usage was a fraction of that.
  //
  // SEC-BUG-INCIDENTS-BUDGET-MIN — this value is mirrored as the slider /
  // patch-validator min for `incidentsAnalysisDailyTokenBudget` in
  //   - web/src/features/settings/types.ts (AGENT_BUDGET_BOUNDS)
  //   - api/src/lib/tenantSettingsStore.ts (AGENT_BUDGET_BOUNDS)
  //   - api/tests/patchSettingsValidation.test.ts (boundary test)
  // Bumping this number requires bumping those three so the admin UI can
  // never produce a guaranteed-fail config (first call would 429 with
  // `budget_exhausted` because `0 + reservedTokens > dailyTokenBudget`).
  return 3000;
}

// --- standalone audit emitters (cache_hit + redaction_lock + superseded) ---

interface StandaloneAuditArgs {
  readonly status: "success" | "error" | "cache_hit" | "budget_exhausted" | "circuit_open";
  readonly runId: string;
  readonly outputSha256?: string;
  readonly runOutcome?: "committed" | "discarded";
  readonly supersedingRunId?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly latencyMs?: number;
  readonly reason?: string;
}

async function emitStandaloneAuditLine(
  config: BriefAgentConfig,
  opts: RunIncidentsAgentOptions,
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
      config.agentIncidentsSource,
    );
    const seq = prev.lastAuditSeq + 1;
    const now = (opts.now ?? new Date()).toISOString();
    const lineRaw: Record<string, unknown> = {
      schemaVersion: 2,
      eventType: "agent.run",
      source: config.agentIncidentsSource,
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
      briefDate: isoDate(opts.now ?? new Date()),
      trigger: opts.trigger,
      ...(args.supersedingRunId ? { supersedingRunId: args.supersedingRunId } : {}),
      ...(args.runOutcome ? { runOutcome: args.runOutcome } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
      callerPrincipalMiClientId: config.agentMiClientId,
      prevLineSha256: resolvePrevLineSha256(
        prev.lastLineSha256,
        config.agentIncidentsSource,
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
          `incidents.audit_lease_contended runId=${args.runId} — concurrent writer; skipping standalone audit append.`,
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
      `incidents.audit_write_failed runId=${args.runId} ${(err as Error).message}`,
    );
    emitAievent(opts.context, "AuditWriteFailed", {
      source: config.agentIncidentsSource,
      tenantId: config.tenantId,
      runId: args.runId,
    });
    throw err;
  }
}
