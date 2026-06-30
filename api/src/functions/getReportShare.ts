// GET /api/reports/share/{token}
//
// ADR-0030 §C.22 (forthcoming) — chunk 2 of the email-to-link migration.
// Token-gated public endpoint that renders the full HTML report a previous
// email send linked to. The token IS the auth: no admin-role gate, no
// client-principal check. Verification of the HMAC-signed token against the
// Key Vault signing key (`reportShareSigningKey.ts`) is the security
// boundary.
//
// Trust model recap (full discussion in `reportShareToken.ts` header):
//   - Anyone holding a valid, unexpired token can read the snapshot.
//   - Recipients can forward; forwarded readers see the same view.
//   - Tokens have a 14-day TTL (default at issue, chunk 3).
//   - Rotation of the KV signing key invalidates all outstanding tokens.
//
// Response headers (defense in depth):
//   - cache-control: private, no-store    — no shared cache, no browser cache
//   - referrer-policy: no-referrer        — prevents URL leak via Referer
//   - x-content-type-options: nosniff     — MIME-type pinning
//   - content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:
//     — defense-in-depth against an injection via envelope fields. The
//       envelope is operator-controlled (admin-rendered) but a defective
//       upstream could let attacker-controlled strings reach renderEnvelopeHtml;
//       the CSP caps the blast radius. `style-src unsafe-inline` is required
//       because reportHtml.ts inlines `<style>` blocks; we do NOT enable
//       `script-src` so JS injection is rejected by the browser.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { resolveIngestConfig } from "../lib/config.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import { readLatestSnapshot } from "../lib/reportSnapshotStore.js";
import { renderEnvelopeHtml } from "../lib/reportHtml.js";
import { loadReportShareSigningKey } from "../lib/reportShareSigningKey.js";
import { verifyReportShareToken } from "../lib/reportShareToken.js";
import { emitReportHtmlShareReadAudit } from "../lib/reportHtmlShareAudit.js";

/** Quick cheap guard so a malformed path doesn't reach the verifier. The
 *  full base64url-alphabet + dot-separator check is part of the verifier;
 *  this regex only rejects obvious junk to keep the log surface clean. */
const TOKEN_PATH_REGEX = /^[A-Za-z0-9_.\-]{8,4096}$/;

const SECURITY_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // CSP extras: `form-action 'none'` guards a future
  // template that adds a `<form>`; `base-uri 'none'` blocks a `<base>` tag
  // injection redirecting relative URLs; `frame-ancestors 'none'` blocks
  // clickjacking via iframe embedding on an attacker page. None are
  // exploitable today; all are one-line hardening.
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
} as const;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const token = (request.params.token ?? "").trim();
  if (!TOKEN_PATH_REGEX.test(token)) {
    context.warn(
      `report.html.share.bad_token_shape correlationId=${context.invocationId}`,
    );
    return errorResponse(400, "invalid_token", "Token is malformed.", context);
  }

  const keyResult = await loadReportShareSigningKey();
  if (keyResult.key === null) {
    context.warn(
      `report.html.share.signing_key_unavailable correlationId=${context.invocationId} fallbackReason=${keyResult.fallbackReason}${keyResult.errorDetail ? ` errorDetail=${keyResult.errorDetail}` : ""}`,
    );
    return errorResponse(
      503,
      "share_link_unavailable",
      "Share links are temporarily unavailable. Ask the sender to retry the email; if the problem persists they should contact the operator.",
      context,
    );
  }

  const verifyResult = verifyReportShareToken(token, keyResult.key, Date.now());
  if (!verifyResult.valid) {
    const reason = verifyResult.reason;
    // 410 Gone for expired (the user can ask for a fresh link); 400 for
    // every signature / shape / version failure (those are "this link is
    // never going to work"). The body code mirrors the reason so the
    // operator can pivot on it in observability.
    if (reason === "expired") {
      return errorResponse(
        410,
        "link_expired",
        "This share link has expired. Ask the sender to send the report again to get a fresh link.",
        context,
      );
    }
    context.warn(
      `report.html.share.invalid_token correlationId=${context.invocationId} reason=${reason}`,
    );
    return errorResponse(
      400,
      reason === "unsupported_version" ? "unsupported_token_version" : "invalid_token",
      "This share link is invalid. Ask the sender to send the report again.",
      context,
    );
  }

  const { t: tenantId, p: periodKey, jti } = verifyResult.claims;

  const ingestConfig = resolveIngestConfig();
  // Operator policy: a token MUST be scoped to the tenant the FA is running
  // for. The signing-key boundary already enforces this — only this FA's
  // signing key could have minted a token with our tenantId — but the
  // explicit check makes a future multi-tenant-FA refactor fail loud.
  if (tenantId !== ingestConfig.tenantId) {
    context.warn(
      `report.html.share.tenant_mismatch correlationId=${context.invocationId} jti=${jti} tokenTenant=${tenantId}`,
    );
    return errorResponse(400, "invalid_token", "This share link is invalid.", context);
  }

  const table = getTableClient(
    {
      endpoint: ingestConfig.opsTableEndpoint,
      managedIdentityClientId: ingestConfig.apiReaderMiClientId,
    },
    OPS_TABLES.ReportSnapshots,
  );

  const envelope = await readLatestSnapshot(table, tenantId, periodKey);
  if (envelope === null) {
    context.warn(
      `report.html.share.snapshot_missing correlationId=${context.invocationId} periodKey=${periodKey} jti=${jti}`,
    );
    return errorResponse(
      404,
      "snapshot_not_found",
      `No snapshot exists for period ${periodKey}. The snapshot may have been deleted via the right-to-erasure flow.`,
      context,
    );
  }

  context.log(
    `report.html.share.read correlationId=${context.invocationId} periodKey=${periodKey} jti=${jti}`,
  );

  // ADR-0030 §C.22 — privacy-tracking audit-chain emission. Best-effort:
  // a write failure on this user-facing read path logs a warn breadcrumb
  // but does NOT 500 the reader. The verifier surfaces chain gaps on
  // the next sweep; recovery is manual reconciliation against the
  // FunctionApp log line above (same correlationId + jti).
  try {
    const auditHealthTable = getTableClient(
      {
        endpoint: ingestConfig.opsTableEndpoint,
        // The ingest MI is the only principal with Storage Table Data
        // Contributor on `IngestHealth` — the audit MI is blob-only
        // and 401s on table writes (mirrors emailReportSnapshot.ts:127).
        managedIdentityClientId: ingestConfig.ingestMiClientId,
      },
      OPS_TABLES.IngestHealth,
    );
    const result = await emitReportHtmlShareReadAudit(
      {
        healthTable: auditHealthTable,
        auditCtx: {
          blobEndpoint: ingestConfig.auditBlobEndpoint,
          auditContainerName: ingestConfig.auditContainerName,
          managedIdentityClientId: ingestConfig.auditMiClientId,
        },
      },
      {
        tenantId,
        periodKey,
        tokenJti: jti,
        readAt: new Date().toISOString(),
        callerPrincipalMiClientId: ingestConfig.auditMiClientId,
      },
    );
    if (result.outcome === "lease_contended") {
      context.warn(
        `report.html.share.audit_lease_contended correlationId=${context.invocationId} jti=${jti} — concurrent reader won the chain advance; this read is unaudited.`,
      );
    }
  } catch (auditErr) {
    context.warn(
      `report.html.share.audit_write_failed correlationId=${context.invocationId} jti=${jti} message=${(auditErr as Error).message} — chain gap; SOC verifier will flag on next sweep.`,
    );
  }

  const html = renderEnvelopeHtml(envelope);

  return {
    status: 200,
    body: html,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...SECURITY_HEADERS,
    },
  };
};

function errorResponse(
  status: number,
  code: string,
  message: string,
  context: InvocationContext,
): HttpResponseInit {
  return {
    status,
    jsonBody: {
      error: {
        code,
        message,
        correlationId: context.invocationId,
      },
    },
    headers: SECURITY_HEADERS,
  };
}

export { handler as getReportShareHandler };

app.http("getReportShare", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "reports/share/{token}",
  handler,
});
