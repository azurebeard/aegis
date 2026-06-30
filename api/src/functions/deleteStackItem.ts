// DELETE /api/stack/items/{id} — ADR-0031 §4. Admin-gated, idempotent.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { emitAievent } from "../lib/aievent.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden } from "../lib/httpAuthResponses.js";
import { resolveIngestConfig } from "../lib/config.js";
import {
  deleteStackItem,
  readStackItem,
} from "../lib/stackItemsStore.js";
import { isValidStackItemId } from "../lib/stackItemsValidation.js";
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
    return forbidden(context, "stack-item delete requires the admin role");
  }

  const id = request.params["id"] ?? "";
  if (!isValidStackItemId(id)) {
    return {
      status: 400,
      jsonBody: {
        error: { code: "bad_request", message: "id must be a UUID", correlationId: context.invocationId },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const config = resolveIngestConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const table = getTableClient(tableCtx, OPS_TABLES.StackItems);

  try {
    // Read first so the audit event captures vendor/product context. The
    // double round-trip on a rare path (operator deletes, days/weeks apart
    // typically) is cheap insurance for forensic traceability.
    const existing = await readStackItem(table, config.tenantId, id);
    if (!existing) {
      // Idempotent — second delete returns 404 same as never-existed.
      return {
        status: 404,
        jsonBody: {
          error: {
            code: "not_found",
            message: `stack item ${id} not found`,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    await deleteStackItem(table, config.tenantId, id);
    emitAievent(context, "StackItemChange", {
      action: "stack-item-delete",
      tenantId: config.tenantId,
      principal: principal.userId,
      id,
      vendor: existing.vendor,
      product: existing.product,
    });
    return { status: 204, headers: { "cache-control": "no-store" } };
  } catch (err) {
    context.error(`stack.items.delete.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "stack inventory store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("deleteStackItem", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "stack/items/{id}",
  handler,
});
