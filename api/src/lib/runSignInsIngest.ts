// ADR-0034 §1, §3.2, §6 — Sign-ins ingest orchestrator.
//
// Flow:
//   1. Read IngestHealth (locks ETag).
//   2. Short-circuit if Status === 'licence_required' AND trigger !== 'admin'.
//   3. Read geo-fence policy from TenantSettings (drives OutOfArea computation).
//   4. Resolve cursor (last successful CreatedDateTime - cursorOverlapMs);
//      first run: now - firstRunSeedBackSeekMs.
//   5. Walk /v1.0/auditLogs/signIns?$filter=createdDateTime gt {cursor}
//      &$orderby=createdDateTime asc (paged via @odata.nextLink).
//   6. Parse each row + compute OutOfArea against the policy; upsert.
//   7. Trim retention (delete rows older than retentionDays).
//   8. Commit IngestHealth with IfMatch + new cursor (max CreatedDateTime
//      observed - cursorOverlapMs); allocates next audit seq.
//   9. Append one ingest.run audit line.
//
// Mirrors ADR-0014 incidents pattern for the cursor + page semantics.
// Mirrors ADR-0023 §7 sticky `licence_required` posture: 403 on first
// fire → sticky-set; subsequent timer fires short-circuit without a
// Graph call until an admin re-probes.

import type { InvocationContext } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { appendAuditLine, type AuditLineFields } from "./audit.js";
import { computeLineSha256, resolvePrevLineSha256 } from "./auditChain.js";
import type { SignInsIngestConfig } from "./config.js";
import {
  fetchSignInsPaged,
  GraphFetchError,
  type SignInsPagedResult,
} from "./graphClient.js";
import {
  commitHealthRow,
  commitStickyLicenceRequired,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import {
  parseSignInsPages,
  type GeoFencePolicy,
} from "./signInsParser.js";
import {
  trimSignInsRetention,
  upsertSignIn,
  SIGN_INS_TABLE_NAME,
} from "./signInsStore.js";
import { readGeoFencePolicy } from "./tenantSettingsStore.js";
import { getTableClient, OPS_TABLES } from "./tables.js";
import { emitAievent } from "./aievent.js";
import type { IngestOutcome } from "./types.js";
import type { TableClient } from "@azure/data-tables";

export type SignInsTrigger = "timer" | "admin";

export interface SignInsOutcome extends IngestOutcome {
  readonly signInsIngested: number;
  readonly signInsSkipped: number;
  readonly signInsRetentionDeleted: number;
  readonly outOfAreaCount: number;
  readonly pagesFetched: number;
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  readonly licenceState: "present" | "licence_required" | "unknown";
}

function hrDurationMs(start: bigint): number {
  const diffNs = process.hrtime.bigint() - start;
  return Number(diffNs / 1_000_000n);
}

function policyFromSettings(
  raw: Awaited<ReturnType<typeof readGeoFencePolicy>>,
): GeoFencePolicy {
  return {
    enabled: raw.enabled,
    allowedCountries: raw.allowedCountries,
    unknownLocationPolicy: raw.unknownLocationPolicy,
  };
}

function resolveCursor(
  config: SignInsIngestConfig,
  prevCursor: string,
  now: Date,
): string {
  if (prevCursor === "") {
    // First-ever run — seed back by firstRunSeedBackSeekMs (default 1h)
    // so we don't try to ingest the entire tenant's sign-in history.
    return new Date(now.getTime() - config.firstRunSeedBackSeekMs).toISOString();
  }
  // Apply 2-min overlap (cursorOverlapMs) — mirrors ADR-0014 §2 semantics.
  const cursorMs = Date.parse(prevCursor);
  if (!Number.isFinite(cursorMs)) {
    // Corrupt cursor — fall back to first-run seed.
    return new Date(now.getTime() - config.firstRunSeedBackSeekMs).toISOString();
  }
  // Cursor sanity: reject anything > now + writeSkewAllowance OR > now + readCorruptThreshold.
  if (cursorMs > now.getTime() + config.cursorReadCorruptThresholdMs) {
    return new Date(now.getTime() - config.firstRunSeedBackSeekMs).toISOString();
  }
  return new Date(cursorMs - config.cursorOverlapMs).toISOString();
}

function nextCursorFrom(
  rows: ReadonlyArray<{ readonly createdDateTime: string }>,
  config: SignInsIngestConfig,
  fallback: string,
): string {
  if (rows.length === 0) return fallback;
  let max = rows[0]!.createdDateTime;
  for (const r of rows) {
    if (r.createdDateTime > max) max = r.createdDateTime;
  }
  // Subtract overlap so the next run picks up any rows whose
  // createdDateTime is at-or-near our max (handles clock-skew + delivery
  // ordering inversions per ADR-0014 §2).
  const ms = Date.parse(max);
  if (!Number.isFinite(ms)) return fallback;
  return new Date(ms - config.cursorOverlapMs).toISOString();
}

export async function runSignInsIngestOnce(
  config: SignInsIngestConfig,
  context: InvocationContext,
  options: { readonly trigger?: SignInsTrigger } = {},
): Promise<SignInsOutcome> {
  const trigger = options.trigger ?? "timer";
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();
  const now = new Date();

  const ingestTables = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const healthTable = getTableClient(ingestTables, OPS_TABLES.IngestHealth);
  const signInsTable = getTableClient(ingestTables, SIGN_INS_TABLE_NAME);
  const settingsTable = getTableClient(ingestTables, OPS_TABLES.TenantSettings);

  const prevHealth = await getOrInitHealthRow(
    healthTable,
    config.tenantId,
    config.source,
  );
  let seqCursor = prevHealth.lastAuditSeq;

  if (prevHealth.status === "licence_required" && trigger !== "admin") {
    context.log(
      `signIns.ingest.short_circuit runId=${runId} status=licence_required trigger=${trigger} — ADR-0034 §6 sticky state`,
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
      signInsIngested: 0,
      signInsSkipped: 0,
      signInsRetentionDeleted: 0,
      outOfAreaCount: 0,
      pagesFetched: 0,
      cursorBefore: prevHealth.lastCursor || null,
      cursorAfter: null,
      licenceState: "licence_required",
    };
  }

  const geoFenceRecord = await readGeoFencePolicy(settingsTable, config.tenantId);
  const policy = policyFromSettings(geoFenceRecord);
  const cursor = resolveCursor(config, prevHealth.lastCursor, now);

  // --- Graph fetch ----------------------------------------------------------

  let pageResult: SignInsPagedResult | null = null;
  let errorKind: NonNullable<IngestOutcome["error"]>["kind"] | null = null;
  let errorMessage: string | null = null;
  let httpStatusFinal: number | null = null;
  try {
    pageResult = await fetchSignInsPaged(
      {
        managedIdentityClientId: config.ingestMiClientId,
        graphBaseUrl: config.graphBaseUrl,
        leaseWindowMs: config.leaseWindowMs,
        timeoutMs: config.graphApiTimeoutMs,
      },
      { greaterThanOrEqual: cursor, pageSize: config.pageSize },
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
      `signIns.ingest.error runId=${runId} kind=${errorKind} message=${errorMessage}`,
    );
  }

  const graphAttempts = pageResult?.attempts ?? 0;
  const pagesFetched = pageResult?.pagesFetched ?? 0;

  // 403 on first sign-ins fetch → tenant lacks Entra ID P1. Sticky-set.
  // Per ADR-0034 §6 — only on `4xx` errorKind matching the licence message.
  const looksLikeLicenceFailure =
    errorKind === "4xx" &&
    httpStatusFinal === 403 &&
    typeof errorMessage === "string" &&
    /premium|licence|license/i.test(errorMessage);
  if (looksLikeLicenceFailure) {
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
      cursorBefore: prevHealth.lastCursor || null,
      context,
    });
  }

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
      pagesFetched,
      cursorBefore: prevHealth.lastCursor || null,
      context,
    });
  }

  // --- Parse + upsert -------------------------------------------------------

  const parsed = parseSignInsPages(pageResult?.rawPages ?? [], {
    ingestedAt: new Date().toISOString(),
    ingestRunId: runId,
    policy,
  });

  for (const row of parsed.rows) {
    await upsertSignIn(signInsTable, config.tenantId, row);
  }

  // --- Retention trim -------------------------------------------------------

  const retentionDeleted = await trimSignInsRetention(
    signInsTable,
    config.tenantId,
    config.retentionDays,
    now,
  );

  // --- Commit IngestHealth + audit line ------------------------------------

  const cursorAfter = nextCursorFrom(parsed.rows, config, prevHealth.lastCursor);
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
    status: parsed.rows.length > 0 ? "success" : "no_data",
    rowsWritten: parsed.rows.length,
    retentionRowsDeleted: retentionDeleted,
    graphAttempts,
    callerPrincipalMiClientId: config.ingestMiClientId,
    cursorBefore: prevHealth.lastCursor || null,
    cursorAfter,
    pagesFetched,
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
      cursor: cursorAfter,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      context.warn(
        `signIns.ingest.lease_contended runId=${runId} — another instance committed first; aborting without audit write.`,
      );
      return {
        runId,
        status: "error",
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: hrDurationMs(startHr),
        rowsWritten: parsed.rows.length,
        retentionRowsDeleted: retentionDeleted,
        graphAttempts,
        httpStatusFinal,
        error: { kind: "lease_contended", message: err.message },
        signInsIngested: parsed.rows.length,
        signInsSkipped: parsed.skippedMalformed,
        signInsRetentionDeleted: retentionDeleted,
        outOfAreaCount: parsed.outOfAreaCount,
        pagesFetched,
        cursorBefore: prevHealth.lastCursor || null,
        cursorAfter,
        licenceState: "present",
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
      `signIns.ingest.audit_write_failed runId=${runId} seq=${seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }

  emitAievent(context, "SignInsIngest", {
    tenantId: config.tenantId,
    source: config.source,
    status: parsed.rows.length > 0 ? "success" : "no_data",
    signInsIngested: parsed.rows.length,
    signInsSkipped: parsed.skippedMalformed,
    signInsRetentionDeleted: retentionDeleted,
    outOfAreaCount: parsed.outOfAreaCount,
    pagesFetched,
    graphAttempts,
    runId,
  });

  context.log(
    `signIns.ingest.run runId=${runId} status=${parsed.rows.length > 0 ? "success" : "no_data"} durationMs=${hrDurationMs(startHr)} rowsWritten=${parsed.rows.length} outOfArea=${parsed.outOfAreaCount} retentionDeleted=${retentionDeleted} pagesFetched=${pagesFetched} graphAttempts=${graphAttempts}`,
  );

  return {
    runId,
    status: parsed.rows.length > 0 ? "success" : "no_data",
    startedAt,
    endedAt,
    durationMs: hrDurationMs(startHr),
    rowsWritten: parsed.rows.length,
    retentionRowsDeleted: retentionDeleted,
    graphAttempts,
    httpStatusFinal,
    signInsIngested: parsed.rows.length,
    signInsSkipped: parsed.skippedMalformed,
    signInsRetentionDeleted: retentionDeleted,
    outOfAreaCount: parsed.outOfAreaCount,
    pagesFetched,
    cursorBefore: prevHealth.lastCursor || null,
    cursorAfter,
    licenceState: "present",
  };
}

interface CommitErrorArgs {
  readonly runId: string;
  readonly startedAt: string;
  readonly startHr: bigint;
  readonly config: SignInsIngestConfig;
  readonly prevHealth: Awaited<ReturnType<typeof getOrInitHealthRow>>;
  readonly healthTable: TableClient;
  readonly seqCursor: number;
  readonly errorKind: NonNullable<IngestOutcome["error"]>["kind"];
  readonly errorMessage: string;
  readonly httpStatusFinal: number | null;
  readonly graphAttempts: number;
  readonly pagesFetched: number;
  readonly cursorBefore: string | null;
  readonly context: InvocationContext;
}

async function commitErrorOutcome(
  args: CommitErrorArgs,
): Promise<SignInsOutcome> {
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
    cursorBefore: args.cursorBefore,
    cursorAfter: null,
    pagesFetched: args.pagesFetched,
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
        `signIns.ingest.lease_contended runId=${args.runId} during error commit`,
      );
      return baseErrorOutcome(args, endedAt, "lease_contended", err.message);
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
      `signIns.ingest.audit_write_failed runId=${args.runId} seq=${args.seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }
  emitAievent(args.context, "SignInsIngest", {
    tenantId: args.config.tenantId,
    source: args.config.source,
    status: "error",
    errorKind: args.errorKind,
    runId: args.runId,
  });
  return baseErrorOutcome(args, endedAt, args.errorKind, args.errorMessage);
}

function baseErrorOutcome(
  args: CommitErrorArgs,
  endedAt: string,
  errorKind: NonNullable<IngestOutcome["error"]>["kind"],
  errorMessage: string,
): SignInsOutcome {
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
    error: { kind: errorKind, message: errorMessage },
    signInsIngested: 0,
    signInsSkipped: 0,
    signInsRetentionDeleted: 0,
    outOfAreaCount: 0,
    pagesFetched: args.pagesFetched,
    cursorBefore: args.cursorBefore,
    cursorAfter: null,
    licenceState: "unknown",
  };
}

interface CommitLicenceArgs {
  readonly runId: string;
  readonly startedAt: string;
  readonly startHr: bigint;
  readonly config: SignInsIngestConfig;
  readonly prevHealth: Awaited<ReturnType<typeof getOrInitHealthRow>>;
  readonly healthTable: TableClient;
  readonly seqCursor: number;
  readonly pagesFetched: number;
  readonly graphAttempts: number;
  readonly cursorBefore: string | null;
  readonly context: InvocationContext;
}

async function commitLicenceRequiredOutcome(
  args: CommitLicenceArgs,
): Promise<SignInsOutcome> {
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
    cursorBefore: args.cursorBefore,
    cursorAfter: null,
    pagesFetched: args.pagesFetched,
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
        `signIns.ingest.lease_contended runId=${args.runId} during licence-required commit`,
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
        httpStatusFinal: 403,
        error: { kind: "lease_contended", message: err.message },
        signInsIngested: 0,
        signInsSkipped: 0,
        signInsRetentionDeleted: 0,
        outOfAreaCount: 0,
        pagesFetched: args.pagesFetched,
        cursorBefore: args.cursorBefore,
        cursorAfter: null,
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
      `signIns.ingest.audit_write_failed runId=${args.runId} seq=${args.seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }
  emitAievent(args.context, "SignInsIngest", {
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
    httpStatusFinal: 403,
    signInsIngested: 0,
    signInsSkipped: 0,
    signInsRetentionDeleted: 0,
    outOfAreaCount: 0,
    pagesFetched: args.pagesFetched,
    cursorBefore: args.cursorBefore,
    cursorAfter: null,
    licenceState: "licence_required",
  };
}

