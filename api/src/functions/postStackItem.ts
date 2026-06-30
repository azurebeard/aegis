// POST /api/stack/items — ADR-0031 §4. Admin-gated.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { randomUUID } from "node:crypto";
import { emitAievent } from "../lib/aievent.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden } from "../lib/httpAuthResponses.js";
import { resolveIngestConfig } from "../lib/config.js";
import {
  createStackItem,
  StackItemsCapReachedError,
} from "../lib/stackItemsStore.js";
import { validateCreateBody } from "../lib/stackItemsValidation.js";
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
    return forbidden(context, "stack-item create requires the admin role");
  }

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

  const validated = validateCreateBody(parsed);
  if ("error" in validated) return badRequest(context, validated.error);

  const config = resolveIngestConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const table = getTableClient(tableCtx, OPS_TABLES.StackItems);

  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    const item = await createStackItem(table, {
      tenantId: config.tenantId,
      id,
      vendor: validated.value.vendor,
      product: validated.value.product,
      version: validated.value.version,
      category: validated.value.category,
      environment: validated.value.environment,
      notes: validated.value.notes,
      tags: validated.value.tags,
      addedBy: principal.userId,
      now,
    });

    emitAievent(context, "StackItemChange", {
      action: "stack-item-add",
      tenantId: config.tenantId,
      principal: principal.userId,
      id,
      vendor: item.vendor,
      product: item.product,
    });

    return {
      status: 201,
      jsonBody: { schemaVersion: 1, item },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    if (err instanceof StackItemsCapReachedError) {
      return {
        status: 409,
        jsonBody: {
          error: {
            code: "cap_reached",
            message: `stack inventory cap reached (${err.cap}); delete an existing item before adding more`,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    context.error(`stack.items.create.error ${String((err as Error).message ?? err)}`);
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

app.http("postStackItem", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "stack/items",
  handler,
});
