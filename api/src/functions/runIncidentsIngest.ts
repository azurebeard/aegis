// POST /api/ingest/incidents/run — admin-only manual Incidents ingest.
//
// SEC-H-INGEST-AUTH-MIGRATION — post ADR-0035 Phase D2 the SWA route gate
// `/api/ingest/* → ["admin"]` is gone. Auth enforced server-side: 401 on
// missing principal, 403 on non-admin.
//
// Per-tenant 30/day rate limit —
// parity with entra-risk + brief + secure-score admin endpoints so a
// misbehaving Refresh-now button can't burn Graph quota faster on
// Incidents than on any other tile.

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
import {
  ADMIN_RUN_DAILY_CEILING,
  incidentsAdminRunRateLimiter,
} from "../lib/rateLimit.js";
import { runIncidentsIngestOnce } from "../lib/runIncidentsIngest.js";

const MAX_BODY_BYTES = 1024;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (!principal.userRoles.includes("admin")) {
    return forbidden(context, "incidents ingest requires the admin role");
  }
  // WS10 SEC-L-STEP4-CODE-02: admin endpoints accept no input body; a
  // client that sends one is either misconfigured or probing. Cap at 1KB to
  // keep the attack surface nil even though the body is never read.
  const lenHeader = request.headers.get("content-length");
  if (lenHeader !== null) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return {
        status: 400,
        jsonBody: {
          error: {
            code: "bad_request",
            message: `request body must be ≤ ${MAX_BODY_BYTES} bytes`,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
  }
  const config = resolveIncidentsIngestConfig();
  const rate = incidentsAdminRunRateLimiter.check(config.tenantId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limit_endpoint",
          message: `admin-endpoint budget exhausted: ${ADMIN_RUN_DAILY_CEILING}/day per tenant`,
          correlationId: context.invocationId,
        },
      },
      headers: {
        "retry-after": Math.ceil(rate.retryAfterMs / 1000).toString(),
        "cache-control": "no-store",
      },
    };
  }
  const outcome = await runIncidentsIngestOnce(config, context);
  return {
    status: outcome.status === "error" ? 500 : 200,
    jsonBody: { outcome },
    headers: { "cache-control": "no-store" },
  };
};

app.http("runIncidentsIngest", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/incidents/run",
  handler,
});
