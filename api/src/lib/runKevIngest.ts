// ADR-0032 §1 + §5 — KEV ingest orchestrator.
//
// Mirrors the SecureScore / Incidents / EntraRisk ingest pattern:
//   1. Get-or-init IngestHealth row → ETag = the lease.
//   2. Compute next seq = lastSeq + 1.
//   3. Fetch + parse the KEV feed.
//   4. Upsert each entry (lastSeenAt = now, removed = false).
//   5. Sweep rows whose lastSeenAt < startedAt → set removed = true.
//   6. Build the audit line (resolve prevLineSha256, compute lineSha256).
//   7. Commit IngestHealth (IfMatch ETag) → 412 means another run won
//      the race; abort without audit-write.
//   8. Append audit line on the cisa.kev chain.

import type { InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { appendAuditLine, type AuditLineFields } from "./audit.js";
import { computeLineSha256, resolvePrevLineSha256 } from "./auditChain.js";
import type { KevIngestConfig } from "./config.js";
import {
  fetchKevFeed,
  KevFetchError,
  type ParsedKevFeed,
} from "./kevFeedClient.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import {
  sweepRemovedKevRows,
  upsertKevEntries,
} from "./kevStore.js";
import { getTableClient, OPS_TABLES } from "./tables.js";

export interface KevIngestOutcome {
  readonly runId: string;
  readonly status: "success" | "no_data" | "error";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly addedThisRun: number;
  readonly updatedThisRun: number;
  readonly removedThisRun: number;
  readonly droppedFromFeed: number;
  readonly catalogVersion: string | null;
  readonly attempts: number;
  readonly httpStatusFinal: number | null;
  readonly error?: { readonly kind: string; readonly message: string };
}

export async function runKevIngestOnce(
  config: KevIngestConfig,
  context: InvocationContext,
): Promise<KevIngestOutcome> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();

  const ingestCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const healthTable = getTableClient(ingestCtx, OPS_TABLES.IngestHealth);
  const kevTable = getTableClient(ingestCtx, OPS_TABLES.KEV);

  const prevHealth = await getOrInitHealthRow(healthTable, config.tenantId, config.source);
  const nextSeq = prevHealth.lastAuditSeq + 1;

  let feed: ParsedKevFeed | null = null;
  let addedThisRun = 0;
  let updatedThisRun = 0;
  let removedThisRun = 0;
  let droppedFromFeed = 0;
  let catalogVersion: string | null = null;
  let attempts = 0;
  let httpStatusFinal: number | null = null;
  let status: KevIngestOutcome["status"] = "error";
  let errorKind: string | null = null;
  let errorMessage: string | null = null;

  try {
    feed = await fetchKevFeed({
      feedUrl: config.feedUrl,
      timeoutMs: config.feedTimeoutMs,
      maxBytes: config.feedMaxBytes,
    });
    attempts = feed.attempts;
    httpStatusFinal = feed.httpStatusFinal;
    catalogVersion = feed.catalogVersion;
    droppedFromFeed = feed.droppedCount;

    if (feed.entries.length === 0) {
      status = "no_data";
    } else {
      const upsertResult = await upsertKevEntries(kevTable, {
        entries: feed.entries,
        now: new Date().toISOString(),
        ingestRunId: runId,
      });
      addedThisRun = upsertResult.addedCount;
      updatedThisRun = upsertResult.updatedCount;
      removedThisRun = await sweepRemovedKevRows(kevTable, {
        currentRunStartedAt: startedAt,
        now: new Date().toISOString(),
        ingestRunId: runId,
      });
      status = "success";
    }
  } catch (err) {
    if (err instanceof KevFetchError) {
      errorKind = err.kind;
      errorMessage = err.message;
      attempts = err.attempts;
      httpStatusFinal = err.status;
    } else {
      errorKind = "internal";
      errorMessage = String((err as Error).message ?? err);
    }
    context.error(`kev.ingest.error kind=${errorKind} message=${errorMessage}`);
    status = "error";
  }

  // Build audit line.
  const endedAt = new Date().toISOString();
  const prevLineSha256 = resolvePrevLineSha256(
    prevHealth.lastLineSha256,
    config.source,
    config.tenantId,
  );
  const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
    schemaVersion: 2,
    eventType: "ingest.run",
    source: config.source,
    seq: nextSeq,
    runId,
    tenantId: config.tenantId,
    startedAt,
    endedAt,
    status,
    rowsWritten: addedThisRun + updatedThisRun,
    retentionRowsDeleted: removedThisRun,
    graphAttempts: attempts,
    callerPrincipalMiClientId: config.ingestMiClientId,
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage.slice(0, 2000) } }
      : {}),
    prevLineSha256,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);

  // Commit IngestHealth — single-winner serialisation.
  try {
    await commitHealthRow(healthTable, prevHealth, {
      outcome: status === "error" ? "error" : "success",
      runId,
      now: endedAt,
      auditSeq: nextSeq,
      lineSha256,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      context.warn(
        `kev.ingest.lease_contended runId=${runId} — another instance committed first; aborting without audit write.`,
      );
      return {
        runId,
        status: "error",
        startedAt,
        endedAt,
        durationMs: hrDurationMs(startHr),
        addedThisRun,
        updatedThisRun,
        removedThisRun,
        droppedFromFeed,
        catalogVersion,
        attempts,
        httpStatusFinal,
        error: { kind: "lease_contended", message: (err as Error).message },
      };
    }
    throw err;
  }

  // Audit append. Failures here leave a chain gap visible to the verifier.
  try {
    await appendAuditLine(
      {
        blobEndpoint: config.auditBlobEndpoint,
        auditContainerName: config.auditContainerName,
        managedIdentityClientId: config.auditMiClientId,
      },
      { ...lineWithoutHash, lineSha256 } as AuditLineFields,
    );
  } catch (auditErr) {
    context.error(
      `kev.ingest.audit_write_failed runId=${runId} seq=${nextSeq} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }

  context.log(
    `kev.ingest.run runId=${runId} status=${status} addedThisRun=${addedThisRun} updatedThisRun=${updatedThisRun} removedThisRun=${removedThisRun} droppedFromFeed=${droppedFromFeed} catalogVersion=${catalogVersion ?? "n/a"} attempts=${attempts} httpStatusFinal=${httpStatusFinal ?? "n/a"}`,
  );

  return {
    runId,
    status,
    startedAt,
    endedAt,
    durationMs: hrDurationMs(startHr),
    addedThisRun,
    updatedThisRun,
    removedThisRun,
    droppedFromFeed,
    catalogVersion,
    attempts,
    httpStatusFinal,
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage } }
      : {}),
  };
}

function hrDurationMs(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / 1_000_000n);
}
