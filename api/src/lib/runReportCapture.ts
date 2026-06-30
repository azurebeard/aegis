// ADR-0030 Phase B — extracted capture-core for report snapshots.
//
// Both the HTTP handler (admin-clicked capture) and the daily auto-capture
// Timer route through this function. Single source of truth for:
//   - period derivation (explicit key OR current-period for the cadence)
//   - skip-if-already-captured logic (Timer: idempotent; HTTP: opt-in)
//   - lease-then-write-then-audit ordering (mirrors runSecureScoreIngest)
//   - audit-line construction with prevLineSha256 + lineSha256 chain
//
// `capturedBy` is the only field that changes between callers — HTTP uses
// `principal.userId`, the Timer uses `"system.timer"` so the audit chain
// can distinguish operator captures from automation.

import { randomUUID } from "node:crypto";
import { appendAuditLine, type AuditLineFields } from "./audit.js";
import { computeLineSha256, resolvePrevLineSha256 } from "./auditChain.js";
import {
  type IngestConfig,
  type ReportSnapshotConfig,
} from "./config.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import { assembleLiveEnvelope } from "./reportEnvelope.js";
import {
  encodeEnvelope,
  EnvelopeTooLargeError,
  insertSnapshot,
  listVersionsForPeriod,
  trimVersionsForPeriod,
} from "./reportSnapshotStore.js";
import {
  periodForCadence,
  periodFromKey,
  type PeriodBounds,
  type ReportCadence,
} from "./reportPeriod.js";
import { getTableClient, OPS_TABLES } from "./tables.js";

export type RunReportCaptureStatus =
  | "success"
  | "error"
  | "size_exceeded"
  | "skipped_already_captured"
  | "lease_contended"
  | "invalid_period";

export interface RunReportCaptureArgs {
  readonly cadence: ReportCadence;
  /** Omit / null → server derives the current period for the cadence. */
  readonly explicitPeriodKey?: string | null;
  /** "principal.userId" for HTTP captures, "system.timer" for the Timer. */
  readonly capturedBy: string;
  /**
   * When true, abort with `skipped_already_captured` if any version already
   * exists for the resolved period. The Timer uses this to make daily
   * fires idempotent — only the first fire after a period rollover writes.
   * The HTTP handler leaves it false to allow operator-driven re-captures
   * (which produce v2, v3, …).
   */
  readonly skipIfPeriodHasVersions?: boolean;
  /** Optional operator note — already validated + sanitised by the
   *  caller (length-cap + control-char-strip). Embedded into the
   *  envelope at capture time; the renderer surfaces it as a callout
   *  under the executive summary. */
  readonly operatorNote?: string;
  readonly ingestConfig: IngestConfig;
  readonly reportConfig: ReportSnapshotConfig;
  /** Logger surface — the Timer passes its InvocationContext, the HTTP
   *  handler also passes its InvocationContext. Anything with `.log` /
   *  `.warn` / `.error` works. */
  readonly logger: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface RunReportCaptureResult {
  readonly status: RunReportCaptureStatus;
  readonly periodKey: string;
  readonly cadence: ReportCadence;
  /** `0` when the run did not write a row (skipped / invalid_period / contended). */
  readonly version: number;
  readonly capturedAt: string;
  readonly retentionRowsDeleted: number;
  readonly envelopeBytes: number;
  readonly trimmedVersions: readonly number[];
  readonly runId: string;
  readonly errorKind?: string;
  readonly errorMessage?: string;
  /** When `status === "skipped_already_captured"`, the existing version
   *  count for the period (≥ 1). */
  readonly existingVersions?: number;
}

/**
 * Capture a single snapshot. Caller-agnostic — callers map the result to
 * their own response shape (HTTP status / Timer log line + AIEVENT).
 *
 * No state is mutated when status is `invalid_period` or
 * `skipped_already_captured` — the IngestHealth lease is not even taken.
 * `lease_contended` is also a write-no-op (audit line is NOT appended).
 * Any other status (`success`, `size_exceeded`, `error`) emits exactly
 * one audit line per invocation.
 */
export async function runReportCaptureOnce(
  args: RunReportCaptureArgs,
): Promise<RunReportCaptureResult> {
  const period: PeriodBounds | null =
    args.explicitPeriodKey === null || args.explicitPeriodKey === undefined
      ? periodForCadence(args.cadence)
      : periodFromKey(args.cadence, args.explicitPeriodKey);
  if (!period) {
    return {
      status: "invalid_period",
      periodKey: args.explicitPeriodKey ?? "",
      cadence: args.cadence,
      version: 0,
      capturedAt: new Date().toISOString(),
      retentionRowsDeleted: 0,
      envelopeBytes: 0,
      trimmedVersions: [],
      runId: "",
      errorKind: "invalid_period",
      errorMessage: `periodKey ${args.explicitPeriodKey} is invalid for cadence=${args.cadence}`,
    };
  }

  const ingestCtx = {
    endpoint: args.ingestConfig.opsTableEndpoint,
    managedIdentityClientId: args.ingestConfig.ingestMiClientId,
  };
  const reportTable = getTableClient(ingestCtx, OPS_TABLES.ReportSnapshots);
  const healthTable = getTableClient(ingestCtx, OPS_TABLES.IngestHealth);

  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // Skip-if-exists for the Timer path. Reading versions BEFORE taking the
  // lease is safe because both Timer and HTTP paths converge on the
  // commitHealthRow IfMatch — a race-loss there returns lease_contended.
  const existing = await listVersionsForPeriod(
    reportTable,
    args.ingestConfig.tenantId,
    period.periodKey,
  );
  if (args.skipIfPeriodHasVersions && existing.length > 0) {
    return {
      status: "skipped_already_captured",
      periodKey: period.periodKey,
      cadence: period.cadence,
      version: 0,
      capturedAt: startedAt,
      retentionRowsDeleted: 0,
      envelopeBytes: 0,
      trimmedVersions: [],
      runId: "",
      existingVersions: existing.length,
    };
  }

  // Lease the chain head before any write.
  const prevHealth = await getOrInitHealthRow(
    healthTable,
    args.ingestConfig.tenantId,
    args.reportConfig.source,
  );
  const nextSeq = prevHealth.lastAuditSeq + 1;

  let status: "success" | "error" | "size_exceeded" = "error";
  let version = 0;
  let envelopeBytes = 0;
  let trimmedVersions: number[] = [];
  let errorMessage: string | null = null;
  let errorKind: string | null = null;

  try {
    const usedVersions = new Set(existing.map((e) => e.Version));
    version = 1;
    while (usedVersions.has(version)) version++;

    const capturedAt = new Date().toISOString();
    const envelope = await assembleLiveEnvelope({
      tenantId: args.ingestConfig.tenantId,
      capturedBy: args.capturedBy,
      version,
      capturedAt,
      period,
      captureRunId: runId,
      ...(args.operatorNote ? { operatorNote: args.operatorNote } : {}),
    });

    let encoded;
    try {
      encoded = encodeEnvelope(envelope);
    } catch (err) {
      if (err instanceof EnvelopeTooLargeError) {
        status = "size_exceeded";
        envelopeBytes = err.compressedBytes;
        errorKind = "envelope_too_large";
        errorMessage = err.message;
      } else {
        throw err;
      }
    }

    if (encoded) {
      envelopeBytes = encoded.compressedBytes;
      await insertSnapshot(reportTable, {
        tenantId: args.ingestConfig.tenantId,
        envelope,
        encoded,
      });
      const trimmed = await trimVersionsForPeriod(
        reportTable,
        args.ingestConfig.tenantId,
        period.periodKey,
        args.reportConfig.versionsPerPeriod,
      );
      trimmedVersions = trimmed.map((e) => e.Version).sort((a, b) => a - b);
      status = "success";
    }
  } catch (err) {
    errorKind = "internal";
    errorMessage = String((err as Error).message ?? err);
    args.logger.error(`report.capture.error runId=${runId} ${errorMessage}`);
    status = "error";
  }

  const endedAt = new Date().toISOString();
  const prevLineSha256 = resolvePrevLineSha256(
    prevHealth.lastLineSha256,
    args.reportConfig.source,
    args.ingestConfig.tenantId,
  );
  const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
    schemaVersion: 2,
    eventType: "audit.report.capture",
    source: args.reportConfig.source,
    seq: nextSeq,
    runId,
    tenantId: args.ingestConfig.tenantId,
    startedAt,
    endedAt,
    status,
    periodKey: period.periodKey,
    cadence: period.cadence,
    capturedBy: args.capturedBy,
    version,
    envelopeBytes,
    contentType: "application/json",
    retentionRowsDeleted: trimmedVersions.length,
    ...(trimmedVersions.length > 0 ? { trimmedVersions } : {}),
    callerPrincipalMiClientId: args.ingestConfig.ingestMiClientId,
    ...(errorKind && errorMessage
      ? { error: { kind: errorKind, message: errorMessage.slice(0, 2000) } }
      : {}),
    prevLineSha256,
  };
  const lineSha256 = computeLineSha256(lineWithoutHash);

  // Commit IngestHealth under IfMatch — single-winner serialisation.
  try {
    await commitHealthRow(healthTable, prevHealth, {
      outcome: status === "success" ? "success" : "error",
      runId,
      now: endedAt,
      auditSeq: nextSeq,
      lineSha256,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      args.logger.warn(
        `report.capture.lease_contended runId=${runId} — another capture committed first; aborting without audit write.`,
      );
      return {
        status: "lease_contended",
        periodKey: period.periodKey,
        cadence: period.cadence,
        version: 0,
        capturedAt: endedAt,
        retentionRowsDeleted: 0,
        envelopeBytes: 0,
        trimmedVersions: [],
        runId,
      };
    }
    throw err;
  }

  // Audit append. Failures here leave a gap visible to the chain verifier;
  // the state-changing inserts above are NOT rolled back (matches ADR-0011
  // §7 / runSecureScoreIngest.ts).
  try {
    await appendAuditLine(
      {
        blobEndpoint: args.ingestConfig.auditBlobEndpoint,
        auditContainerName: args.ingestConfig.auditContainerName,
        managedIdentityClientId: args.ingestConfig.auditMiClientId,
      },
      { ...lineWithoutHash, lineSha256 } as AuditLineFields,
    );
  } catch (auditErr) {
    args.logger.error(
      `report.capture.audit_write_failed runId=${runId} seq=${nextSeq} message=${String((auditErr as Error).message ?? auditErr)}`,
    );
    throw auditErr;
  }

  return {
    status,
    periodKey: period.periodKey,
    cadence: period.cadence,
    version: status === "success" ? version : 0,
    capturedAt: endedAt,
    retentionRowsDeleted: trimmedVersions.length,
    envelopeBytes,
    trimmedVersions,
    runId,
    ...(errorKind && errorMessage
      ? { errorKind, errorMessage: errorMessage.slice(0, 2000) }
      : {}),
  };
}
