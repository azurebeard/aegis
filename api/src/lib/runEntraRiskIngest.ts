// EntraRisk ingest orchestrator (ADR-0023 + ADR-0024 + ADR-0020 Step-6 amendment).
//
// Shape:
//   1.  Read IngestHealth row (creates on first run), capture ETag.
//   2.  Licence-probe branch (ADR-0023 §7):
//         - If Status === 'licence_required' AND !adminTrigger → short-circuit.
//         - If adminTrigger OR LastSuccessAt == null → probe `/organization`.
//           -> absent/disabled ⇒ Status := licence_required (sticky).
//           -> 403 on probe ⇒ error.kind = 'license_probe_failed'; no sticky.
//   3.  Read-clamp cursor if > now + 1h (same two-gate pattern as ADR-0014 §2).
//   4.  Fetch `/identityProtection/riskyUsers` paged on
//       `riskLastUpdatedDateTime ge <cursor - 2min>`, $top=500.
//   5.  Parse + upsert each row.
//   6.  cursorAfter = max(riskLastUpdatedDateTime) - overlapMs. Reject-if-future.
//   7.  Retention sweep (trim-at-write).
//   8.  Commit IngestHealth under IfMatch with new seq + lineSha256 + cursor.
//   9.  Append `ingest.run` audit line with EntraRisk-specific fields.
//
// Uses `graphClient.fetchRiskyUsersPaged` which sets the `Prefer:
// include-unknown-enum-members` header and sequentially paginates per
// ADR-0023 §8.

import type { InvocationContext } from "@azure/functions";
import type { TableClient } from "@azure/data-tables";
import { randomUUID } from "node:crypto";
import { emitAievent } from "./aievent.js";
import { appendAuditLine, type AuditLineFields } from "./audit.js";
import { computeLineSha256, resolvePrevLineSha256 } from "./auditChain.js";
import type { EntraRiskIngestConfig } from "./config.js";
import {
  extractOrganizationDirectory,
  fetchOrganizationAssignedPlans,
  fetchRiskyUsersPaged,
  GraphFetchError,
  hasEntraIdP2,
} from "./graphClient.js";
import { upsertTenantDirectory } from "./tenantDirectoryStore.js";
import {
  parseRiskyUsersPage,
  type RiskyUserDomain,
} from "./entraRiskParser.js";
import {
  commitHealthRow,
  commitStickyLicenceRequired,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import {
  ENTRA_RISK_TABLE_NAME,
  sweepExpiredRows,
  upsertRiskyUser,
} from "./entraRiskStore.js";
import { getTableClient, OPS_TABLES } from "./tables.js";
import type {
  EntraRiskIngestOutcome,
  EntraRiskLicenceState,
  IngestOutcome,
} from "./types.js";

export interface RunEntraRiskIngestOptions {
  /** `timer` (default) or `admin` — ADR-0024 §1.3 unconditionally re-probes
   * licence on admin trigger regardless of persisted Status. */
  readonly trigger?: "timer" | "admin";
}

export async function runEntraRiskIngestOnce(
  config: EntraRiskIngestConfig,
  context: InvocationContext,
  options: RunEntraRiskIngestOptions = {},
): Promise<EntraRiskIngestOutcome> {
  const trigger = options.trigger ?? "timer";
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startHr = process.hrtime.bigint();

  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);
  const entraRiskTable = getTableClient(tableCtx, ENTRA_RISK_TABLE_NAME);

  const prevHealth = await getOrInitHealthRow(healthTable, config.tenantId, config.source);
  let seqCursor = prevHealth.lastAuditSeq;

  // --- Step 2: licence probe branch ---------------------------------------
  // Sticky-state short-circuit — ADR-0023 §7 / WS10 SEC-M-ADR-23-03.
  if (prevHealth.status === "licence_required" && trigger !== "admin") {
    context.log(
      `entraRisk.ingest.short_circuit runId=${runId} status=licence_required trigger=${trigger} — ADR-0023 §7 sticky state`,
    );
    const endedAt = new Date().toISOString();
    return {
      runId,
      status: "no_data",
      startedAt,
      endedAt,
      durationMs: hrDurationMs(startHr),
      rowsWritten: 0,
      retentionRowsDeleted: 0,
      graphAttempts: 0,
      httpStatusFinal: null,
      licenceState: "licence_required",
      cursorBefore: prevHealth.lastCursor,
      cursorAfter: null,
      pagesFetched: 0,
      riskyUsersIngested: 0,
      riskyUsersSkipped: 0,
      riskyUsersProcessing: 0,
    };
  }

  let licenceState: EntraRiskLicenceState = "unknown";
  let licenceProbeFailed = false;
  const shouldProbe = trigger === "admin" || prevHealth.lastSuccessAt === null;
  if (shouldProbe) {
    try {
      const orgResult = await fetchOrganizationAssignedPlans(
        {
          managedIdentityClientId: config.ingestMiClientId,
          graphBaseUrl: config.graphBaseUrl,
          leaseWindowMs: config.leaseWindowMs,
          timeoutMs: config.graphApiTimeoutMs,
        },
        context,
      );
      const present = hasEntraIdP2(orgResult.data);
      licenceState = present ? "present" : "licence_required";
      emitCustomEvent(context, "EntraRiskLicenceProbe", {
        source: config.source,
        tenantId: config.tenantId,
        result: licenceState,
        trigger,
      });
      // Piggy-back on the licence probe: cache the tenant displayName into
      // TenantDirectory so the brief-agent prompt builder can render a human
      // name instead of a GUID. Agent MI has no Graph scopes (ADR-0017 §3),
      // so the name must be resolved ingest-side. Non-fatal — brief-agent
      // falls back to GUID if the row is missing.
      const directory = extractOrganizationDirectory(orgResult.data);
      if (directory) {
        try {
          const directoryTable = getTableClient(
            {
              endpoint: config.opsTableEndpoint,
              managedIdentityClientId: config.ingestMiClientId,
            },
            OPS_TABLES.TenantDirectory,
          );
          await upsertTenantDirectory(directoryTable, {
            tenantId: config.tenantId,
            displayName: directory.displayName,
            updatedAt: new Date().toISOString(),
          });
        } catch (dirErr) {
          context.warn(
            `tenantDirectory.upsert_failed runId=${runId} message=${String((dirErr as Error).message ?? dirErr)} — non-fatal, brief falls back to GUID`,
          );
        }
      }
    } catch (err) {
      if (err instanceof GraphFetchError && err.status === 403) {
        licenceProbeFailed = true;
        context.warn(
          `entraRisk.ingest.license_probe_403 runId=${runId} message=${err.message} — ADR-0023 §7 defence-in-depth: NOT marking licence_required on inconclusive probe`,
        );
      } else if (err instanceof GraphFetchError) {
        // Other Graph error — propagate to the fetch-error handling below.
        return await commitAndEmitFailure(
          {
            runId,
            startedAt,
            startHr,
            prevHealth,
            seqCursor: seqCursor + 1,
            config,
            context,
            healthTable,
            errorKind: err.kind,
            errorMessage: err.message,
            httpStatusFinal: err.status,
            cursorBefore: prevHealth.lastCursor,
            licenceState: "unknown",
            emitAudit: true,
          },
        );
      } else {
        throw err;
      }
    }
  } else {
    // Persisted-state path — not licence_required (handled above), so P2 is
    // present from a prior successful probe.
    licenceState = "present";
  }

  if (licenceProbeFailed) {
    return await commitAndEmitFailure({
      runId,
      startedAt,
      startHr,
      prevHealth,
      seqCursor: seqCursor + 1,
      config,
      context,
      healthTable,
      errorKind: "license_probe_failed",
      errorMessage: "/organization 403 — defence-in-depth: not marking licence_required",
      httpStatusFinal: 403,
      cursorBefore: prevHealth.lastCursor,
      licenceState: "unknown",
      emitAudit: true,
    });
  }

  if (licenceState === "licence_required") {
    // Sticky-set: commit IngestHealth.Status = 'licence_required' and write
    // an audit line for this probe observation. No Graph fetch, no cursor
    // advance.
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
      status: "no_data",
      rowsWritten: 0,
      retentionRowsDeleted: 0,
      graphAttempts: 0,
      cursorBefore: prevHealth.lastCursor || null,
      cursorAfter: null,
      pagesFetched: 0,
      riskyUsersIngested: 0,
      riskyUsersSkipped: 0,
      riskyUsersProcessing: 0,
      licenceState,
      callerPrincipalMiClientId: config.ingestMiClientId,
      prevLineSha256: chainPrev,
    };
    const lineSha256 = computeLineSha256(lineWithoutHash);
    try {
      await commitStickyLicenceRequired(
        healthTable,
        prevHealth,
        runId,
        endedAt,
        seqCursor,
        lineSha256,
      );
    } catch (err) {
      if (err instanceof LeaseContendedError) {
        context.warn(`entraRisk.ingest.lease_contended runId=${runId} during licence-required commit`);
        return {
          runId,
          status: "error",
          startedAt,
          endedAt,
          durationMs: hrDurationMs(startHr),
          rowsWritten: 0,
          retentionRowsDeleted: 0,
          graphAttempts: 0,
          httpStatusFinal: null,
          error: { kind: "lease_contended", message: err.message },
          cursorBefore: prevHealth.lastCursor,
          cursorAfter: null,
          pagesFetched: 0,
          riskyUsersIngested: 0,
          riskyUsersSkipped: 0,
          riskyUsersProcessing: 0,
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
        `entraRisk.ingest.audit_write_failed runId=${runId} seq=${seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
      );
      emitCustomEvent(context, "AuditWriteFailed", {
        source: config.source,
        tenantId: config.tenantId,
        seq: seqCursor,
        runId,
      });
      throw auditErr;
    }
    return {
      runId,
      status: "no_data",
      startedAt,
      endedAt,
      durationMs: hrDurationMs(startHr),
      rowsWritten: 0,
      retentionRowsDeleted: 0,
      graphAttempts: 0,
      httpStatusFinal: 200,
      cursorBefore: prevHealth.lastCursor,
      cursorAfter: null,
      pagesFetched: 0,
      riskyUsersIngested: 0,
      riskyUsersSkipped: 0,
      riskyUsersProcessing: 0,
      licenceState,
    };
  }

  // --- Step 3: cursor read-clamp ------------------------------------------
  const now = Date.now();
  const { effectiveCursor, clamped } = resolveCursor(prevHealth.lastCursor, config, now);
  if (clamped) {
    emitCustomEvent(context, "EntraRiskCursorCorrupt", {
      cursorRead: prevHealth.lastCursor,
      clampedTo: effectiveCursor,
      source: config.source,
      tenantId: config.tenantId,
    });
  }
  // Apply the 2-minute overlap to the filter value (the persisted cursor is
  // already `max - overlap`; subtract another overlap on send keeps the
  // overlap semantics explicit and survives a manual rewrite of the row).
  const filterCursorMs = Date.parse(effectiveCursor) - config.cursorOverlapMs;
  const filterCursorIso = new Date(
    Number.isFinite(filterCursorMs) ? filterCursorMs : now - config.firstRunSeedBackSeekMs,
  ).toISOString();

  let graphAttempts = 0;
  let pagesFetched = 0;
  let httpStatusFinal: number | null = null;
  let status: IngestOutcome["status"] = "error";
  type IngestErrorKind = NonNullable<IngestOutcome["error"]>["kind"];
  let errorKind: IngestErrorKind | null = null;
  let errorMessage: string | null = null;

  let riskyUsersIngested = 0;
  let riskyUsersSkipped = 0;
  let riskyUsersProcessing = 0;
  let maxRiskLastUpdatedDateTime: string | null = null;
  let retentionDeleted = 0;

  try {
    const pageResult = await fetchRiskyUsersPaged(
      {
        managedIdentityClientId: config.ingestMiClientId,
        graphBaseUrl: config.graphBaseUrl,
        leaseWindowMs: config.leaseWindowMs,
        timeoutMs: config.graphApiTimeoutMs,
      },
      { greaterThanOrEqual: filterCursorIso, pageSize: config.pageSize },
      context,
    );
    graphAttempts = pageResult.attempts;
    pagesFetched = pageResult.pagesFetched;
    httpStatusFinal = 200;

    for (const raw of pageResult.rawPages) {
      const ingestedAt = new Date().toISOString();
      const parsed = parseRiskyUsersPage(raw, { ingestedAt, ingestRunId: runId });
      for (const sample of parsed.unknownEnumSamples) {
        emitCustomEvent(context, "EntraRiskUnknownEnum", {
          source: config.source,
          field: sample.field,
          value: sample.value,
          userIdFirst32: sample.userId.slice(0, 32),
        });
      }
      riskyUsersSkipped += parsed.skipped.length;
      for (const skip of parsed.skipped) {
        context.warn(
          `entraRisk.ingest.row_skipped reason=${skip.reason} idFirst32=${skip.idFirst32}`,
        );
      }
      for (const row of parsed.entries) {
        await upsertRiskyUser(entraRiskTable, config.tenantId, row);
        riskyUsersIngested += 1;
        if (row.isProcessing) riskyUsersProcessing += 1;
        if (
          maxRiskLastUpdatedDateTime === null ||
          row.riskLastUpdatedDateTime > maxRiskLastUpdatedDateTime
        ) {
          maxRiskLastUpdatedDateTime = row.riskLastUpdatedDateTime;
        }
      }
    }

    if (maxRiskLastUpdatedDateTime !== null) {
      const maxMs = Date.parse(maxRiskLastUpdatedDateTime);
      if (!Number.isFinite(maxMs)) {
        throw new Error(
          `entraRisk.ingest.cursor_max_invalid value=${maxRiskLastUpdatedDateTime}`,
        );
      }
      const newCursorMs = maxMs - config.cursorOverlapMs;
      const writeSkewCutoff = Date.now() + config.cursorWriteSkewAllowanceMs;
      if (newCursorMs > writeSkewCutoff) {
        emitCustomEvent(context, "EntraRiskCursorRejected", {
          source: config.source,
          tenantId: config.tenantId,
          rejectedValue: new Date(newCursorMs).toISOString(),
          nowPlusAllowance: new Date(writeSkewCutoff).toISOString(),
        });
        errorKind = "cursor_rejected";
        errorMessage = `cursorAfter exceeds now + ${config.cursorWriteSkewAllowanceMs}ms`;
        status = "error";
      } else {
        status = "success";
      }
    } else {
      status = "success";
    }

    if (status === "success") {
      const retentionCutoff = new Date(
        Date.now() - config.entraRiskRetentionDays * 86_400_000,
      );
      retentionDeleted = await sweepExpiredRows(
        entraRiskTable,
        config.tenantId,
        retentionCutoff,
      );
    }
  } catch (err) {
    if (err instanceof GraphFetchError) {
      errorKind = err.kind;
      errorMessage = err.message;
      httpStatusFinal = err.status;
    } else {
      errorKind = "internal";
      errorMessage = String((err as Error).message ?? err);
    }
    context.error(`entraRisk.ingest.error kind=${errorKind} message=${errorMessage}`);
    status = "error";
  }

  // --- Commit + audit -----------------------------------------------------
  seqCursor += 1;
  const endedAt = new Date().toISOString();
  const cursorAfterForAudit =
    status === "success" && maxRiskLastUpdatedDateTime !== null
      ? new Date(Date.parse(maxRiskLastUpdatedDateTime) - config.cursorOverlapMs).toISOString()
      : null;

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
    status,
    rowsWritten: riskyUsersIngested,
    retentionRowsDeleted: retentionDeleted,
    graphAttempts,
    cursorBefore: effectiveCursor || null,
    cursorAfter: cursorAfterForAudit,
    pagesFetched,
    riskyUsersIngested,
    riskyUsersSkipped,
    riskyUsersProcessing,
    licenceState,
    callerPrincipalMiClientId: config.ingestMiClientId,
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage.slice(0, 2000) } }
      : {}),
    prevLineSha256: chainPrev,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);

  try {
    await commitHealthRow(healthTable, prevHealth, {
      outcome: status === "error" ? "error" : "success",
      runId,
      now: endedAt,
      auditSeq: seqCursor,
      lineSha256,
      ...(status === "success" && cursorAfterForAudit
        ? { cursor: cursorAfterForAudit }
        : {}),
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      context.warn(
        `entraRisk.ingest.lease_contended runId=${runId} — another instance committed first`,
      );
      return {
        runId,
        status: "error",
        startedAt,
        endedAt,
        durationMs: hrDurationMs(startHr),
        rowsWritten: riskyUsersIngested,
        retentionRowsDeleted: retentionDeleted,
        graphAttempts,
        httpStatusFinal,
        error: { kind: "lease_contended", message: err.message },
        cursorBefore: effectiveCursor,
        cursorAfter: null,
        pagesFetched,
        riskyUsersIngested,
        riskyUsersSkipped,
        riskyUsersProcessing,
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
      `entraRisk.ingest.audit_write_failed runId=${runId} seq=${seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    emitCustomEvent(context, "AuditWriteFailed", {
      source: config.source,
      tenantId: config.tenantId,
      seq: seqCursor,
      runId,
    });
    throw auditErr;
  }

  const outcome: EntraRiskIngestOutcome = {
    runId,
    status,
    startedAt,
    endedAt,
    durationMs: hrDurationMs(startHr),
    rowsWritten: riskyUsersIngested,
    retentionRowsDeleted: retentionDeleted,
    graphAttempts,
    httpStatusFinal,
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage } }
      : {}),
    cursorBefore: effectiveCursor,
    cursorAfter: cursorAfterForAudit,
    pagesFetched,
    riskyUsersIngested,
    riskyUsersSkipped,
    riskyUsersProcessing,
    licenceState,
  };

  context.log(
    `entraRisk.ingest.run runId=${runId} trigger=${trigger} status=${status} durationMs=${outcome.durationMs} riskyUsersIngested=${riskyUsersIngested} riskyUsersSkipped=${riskyUsersSkipped} riskyUsersProcessing=${riskyUsersProcessing} licenceState=${licenceState} pagesFetched=${pagesFetched}`,
  );
  return outcome;
}

// --- Helpers ----------------------------------------------------------------

function resolveCursor(
  stored: string,
  config: EntraRiskIngestConfig,
  now: number,
): { effectiveCursor: string; clamped: boolean } {
  if (!stored) {
    const retentionMs = config.entraRiskRetentionDays * 86_400_000;
    const seek = Math.min(config.firstRunSeedBackSeekMs, retentionMs);
    return { effectiveCursor: new Date(now - seek).toISOString(), clamped: false };
  }
  const storedMs = Date.parse(stored);
  if (!Number.isFinite(storedMs)) {
    return {
      effectiveCursor: new Date(now - config.firstRunSeedBackSeekMs).toISOString(),
      clamped: true,
    };
  }
  if (storedMs > now + config.cursorReadCorruptThresholdMs) {
    return {
      effectiveCursor: new Date(now - config.firstRunSeedBackSeekMs).toISOString(),
      clamped: true,
    };
  }
  return { effectiveCursor: stored, clamped: false };
}

interface CommitAndEmitFailureInput {
  readonly runId: string;
  readonly startedAt: string;
  readonly startHr: bigint;
  readonly prevHealth: Awaited<ReturnType<typeof getOrInitHealthRow>>;
  readonly seqCursor: number;
  readonly config: EntraRiskIngestConfig;
  readonly context: InvocationContext;
  readonly healthTable: TableClient;
  readonly errorKind: NonNullable<IngestOutcome["error"]>["kind"];
  readonly errorMessage: string;
  readonly httpStatusFinal: number | null;
  readonly cursorBefore: string | null;
  readonly licenceState: EntraRiskLicenceState;
  readonly emitAudit: boolean;
}

async function commitAndEmitFailure(
  input: CommitAndEmitFailureInput,
): Promise<EntraRiskIngestOutcome> {
  const { runId, startedAt, startHr, prevHealth, seqCursor, config, context } = input;
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
    status: "error",
    rowsWritten: 0,
    retentionRowsDeleted: 0,
    graphAttempts: 0,
    cursorBefore: input.cursorBefore,
    cursorAfter: null,
    pagesFetched: 0,
    riskyUsersIngested: 0,
    riskyUsersSkipped: 0,
    riskyUsersProcessing: 0,
    licenceState: input.licenceState,
    callerPrincipalMiClientId: config.ingestMiClientId,
    error: { kind: input.errorKind, message: input.errorMessage.slice(0, 2000) },
    prevLineSha256: chainPrev,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);
  try {
    await commitHealthRow(input.healthTable, prevHealth, {
      outcome: "error",
      runId,
      now: endedAt,
      auditSeq: seqCursor,
      lineSha256,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      context.warn(
        `entraRisk.ingest.lease_contended runId=${runId} during failure commit`,
      );
    } else {
      throw err;
    }
  }
  if (input.emitAudit) {
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
        `entraRisk.ingest.audit_write_failed runId=${runId} seq=${seqCursor} message=${String((auditErr as Error).message ?? auditErr)}`,
      );
    }
  }
  return {
    runId,
    status: "error",
    startedAt,
    endedAt,
    durationMs: hrDurationMs(startHr),
    rowsWritten: 0,
    retentionRowsDeleted: 0,
    graphAttempts: 0,
    httpStatusFinal: input.httpStatusFinal,
    error: { kind: input.errorKind, message: input.errorMessage },
    cursorBefore: input.cursorBefore,
    cursorAfter: null,
    pagesFetched: 0,
    riskyUsersIngested: 0,
    riskyUsersSkipped: 0,
    riskyUsersProcessing: 0,
    licenceState: input.licenceState,
  };
}

export function emitCustomEvent(
  context: InvocationContext,
  name: string,
  properties: Record<string, unknown>,
): void {
  // Thin wrapper kept at the original call-site signature; routes through
  // the centralised AIEVENT helper for both FunctionAppLogs grep + App
  // Insights customEvents.
  emitAievent(context, name, properties);
}

function hrDurationMs(start: bigint): number {
  const diffNs = process.hrtime.bigint() - start;
  return Number(diffNs / 1_000_000n);
}

// Re-export the domain type so handlers can annotate without circular imports.
export type { RiskyUserDomain };
