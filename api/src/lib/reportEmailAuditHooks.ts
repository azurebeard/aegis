// ADR-0030 Phase C §C.7 — audit-chain + send-history wiring for the
// `reportEmail.ts` orchestrator. Slice 1(c)/A — factored out of the HTTP
// handler so unit tests can drive it independently of HTTP context.
//
// Two audit chains:
//   source="report.email.intent"  — one line per send (pre-send fingerprint).
//   source="report.email.sent"    — outcome (success / failure variant).
//
// The intent line's `seq` is carried forward as `intentLineSeq` on the
// outcome line so chain readers can pair them on (periodKey, intentLineSeq).
// Unpaired intent → "phantom send"; admin reconciles via Exchange message
// trace using the `internetMessageId`.

import { randomUUID } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import { appendAuditLine, type AuditContext, type AuditLineFields } from "./audit.js";
import {
  computeLineSha256,
  resolvePrevLineSha256,
} from "./auditChain.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";
import type { IngestHealthRow } from "./types.js";
import { upsertReportEmailSend } from "./tenantSettingsStore.js";
import type {
  IntentAuditEvent,
  SentAuditEvent,
  FailedAuditEvent,
  SendHistoryRow,
  SendReportEmailHooks,
} from "./reportEmail.js";

export const INTENT_SOURCE = "report.email.intent";
export const SENT_SOURCE = "report.email.sent"; // hosts both sent + failed variants

export interface ReportEmailAuditDeps {
  /** Table client over `IngestHealth` (audit chain head storage). MUST be
   *  authenticated as the AUDIT MI (the only principal with append on the
   *  audit container — same as every other source). */
  readonly healthTable: TableClient;
  /** Table client over `TenantSettings`. MUST be authenticated as the
   *  mailSender MI; only that MI has Storage Table Data Contributor scoped
   *  to TenantSettings (§C.9 Bicep grant). */
  readonly tenantSettingsTable: TableClient;
  /** Audit blob append context (same shape as every other ingest run). */
  readonly auditCtx: AuditContext;
  /** Logger / context — passed through for warn/error breadcrumbs. */
  readonly logger: {
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/**
 * Build the four orchestrator hooks. State shared across them — the intent
 * line's `seq` becomes the outcome line's `intentLineSeq` back-reference, and
 * the outcome line's `seq` + `lineSha256` are echoed into the send-history row
 * for forensic pairing.
 */
export function buildReportEmailAuditHooks(
  deps: ReportEmailAuditDeps,
): SendReportEmailHooks {
  // Single-send state carried across hook invocations. The orchestrator calls
  // them in order: onIntent → onSent OR onFailed → (onHistoryWrite on success).
  // A fresh hooks bundle is built per HTTP request, so this state is per-send.
  let intentSeq = 0;
  let outcomeSeq = 0;
  let outcomeLineSha256 = "";
  const runId = randomUUID();

  const onIntent = async (event: IntentAuditEvent): Promise<void> => {
    const prevHealth = await getOrInitHealthRow(
      deps.healthTable,
      event.tenantId,
      INTENT_SOURCE,
    );
    const seq = prevHealth.lastAuditSeq + 1;
    const prevLineSha256 = resolvePrevLineSha256(
      prevHealth.lastLineSha256,
      INTENT_SOURCE,
      event.tenantId,
    );
    const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
      schemaVersion: 2,
      eventType: "report.email.intent",
      source: INTENT_SOURCE,
      seq,
      runId,
      tenantId: event.tenantId,
      startedAt: event.intentAt,
      endedAt: event.intentAt,
      status: "success",
      periodKey: event.periodKey,
      capturedAtOfSnapshot: event.capturedAtOfSnapshot,
      renderedAt: event.renderedAt,
      senderMailbox: event.senderMailbox,
      recipientCount: event.recipientCount,
      externalRecipientCount: event.externalRecipientCount,
      // Forward whichever fingerprint variant the orchestrator emitted.
      // Mutually exclusive per ADR-0030 §C.21 — the orchestrator never sets
      // both (recipientHashPepper.loadRecipientHashPepper picks one).
      ...(event.recipientHashSalted ? { recipientHashSalted: event.recipientHashSalted } : {}),
      ...(event.recipientHashSaltedV2 ? { recipientHashSaltedV2: event.recipientHashSaltedV2 } : {}),
      bodySha256: event.bodySha256,
      bodyBytes: event.bodyBytes,
      subjectSha256: event.subjectSha256,
      triggeredBy: event.triggeredBy,
      operatorPrincipal: event.operatorPrincipal,
      ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
      intentAt: event.intentAt,
      callerPrincipalMiClientId: event.callerPrincipalMiClientId,
      prevLineSha256,
    };
    const lineSha256 = computeLineSha256(
      lineWithoutHash as unknown as Record<string, unknown>,
    );
    await appendAuditLine(deps.auditCtx, {
      ...lineWithoutHash,
      lineSha256,
    } as AuditLineFields);
    await commitHealthRow(deps.healthTable, prevHealth, {
      outcome: "success",
      runId,
      now: event.intentAt,
      auditSeq: seq,
      lineSha256,
    });
    intentSeq = seq;
  };

  const writeOutcomeLine = async (args: {
    readonly eventType: "report.email.sent" | "report.email.failed";
    readonly outcome: "success" | "error";
    readonly periodKey: string;
    readonly tenantId: string;
    readonly startedAt: string;
    readonly callerPrincipalMiClientId: string;
    readonly extra: Record<string, unknown>;
  }): Promise<{ seq: number; lineSha256: string }> => {
    const prevHealth: IngestHealthRow = await getOrInitHealthRow(
      deps.healthTable,
      args.tenantId,
      SENT_SOURCE,
    );
    const seq = prevHealth.lastAuditSeq + 1;
    const prevLineSha256 = resolvePrevLineSha256(
      prevHealth.lastLineSha256,
      SENT_SOURCE,
      args.tenantId,
    );
    const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
      schemaVersion: 2,
      eventType: args.eventType,
      source: SENT_SOURCE,
      seq,
      runId,
      tenantId: args.tenantId,
      startedAt: args.startedAt,
      endedAt: args.startedAt,
      status: args.outcome,
      periodKey: args.periodKey,
      intentLineSeq: intentSeq,
      callerPrincipalMiClientId: args.callerPrincipalMiClientId,
      prevLineSha256,
      ...args.extra,
    } as unknown as Omit<AuditLineFields, "lineSha256">;
    const lineSha256 = computeLineSha256(
      lineWithoutHash as unknown as Record<string, unknown>,
    );
    await appendAuditLine(deps.auditCtx, {
      ...lineWithoutHash,
      lineSha256,
    } as AuditLineFields);
    try {
      await commitHealthRow(deps.healthTable, prevHealth, {
        outcome: args.outcome,
        runId,
        now: args.startedAt,
        auditSeq: seq,
        lineSha256,
      });
    } catch (err) {
      if (err instanceof LeaseContendedError) {
        // The outcome line is already on the audit blob; the health row
        // didn't move. Verifier sees the line + a static health row. The
        // outer caller observes the failure via the thrown error.
        deps.logger.warn(
          `report.email.health.commit_contended source=${SENT_SOURCE} seq=${seq} — chain advances on next verify pass.`,
        );
      } else {
        throw err;
      }
    }
    return { seq, lineSha256 };
  };

  const onSent = async (event: SentAuditEvent): Promise<void> => {
    const r = await writeOutcomeLine({
      eventType: "report.email.sent",
      outcome: "success",
      periodKey: event.periodKey,
      tenantId: event.tenantId,
      startedAt: event.sentAt,
      callerPrincipalMiClientId: event.callerPrincipalMiClientId,
      extra: {
        graphMessageId: event.graphMessageId,
        graphClientRequestId: event.graphClientRequestId,
        internetMessageId: event.internetMessageId,
        sentAt: event.sentAt,
      },
    });
    outcomeSeq = r.seq;
    outcomeLineSha256 = r.lineSha256;
  };

  const onFailed = async (event: FailedAuditEvent): Promise<void> => {
    await writeOutcomeLine({
      eventType: "report.email.failed",
      outcome: "error",
      periodKey: event.periodKey,
      tenantId: event.tenantId,
      startedAt: event.failedAt,
      callerPrincipalMiClientId: event.callerPrincipalMiClientId,
      extra: {
        graphClientRequestId: event.graphClientRequestId,
        internetMessageId: event.internetMessageId,
        errorKind: event.errorKind,
        errorMessage: event.errorMessage.slice(0, 2000),
        attempt: event.attempt,
        failedAt: event.failedAt,
      },
    });
  };

  const onHistoryWrite = async (row: SendHistoryRow): Promise<void> => {
    await upsertReportEmailSend(deps.tenantSettingsTable, {
      tenantId: row.tenantId,
      periodKey: row.periodKey,
      graphMessageId: row.graphMessageId,
      sentAt: row.sentAt,
      senderMailbox: row.senderMailbox,
      recipients: [...row.recipients],
      operatorPrincipal: row.operatorPrincipal,
      internetMessageId: row.internetMessageId,
      clientRequestId: row.clientRequestId,
      auditLineSeq: outcomeSeq,
      auditLineSha256: outcomeLineSha256,
    });
  };

  return { onIntent, onSent, onFailed, onHistoryWrite };
}
