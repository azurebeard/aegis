// ADR-0036 — Defender for Cloud Secure Score ingest orchestrator.
//
// Flow:
//   1. Read IngestHealth (locks ETag).
//   2. Resolve subscriptionName once (best-effort; degrades to GUID).
//   3. Walk Microsoft.Security/secureScores (one ARM call; single
//      subscription in v1 per ADR-0036 §1).
//   4. Parse the first entry into a typed snapshot row.
//   5. Upsert into AzureSecureScores keyed by (tenantId, subscriptionId,
//      yyyy-mm-dd).
//   6. Trim retention (delete rows older than retentionDays).
//   7. Commit IngestHealth (allocates next audit seq).
//   8. Append one ingest.run audit line.
//
// No licence-required pattern: ARM Reader has no licence dimension; a
// Free-tier subscription returns a valid (often very low) score.

import type { InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { appendAuditLine, type AuditLineFields } from "./audit.js";
import { computeLineSha256, resolvePrevLineSha256 } from "./auditChain.js";
import {
  ArmFetchError,
  fetchAzureSecureScore,
  fetchSubscriptionDisplayName,
} from "./armClient.js";
import { parseAzureSecureScore } from "./azureSecureScoreParser.js";
import {
  AZURE_SECURE_SCORES_TABLE_NAME,
  trimAzureSecureScoreRetention,
  upsertAzureSecureScore,
} from "./azureSecureScoreStore.js";
import type { AzureSecureScoreIngestConfig } from "./config.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import { getTableClient, OPS_TABLES } from "./tables.js";
import { emitAievent } from "./aievent.js";
import type { IngestOutcome } from "./types.js";

export type AzureSecureScoreTrigger = "timer" | "admin";

export interface AzureSecureScoreOutcome extends IngestOutcome {
  readonly subscriptionId: string;
  readonly subscriptionName: string;
  readonly snapshotDate: string;
  readonly currentScore: number | null;
  readonly maxScore: number | null;
  readonly percentage: number | null;
  readonly retentionRowsDeletedCount: number;
}

function hrDurationMs(start: bigint): number {
  const diffNs = process.hrtime.bigint() - start;
  return Number(diffNs / 1_000_000n);
}

export async function runAzureSecureScoreIngestOnce(
  config: AzureSecureScoreIngestConfig,
  context: InvocationContext,
  options: { readonly trigger?: AzureSecureScoreTrigger } = {},
): Promise<AzureSecureScoreOutcome> {
  const trigger = options.trigger ?? "timer";
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();
  const snapshotDate = startedAt.slice(0, 10);

  const ingestTables = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.armIngestMiClientId,
  };
  // ADR-0036 v1.3 — ARM-plane freshness rows live in ArmIngestHealth, not
  // the shared IngestHealth. The arm-ingest MI's Contributor grant is
  // bounded to ArmIngestHealth so a compromise of this MI can't forge a
  // freshness row against a Graph-side source on IngestHealth.
  const healthTable = getTableClient(ingestTables, OPS_TABLES.ArmIngestHealth);
  const scoresTable = getTableClient(ingestTables, AZURE_SECURE_SCORES_TABLE_NAME);

  const prevHealth = await getOrInitHealthRow(
    healthTable,
    config.tenantId,
    config.source,
  );

  const armOpts = {
    managedIdentityClientId: config.armIngestMiClientId,
    timeoutMs: config.armApiTimeoutMs,
  };

  // --- ARM fetch -----------------------------------------------------------

  let scoreRes: Awaited<ReturnType<typeof fetchAzureSecureScore>> | null = null;
  let errorKind: NonNullable<IngestOutcome["error"]>["kind"] | null = null;
  let errorMessage: string | null = null;
  let httpStatusFinal: number | null = null;
  try {
    scoreRes = await fetchAzureSecureScore(armOpts, config.subscriptionId, context);
    httpStatusFinal = scoreRes.finalHttpStatus;
  } catch (err) {
    if (err instanceof ArmFetchError) {
      errorKind = err.kind;
      errorMessage = err.message;
      httpStatusFinal = err.status;
    } else {
      errorKind = "internal";
      errorMessage = String((err as Error).message ?? err);
    }
    context.error(
      `azureSecureScore.ingest.error runId=${runId} kind=${errorKind} message=${errorMessage}`,
    );
  }

  const graphAttempts = scoreRes?.attempts ?? 0;

  if (errorKind !== null) {
    return await commitErrorOutcome({
      runId,
      startedAt,
      startHr,
      snapshotDate,
      config,
      prevHealth,
      healthTable,
      seqCursor: prevHealth.lastAuditSeq + 1,
      errorKind,
      errorMessage: errorMessage ?? "",
      httpStatusFinal,
      graphAttempts,
      context,
    });
  }

  // --- Resolve subscription name + parse + upsert + retention --------------

  const subscriptionName =
    (await fetchSubscriptionDisplayName(armOpts, config.subscriptionId, context)) ??
    config.subscriptionId;

  const parsed = parseAzureSecureScore(scoreRes!.data, {
    subscriptionId: config.subscriptionId,
    subscriptionName,
    snapshotDate,
    ingestedAt: new Date().toISOString(),
    ingestRunId: runId,
  });

  if (parsed.row === null) {
    // Treat as an error so IngestHealth surfaces a degrading state — the
    // ARM API succeeded but the response shape was unparseable.
    return await commitErrorOutcome({
      runId,
      startedAt,
      startHr,
      snapshotDate,
      config,
      prevHealth,
      healthTable,
      seqCursor: prevHealth.lastAuditSeq + 1,
      errorKind: "internal",
      errorMessage: parsed.skippedReason ?? "secureScores parse returned null",
      httpStatusFinal,
      graphAttempts,
      context,
    });
  }

  const row = parsed.row;
  await upsertAzureSecureScore(scoresTable, config.tenantId, row);
  const retentionRowsDeletedCount = await trimAzureSecureScoreRetention(
    scoresTable,
    config.tenantId,
    config.retentionDays,
  );

  // --- Commit IngestHealth + audit line ------------------------------------

  const seqCursor = prevHealth.lastAuditSeq + 1;
  const endedAt = new Date().toISOString();
  const chainPrev = resolvePrevLineSha256(
    prevHealth.lastLineSha256,
    config.source,
    config.tenantId,
  );
  const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
    schemaVersion: 2,
    eventType: "ingest.run",
    source: config.source,
    seq: seqCursor,
    runId,
    tenantId: config.tenantId,
    startedAt,
    endedAt,
    status: "success",
    rowsWritten: 1,
    retentionRowsDeleted: retentionRowsDeletedCount,
    graphAttempts,
    callerPrincipalMiClientId: config.armIngestMiClientId,
    prevLineSha256: chainPrev,
    snapshotDate,
    currentScore: row.currentScore,
    maxScore: row.maxScore,
    subscriptionId: config.subscriptionId,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);

  try {
    await commitHealthRow(healthTable, prevHealth, {
      outcome: "success",
      runId,
      now: endedAt,
      auditSeq: seqCursor,
      lineSha256,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      context.warn(
        `azureSecureScore.ingest.lease_contended runId=${runId} — another instance committed first; aborting without audit write.`,
      );
      return errorOutcomeShape(
        runId,
        startedAt,
        startHr,
        snapshotDate,
        config,
        graphAttempts,
        httpStatusFinal,
        { kind: "lease_contended", message: err.message },
        retentionRowsDeletedCount,
        row,
      );
    }
    throw err;
  }

  await appendAuditLine(
    {
      blobEndpoint: config.auditBlobEndpoint,
      auditContainerName: config.auditContainerName,
      managedIdentityClientId: config.auditMiClientId,
    },
    { ...lineWithoutHash, lineSha256 } as AuditLineFields,
  );

  emitAievent(context, "AzureSecureScoreIngest", {
    tenantId: config.tenantId,
    source: config.source,
    status: "success",
    subscriptionId: config.subscriptionId,
    subscriptionName,
    snapshotDate,
    currentScore: row.currentScore,
    maxScore: row.maxScore,
    percentage: row.percentage,
    retentionRowsDeleted: retentionRowsDeletedCount,
    trigger,
    runId,
  });

  return {
    runId,
    status: "success",
    startedAt,
    endedAt,
    durationMs: hrDurationMs(startHr),
    rowsWritten: 1,
    retentionRowsDeleted: retentionRowsDeletedCount,
    graphAttempts,
    httpStatusFinal,
    subscriptionId: config.subscriptionId,
    subscriptionName,
    snapshotDate,
    currentScore: row.currentScore,
    maxScore: row.maxScore,
    percentage: row.percentage,
    retentionRowsDeletedCount,
  };
}

async function commitErrorOutcome(args: {
  runId: string;
  startedAt: string;
  startHr: bigint;
  snapshotDate: string;
  config: AzureSecureScoreIngestConfig;
  prevHealth: Awaited<ReturnType<typeof getOrInitHealthRow>>;
  healthTable: ReturnType<typeof getTableClient>;
  seqCursor: number;
  errorKind: NonNullable<IngestOutcome["error"]>["kind"];
  errorMessage: string;
  httpStatusFinal: number | null;
  graphAttempts: number;
  context: InvocationContext;
}): Promise<AzureSecureScoreOutcome> {
  const endedAt = new Date().toISOString();
  const chainPrev = resolvePrevLineSha256(
    args.prevHealth.lastLineSha256,
    args.config.source,
    args.config.tenantId,
  );
  const errLineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
    schemaVersion: 2,
    eventType: "ingest.run",
    source: args.config.source,
    seq: args.seqCursor,
    runId: args.runId,
    tenantId: args.config.tenantId,
    startedAt: args.startedAt,
    endedAt,
    status: "error",
    rowsWritten: 0,
    retentionRowsDeleted: 0,
    graphAttempts: args.graphAttempts,
    callerPrincipalMiClientId: args.config.armIngestMiClientId,
    prevLineSha256: chainPrev,
    error: { kind: args.errorKind, message: args.errorMessage },
  };
  const errLineSha256 = computeLineSha256(errLineWithoutHash);
  try {
    await commitHealthRow(args.healthTable, args.prevHealth, {
      outcome: "error",
      runId: args.runId,
      now: endedAt,
      auditSeq: args.seqCursor,
      lineSha256: errLineSha256,
    });
  } catch (commitErr) {
    if (commitErr instanceof LeaseContendedError) {
      return errorOutcomeShape(
        args.runId,
        args.startedAt,
        args.startHr,
        args.snapshotDate,
        args.config,
        args.graphAttempts,
        args.httpStatusFinal,
        { kind: "lease_contended", message: commitErr.message },
        0,
        null,
      );
    }
    throw commitErr;
  }
  await appendAuditLine(
    {
      blobEndpoint: args.config.auditBlobEndpoint,
      auditContainerName: args.config.auditContainerName,
      managedIdentityClientId: args.config.auditMiClientId,
    },
    { ...errLineWithoutHash, lineSha256: errLineSha256 } as AuditLineFields,
  );
  return errorOutcomeShape(
    args.runId,
    args.startedAt,
    args.startHr,
    args.snapshotDate,
    args.config,
    args.graphAttempts,
    args.httpStatusFinal,
    { kind: args.errorKind, message: args.errorMessage },
    0,
    null,
  );
}

function errorOutcomeShape(
  runId: string,
  startedAt: string,
  startHr: bigint,
  snapshotDate: string,
  config: AzureSecureScoreIngestConfig,
  graphAttempts: number,
  httpStatusFinal: number | null,
  error: NonNullable<IngestOutcome["error"]>,
  retentionRowsDeletedCount: number,
  row: { currentScore: number; maxScore: number; percentage: number } | null,
): AzureSecureScoreOutcome {
  return {
    runId,
    status: "error",
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: hrDurationMs(startHr),
    rowsWritten: row !== null ? 1 : 0,
    retentionRowsDeleted: retentionRowsDeletedCount,
    graphAttempts,
    httpStatusFinal,
    error,
    subscriptionId: config.subscriptionId,
    subscriptionName: config.subscriptionId,
    snapshotDate,
    currentScore: row?.currentScore ?? null,
    maxScore: row?.maxScore ?? null,
    percentage: row?.percentage ?? null,
    retentionRowsDeletedCount,
  };
}
