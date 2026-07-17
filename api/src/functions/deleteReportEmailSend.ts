// DELETE /api/reports/email/sends/{graphMessageId}
//
// ADR-0030 Phase C §C.10 — right-to-erasure for plaintext recipient rows.
// Removes the TenantSettings `report-email-send:<graphMessageId>` row only;
// the audit chain entries (intent + sent/failed) are NOT touched (chain
// integrity is non-negotiable per §C.7). After erasure, chain replay still
// surfaces "send happened, plaintext purged" via the salted recipient hash
// on the intent line.
//
// Emits an `aievent.report.email.historyRowDeleted` so the operator's
// compliance trail records the erasure ACTION itself — closes the loop on
// "we honoured the request".

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden } from "../lib/httpAuthResponses.js";
import { resolveIngestConfig } from "../lib/config.js";
import { reportEmailDeleteRateLimiter } from "../lib/rateLimit.js";
import { deleteReportEmailSend } from "../lib/tenantSettingsStore.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import { emitAievent } from "../lib/aievent.js";

/** WS10 Slice 1(c)/B3 MEDIUM #1 — same validator as the Get handler; reject
 *  Azure-Table-key-illegal chars before issuing a delete. */
const GRAPH_MESSAGE_ID_REGEX = /^[A-Za-z0-9_\-=.@:+]{1,256}$/;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal || !principal.userRoles.includes("admin")) {
    return forbidden(context, "report email send erasure requires the admin role");
  }

  const graphMessageId = (request.params.graphMessageId ?? "").trim();
  if (!graphMessageId) {
    return badRequest(context, "graphMessageId path parameter is required");
  }
  if (!GRAPH_MESSAGE_ID_REGEX.test(graphMessageId)) {
    return badRequest(
      context,
      "graphMessageId must be 1-256 chars of [A-Za-z0-9_-=.@:+]",
    );
  }

  const ingestConfig = resolveIngestConfig();
  const mailSenderMiClientId = (process.env.MAIL_SENDER_MI_CLIENT_ID ?? "").trim();
  if (mailSenderMiClientId.length === 0) {
    return notConfigured(
      context,
      "MAIL_SENDER_MI_CLIENT_ID is not set — DELETE requires the mailSender MI's Table Data Contributor grant on TenantSettings.",
    );
  }

  // §C.10 per-admin rate-limit. Keyed by principal.userId so a single
  // misbehaving admin can't flood the audit/telemetry surface; other
  // admins keep their own budgets. Applied after the auth + mailSender
  // gates so an unauthenticated / inert-deployment caller never burns
  // a budget slot. 30/day per admin (ADMIN_RUN ceiling parity).
  const rate = reportEmailDeleteRateLimiter.check(principal.userId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limited",
          message: `report email erasure is capped at 30/24h per admin; retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`,
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

  // The mailSender MI is the only principal with Table Data Contributor on
  // TenantSettings — required for the delete operation.
  const table = getTableClient(
    {
      endpoint: ingestConfig.opsTableEndpoint,
      managedIdentityClientId: mailSenderMiClientId,
    },
    OPS_TABLES.TenantSettings,
  );

  const deleted = await deleteReportEmailSend(
    table,
    ingestConfig.tenantId,
    graphMessageId,
  );

  // Emit the erasure-action telemetry whether or not a row was present (so a
  // replay of a previously-erased graphMessageId still records the operator's
  // intent + decision).
  emitAievent(context, "report.email.historyRowDeleted", {
    tenantId: ingestConfig.tenantId,
    graphMessageId,
    operatorPrincipal: principal.userId,
    rowFound: deleted,
    correlationId: context.invocationId,
  });

  return {
    status: 200,
    jsonBody: {
      schemaVersion: 1,
      graphMessageId,
      deleted,
      auditChainNote:
        "Audit chain entries (report.email.intent + report.email.sent) remain unchanged; chain integrity is non-negotiable per ADR-0030 §C.7.",
    },
    headers: { "cache-control": "no-store" },
  };
};

function badRequest(context: InvocationContext, message: string): HttpResponseInit {
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

app.http("deleteReportEmailSend", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "reports/email/sends/{graphMessageId}",
  handler,
});

export { handler as deleteReportEmailSendHandler };
