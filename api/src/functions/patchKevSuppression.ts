// PATCH /api/kev/suppressions/{stackItemId}/{cveID} — ADR-0033 §7.
//
// Admin-only. Body: { status, notes?, expiresAt? }. Upsert.
// Emits AIEVENT KevSuppressionChange with from→to transition.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { emitAievent } from "../lib/aievent.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden, unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveIngestConfig } from "../lib/config.js";
import {
  readSuppression,
  upsertSuppression,
} from "../lib/kevSuppressionsStore.js";
import {
  validateSuppressionPatchBody,
  validateSuppressionPath,
} from "../lib/kevSuppressionsValidation.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const MAX_BODY_BYTES = 1024;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (!principal.userRoles.includes("admin")) {
    return forbidden(context, "kev-suppression update requires the admin role");
  }

  const stackItemId = request.params["stackItemId"] ?? "";
  const cveID = request.params["cveID"] ?? "";
  const path = validateSuppressionPath(stackItemId, cveID);
  if ("error" in path) return badRequest(context, path.error);

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
  const validated = validateSuppressionPatchBody(parsed);
  if ("error" in validated) return badRequest(context, validated.error);

  const config = resolveIngestConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.ingestMiClientId,
  };
  const table = getTableClient(tableCtx, OPS_TABLES.KevSuppressions);

  try {
    const existing = await readSuppression(table, config.tenantId, stackItemId, cveID);
    const now = new Date().toISOString();
    const result = await upsertSuppression(table, {
      tenantId: config.tenantId,
      stackItemId,
      cveID,
      status: validated.value.status,
      notes: validated.value.notes,
      expiresAt: validated.value.expiresAt,
      updatedBy: principal.userId,
      now,
    });
    emitAievent(context, "KevSuppressionChange", {
      action: "kev-suppression-set",
      tenantId: config.tenantId,
      principal: principal.userId,
      stackItemId,
      cveID,
      from: existing?.status ?? "open",
      to: validated.value.status,
      expiresAt: validated.value.expiresAt || null,
    });
    return {
      status: 200,
      jsonBody: { schemaVersion: 1, suppression: result },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`kev.suppression.upsert.error ${String((err as Error).message ?? err)}`);
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

app.http("patchKevSuppression", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "kev/suppressions/{stackItemId}/{cveID}",
  handler,
});
