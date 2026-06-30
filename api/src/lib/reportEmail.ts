// ADR-0030 Phase C §C.6/§C.7/§C.8 — outbound email orchestrator.
//
// Slice 1(b) scope: pure orchestrator. Renders the email, validates recipients,
// caps the body, emits hash-bound audit fingerprints via injected hooks, drives
// the Graph draft + send-draft POST pair, and surfaces the success/failure
// outcome to the caller. Audit-chain seq + IngestHealth coupling + send-history
// TenantSettings writes are provided as caller-supplied hooks so Slice 1(c)
// (the admin HTTP endpoint) can wire them with handler context. Tests inject
// no-op hooks; the orchestrator's contract is testable in isolation.
//
// Decisions captured here (from the ADR addendum):
//
//  - Draft + send-draft pattern (§C.8). `sendMail` returns 202 with empty body
//    — no message ID. Use POST /users/{from}/messages → returns the Message
//    resource with `.id` (the graphMessageId we audit) → POST .../messages/{id}/send.
//  - Internet message ID is generated client-side as `<{uuid}@{senderDomain}>`
//    and applied via `internetMessageHeaders` (the read-only `internetMessageId`
//    field is set by Graph, not us; the custom header is the durable
//    correlation handle for the SentItems retry-ambiguity probe — §C.8.1).
//  - `client-request-id` header per attempt for Graph-side request tracing.
//  - Recipient-domain allowlist enforced at the orchestrator as defence in
//    depth to AAP (§C.1 LOW C.1).
//  - 1 MB body cap (§C.6 MED C.6); exceeded → throws BodyTooLargeError.
//  - Inert detection (§C.5.2): missing MI client id, missing sender mailbox,
//    or empty recipients → throws NotConfiguredError before any side effect.

import { randomUUID, createHash } from "node:crypto";
import type { InvocationContext } from "@azure/functions";
import {
  graphPostJsonWithRetry,
  GraphFetchError,
  type GraphFetchOptions,
} from "./graphClient.js";
import type { ReportSnapshotEnvelope } from "./reportSnapshotStore.js";
import { renderEmailHtml, type EmailRenderOptions } from "./reportEmailRender.js";
import { loadRecipientHashPepper, RecipientHashPepperRequiredError } from "./recipientHashPepper.js";
import { loadReportShareSigningKey } from "./reportShareSigningKey.js";
import {
  signReportShareToken,
  DEFAULT_SHARE_TOKEN_TTL_MS,
} from "./reportShareToken.js";

// Re-export so the handler can catch via the same import surface as the
// other orchestrator-thrown errors (NotConfiguredError, BodyTooLargeError,
// RecipientDomainBlockedError, EmailSendError).
export { RecipientHashPepperRequiredError };
import { emitAievent } from "./aievent.js";

/** SEC-L-L12-02 — every reason `buildShareUrlOrAievent` can fail-soft on.
 *  Promoted to a named union so the hard-fail error class and the
 *  AIEVENT reason string share a single source of truth. */
export type ShareUrlFallbackReason =
  | "url_base_unset"
  | "url_base_not_https"
  | "env_unset"
  | "kv_read_failed"
  | "empty_secret"
  | "too_short"
  | "sign_threw";

/** Thrown by `buildShareUrlOrAievent` when `REPORT_SHARE_URL_REQUIRED=true`
 *  AND a share URL cannot be minted. Mirror of
 *  `RecipientHashPepperRequiredError` — the caller
 *  (`emailReportSnapshot`) maps this to **502 `report_share_url_required`**
 *  so prod fails loudly when share-link issuance regresses, rather than
 *  silently downgrading the email to a no-link body.
 *
 *  Default off; dev keeps the fail-soft AIEVENT flow for KV-down /
 *  REPORT_SHARE_URL_BASE-unset developer workflow. Operator opts in via
 *  `azd env set AZURE_REPORT_SHARE_URL_REQUIRED true` once chunk-4
 *  provisioning has been confirmed live (mirrors the L12-01 enablement
 *  runbook in docs/0030-reports-and-snapshot-contract.md §1085). */
export class ReportShareUrlRequiredError extends Error {
  readonly fallbackReason: ShareUrlFallbackReason;
  readonly errorDetail?: string;
  constructor(fallbackReason: ShareUrlFallbackReason, errorDetail?: string) {
    super(
      `Share URL is required (REPORT_SHARE_URL_REQUIRED=true) but unavailable: ${fallbackReason}${errorDetail ? ` (${errorDetail})` : ""}`,
    );
    this.name = "ReportShareUrlRequiredError";
    this.fallbackReason = fallbackReason;
    if (errorDetail !== undefined) this.errorDetail = errorDetail;
  }
}

/** True iff `REPORT_SHARE_URL_REQUIRED` is the literal string `"true"`
 *  (case-insensitive, whitespace-trimmed). Anything else — including
 *  unset, empty, `"1"`, `"yes"` — is treated as false. Strict match
 *  follows the precedent in `recipientHashPepper.isPepperRequired`
 * so an operator setting `"1"` expecting true gets
 *  fail-soft, not the wrong belief that hard-fail is active. */
function isShareUrlRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.REPORT_SHARE_URL_REQUIRED;
  if (raw === undefined) return false;
  return raw.trim().toLowerCase() === "true";
}

// ─── Public types ───────────────────────────────────────────────────────────

export interface ReportEmailConfig {
  readonly senderMailbox: string;
  readonly recipients: readonly string[];
  readonly allowExternalRecipients: boolean;
  /** Operator-allowlisted recipient domains when `allowExternalRecipients`
   *  is true. Sender domain is ALWAYS allowed regardless of this list. */
  readonly externalRecipientDomains: readonly string[];
  readonly subjectPrefix?: string;
  readonly productName: string;
}

export interface SendReportEmailArgs {
  readonly envelope: ReportSnapshotEnvelope;
  readonly config: ReportEmailConfig;
  readonly mailSenderMiClientId: string;
  /** UPN or AAD object ID of the admin triggering the send. */
  readonly operatorPrincipal: string;
  /** "admin" — operator-clicked. "auto" — scheduled (forward-track v2). */
  readonly triggeredBy: "admin" | "auto";
  /** Idempotency-Key header from the caller, if any (§C.5.1). Forwarded to
   *  the audit lines for replay reconciliation; the orchestrator does NOT
   *  itself implement the replay cache — that lives at the handler layer. */
  readonly idempotencyKey?: string;
  readonly context: InvocationContext;
  /** Graph base URL — typically `https://graph.microsoft.com/v1.0`. */
  readonly graphBaseUrl: string;
  /** Lease window (ms) for Retry-After clamping. The admin endpoint has no
   *  lease the way ingest does — pass a generous bound like 60_000. */
  readonly leaseWindowMs: number;
  readonly hooks: SendReportEmailHooks;
}

/** Caller-injected side-effect hooks. Slice 1(c) wires audit chain + tenant
 *  settings; tests inject no-ops or fakes. */
export interface SendReportEmailHooks {
  /** Emit the pre-send `report.email.intent` audit line. Must complete
   *  before the first Graph POST. Throwing aborts the send. */
  readonly onIntent: (event: IntentAuditEvent) => Promise<void>;
  /** Emit the post-success `report.email.sent` audit line. Failures are
   *  logged but DO NOT roll back the send (audit gap visible to the chain
   *  verifier). */
  readonly onSent: (event: SentAuditEvent) => Promise<void>;
  /** Emit the post-failure `report.email.failed` audit line. */
  readonly onFailed: (event: FailedAuditEvent) => Promise<void>;
  /** Best-effort write of the plaintext-recipient send-history row
   *  (TenantSettings RowKey `report-email-send:<graphMessageId>`). Failure
   *  is non-fatal — the audit pair already records the send. */
  readonly onHistoryWrite: (event: SendHistoryRow) => Promise<void>;
}

export interface IntentAuditEvent {
  readonly periodKey: string;
  readonly tenantId: string;
  readonly capturedAtOfSnapshot: string;
  readonly renderedAt: string;
  readonly senderMailbox: string;
  readonly recipientCount: number;
  readonly externalRecipientCount: number;
  /** Pre-pepper (legacy) recipient fingerprint. Present iff the orchestrator
   *  could NOT load a KV pepper this call. Mutually exclusive with
   *  `recipientHashSaltedV2`. See `recipientHashPepper.ts` + ADR-0030 §C.21. */
  readonly recipientHashSalted?: string;
  /** Peppered recipient fingerprint. Present iff the orchestrator loaded a
   *  pepper from KV this call. Mutually exclusive with `recipientHashSalted`. */
  readonly recipientHashSaltedV2?: string;
  readonly bodySha256: string;
  readonly bodyBytes: number;
  readonly subjectSha256: string;
  readonly callerPrincipalMiClientId: string;
  readonly triggeredBy: "admin" | "auto";
  readonly operatorPrincipal: string;
  readonly idempotencyKey?: string;
  readonly intentAt: string;
}

export interface SentAuditEvent {
  readonly periodKey: string;
  readonly tenantId: string;
  readonly graphMessageId: string;
  readonly graphClientRequestId: string;
  readonly internetMessageId: string;
  readonly sentAt: string;
  readonly callerPrincipalMiClientId: string;
}

export interface FailedAuditEvent {
  readonly periodKey: string;
  readonly tenantId: string;
  readonly graphClientRequestId: string;
  readonly internetMessageId: string;
  readonly errorKind: "throttle" | "4xx" | "5xx" | "internal" | "ambiguous" | "network" | "timeout";
  readonly errorMessage: string;
  readonly attempt: number;
  readonly failedAt: string;
  readonly callerPrincipalMiClientId: string;
}

export interface SendHistoryRow {
  readonly tenantId: string;
  readonly periodKey: string;
  readonly graphMessageId: string;
  readonly sentAt: string;
  readonly senderMailbox: string;
  readonly recipients: readonly string[];
  readonly operatorPrincipal: string;
  readonly internetMessageId: string;
  readonly clientRequestId: string;
}

export interface SendReportEmailResult {
  readonly status: "sent" | "sent_but_history_write_failed";
  readonly graphMessageId: string;
  readonly internetMessageId: string;
  readonly clientRequestId: string;
  readonly attempts: number;
  readonly subject: string;
  readonly bodyBytes: number;
  readonly recipientCount: number;
  readonly sentAt: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class NotConfiguredError extends Error {
  readonly kind = "not_configured";
  readonly reason: string;
  constructor(reason: string) {
    super(`Phase C email orchestrator is not configured: ${reason}`);
    this.name = "NotConfiguredError";
    this.reason = reason;
  }
}

export class BodyTooLargeError extends Error {
  readonly kind = "body_too_large";
  readonly bytes: number;
  constructor(bytes: number) {
    super(`Phase C email body exceeds 1 MB cap (${bytes} bytes)`);
    this.name = "BodyTooLargeError";
    this.bytes = bytes;
  }
}

export class RecipientDomainBlockedError extends Error {
  readonly kind = "recipient_domain_blocked";
  readonly recipient: string;
  readonly recipientDomain: string;
  constructor(recipient: string, recipientDomain: string) {
    super(
      `Recipient domain '${recipientDomain}' is not allowed by current config (recipient=${recipient}). Toggle 'allowExternalRecipients' AND add the domain to the allowlist to permit.`,
    );
    this.name = "RecipientDomainBlockedError";
    this.recipient = recipient;
    this.recipientDomain = recipientDomain;
  }
}

export class EmailSendError extends Error {
  readonly kind: FailedAuditEvent["errorKind"];
  readonly attempts: number;
  readonly graphClientRequestId: string;
  readonly internetMessageId: string;
  readonly status: number | null;
  constructor(
    kind: FailedAuditEvent["errorKind"],
    message: string,
    attempts: number,
    graphClientRequestId: string,
    internetMessageId: string,
    status: number | null,
  ) {
    super(message);
    this.name = "EmailSendError";
    this.kind = kind;
    this.attempts = attempts;
    this.graphClientRequestId = graphClientRequestId;
    this.internetMessageId = internetMessageId;
    this.status = status;
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BODY_BYTE_CAP = 1 * 1024 * 1024; // 1 MB, §C.6 MED C.6.
/** Per-field pre-render caps so attacker-influenceable envelope strings can't
 *  push the renderer through a multi-MB allocation before the post-render
 *  1 MB cap rejects (Slice 1(b) WS10 LOW #6). Each operator-controlled string
 *  has an independent cap so legitimate content never trips it. */
const OPERATOR_NOTE_MAX_CHARS = 4 * 1024; // 4 KB — matches admin patchSettings cap.
/** RFC 5321-lite sender mailbox UPN validator. Rejects CRLF, control chars,
 *  and anything outside the conservative set Microsoft accepts for Graph
 *  `/users/{upn}/messages`. (Slice 1(b) WS10 LOW #8) */
const SENDER_UPN_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
/** Custom header carried on the draft and probed in SentItems (§C.8.1). The
 *  read-only `internetMessageId` field on the Message resource is set by Graph
 *  and is not predictable client-side, so we use this custom header as the
 *  durable correlation handle for the retry-ambiguity probe. */
export const AEGIS_CORRELATION_HEADER = "X-Aegis-Correlation-Id";

// ─── Orchestrator ───────────────────────────────────────────────────────────

export async function sendReportSnapshotEmail(
  args: SendReportEmailArgs,
): Promise<SendReportEmailResult> {
  const {
    envelope,
    config,
    mailSenderMiClientId,
    operatorPrincipal,
    triggeredBy,
    context,
    graphBaseUrl,
    leaseWindowMs,
    hooks,
  } = args;

  // ─── Inert detection (§C.5.2) ────────────────────────────────────────────
  if (!mailSenderMiClientId || mailSenderMiClientId.trim().length === 0) {
    throw new NotConfiguredError(
      "mailSenderMiClientId is empty (MAIL_SENDER_MI_CLIENT_ID not set on Function App).",
    );
  }
  if (!config.senderMailbox || config.senderMailbox.trim().length === 0) {
    throw new NotConfiguredError(
      "config.senderMailbox is empty (no AZURE_MAIL_SENDER_UPN configured at provision time, or admin has not enabled report email).",
    );
  }
  if (config.recipients.length === 0) {
    throw new NotConfiguredError(
      "config.recipients is empty (admin has not configured a recipient list in /admin/email).",
    );
  }

  // Slice 1(b) WS10 LOW #8 — defence-in-depth: reject mailbox UPNs that contain
  // CRLF, control chars, or anything outside the RFC 5321-lite shape Graph
  // accepts. Stops a stray CRLF in `AZURE_MAIL_SENDER_UPN` from flowing into
  // the X-Aegis-Correlation-Id header value (or the Graph URL path).
  if (!SENDER_UPN_REGEX.test(config.senderMailbox)) {
    throw new NotConfiguredError(
      `config.senderMailbox '${config.senderMailbox}' contains characters outside the RFC 5321-lite mailbox UPN set.`,
    );
  }
  const senderDomain = extractDomain(config.senderMailbox);
  if (!senderDomain) {
    throw new NotConfiguredError(
      `config.senderMailbox '${config.senderMailbox}' is not a valid UPN (no '@domain' suffix).`,
    );
  }

  // Slice 1(b) WS10 LOW #6 — bound attacker-influenceable envelope strings
  // BEFORE the renderer allocates body bytes. The post-render 1 MB cap still
  // applies, but this lets us reject early and avoid heap-burn DoS.
  if (envelope.operatorNote && envelope.operatorNote.length > OPERATOR_NOTE_MAX_CHARS) {
    throw new BodyTooLargeError(envelope.operatorNote.length);
  }

  // Slice 1(b) WS10 MEDIUM #2 — canonicalise recipients ONCE so validation,
  // hashing, and Graph payload all see the same form. Without this, leading
  // whitespace on one recipient produces a domain check pass but a different
  // hash than the lowercased canonical form.
  const canonicalRecipients = canonicaliseRecipients(config.recipients);

  // ─── Recipient-domain validation (§C.1 LOW C.1) ─────────────────────────
  const externalRecipientCount = validateRecipients(
    canonicalRecipients,
    senderDomain,
    config.allowExternalRecipients,
    config.externalRecipientDomains,
  );

  // ─── Mint share-link token (§C.22) ──────────────────────────────────────
  // Fail-soft: when the signing key is unavailable OR the URL base is
  // unset, the email body falls back to the legacy KPI shape. AIEVENT
  // surfaces the degraded posture so the operator knows to provision the
  // KV secret. Both env-side states (key absent, URL base absent) are
  // valid during the chunk 1→4 rollout window.
  const shareUrl = await buildShareUrlOrAievent(
    context,
    envelope.tenantId,
    envelope.periodKey,
  );

  // ─── Render email (§C.6) ────────────────────────────────────────────────
  const renderedAt = new Date().toISOString();
  const renderOpts: EmailRenderOptions = {
    productName: config.productName,
    senderMailbox: config.senderMailbox,
    ...(config.subjectPrefix ? { subjectPrefix: config.subjectPrefix } : {}),
    ...(shareUrl ? { shareUrl } : {}),
  };
  const { subject, html } = renderEmailHtml(envelope, renderOpts);
  const bodyBytes = Buffer.byteLength(html, "utf-8");
  if (bodyBytes > BODY_BYTE_CAP) {
    throw new BodyTooLargeError(bodyBytes);
  }

  // ─── IDs + hashes ────────────────────────────────────────────────────────
  const clientRequestId = randomUUID();
  const internetMessageIdLocal = randomUUID();
  const internetMessageId = `<${internetMessageIdLocal}@${senderDomain}>`;
  const bodySha256 = sha256Hex(html);
  const subjectSha256 = sha256Hex(subject);
  // §C.21 — load the Key Vault pepper (L12 landing). Fail-soft posture:
  // when the pepper is unavailable (env unset, KV down, secret empty), the
  // orchestrator falls back to the legacy tenant-bound hash + emits an
  // AIEVENT so the operator's telemetry surfaces the degraded posture.
  // Pepper is defense-in-depth — a send must never be gated on KV.
  const pepperResult = await loadRecipientHashPepper();
  const canonicalRecipientsJoined = canonicalRecipients.join(",");
  const recipientHashFields: {
    recipientHashSalted?: string;
    recipientHashSaltedV2?: string;
  } = pepperResult.pepper
    ? {
        recipientHashSaltedV2: sha256Hex(
          `${pepperResult.pepper}:${envelope.tenantId}:${canonicalRecipientsJoined}`,
        ),
      }
    : {
        recipientHashSalted: sha256Hex(`${envelope.tenantId}:${canonicalRecipientsJoined}`),
      };
  if (!pepperResult.pepper) {
    emitAievent(context, "report.email.pepper.fallback", {
      tenantId: envelope.tenantId,
      reason: pepperResult.fallbackReason ?? "unknown",
      ...(pepperResult.errorDetail ? { errorDetail: pepperResult.errorDetail } : {}),
    });
  }

  // ─── Intent audit line (pre-send, §C.7) ─────────────────────────────────
  const intentAt = new Date().toISOString();
  const intentEvent: IntentAuditEvent = {
    periodKey: envelope.periodKey,
    tenantId: envelope.tenantId,
    capturedAtOfSnapshot: envelope.capturedAt,
    renderedAt,
    senderMailbox: config.senderMailbox,
    recipientCount: canonicalRecipients.length,
    externalRecipientCount,
    ...recipientHashFields,
    bodySha256,
    bodyBytes,
    subjectSha256,
    callerPrincipalMiClientId: mailSenderMiClientId,
    triggeredBy,
    operatorPrincipal,
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    intentAt,
  };
  await hooks.onIntent(intentEvent);

  // ─── Draft + send-draft via Graph (§C.8 draft+send pattern) ─────────────
  const graphOptions: GraphFetchOptions = {
    managedIdentityClientId: mailSenderMiClientId,
    graphBaseUrl,
    leaseWindowMs,
  };
  const senderPath = `${graphBaseUrl.replace(/\/$/, "")}/users/${encodeURIComponent(config.senderMailbox)}`;
  const draftUrl = `${senderPath}/messages`;

  const draftPayload = buildDraftPayload({
    subject,
    html,
    recipients: canonicalRecipients,
    correlationHeaderValue: internetMessageId,
  });

  let graphMessageId: string;
  let createAttempts = 0;

  try {
    const createResult = await graphPostJsonWithRetry<typeof draftPayload, { id?: string }>(
      draftUrl,
      draftPayload,
      graphOptions,
      context,
      {
        extraHeaders: { "client-request-id": clientRequestId },
        // Slice 1(b) WS10 MEDIUM #3 — create-draft is not idempotent; do not
        // retry on transport-layer failure. An aborted-but-delivered request
        // would orphan a draft in the mailbox.
        retryOnTransport: false,
      },
    );
    createAttempts = createResult.attempts;
    const id = createResult.data?.id;
    if (!id || typeof id !== "string") {
      throw new GraphFetchError(
        "internal",
        "Graph create-draft returned 2xx but no `id` field in response body.",
        createResult.finalHttpStatus,
        createResult.attempts,
      );
    }
    graphMessageId = id;
  } catch (err) {
    await emitFailureAudit(err, hooks, {
      tenantId: envelope.tenantId,
      periodKey: envelope.periodKey,
      clientRequestId,
      internetMessageId,
      callerPrincipalMiClientId: mailSenderMiClientId,
    });
    throw wrapGraphError(err, clientRequestId, internetMessageId);
  }

  // Send the draft. The send endpoint returns 202 with empty body.
  const sendUrl = `${senderPath}/messages/${encodeURIComponent(graphMessageId)}/send`;
  let sendAttempts = 0;
  try {
    const sendResult = await graphPostJsonWithRetry<Record<string, never>, never>(
      sendUrl,
      {},
      graphOptions,
      context,
      {
        extraHeaders: { "client-request-id": clientRequestId },
      },
    );
    sendAttempts = sendResult.attempts;
  } catch (err) {
    await emitFailureAudit(err, hooks, {
      tenantId: envelope.tenantId,
      periodKey: envelope.periodKey,
      clientRequestId,
      internetMessageId,
      callerPrincipalMiClientId: mailSenderMiClientId,
    });
    throw wrapGraphError(err, clientRequestId, internetMessageId);
  }

  const sentAt = new Date().toISOString();

  // ─── Sent audit line + send-history row ──────────────────────────────────
  const sentEvent: SentAuditEvent = {
    periodKey: envelope.periodKey,
    tenantId: envelope.tenantId,
    graphMessageId,
    graphClientRequestId: clientRequestId,
    internetMessageId,
    sentAt,
    callerPrincipalMiClientId: mailSenderMiClientId,
  };
  try {
    await hooks.onSent(sentEvent);
  } catch (auditErr) {
    // The send already happened — log the audit-write gap but don't
    // un-send. The chain verifier will surface the gap.
    context.error(
      `report.email.sent audit write failed graphMessageId=${graphMessageId} clientRequestId=${clientRequestId} err=${String((auditErr as Error).message ?? auditErr)}`,
    );
  }

  let historyOk = true;
  try {
    await hooks.onHistoryWrite({
      tenantId: envelope.tenantId,
      periodKey: envelope.periodKey,
      graphMessageId,
      sentAt,
      senderMailbox: config.senderMailbox,
      recipients: canonicalRecipients,
      operatorPrincipal,
      internetMessageId,
      clientRequestId,
    });
  } catch (historyErr) {
    historyOk = false;
    context.warn(
      `report.email.history.write_failed graphMessageId=${graphMessageId} err=${String((historyErr as Error).message ?? historyErr)} (audit pair still proves the send)`,
    );
  }

  return {
    status: historyOk ? "sent" : "sent_but_history_write_failed",
    graphMessageId,
    internetMessageId,
    clientRequestId,
    attempts: createAttempts + sendAttempts,
    subject,
    bodyBytes,
    recipientCount: canonicalRecipients.length,
    sentAt,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface DraftPayloadInput {
  readonly subject: string;
  readonly html: string;
  readonly recipients: readonly string[];
  readonly correlationHeaderValue: string;
}

function buildDraftPayload(input: DraftPayloadInput): {
  readonly subject: string;
  readonly body: { readonly contentType: "HTML"; readonly content: string };
  readonly toRecipients: ReadonlyArray<{ readonly emailAddress: { readonly address: string } }>;
  readonly internetMessageHeaders: ReadonlyArray<{ readonly name: string; readonly value: string }>;
} {
  return {
    subject: input.subject,
    body: { contentType: "HTML", content: input.html },
    toRecipients: input.recipients.map((r) => ({ emailAddress: { address: r } })),
    internetMessageHeaders: [
      { name: AEGIS_CORRELATION_HEADER, value: input.correlationHeaderValue },
    ],
  };
}

function validateRecipients(
  recipients: readonly string[],
  senderDomain: string,
  allowExternal: boolean,
  externalAllowlist: readonly string[],
): number {
  // Slice 1(b) WS10 LOW #7 — NFC-normalise + lowercase domains so Unicode
  // homograph allowlist bypasses are foiled. ASCII-only domains round-trip
  // unchanged; punycode (xn--...) is comparable as-is.
  const normalised = (d: string): string => d.normalize("NFC").toLowerCase();
  const senderDomainCanonical = normalised(senderDomain);
  const allowedDomains = new Set<string>([senderDomainCanonical]);
  if (allowExternal) {
    for (const d of externalAllowlist) allowedDomains.add(normalised(d));
  }
  let externalCount = 0;
  for (const r of recipients) {
    const dom = extractDomain(r);
    if (!dom) {
      throw new RecipientDomainBlockedError(r, "");
    }
    const domCanonical = normalised(dom);
    if (!allowedDomains.has(domCanonical)) {
      throw new RecipientDomainBlockedError(r, domCanonical);
    }
    if (domCanonical !== senderDomainCanonical) {
      externalCount++;
    }
  }
  return externalCount;
}

function extractDomain(upn: string): string | null {
  const at = upn.lastIndexOf("@");
  if (at <= 0 || at === upn.length - 1) return null;
  return upn.slice(at + 1);
}

/**
 * Canonical form used for validation, audit-hash computation, and the Graph
 * `toRecipients` payload: NFC-normalised, trimmed, lowercased, deduplicated,
 * sorted. Sort order makes the recipient hash stable regardless of the order
 * the operator typed the list in `/admin/email` (Slice 1(b) WS10 MEDIUM #2).
 */
function canonicaliseRecipients(recipients: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const r of recipients) {
    const c = r.normalize("NFC").trim().toLowerCase();
    if (c.length > 0) seen.add(c);
  }
  return [...seen].sort();
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

async function emitFailureAudit(
  err: unknown,
  hooks: SendReportEmailHooks,
  args: {
    readonly tenantId: string;
    readonly periodKey: string;
    readonly clientRequestId: string;
    readonly internetMessageId: string;
    readonly callerPrincipalMiClientId: string;
  },
): Promise<void> {
  const { kind, attempt, message } = classifyError(err);
  try {
    await hooks.onFailed({
      tenantId: args.tenantId,
      periodKey: args.periodKey,
      graphClientRequestId: args.clientRequestId,
      internetMessageId: args.internetMessageId,
      errorKind: kind,
      errorMessage: message.slice(0, 200),
      attempt,
      failedAt: new Date().toISOString(),
      callerPrincipalMiClientId: args.callerPrincipalMiClientId,
    });
  } catch {
    // Audit emission failed inside the failure path; the outer caller will
    // still throw the original error.
  }
}

function classifyError(err: unknown): {
  readonly kind: FailedAuditEvent["errorKind"];
  readonly attempt: number;
  readonly message: string;
} {
  if (err instanceof GraphFetchError) {
    return { kind: err.kind, attempt: err.attempts, message: err.message };
  }
  if (err instanceof Error) {
    return { kind: "internal", attempt: 1, message: err.message };
  }
  return { kind: "internal", attempt: 1, message: String(err) };
}

function wrapGraphError(
  err: unknown,
  clientRequestId: string,
  internetMessageId: string,
): EmailSendError {
  if (err instanceof EmailSendError) return err;
  const { kind, attempt, message } = classifyError(err);
  const status = err instanceof GraphFetchError ? err.status : null;
  return new EmailSendError(kind, message, attempt, clientRequestId, internetMessageId, status);
}

// ─── §C.22 share-link issuer ────────────────────────────────────────────────

/**
 * Resolve the share-link URL the email body will reference. Fail-soft: on
 * any error path (env var unset, KV signing key unavailable, sign throw)
 * returns null and emits an AIEVENT so the operator's telemetry surfaces
 * the degraded posture. Never throws — the email send must not be gated
 * on share-link availability during the rollout.
 *
 * The URL base is the SWA-served prefix that fronts the API (the FA's
 * `/api/reports/share/{token}` endpoint reachable through SWA's `/api/`
 * proxy). Configured via `REPORT_SHARE_URL_BASE`; trailing slash optional.
 */
/** @internal — exported for unit tests of the L12-02 hard-fail flag.
 *  Not intended as part of the public orchestrator surface; call sites
 *  outside this module should go through `sendReportSnapshotEmail`. */
export async function buildShareUrlOrAievent(
  context: InvocationContext,
  tenantId: string,
  periodKey: string,
): Promise<string | null> {
  // SEC-L-L12-02 — when `REPORT_SHARE_URL_REQUIRED=true` the operator has
  // opted in to hard-fail (fail-loud 502) instead of fail-soft (link
  // omitted + AIEVENT). Centralise the dispatch so every fail-soft branch
  // below routes through one decision point — adding a new fallback
  // case in the future automatically inherits the hard-fail posture.
  const hardFail = isShareUrlRequired();
  const failSoft = (
    reason: ShareUrlFallbackReason,
    extra: Record<string, string> = {},
  ): null => {
    if (hardFail) {
      // SEC-L-L12-02 WS10 Q8 follow-track — emit a distinct AIEVENT on
      // the hard-fail path BEFORE throwing so SOC dashboards see
      // parity telemetry across both postures (fail-soft and
      // fail-loud). Without this, a flag-ON regression surfaces only
      // through the 502 + warn-log; with this, the same AIEVENT-
      // backed projection that catches fail-soft drift also catches
      // the hard-fail throw. The event name differs so downstream
      // queries can distinguish — fail-soft is "degraded posture";
      // hard-fail is "send aborted".
      emitAievent(context, "report.email.share_link.hard_fail", {
        tenantId,
        periodKey,
        reason,
        ...extra,
      });
      throw new ReportShareUrlRequiredError(reason, extra.errorDetail);
    }
    emitAievent(context, "report.email.share_link.fallback", {
      tenantId,
      periodKey,
      reason,
      ...extra,
    });
    return null;
  };

  const urlBaseRaw = (process.env.REPORT_SHARE_URL_BASE ?? "").trim();
  if (urlBaseRaw === "") {
    return failSoft("url_base_unset");
  }
  // Defensive: require https. We don't want to mint links that go over
  // plaintext for an operator who pasted in `http://` by mistake.
  if (!/^https:\/\//i.test(urlBaseRaw)) {
    return failSoft("url_base_not_https");
  }

  const keyResult = await loadReportShareSigningKey();
  if (keyResult.key === null) {
    // `loadReportShareSigningKey`'s `fallbackReason` is the same string
    // union as ours minus `url_base_*` / `sign_threw` — every value it
    // returns is in `ShareUrlFallbackReason`, so the cast is safe.
    // `kv_unknown` only fires if a future loader variant returns null
    // with no reason; treat as `kv_read_failed` for the SOC pivot.
    const reason: ShareUrlFallbackReason =
      keyResult.fallbackReason ?? "kv_read_failed";
    return failSoft(reason, {
      ...(keyResult.errorDetail ? { errorDetail: keyResult.errorDetail } : {}),
    });
  }

  try {
    const expiresAtMs = Date.now() + DEFAULT_SHARE_TOKEN_TTL_MS;
    const token = signReportShareToken(
      { tenantId, periodKey, expiresAtMs },
      keyResult.key,
    );
    const urlBase = urlBaseRaw.replace(/\/+$/, "");
    return `${urlBase}/${encodeURIComponent(token)}`;
  } catch (err) {
    return failSoft("sign_threw", {
      errorDetail: (err as Error)?.name ?? "Error",
    });
  }
}
