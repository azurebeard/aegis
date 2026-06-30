// ADR-0034 §3.3 + §10 — Conditional Access policy state ingest orchestrator.
//
// Flow:
//   1. Read IngestHealth (locks ETag).
//   2. Walk /v1.0/identity/conditionalAccess/policies (no licence_required
//      pattern — empty value:[] is a legitimate "no policies configured"
//      state on Free tenants, NOT a P1 absence per ADR-0034 §6).
//   3. Parse + JCS-canonicalise + bound the three nested fields.
//   4. List the prior snapshot from the Table (same `(tenantId)` partition).
//   5. Upsert all freshly-parsed rows.
//   6. Reconcile: delete any RowKey whose policyId wasn't observed.
//   7. Diff the prior snapshot against the new batch; build a list of
//      `{ created, modified, deleted }` entries.
//   8. Commit IngestHealth (allocates next audit seq).
//   9. Append one ingest.run audit line.
//   10. For EACH diff entry, append one `ca.policy.changed` audit line —
//       chained on the same `(source, tenantId)` chain so ADR-0015's
//       forward-only invariant holds.

import type { InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { appendAuditLine, type AuditLineFields } from "./audit.js";
import { computeLineSha256, resolvePrevLineSha256 } from "./auditChain.js";
import type { ConditionalAccessIngestConfig } from "./config.js";
import {
  diffConditionalAccessPolicies,
  type PolicyDiffEntry,
} from "./conditionalAccessDiff.js";
import {
  parseConditionalAccessPages,
} from "./conditionalAccessParser.js";
import {
  CONDITIONAL_ACCESS_TABLE_NAME,
  deleteConditionalAccessPolicyRow,
  listConditionalAccessPolicies,
  upsertConditionalAccessPolicy,
} from "./conditionalAccessStore.js";
import {
  fetchConditionalAccessPolicies,
  GraphFetchError,
} from "./graphClient.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import { getTableClient, OPS_TABLES } from "./tables.js";
import { emitAievent } from "./aievent.js";
import type { IngestOutcome } from "./types.js";

export type ConditionalAccessTrigger = "timer" | "admin";

export interface ConditionalAccessOutcome extends IngestOutcome {
  readonly policiesIngested: number;
  readonly policiesSkipped: number;
  readonly policiesDeleted: number;
  readonly diffCreated: number;
  readonly diffModified: number;
  readonly diffDeleted: number;
  readonly truncatedFieldCount: number;
  readonly pagesFetched: number;
}

function hrDurationMs(start: bigint): number {
  const diffNs = process.hrtime.bigint() - start;
  return Number(diffNs / 1_000_000n);
}

export async function runConditionalAccessIngestOnce(
  config: ConditionalAccessIngestConfig,
  context: InvocationContext,
  options: { readonly trigger?: ConditionalAccessTrigger } = {},
): Promise<ConditionalAccessOutcome> {
  const trigger = options.trigger ?? "timer";
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();

  const ingestTables = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const healthTable = getTableClient(ingestTables, OPS_TABLES.IngestHealth);
  const caTable = getTableClient(ingestTables, CONDITIONAL_ACCESS_TABLE_NAME);

  const prevHealth = await getOrInitHealthRow(
    healthTable,
    config.tenantId,
    config.source,
  );
  let seqCursor = prevHealth.lastAuditSeq;

  // --- Graph fetch ---------------------------------------------------------

  let pageResult: Awaited<ReturnType<typeof fetchConditionalAccessPolicies>> | null = null;
  let errorKind: NonNullable<IngestOutcome["error"]>["kind"] | null = null;
  let errorMessage: string | null = null;
  let httpStatusFinal: number | null = null;
  try {
    pageResult = await fetchConditionalAccessPolicies(
      {
        managedIdentityClientId: config.ingestMiClientId,
        graphBaseUrl: config.graphBaseUrl,
        leaseWindowMs: config.leaseWindowMs,
        timeoutMs: config.graphApiTimeoutMs,
      },
      context,
    );
    httpStatusFinal = 200;
  } catch (err) {
    if (err instanceof GraphFetchError) {
      errorKind = err.kind;
      errorMessage = err.message;
      httpStatusFinal = err.status;
    } else {
      errorKind = "internal";
      errorMessage = String((err as Error).message ?? err);
    }
    context.error(
      `conditionalAccess.ingest.error runId=${runId} kind=${errorKind} message=${errorMessage}`,
    );
  }

  const graphAttempts = pageResult?.attempts ?? 0;
  const pagesFetched = pageResult?.pagesFetched ?? 0;

  if (errorKind !== null) {
    // Error path: bump seq, write error audit + IngestHealth, return.
    seqCursor += 1;
    const endedAt = new Date().toISOString();
    const chainPrev = resolvePrevLineSha256(
      prevHealth.lastLineSha256,
      config.source,
      config.tenantId,
    );
    const errLineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
      schemaVersion: 2,
      eventType: "ingest.run",
      source: config.source,
      seq: seqCursor,
      runId,
      tenantId: config.tenantId,
      startedAt,
      endedAt,
      status: "error",
      rowsWritten: 0,
      retentionRowsDeleted: 0,
      graphAttempts,
      callerPrincipalMiClientId: config.ingestMiClientId,
      prevLineSha256: chainPrev,
      error: { kind: errorKind, message: errorMessage ?? "" },
    };
    const errLineSha256 = computeLineSha256(errLineWithoutHash);
    try {
      await commitHealthRow(healthTable, prevHealth, {
        outcome: "error",
        runId,
        now: endedAt,
        auditSeq: seqCursor,
        lineSha256: errLineSha256,
      });
    } catch (commitErr) {
      if (commitErr instanceof LeaseContendedError) {
        return errorOutcome(runId, startedAt, startHr, graphAttempts, httpStatusFinal, {
          kind: "lease_contended",
          message: commitErr.message,
        }, pagesFetched);
      }
      throw commitErr;
    }
    await appendAuditLine(
      {
        blobEndpoint: config.auditBlobEndpoint,
        auditContainerName: config.auditContainerName,
        managedIdentityClientId: config.auditMiClientId,
      },
      { ...errLineWithoutHash, lineSha256: errLineSha256 } as AuditLineFields,
    );
    return errorOutcome(runId, startedAt, startHr, graphAttempts, httpStatusFinal, {
      kind: errorKind,
      message: errorMessage ?? "",
    }, pagesFetched);
  }

  // --- Parse + upsert + reconcile + diff ----------------------------------

  const parsed = parseConditionalAccessPages(pageResult?.rawPages ?? [], {
    ingestedAt: new Date().toISOString(),
    ingestRunId: runId,
  });

  const prior = await listConditionalAccessPolicies(caTable, config.tenantId);
  const observedIds = new Set<string>();
  for (const r of parsed.rows) {
    observedIds.add(r.id);
    await upsertConditionalAccessPolicy(caTable, config.tenantId, r);
  }

  let policiesDeleted = 0;
  for (const p of prior) {
    if (!observedIds.has(p.id)) {
      await deleteConditionalAccessPolicyRow(caTable, config.tenantId, p.id);
      policiesDeleted += 1;
    }
  }

  const diff = diffConditionalAccessPolicies(prior, parsed.rows);

  // --- Commit IngestHealth + audit lines ----------------------------------

  // The audit chain advances ONE seq per appended line. We append:
  //   1 ingest.run line
  //   + N ca.policy.changed lines (one per diff entry)
  // The IngestHealth row's LastAuditSeq + LastLineSha256 reflect the LAST
  // line written in this run so subsequent runs chain forward correctly.
  const totalAuditLines = 1 + diff.entries.length;
  const finalSeq = seqCursor + totalAuditLines;
  let chainPrev = resolvePrevLineSha256(
    prevHealth.lastLineSha256,
    config.source,
    config.tenantId,
  );

  // Build the line shapes UP-FRONT so we can compute the final LineSha256
  // (= the chain head after this run) and pass it to commitHealthRow with
  // the correct ETag. We then write the audit lines AFTER commit so a
  // lease-contended commit doesn't corrupt the chain.
  const endedAt = new Date().toISOString();
  const ingestRunLineNoHash: Omit<AuditLineFields, "lineSha256"> = {
    schemaVersion: 2,
    eventType: "ingest.run",
    source: config.source,
    seq: seqCursor + 1,
    runId,
    tenantId: config.tenantId,
    startedAt,
    endedAt,
    status: "success",
    rowsWritten: parsed.rows.length,
    retentionRowsDeleted: policiesDeleted,
    graphAttempts,
    callerPrincipalMiClientId: config.ingestMiClientId,
    prevLineSha256: chainPrev,
  };
  const ingestRunLineSha256 = computeLineSha256(ingestRunLineNoHash);
  chainPrev = ingestRunLineSha256;

  // Pre-compute every change-line + its sha so we can know the FINAL chain head.
  const changeLinesNoHash: Array<Omit<AuditLineFields, "lineSha256">> = [];
  const changeLineShas: string[] = [];
  let runningSeq = seqCursor + 1;
  for (const entry of diff.entries) {
    runningSeq += 1;
    const lineNoHash = changeLineFor(
      entry,
      config,
      runId,
      runningSeq,
      endedAt,
      chainPrev,
    );
    const sha = computeLineSha256(lineNoHash);
    changeLinesNoHash.push(lineNoHash);
    changeLineShas.push(sha);
    chainPrev = sha;
  }

  // chainPrev now holds the FINAL line's sha — that's what IngestHealth
  // commits as the new chain head. seqCursor → finalSeq matches.
  try {
    await commitHealthRow(healthTable, prevHealth, {
      outcome: "success",
      runId,
      now: endedAt,
      auditSeq: finalSeq,
      lineSha256: chainPrev,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      context.warn(
        `conditionalAccess.ingest.lease_contended runId=${runId} — another instance committed first; aborting without audit write.`,
      );
      return errorOutcome(runId, startedAt, startHr, graphAttempts, httpStatusFinal, {
        kind: "lease_contended",
        message: err.message,
      }, pagesFetched);
    }
    throw err;
  }

  const auditCtx = {
    blobEndpoint: config.auditBlobEndpoint,
    auditContainerName: config.auditContainerName,
    managedIdentityClientId: config.auditMiClientId,
  };
  // Write the ingest.run line first, then each change-line in seq order.
  await appendAuditLine(
    auditCtx,
    { ...ingestRunLineNoHash, lineSha256: ingestRunLineSha256 } as AuditLineFields,
  );
  for (let i = 0; i < changeLinesNoHash.length; i++) {
    await appendAuditLine(
      auditCtx,
      { ...changeLinesNoHash[i]!, lineSha256: changeLineShas[i]! } as AuditLineFields,
    );
  }

  emitAievent(context, "ConditionalAccessIngest", {
    tenantId: config.tenantId,
    source: config.source,
    status: "success",
    policiesIngested: parsed.rows.length,
    policiesSkipped: parsed.skippedMalformed,
    policiesDeleted,
    diffCreated: diff.createdCount,
    diffModified: diff.modifiedCount,
    diffDeleted: diff.deletedCount,
    truncatedFieldCount: parsed.truncatedFieldCount,
    trigger,
    runId,
  });

  return {
    runId,
    status: "success",
    startedAt,
    endedAt,
    durationMs: hrDurationMs(startHr),
    rowsWritten: parsed.rows.length,
    retentionRowsDeleted: policiesDeleted,
    graphAttempts,
    httpStatusFinal,
    policiesIngested: parsed.rows.length,
    policiesSkipped: parsed.skippedMalformed,
    policiesDeleted,
    diffCreated: diff.createdCount,
    diffModified: diff.modifiedCount,
    diffDeleted: diff.deletedCount,
    truncatedFieldCount: parsed.truncatedFieldCount,
    pagesFetched,
  };
}

function changeLineFor(
  entry: PolicyDiffEntry,
  config: ConditionalAccessIngestConfig,
  runId: string,
  seq: number,
  now: string,
  prevSha: string,
): Omit<AuditLineFields, "lineSha256"> {
  return {
    schemaVersion: 2,
    eventType: "ca.policy.changed",
    source: config.source,
    seq,
    runId,
    tenantId: config.tenantId,
    startedAt: now,
    callerPrincipalMiClientId: config.ingestMiClientId,
    prevLineSha256: prevSha,
    policyId: entry.policyId,
    displayName: entry.displayName,
    diffKind: entry.kind,
    policyBefore: entry.before,
    policyAfter: entry.after,
  };
}

function errorOutcome(
  runId: string,
  startedAt: string,
  startHr: bigint,
  graphAttempts: number,
  httpStatusFinal: number | null,
  error: NonNullable<IngestOutcome["error"]>,
  pagesFetched: number,
): ConditionalAccessOutcome {
  return {
    runId,
    status: "error",
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: hrDurationMs(startHr),
    rowsWritten: 0,
    retentionRowsDeleted: 0,
    graphAttempts,
    httpStatusFinal,
    error,
    policiesIngested: 0,
    policiesSkipped: 0,
    policiesDeleted: 0,
    diffCreated: 0,
    diffModified: 0,
    diffDeleted: 0,
    truncatedFieldCount: 0,
    pagesFetched,
  };
}
