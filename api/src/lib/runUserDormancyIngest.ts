// ADR-0034 §1, §3.1, §6 — User dormancy ingest orchestrator.
//
// Flow:
//   1. Read IngestHealth (locks ETag).
//   2. Short-circuit if Status === 'licence_required' AND trigger !== 'admin'.
//   3. Walk /v1.0/users?$select=...,signInActivity (paged).
//   4. Parse + upsert all rows; track observed ids.
//   5. Reconcile: list current Table rows; delete any whose RowKey wasn't
//      observed in this run.
//   6. Detect licence absence: when EVERY observed row has all three
//      signInActivity fields null AND the response was non-empty, set
//      sticky `licence_required` (ADR-0034 §6).
//   7. Commit IngestHealth with IfMatch (allocates next audit seq).
//   8. Append one ingest.run audit line.

import type { InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { appendAuditLine, type AuditLineFields } from "./audit.js";
import { computeLineSha256, resolvePrevLineSha256 } from "./auditChain.js";
import type { UserDormancyIngestConfig } from "./config.js";
import {
  fetchUsersPaged,
  GraphFetchError,
  type UsersPagedResult,
} from "./graphClient.js";
import {
  commitHealthRow,
  commitStickyLicenceRequired,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import {
  isLicenceRequiredBatch,
  parseUsersPages,
} from "./userDormancyParser.js";
import {
  deleteUserDormancyRow,
  listUserDormancyRows,
  upsertUserDormancyRow,
} from "./userDormancyStore.js";
import { getTableClient, OPS_TABLES } from "./tables.js";
import { emitAievent } from "./aievent.js";
import type { IngestOutcome } from "./types.js";
import type { TableClient } from "@azure/data-tables";

export type UserDormancyTrigger = "timer" | "admin";

export interface UserDormancyOutcome extends IngestOutcome {
  readonly usersIngested: number;
  readonly usersSkipped: number;
  readonly usersDeleted: number;
  readonly pagesFetched: number;
  readonly licenceState: "present" | "licence_required" | "unknown";
}

export async function runUserDormancyIngestOnce(
  config: UserDormancyIngestConfig,
  context: InvocationContext,
  options: { readonly trigger?: UserDormancyTrigger } = {},
): Promise<UserDormancyOutcome> {
  const trigger = options.trigger ?? "timer";
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();

  const ingestTables = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const healthTable = getTableClient(ingestTables, OPS_TABLES.IngestHealth);
  const dormancyTable = getTableClient(ingestTables, OPS_TABLES.UserDormancy);

  const prevHealth = await getOrInitHealthRow(
    healthTable,
    config.tenantId,
    config.source,
  );
  let seqCursor = prevHealth.lastAuditSeq;

  // Short-circuit if licence_required AND non-admin.
  if (prevHealth.status === "licence_required" && trigger !== "admin") {
    context.log(
      `userDormancy.ingest.short_circuit runId=${runId} status=licence_required trigger=${trigger} — ADR-0034 §6 sticky state`,
    );
    return {
      runId,
      status: "no_data",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: hrDurationMs(startHr),
      rowsWritten: 0,
      retentionRowsDeleted: 0,
      graphAttempts: 0,
      httpStatusFinal: null,
      usersIngested: 0,
      usersSkipped: 0,
      usersDeleted: 0,
      pagesFetched: 0,
      licenceState: "licence_required",
    };
  }

  // --- Graph fetch ----------------------------------------------------------

  let pageResult: UsersPagedResult | null = null;
  let errorKind: NonNullable<IngestOutcome["error"]>["kind"] | null = null;
  let errorMessage: string | null = null;
  let httpStatusFinal: number | null = null;
  try {
    pageResult = await fetchUsersPaged(
      {
        managedIdentityClientId: config.ingestMiClientId,
        graphBaseUrl: config.graphBaseUrl,
        leaseWindowMs: config.leaseWindowMs,
        timeoutMs: config.graphApiTimeoutMs,
      },
      { pageSize: config.pageSize },
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
      `userDormancy.ingest.error runId=${runId} kind=${errorKind} message=${errorMessage}`,
    );
  }

  const graphAttempts = pageResult?.attempts ?? 0;
  const pagesFetched = pageResult?.pagesFetched ?? 0;

  // Error path → emit error audit line + IngestHealth, return.
  if (errorKind !== null) {
    return await commitErrorOutcome({
      runId,
      startedAt,
      startHr,
      config,
      prevHealth,
      healthTable,
      seqCursor: seqCursor + 1,
      errorKind,
      errorMessage: errorMessage ?? "",
      httpStatusFinal,
      graphAttempts,
      context,
    });
  }

  // --- Parse + upsert + reconcile -------------------------------------------

  const parsed = parseUsersPages(pageResult?.rawPages ?? [], {
    ingestedAt: new Date().toISOString(),
    ingestRunId: runId,
  });
  const observedIds = new Set<string>();
  for (const r of parsed.rows) observedIds.add(r.id);

  // Licence detection: every observed row has all three signInActivity
  // fields null. Empty `value: []` is NOT licence_required (legitimate
  // empty tenant — no users at all). Apply only when rows.length > 0.
  const licenceRequired =
    parsed.rows.length > 0 && isLicenceRequiredBatch(parsed.rows);
  const licenceState: UserDormancyOutcome["licenceState"] = licenceRequired
    ? "licence_required"
    : "present";

  if (licenceRequired) {
    // Don't write any rows — the data is uniformly null and would just
    // pollute the table. Sticky-set the IngestHealth row instead.
    seqCursor += 1;
    return await commitLicenceRequiredOutcome({
      runId,
      startedAt,
      startHr,
      config,
      prevHealth,
      healthTable,
      seqCursor,
      pagesFetched,
      graphAttempts,
      context,
    });
  }

  // Upsert each row.
  for (const row of parsed.rows) {
    await upsertUserDormancyRow(dormancyTable, config.tenantId, row);
  }

  // Delete-not-found reconciliation.
  let usersDeleted = 0;
  const existing = await listUserDormancyRows(dormancyTable, config.tenantId);
  for (const e of existing) {
    if (!observedIds.has(e.id)) {
      try {
        await deleteUserDormancyRow(dormancyTable, config.tenantId, e.id);
        usersDeleted++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code !== 404) {
          // Concurrent delete is fine; anything else is a real error.
          throw err;
        }
      }
    }
  }

  // --- Commit IngestHealth + audit line ------------------------------------

  seqCursor += 1;
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
    rowsWritten: parsed.rows.length,
    retentionRowsDeleted: usersDeleted,
    graphAttempts,
    callerPrincipalMiClientId: config.ingestMiClientId,
    prevLineSha256: chainPrev,
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
        `userDormancy.ingest.lease_contended runId=${runId} — another instance committed first; aborting without audit write.`,
      );
      return {
        runId,
        status: "error",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: hrDurationMs(startHr),
        rowsWritten: parsed.rows.length,
        retentionRowsDeleted: usersDeleted,
        graphAttempts,
        httpStatusFinal,
        error: { kind: "lease_contended", message: err.message },
        usersIngested: parsed.rows.length,
        usersSkipped: parsed.skippedMalformed,
        usersDeleted,
        pagesFetched,
        licenceState,
      };
    }
    throw err;
  }

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
      `userDormancy.ingest.audit_write_failed runId=${runId} seq=${seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }

  emitAievent(context, "UserDormancyIngest", {
    tenantId: config.tenantId,
    source: config.source,
    status: "success",
    usersIngested: parsed.rows.length,
    usersSkipped: parsed.skippedMalformed,
    usersDeleted,
    pagesFetched,
    graphAttempts,
    runId,
  });

  context.log(
    `userDormancy.ingest.run runId=${runId} status=success durationMs=${hrDurationMs(startHr)} rowsWritten=${parsed.rows.length} usersDeleted=${usersDeleted} pagesFetched=${pagesFetched} graphAttempts=${graphAttempts}`,
  );

  return {
    runId,
    status: "success",
    startedAt,
    endedAt,
    durationMs: hrDurationMs(startHr),
    rowsWritten: parsed.rows.length,
    retentionRowsDeleted: usersDeleted,
    graphAttempts,
    httpStatusFinal,
    usersIngested: parsed.rows.length,
    usersSkipped: parsed.skippedMalformed,
    usersDeleted,
    pagesFetched,
    licenceState,
  };
}

interface CommitErrorArgs {
  readonly runId: string;
  readonly startedAt: string;
  readonly startHr: bigint;
  readonly config: UserDormancyIngestConfig;
  readonly prevHealth: Awaited<ReturnType<typeof getOrInitHealthRow>>;
  readonly healthTable: TableClient;
  readonly seqCursor: number;
  readonly errorKind: NonNullable<IngestOutcome["error"]>["kind"];
  readonly errorMessage: string;
  readonly httpStatusFinal: number | null;
  readonly graphAttempts: number;
  readonly context: InvocationContext;
}

async function commitErrorOutcome(
  args: CommitErrorArgs,
): Promise<UserDormancyOutcome> {
  const endedAt = new Date().toISOString();
  const chainPrev = resolvePrevLineSha256(
    args.prevHealth.lastLineSha256,
    args.config.source,
    args.config.tenantId,
  );
  const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
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
    callerPrincipalMiClientId: args.config.ingestMiClientId,
    error: { kind: args.errorKind, message: args.errorMessage.slice(0, 2000) },
    prevLineSha256: chainPrev,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);
  try {
    await commitHealthRow(args.healthTable, args.prevHealth, {
      outcome: "error",
      runId: args.runId,
      now: endedAt,
      auditSeq: args.seqCursor,
      lineSha256,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      args.context.warn(
        `userDormancy.ingest.lease_contended runId=${args.runId} during error commit`,
      );
      return {
        runId: args.runId,
        status: "error",
        startedAt: args.startedAt,
        endedAt,
        durationMs: hrDurationMs(args.startHr),
        rowsWritten: 0,
        retentionRowsDeleted: 0,
        graphAttempts: args.graphAttempts,
        httpStatusFinal: args.httpStatusFinal,
        error: { kind: "lease_contended", message: err.message },
        usersIngested: 0,
        usersSkipped: 0,
        usersDeleted: 0,
        pagesFetched: 0,
        licenceState: "unknown",
      };
    }
    throw err;
  }
  try {
    await appendAuditLine(
      {
        blobEndpoint: args.config.auditBlobEndpoint,
        auditContainerName: args.config.auditContainerName,
        managedIdentityClientId: args.config.auditMiClientId,
      },
      { ...lineWithoutHash, lineSha256 } as AuditLineFields,
    );
  } catch (auditErr) {
    args.context.error(
      `userDormancy.ingest.audit_write_failed runId=${args.runId} seq=${args.seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }
  emitAievent(args.context, "UserDormancyIngest", {
    tenantId: args.config.tenantId,
    source: args.config.source,
    status: "error",
    errorKind: args.errorKind,
    runId: args.runId,
  });
  return {
    runId: args.runId,
    status: "error",
    startedAt: args.startedAt,
    endedAt,
    durationMs: hrDurationMs(args.startHr),
    rowsWritten: 0,
    retentionRowsDeleted: 0,
    graphAttempts: args.graphAttempts,
    httpStatusFinal: args.httpStatusFinal,
    error: { kind: args.errorKind, message: args.errorMessage },
    usersIngested: 0,
    usersSkipped: 0,
    usersDeleted: 0,
    pagesFetched: 0,
    licenceState: "unknown",
  };
}

interface CommitLicenceRequiredArgs {
  readonly runId: string;
  readonly startedAt: string;
  readonly startHr: bigint;
  readonly config: UserDormancyIngestConfig;
  readonly prevHealth: Awaited<ReturnType<typeof getOrInitHealthRow>>;
  readonly healthTable: TableClient;
  readonly seqCursor: number;
  readonly pagesFetched: number;
  readonly graphAttempts: number;
  readonly context: InvocationContext;
}

async function commitLicenceRequiredOutcome(
  args: CommitLicenceRequiredArgs,
): Promise<UserDormancyOutcome> {
  const endedAt = new Date().toISOString();
  const chainPrev = resolvePrevLineSha256(
    args.prevHealth.lastLineSha256,
    args.config.source,
    args.config.tenantId,
  );
  const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
    schemaVersion: 2,
    eventType: "ingest.run",
    source: args.config.source,
    seq: args.seqCursor,
    runId: args.runId,
    tenantId: args.config.tenantId,
    startedAt: args.startedAt,
    endedAt,
    status: "no_data",
    rowsWritten: 0,
    retentionRowsDeleted: 0,
    graphAttempts: args.graphAttempts,
    callerPrincipalMiClientId: args.config.ingestMiClientId,
    prevLineSha256: chainPrev,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);
  try {
    await commitStickyLicenceRequired(
      args.healthTable,
      args.prevHealth,
      args.runId,
      endedAt,
      args.seqCursor,
      lineSha256,
    );
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      args.context.warn(
        `userDormancy.ingest.lease_contended runId=${args.runId} during licence-required commit`,
      );
      return {
        runId: args.runId,
        status: "error",
        startedAt: args.startedAt,
        endedAt,
        durationMs: hrDurationMs(args.startHr),
        rowsWritten: 0,
        retentionRowsDeleted: 0,
        graphAttempts: args.graphAttempts,
        httpStatusFinal: 200,
        error: { kind: "lease_contended", message: err.message },
        usersIngested: 0,
        usersSkipped: 0,
        usersDeleted: 0,
        pagesFetched: args.pagesFetched,
        licenceState: "licence_required",
      };
    }
    throw err;
  }
  try {
    await appendAuditLine(
      {
        blobEndpoint: args.config.auditBlobEndpoint,
        auditContainerName: args.config.auditContainerName,
        managedIdentityClientId: args.config.auditMiClientId,
      },
      { ...lineWithoutHash, lineSha256 } as AuditLineFields,
    );
  } catch (auditErr) {
    args.context.error(
      `userDormancy.ingest.audit_write_failed runId=${args.runId} seq=${args.seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }
  emitAievent(args.context, "UserDormancyIngest", {
    tenantId: args.config.tenantId,
    source: args.config.source,
    status: "licence_required",
    runId: args.runId,
  });
  return {
    runId: args.runId,
    status: "no_data",
    startedAt: args.startedAt,
    endedAt,
    durationMs: hrDurationMs(args.startHr),
    rowsWritten: 0,
    retentionRowsDeleted: 0,
    graphAttempts: args.graphAttempts,
    httpStatusFinal: 200,
    usersIngested: 0,
    usersSkipped: 0,
    usersDeleted: 0,
    pagesFetched: args.pagesFetched,
    licenceState: "licence_required",
  };
}

function hrDurationMs(start: bigint): number {
  const diffNs = process.hrtime.bigint() - start;
  return Number(diffNs / 1_000_000n);
}
