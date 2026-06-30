// PATCH /api/stack/items/{id} — ADR-0031 §4. Admin-gated.

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
import { updateStackItem } from "../lib/stackItemsStore.js";
import {
  isValidStackItemId,
  validatePatchBody,
} from "../lib/stackItemsValidation.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const MAX_BODY_BYTES = 4096;

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
    return forbidden(context, "stack-item update requires the admin role");
  }

  const id = request.params["id"] ?? "";
  if (!isValidStackItemId(id)) return badRequest(context, "id must be a UUID");

  const lenHeader = request.headers.get("content-length");
  if (lenHeader !== null) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) return payloadTooLarge(context);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return badRequest(context, "unable to read request body");
  }
  if (Buffer.byteLength(raw, "utf-8") > MAX_BODY_BYTES) return payloadTooLarge(context);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return badRequest(context, "body is not valid JSON");
  }

  const validated = validatePatchBody(parsed);
  if ("error" in validated) return badRequest(context, validated.error);

  const config = resolveIngestConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const table = getTableClient(tableCtx, OPS_TABLES.StackItems);

  try {
    const updated = await updateStackItem(table, {
      tenantId: config.tenantId,
      id,
      patch: validated.value,
      updatedBy: principal.userId,
      now: new Date().toISOString(),
    });
    if (!updated) {
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
    emitAievent(context, "StackItemChange", {
      action: "stack-item-update",
      tenantId: config.tenantId,
      principal: principal.userId,
      id,
      vendor: updated.vendor,
      product: updated.product,
      changed: Object.keys(validated.value),
    });
    return {
      status: 200,
      jsonBody: { schemaVersion: 1, item: updated },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`stack.items.update.error ${String((err as Error).message ?? err)}`);
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

function badRequest(context: InvocationContext, message: string): HttpResponseInit {
  return {
    status: 400,
    jsonBody: { error: { code: "bad_request", message, correlationId: context.invocationId } },
    headers: { "cache-control": "no-store" },
  };
}

function payloadTooLarge(context: InvocationContext): HttpResponseInit {
  return {
    status: 413,
    jsonBody: {
      error: {
        code: "payload_too_large",
        message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("patchStackItem", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "stack/items/{id}",
  handler,
});
