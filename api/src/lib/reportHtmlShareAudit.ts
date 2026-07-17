// ADR-0030 §C.22 — audit-chain emitter for the share-link read endpoint
// (GET /api/reports/share/{token}).
//
// One chained line per successful 200 read; failed verification paths
// (bad-shape token / signature failure / expired / tenant-mismatch /
// snapshot-missing) are NOT audited because they reveal nothing about
// a snapshot. The audit chain is for actual reads only.
//
// Concurrency contract — commit-first, then append. The share endpoint
// is unauthenticated and can be hit by anyone holding a token, so
// concurrent reads of THE SAME LINK (e.g. two recipients open the email
// within the same second) are not theoretical. To stay race-free we
// follow the `runAgent.emitAudit` pattern (commit the IngestHealth row
// under its ETag lease FIRST, append the blob line ONLY if the commit
// won) rather than the older append-first pattern in
// `reportEmailAuditHooks.ts` (safe in practice for admin-triggered
// sends with rate-limit-bound concurrency, but not for an end-user
// read path).
//
// Fail-soft contract — the caller (`getReportShare`) MUST treat any
// throw from this function as a logged warn breadcrumb and continue
// serving the report. The reader already has the HTML; a missing
// audit line manifests as a chain gap that the verifier surfaces on
// the next sweep. The caller never propagates the audit failure to
// the user as a 500.

import { randomUUID } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import {
  appendAuditLine,
  type AuditContext,
  type AuditLineFields,
} from "./audit.js";
import {
  computeLineSha256,
  resolvePrevLineSha256,
} from "./auditChain.js";
import {
  commitHealthRow,
  getOrInitHealthRow,
  LeaseContendedError,
} from "./ingestHealth.js";

export const REPORT_HTML_SHARE_SOURCE = "report.html.share";

export interface ReportHtmlShareReadEvent {
  readonly tenantId: string;
  readonly periodKey: string;
  /** Opaque per-link identifier minted at issue time by
   *  `reportShareToken.signReportShareToken`. NOT user data — random
   *  bytes. Lands on the audit line so a SOC pivot can correlate a
   *  reported abuse case back to the specific token + Exchange send
   *  history. */
  readonly tokenJti: string;
  /** ISO 8601 — also the line's `startedAt` / `endedAt`. */
  readonly readAt: string;
  /** The MI client id appended on the line's `callerPrincipalMiClientId`
   *  field. Conventionally the audit MI for blob-write attribution. */
  readonly callerPrincipalMiClientId: string;
}

export interface ReportHtmlShareAuditDeps {
  /** Table client over `IngestHealth`. MUST be authenticated as the
   *  ingest MI (the only principal with Storage Table Data Contributor
   *  on IngestHealth — same MI as the other report.* audit chains use
   *  for chain-head storage; the audit MI is BLOB-only and 401s on
   *  table writes). */
  readonly healthTable: TableClient;
  /** Audit blob append context. */
  readonly auditCtx: AuditContext;
}

export type EmitResult =
  | { readonly outcome: "emitted"; readonly seq: number; readonly lineSha256: string }
  | { readonly outcome: "lease_contended" };

/**
 * Emit one chained audit line for a successful share-link read.
 *
 * Returns `{outcome:"emitted", seq, lineSha256}` on success or
 * `{outcome:"lease_contended"}` when a concurrent reader won the
 * ETag race — in that case neither the line NOR the head moved, so
 * the chain stays consistent (this read just doesn't get audited).
 * Throws on every other failure; caller MUST wrap with try/catch
 * and log a warn rather than propagating to the HTTP response.
 */
export async function emitReportHtmlShareReadAudit(
  deps: ReportHtmlShareAuditDeps,
  event: ReportHtmlShareReadEvent,
): Promise<EmitResult> {
  const runId = randomUUID();
  const prevHealth = await getOrInitHealthRow(
    deps.healthTable,
    event.tenantId,
    REPORT_HTML_SHARE_SOURCE,
  );
  const seq = prevHealth.lastAuditSeq + 1;
  const prevLineSha256 = resolvePrevLineSha256(
    prevHealth.lastLineSha256,
    REPORT_HTML_SHARE_SOURCE,
    event.tenantId,
  );

  const lineWithoutHash: Omit<AuditLineFields, "lineSha256"> = {
    schemaVersion: 2,
    eventType: "report.html.share.read",
    source: REPORT_HTML_SHARE_SOURCE,
    seq,
    runId,
    tenantId: event.tenantId,
    startedAt: event.readAt,
    endedAt: event.readAt,
    status: "success",
    periodKey: event.periodKey,
    tokenJti: event.tokenJti,
    callerPrincipalMiClientId: event.callerPrincipalMiClientId,
    prevLineSha256,
  };
  const lineSha256 = computeLineSha256(
    lineWithoutHash as unknown as Record<string, unknown>,
  );

  // Commit-first: try to advance the IngestHealth chain head under its
  // ETag lease BEFORE appending the line to the blob. On contention
  // (412) we have NOT written the line yet, so the chain stays clean.
  try {
    await commitHealthRow(deps.healthTable, prevHealth, {
      outcome: "success",
      runId,
      now: event.readAt,
      auditSeq: seq,
      lineSha256,
    });
  } catch (err) {
    if (err instanceof LeaseContendedError) {
      return { outcome: "lease_contended" };
    }
    throw err;
  }

  // Lease won — append the line. A failure here leaves the head ahead
  // of the blob (chain forward-only invariant from ADR-0015 §Negative
  // "audit-write-gap"); the verifier's ingest-repair detection on the
  // next emit will surface it. We propagate the throw so the caller's
  // fail-soft wrapper logs the breadcrumb.
  await appendAuditLine(deps.auditCtx, {
    ...lineWithoutHash,
    lineSha256,
  } as AuditLineFields);

  return { outcome: "emitted", seq, lineSha256 };
}
