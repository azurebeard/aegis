// GET /api/reports/email/sends/{graphMessageId}
//
// ADR-0030 Phase C §C.16 — admin single-row fetch. Includes the plaintext
// recipients list (PII — only served to admins, no caching).

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
import { readReportEmailSend } from "../lib/tenantSettingsStore.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

/** WS10 Slice 1(c)/B3 MEDIUM #1 — Azure Tables RowKey forbids `/\\#?` and
 *  control chars. Graph message IDs are base64url-ish; this regex matches
 *  the safe subset and rejects anything else with a clean 400 before the
 *  Tables SDK surfaces a generic InvalidInput 500. */
const GRAPH_MESSAGE_ID_REGEX = /^[A-Za-z0-9_\-=.@:+]{1,256}$/;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal || !principal.userRoles.includes("admin")) {
    return forbidden(context, "report email send detail requires the admin role");
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
  const table = getTableClient(
    {
      endpoint: ingestConfig.opsTableEndpoint,
      managedIdentityClientId: ingestConfig.apiReaderMiClientId,
    },
    OPS_TABLES.TenantSettings,
  );

  const row = await readReportEmailSend(table, ingestConfig.tenantId, graphMessageId);
  if (!row) {
    return {
      status: 404,
      jsonBody: {
        error: {
          code: "send_not_found",
          message: `No send-history row for graphMessageId=${graphMessageId}. The row may have been erased (right-to-erasure) — audit chain still records the send.`,
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  return {
    status: 200,
    jsonBody: {
      schemaVersion: 1,
      graphMessageId: row.graphMessageId,
      periodKey: row.periodKey,
      sentAt: row.sentAt,
      senderMailbox: row.senderMailbox,
      recipients: row.recipients,
      operatorPrincipal: row.operatorPrincipal,
      internetMessageId: row.internetMessageId,
      clientRequestId: row.clientRequestId,
      auditLineSeq: row.auditLineSeq,
      auditLineSha256: row.auditLineSha256,
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

app.http("getReportEmailSend", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "reports/email/sends/{graphMessageId}",
  handler,
});
