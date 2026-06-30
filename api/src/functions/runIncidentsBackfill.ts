// POST /api/ingest/incidents/backfill — admin-only historical backfill.
//
// SEC-H-INGEST-AUTH-MIGRATION — post ADR-0035 Phase D2 the SWA route gate
// `/api/ingest/* → ["admin"]` is gone. Auth enforced server-side: 401 on
// missing principal, 403 on non-admin.
//
// Body: { from: ISO8601, to: ISO8601 }. Max window 30 days (ADR-0014 §2).
// The forward cursor (IngestHealth.LastCursor) is NOT modified by a backfill
// run; it remains the forward cursor. Audit line eventType carries a
// `reason: "backfill"` so a verifier distinguishes historical from forward.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden, unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveIncidentsIngestConfig } from "../lib/config.js";
import { runIncidentsIngestOnce } from "../lib/runIncidentsIngest.js";

const ISO8601_STRICT_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_BODY_BYTES = 1024;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (!principal.userRoles.includes("admin")) {
    return forbidden(context, "incidents backfill requires the admin role");
  }
  // WS10 SEC-L-STEP4-CODE-02: cap the body at 1KB. Real backfill requests
  // are ~100 bytes of JSON; anything larger is a misconfigured client.
  const lenHeader = request.headers.get("content-length");
  if (lenHeader !== null) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return bad(context, `request body must be ≤ ${MAX_BODY_BYTES} bytes`);
    }
  }
  let body: { from?: unknown; to?: unknown };
  try {
    body = (await request.json()) as { from?: unknown; to?: unknown };
  } catch {
    return bad(context, "body is not valid JSON");
  }
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  if (!ISO8601_STRICT_Z.test(from) || !ISO8601_STRICT_Z.test(to)) {
    return bad(context, "`from` and `to` must be ISO8601 UTC with Z suffix");
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return bad(context, "`to` must be strictly greater than `from`");
  }
  if (toMs - fromMs > 30 * 86_400_000) {
    return bad(context, "backfill window must be ≤ 30 days");
  }

  try {
    const config = resolveIncidentsIngestConfig();
    const outcome = await runIncidentsIngestOnce(config, context, {
      mode: "backfill",
      backfillFrom: from,
      backfillTo: to,
    });
    return {
      status: outcome.status === "error" ? 500 : 200,
      jsonBody: { outcome },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(
      `incidents.backfill.error ${String((err as Error).message ?? err)}`,
    );
    return {
      status: 500,
      jsonBody: {
        error: {
          code: "internal_error",
          message: (err as Error).message ?? "backfill failed",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

function bad(context: InvocationContext, message: string): HttpResponseInit {
  return {
    status: 400,
    jsonBody: {
      error: { code: "bad_request", message, correlationId: context.invocationId },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("runIncidentsBackfill", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/incidents/backfill",
  handler,
});
