// GET /api/reports/email/sends
//
// ADR-0030 Phase C §C.16 — admin-paginated list of send-history rows.
// Each item is projected (no `recipients[]`) for PII minimisation; full
// recipient list is in GET /api/reports/email/sends/{graphMessageId}.

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
import {
  listReportEmailSends,
  LIST_REPORT_EMAIL_SENDS_DEFAULT_LIMIT,
  LIST_REPORT_EMAIL_SENDS_MAX_LIMIT,
} from "../lib/tenantSettingsStore.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal || !principal.userRoles.includes("admin")) {
    return forbidden(context, "report email sends list requires the admin role");
  }

  const limitRaw = request.query.get("limit");
  let limit = LIST_REPORT_EMAIL_SENDS_DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return badRequest(context, "limit must be a positive integer");
    }
    if (parsed > LIST_REPORT_EMAIL_SENDS_MAX_LIMIT) {
      return badRequest(
        context,
        `limit must be ≤ ${LIST_REPORT_EMAIL_SENDS_MAX_LIMIT}`,
      );
    }
    limit = parsed;
  }
  const continuationToken = request.query.get("continuationToken");

  const ingestConfig = resolveIngestConfig();
  const table = getTableClient(
    {
      endpoint: ingestConfig.opsTableEndpoint,
      managedIdentityClientId: ingestConfig.apiReaderMiClientId,
    },
    OPS_TABLES.TenantSettings,
  );

  const result = await listReportEmailSends(table, {
    tenantId: ingestConfig.tenantId,
    limit,
    continuationToken,
  });

  return {
    status: 200,
    jsonBody: {
      schemaVersion: 1,
      items: result.items,
      continuationToken: result.continuationToken,
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

app.http("listReportEmailSends", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "reports/email/sends",
  handler,
});
