// DELETE /api/kev/suppressions/{stackItemId}/{cveID} — ADR-0033 §7.
// Admin-only. Idempotent — 204 on delete OR 404 (already absent).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { emitAievent } from "../lib/aievent.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveIngestConfig } from "../lib/config.js";
import {
  deleteSuppression,
  readSuppression,
} from "../lib/kevSuppressionsStore.js";
import { validateSuppressionPath } from "../lib/kevSuppressionsValidation.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) {
    return {
      status: 401,
      jsonBody: {
        error: {
          code: "unauthenticated",
          message: "authentication required",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
  if (!principal.userRoles.includes("admin")) {
    return {
      status: 403,
      jsonBody: {
        error: {
          code: "forbidden",
          message: "kev-suppression delete requires the admin role",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const stackItemId = request.params["stackItemId"] ?? "";
  const cveID = request.params["cveID"] ?? "";
  const path = validateSuppressionPath(stackItemId, cveID);
  if ("error" in path) {
    return {
      status: 400,
      jsonBody: {
        error: { code: "bad_request", message: path.error, correlationId: context.invocationId },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const config = resolveIngestConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const table = getTableClient(tableCtx, OPS_TABLES.KevSuppressions);

  try {
    // Read first so the audit emits the prior status. Costs one round-trip
    // but the workflow change is rare and forensic clarity matters.
    const existing = await readSuppression(table, config.tenantId, stackItemId, cveID);
    if (!existing) {
      return {
        status: 404,
        jsonBody: {
          error: {
            code: "not_found",
            message: "no suppression to clear",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    await deleteSuppression(table, config.tenantId, stackItemId, cveID);
    emitAievent(context, "KevSuppressionChange", {
      action: "kev-suppression-clear",
      tenantId: config.tenantId,
      principal: principal.userId,
      stackItemId,
      cveID,
      from: existing.status,
      to: "open",
    });
    return { status: 204, headers: { "cache-control": "no-store" } };
  } catch (err) {
    context.error(`kev.suppression.delete.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "kev suppressions store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("deleteKevSuppression", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "kev/suppressions/{stackItemId}/{cveID}",
  handler,
});
