// POST /api/reports/snapshots/{periodKey}/email
//
// ADR-0030 Phase C Slice 1(c)/A — send the latest captured snapshot for the
// given periodKey via Graph Mail.Send (orchestrator + draft + send-draft).
// Admin-gated. Inert when MAIL_SENDER_MI_CLIENT_ID is unset OR the
// `report-email-config` row is absent / disabled / has no recipients.
//
// Out of scope for /A (lands in /B): Idempotency-Key replay cache (§C.5.1),
// auto-capture missing snapshot (§C.5), List/Get/Delete history endpoints
// (§C.10), dedicated 10/day rate limit (§C.5).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden } from "../lib/httpAuthResponses.js";
import { resolveIngestConfig, resolveReportSnapshotConfig } from "../lib/config.js";
import { isValidPeriodKey, periodFromKey } from "../lib/reportPeriod.js";
import { readLatestSnapshot } from "../lib/reportSnapshotStore.js";
import { runReportCaptureOnce } from "../lib/runReportCapture.js";
import {
  readReportEmailConfig,
  readReportEmailIdempotency,
  upsertReportEmailIdempotency,
  REPORT_EMAIL_IDEMPOTENCY_TTL_MS,
} from "../lib/tenantSettingsStore.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import {
  reportEmailAutoCaptureRateLimiter,
  reportEmailSendRateLimiter,
} from "../lib/rateLimit.js";
import {
  sendReportSnapshotEmail,
  NotConfiguredError,
  BodyTooLargeError,
  RecipientDomainBlockedError,
  EmailSendError,
  RecipientHashPepperRequiredError,
  ReportShareUrlRequiredError,
} from "../lib/reportEmail.js";
import { buildReportEmailAuditHooks } from "../lib/reportEmailAuditHooks.js";
import { emitAievent } from "../lib/aievent.js";

const PRODUCT_NAME = "Aegis";

/** §C.5.1 — RFC-flavoured Idempotency-Key validator. Keep the regex narrow
 *  to avoid weird whitespace / control chars in the row key. `/` is dropped
 *  per WS10 Slice 1(c)/B1 LOW #5 — Azure Tables RowKey rejects `/`, so a key
 *  containing it would pass regex, pass cache-read (404), invoke the
 *  orchestrator (sending!), then crash the cache upsert. */
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:+\-=]{8,128}$/;

// §C.5 / WS10 Slice 1(c)/B2 LOW #2 — single-retry delays for the two
// race conditions on the auto-capture-on-miss path. Lease contention is
// usually resolved by another writer in well under a second; table-storage
// read-after-write replication lag is rarely more than a few hundred ms.
// Capped at one retry each — a second miss is a real anomaly we want to
// surface (lease_contended → 409 / read-after-write → 500) rather than
// disguise with longer waits that would also lengthen the bad-day p99.
const LEASE_CONTENDED_RETRY_DELAY_MS = 500;
const READ_AFTER_WRITE_RETRY_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal || !principal.userRoles.includes("admin")) {
    return forbidden(context, "report email send requires the admin role");
  }

  const periodKey = request.params.periodKey ?? "";
  if (!periodKey) {
    return badRequest(context, "periodKey path parameter is required");
  }
  const cadence = inferCadenceFromPeriodKey(periodKey);
  if (!cadence) {
    return badRequest(context, `periodKey '${periodKey}' is not a recognised cadence shape`);
  }
  if (!isValidPeriodKey(cadence, periodKey)) {
    return badRequest(context, `periodKey '${periodKey}' is invalid for cadence=${cadence}`);
  }

  const ingestConfig = resolveIngestConfig();
  const mailSenderMiClientId = (process.env.MAIL_SENDER_MI_CLIENT_ID ?? "").trim();
  if (mailSenderMiClientId.length === 0) {
    return notConfigured(
      context,
      "MAIL_SENDER_MI_CLIENT_ID is not set on the Function App — Phase C email is inert. Re-run azd provision after setting AZURE_MAIL_SENDER_UPN.",
    );
  }

  // §C.5 — resolve the snapshot config BEFORE the idempotency/rate-limit
  // checks so a misconfigured deployment fails fast without (a) burning a
  // rate-limit slot, (b) caching a config-broken outcome as a replayable
  // response under the operator's Idempotency-Key. Env-var read only; same
  // throw semantics as the original auto-capture-time call.
  const reportConfig = resolveReportSnapshotConfig();

  // §C.5.1 Idempotency-Key — optional header. Validate first so a malformed
  // key fails fast before any storage read.
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (idempotencyKey.length > 0 && !IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
    return badRequest(
      context,
      "Idempotency-Key must be 8-128 chars of [A-Za-z0-9._:+-=]",
    );
  }

  const tableCtx = {
    endpoint: ingestConfig.opsTableEndpoint,
    managedIdentityClientId: ingestConfig.apiReaderMiClientId,
  };
  const tenantSettingsTable = getTableClient(tableCtx, OPS_TABLES.TenantSettings);
  const reportTable = getTableClient(tableCtx, OPS_TABLES.ReportSnapshots);
  // IngestHealth chain-head writes use the ingest MI (the only MI with
  // Storage Table Data Contributor on IngestHealth — same identity that
  // every other audit-chain source uses, including report.snapshot. Audit
  // MI is BLOB-only and would 401 with AuthorizationPermissionMismatch).
  const healthTable = getTableClient(
    { endpoint: ingestConfig.opsTableEndpoint, managedIdentityClientId: ingestConfig.ingestMiClientId },
    OPS_TABLES.IngestHealth,
  );
  // Send-history rows are written by the mailSender MI (it's the only MI
  // with Storage Table Data Contributor scoped to TenantSettings — §C.9).
  const mailSenderTenantSettingsTable = getTableClient(
    { endpoint: ingestConfig.opsTableEndpoint, managedIdentityClientId: mailSenderMiClientId },
    OPS_TABLES.TenantSettings,
  );

  // §C.5.1 — idempotency cache lookup. Done BEFORE the rate limit so a
  // legitimate retry loop with the same key doesn't burn the 10/day quota
  // on cache hits (WS10 Slice 1(c)/B1 MEDIUM #2). When a fresh row exists
  // for the key:
  //   * matching periodKey → return the cached response with
  //     `Idempotency-Replayed: true`.
  //   * mismatched periodKey → 409 per §C.5.1 spec alignment with
  //     draft-ietf-httpapi-idempotency: same key + different request shape
  //     is a client-side bug, not a replay (WS10 Slice 1(c)/B1 MEDIUM #1).
  if (idempotencyKey.length > 0) {
    try {
      const cached = await readReportEmailIdempotency(
        tenantSettingsTable,
        ingestConfig.tenantId,
        idempotencyKey,
      );
      if (cached) {
        if (cached.periodKey && cached.periodKey !== periodKey) {
          return {
            status: 409,
            jsonBody: {
              error: {
                code: "idempotency_key_mismatch",
                message: `Idempotency-Key '${idempotencyKey}' was previously used for periodKey='${cached.periodKey}'. Use a fresh key for periodKey='${periodKey}'.`,
                cachedPeriodKey: cached.periodKey,
                cachedAt: cached.cachedAt,
                correlationId: context.invocationId,
              },
            },
            headers: { "cache-control": "no-store" },
          };
        }
        return {
          status: 200,
          jsonBody: cached.responseBody,
          headers: {
            "cache-control": "no-store",
            "idempotency-replayed": "true",
            "x-idempotency-cached-at": cached.cachedAt,
          },
        };
      }
    } catch (cacheErr) {
      // Cache failure must NOT block the send; just log + fall through.
      context.warn(
        `report.email.idempotency.read_failed correlationId=${context.invocationId} err=${String((cacheErr as Error).message ?? cacheErr)}`,
      );
    }
  }

  // §C.5 dedicated 10/day rate limit, per tenant. Applied AFTER the cache
  // lookup so replays don't burn the budget — only requests that will reach
  // the orchestrator consume a slot.
  //
  // Ordering note: the send slot is taken BEFORE
  // the auto-capture sub-budget check (below). A denied auto-capture still
  // burns a send slot — this defensive coupling is deliberate: an attacker
  // exhausting the send budget loses both paths. The cost: legitimate
  // operators who hit the auto-capture cap also lose send-budget on those
  // requests. If telemetry shows tenants hitting send-cap because of
  // auto-capture spam, swap the ordering so auto-capture is checked first
  // against the per-tenant key. Forward-tracked.
  const rate = reportEmailSendRateLimiter.check(ingestConfig.tenantId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limited",
          message: `report email send is capped at 10/24h per tenant; retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`,
          retryAfterSeconds: Math.ceil(rate.retryAfterMs / 1000),
          correlationId: context.invocationId,
        },
      },
      headers: {
        "cache-control": "no-store",
        "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)),
      },
    };
  }

  // Load operator email config + period snapshot in parallel.
  const [emailConfig, initialEnvelope] = await Promise.all([
    readReportEmailConfig(tenantSettingsTable, ingestConfig.tenantId),
    readLatestSnapshot(reportTable, ingestConfig.tenantId, periodKey),
  ]);

  if (!emailConfig.enabled || emailConfig.recipients.length === 0) {
    return notConfigured(
      context,
      "report-email-config row absent, disabled, or has no recipients. Configure via /admin/email before sending.",
    );
  }

  // §C.5 — auto-capture on miss. When no snapshot exists for the requested
  // periodKey, drive `runReportCaptureOnce` (the same lib helper the daily
  // Timer + POST /api/reports/snapshots use) to produce one, then re-read.
  // The capture is admin-attributed via `capturedBy: principal.userId` so
  // the audit chain reflects the actual operator who triggered it.
  let envelope = initialEnvelope;
  if (!envelope) {
    // §C.5 — dedicated sub-budget for the auto-capture-on-miss path. The
    // parent reportEmailSendRateLimiter slot is already consumed (above)
    // and caps Graph quota burn at 10/day; this second limiter caps the
    // audit-chain + envelope-blob writes a capture entails at 5/day per
    // tenant. A scripted "send 10 fresh periodKeys" loop would otherwise
    // generate 10 captures hammering the chain + blob store. Per-tenant
    // keying mirrors the send limiter. WS10 Slice 1(c)/B2 LOW #1.
    const captureRate = reportEmailAutoCaptureRateLimiter.check(ingestConfig.tenantId);
    if (!captureRate.allowed) {
      return {
        status: 429,
        jsonBody: {
          error: {
            code: "auto_capture_rate_limited",
            message: `auto-capture-on-miss is capped at 5/24h per tenant; retry after ${Math.ceil(captureRate.retryAfterMs / 1000)}s, or capture the periodKey via POST /api/reports/snapshots first`,
            retryAfterSeconds: Math.ceil(captureRate.retryAfterMs / 1000),
            correlationId: context.invocationId,
          },
        },
        headers: {
          "cache-control": "no-store",
          "retry-after": String(Math.ceil(captureRate.retryAfterMs / 1000)),
        },
      };
    }
    context.log(
      `report.email.auto_capture.start periodKey=${periodKey} cadence=${cadence} correlationId=${context.invocationId}`,
    );
    const captureResult = await runReportCaptureOnce({
      cadence,
      explicitPeriodKey: periodKey,
      capturedBy: principal.userId,
      skipIfPeriodHasVersions: false,
      ingestConfig,
      reportConfig,
      logger: context,
    });
    switch (captureResult.status) {
      case "success":
      case "skipped_already_captured":
        // Both paths produce an existing version we can read; for the
        // skipped case another writer landed it first, which is fine.
        break;
      case "invalid_period":
        return badRequest(
          context,
          captureResult.errorMessage ?? `periodKey ${periodKey} is invalid for cadence=${cadence}`,
        );
      case "lease_contended": {
        // §C.5 — another capture for this tenant is mid-flight. The other
        // writer is almost certainly seconds away from committing, so a
        // tight sleep + re-read often turns a 409 into a successful send
        // without round-tripping the operator. WS10 Slice 1(c)/B2 LOW #2.
        await sleep(LEASE_CONTENDED_RETRY_DELAY_MS);
        const racedEnvelope = await readLatestSnapshot(
          reportTable,
          ingestConfig.tenantId,
          periodKey,
        );
        if (racedEnvelope) {
          context.log(
            `report.email.auto_capture.lease_contended_recovered periodKey=${periodKey} correlationId=${context.invocationId}`,
          );
          // WS10 SEC-X-MEDS-BATCH-02 — surface the cross-chain link as a
          // queryable aievent so forensic replay can join the racing
          // writer's capture chain (`capturedBy`) to this invocation's send
          // chain (`operatorPrincipal`). The send chain's audit lines
          // already reference the envelope's capturedBy via the snapshot's
          // version metadata, but a flat aievent surface makes KQL joins
          // ergonomic.
          emitAievent(context, "report.email.auto_capture.lease_contended_recovered", {
            tenantId: ingestConfig.tenantId,
            periodKey,
            cadence,
            envelopeVersion: racedEnvelope.version,
            envelopeCapturedBy: racedEnvelope.capturedBy,
            sendOperatorPrincipal: principal.userId,
            correlationId: context.invocationId,
          });
          envelope = racedEnvelope;
          break;
        }
        return {
          status: 409,
          jsonBody: {
            error: {
              code: "capture_in_progress",
              message: `Another capture for periodKey=${periodKey} is in progress; retry shortly to fetch the result.`,
              correlationId: context.invocationId,
            },
          },
          headers: { "cache-control": "no-store" },
        };
      }
      case "size_exceeded":
        return {
          status: 413,
          jsonBody: {
            error: {
              code: "envelope_too_large",
              message: `Snapshot envelope for periodKey=${periodKey} exceeded the compressed cap (${captureResult.envelopeBytes} bytes). Phase B blob fallback required.`,
              correlationId: context.invocationId,
            },
          },
          headers: { "cache-control": "no-store" },
        };
      case "error":
        return {
          status: 500,
          jsonBody: {
            error: {
              code: "auto_capture_failed",
              message:
                captureResult.errorMessage ??
                "auto-capture failed before send; see audit chain (source=report.snapshot) for details",
              correlationId: context.invocationId,
            },
          },
          headers: { "cache-control": "no-store" },
        };
    }
    // §C.5 — only run the read-after-write path when the capture itself
    // didn't already populate `envelope` via the lease_contended recovery
    // branch above. WS10 Slice 1(c)/B2 LOW #2.
    if (!envelope) {
      envelope = await readLatestSnapshot(reportTable, ingestConfig.tenantId, periodKey);
      if (!envelope) {
        // Table-storage read-after-write occasionally lags. One retry after
        // a short sleep absorbs the common case (single-digit-ms replication
        // hiccup) before we surface a 500. Capped at one attempt — a second
        // miss is a real anomaly worth alerting on.
        await sleep(READ_AFTER_WRITE_RETRY_DELAY_MS);
        envelope = await readLatestSnapshot(reportTable, ingestConfig.tenantId, periodKey);
      }
      if (!envelope) {
        // Belt-and-braces: the capture reported success but the read still
        // returned null after one retry. 500 with the captured-run-id for
        // forensic lookup.
        context.error(
          `report.email.auto_capture.read_after_write_miss periodKey=${periodKey} runId=${captureResult.runId} correlationId=${context.invocationId}`,
        );
        return {
          status: 500,
          jsonBody: {
            error: {
              code: "snapshot_read_after_write_miss",
              message: `Auto-capture reported ${captureResult.status} for periodKey=${periodKey} but the snapshot read returned null after retry. See audit chain runId=${captureResult.runId}.`,
              correlationId: context.invocationId,
            },
          },
          headers: { "cache-control": "no-store" },
        };
      }
    }
    context.log(
      `report.email.auto_capture.ok periodKey=${periodKey} version=${captureResult.version} envelopeBytes=${captureResult.envelopeBytes} correlationId=${context.invocationId}`,
    );
  }

  const hooks = buildReportEmailAuditHooks({
    healthTable,
    tenantSettingsTable: mailSenderTenantSettingsTable,
    auditCtx: {
      blobEndpoint: ingestConfig.auditBlobEndpoint,
      auditContainerName: ingestConfig.auditContainerName,
      managedIdentityClientId: ingestConfig.auditMiClientId,
    },
    logger: context,
  });

  try {
    const result = await sendReportSnapshotEmail({
      envelope,
      config: {
        senderMailbox: process.env.AZURE_MAIL_SENDER_UPN ?? "",
        recipients: emailConfig.recipients,
        allowExternalRecipients: emailConfig.allowExternalRecipients,
        externalRecipientDomains: emailConfig.externalRecipientDomains,
        ...(emailConfig.subjectPrefix ? { subjectPrefix: emailConfig.subjectPrefix } : {}),
        productName: PRODUCT_NAME,
      },
      mailSenderMiClientId,
      operatorPrincipal: principal.userId,
      triggeredBy: "admin",
      ...(idempotencyKey.length > 0 ? { idempotencyKey } : {}),
      context,
      graphBaseUrl: ingestConfig.graphBaseUrl,
      leaseWindowMs: ingestConfig.leaseWindowMs,
      hooks,
    });

    const responseBody: Record<string, unknown> = {
      schemaVersion: 1,
      status: result.status,
      periodKey,
      graphMessageId: result.graphMessageId,
      internetMessageId: result.internetMessageId,
      clientRequestId: result.clientRequestId,
      sentAt: result.sentAt,
      recipientCount: result.recipientCount,
      bodyBytes: result.bodyBytes,
      attempts: result.attempts,
      subject: result.subject,
    };

    // §C.5.1 — cache the successful response so a retry with the same key
    // replays the same body. Best-effort: a cache write failure does NOT
    // affect the (already-completed) send. Uses the mailSender MI's table
    // client — only it has TDC on TenantSettings.
    if (idempotencyKey.length > 0) {
      const now = Date.now();
      try {
        await upsertReportEmailIdempotency(
          mailSenderTenantSettingsTable,
          ingestConfig.tenantId,
          {
            idempotencyKey,
            periodKey,
            responseBody,
            cachedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + REPORT_EMAIL_IDEMPOTENCY_TTL_MS).toISOString(),
          },
        );
      } catch (cacheErr) {
        context.warn(
          `report.email.idempotency.write_failed correlationId=${context.invocationId} graphMessageId=${result.graphMessageId} err=${String((cacheErr as Error).message ?? cacheErr)}`,
        );
      }
    }

    return {
      status: 200,
      jsonBody: responseBody,
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return notConfigured(context, err.message);
    }
    if (err instanceof BodyTooLargeError) {
      return {
        status: 413,
        jsonBody: {
          error: {
            code: "body_too_large",
            message: err.message,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    if (err instanceof ReportShareUrlRequiredError) {
      // SEC-L-L12-02 — operator opted into hard-fail via
      // REPORT_SHARE_URL_REQUIRED=true. Share-URL mint failed (env-unset
      // / not-https / KV-down / sign-throw); the send is aborted before
      // the orchestrator's first Graph POST. Mirror of the L12-01
      // pepper-required 502 above — same wire shape, distinct code
      // string so SPA telemetry can pivot.
      //
      // Same body-vs-log split as the L12-01 case: `err.message`
      // includes the scrubbed `errorDetail` parenthetical
      // (`(RestError 503)` etc.), which is appropriate for warn-log
      // surfaces but not for the admin-facing wire payload — build a
      // separate body message and keep the full error string on the
      // warn log only.
      context.warn(
        `report.email.send.share_url_required_unavailable correlationId=${context.invocationId} fallbackReason=${err.fallbackReason}${err.errorDetail ? ` errorDetail=${err.errorDetail}` : ""}`,
      );
      return {
        status: 502,
        jsonBody: {
          error: {
            code: "report_share_url_required",
            message: `Share URL is required but unavailable: ${err.fallbackReason}`,
            fallbackReason: err.fallbackReason,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    if (err instanceof RecipientHashPepperRequiredError) {
      // SEC-L-L12-01 — operator opted into hard-fail via
      // RECIPIENT_HASH_PEPPER_REQUIRED=true. KV pepper unavailable, send
      // aborted before the orchestrator's first Graph POST. Surface as 502
      // so the SPA banner mirrors other dependency-failure shapes.
      //
      // WS10 M-1: the error class's `message` includes
      // the scrubbed `errorDetail` parenthetical (`(RestError 503)` etc.).
      // That's appropriate for log surfaces but not for the response body —
      // dependency-error metadata, even scrubbed, doesn't belong on the
      // admin-facing wire payload. Build a separate body message and keep
      // the full error string (with errorDetail) on the warn log only.
      context.warn(
        `report.email.send.pepper_required_unavailable correlationId=${context.invocationId} fallbackReason=${err.fallbackReason}${err.errorDetail ? ` errorDetail=${err.errorDetail}` : ""}`,
      );
      return {
        status: 502,
        jsonBody: {
          error: {
            code: "recipient_hash_pepper_required",
            message: `Recipient-hash pepper is required but unavailable: ${err.fallbackReason}`,
            fallbackReason: err.fallbackReason,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    if (err instanceof RecipientDomainBlockedError) {
      context.warn(
        `report.email.send.recipient_domain_blocked correlationId=${context.invocationId} recipient=${err.recipient} domain=${err.recipientDomain}`,
      );
      return {
        status: 400,
        jsonBody: {
          error: {
            code: "recipient_domain_blocked",
            message: err.message,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    if (err instanceof EmailSendError) {
      const status = mapEmailSendErrorToStatus(err);
      // Surface Graph rejection details so we can diagnose post-hoc without
      // round-tripping the operator for the response body.
      context.warn(
        `report.email.send.email_send_${err.kind} correlationId=${context.invocationId} status=${err.status ?? "?"} attempts=${err.attempts} clientRequestId=${err.graphClientRequestId} msg=${err.message.slice(0, 500)}`,
      );
      return {
        status,
        jsonBody: {
          error: {
            code: `email_send_${err.kind}`,
            message: err.message.slice(0, 500),
            attempts: err.attempts,
            graphClientRequestId: err.graphClientRequestId,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    context.error(
      `report.email.send.internal_error correlationId=${context.invocationId} err=${String((err as Error).message ?? err)}`,
    );
    return {
      status: 500,
      jsonBody: {
        error: {
          code: "internal_error",
          message: "report email send failed; see audit chain for details",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

function mapEmailSendErrorToStatus(err: EmailSendError): number {
  switch (err.kind) {
    case "4xx":
      // Graph 4xx is an upstream-dependency rejection (permissions not
      // propagated, mailbox disabled, AAP scope drift, recipient rejected by
      // EXO) — not a client error of this API. Return 502 so the SPA's
      // generic error UI distinguishes it from "your request body was
      // malformed" and operators can see at a glance that the failure was
      // beyond our boundary. The response body's `code: "email_send_4xx"`
      // still carries the discriminator for finer-grained UI handling.
      return 502;
    case "throttle":
      return 429;
    case "5xx":
    case "internal":
    case "network":
    case "timeout":
    case "ambiguous":
      return 502;
  }
}

/**
 * Infer cadence from a periodKey shape — `YYYY-Www` → weekly, `YYYY-MM` →
 * monthly, `YYYY-Qq` → quarterly. Same rule the SPA uses for cadence-tag
 * derivation. Slice 1(c)/A keeps this local to avoid pulling cadence in via
 * an extra body field; matches the periodKey-only URL path.
 */
function inferCadenceFromPeriodKey(periodKey: string): "weekly" | "monthly" | "quarterly" | null {
  if (/^\d{4}-W\d{2}$/.test(periodKey)) return "weekly";
  if (/^\d{4}-\d{2}$/.test(periodKey)) return "monthly";
  if (/^\d{4}-Q[1-4]$/.test(periodKey)) return "quarterly";
  return null;
}

// `periodFromKey` imported for forward-compat with Slice 1(c)/B auto-capture.
void periodFromKey;

function badRequest(context: InvocationContext, message: string): HttpResponseInit {
  // Log every 400 so the operator can diagnose without devtools. Body
  // surface keeps the existing shape; logs add server-side observability.
  context.warn(
    `report.email.send.bad_request correlationId=${context.invocationId} message=${message}`,
  );
  return {
    status: 400,
    jsonBody: {
      error: { code: "bad_request", message, correlationId: context.invocationId },
    },
    headers: { "cache-control": "no-store" },
  };
}

function notConfigured(context: InvocationContext, message: string): HttpResponseInit {
  return {
    status: 503,
    jsonBody: {
      error: { code: "not_configured", message, correlationId: context.invocationId },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("emailReportSnapshot", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "reports/snapshots/{periodKey}/email",
  handler,
});

export { handler as emailReportSnapshotHandler };
