// POST /api/ingest/kev/run — admin-only manual KEV ingest trigger (ADR-0032 §1).
//
// SEC-H-INGEST-AUTH-MIGRATION — post ADR-0035 Phase D2 the SWA route gate
// `/api/ingest/* → ["admin"]` is gone. Auth enforced server-side: 401 on
// missing principal, 403 on non-admin.
//
// Per-tenant 30/day rate limit, matches the SecureScore / Incidents / EntraRisk
// admin endpoints (cross-vertical parity).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden, unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveKevIngestConfig } from "../lib/config.js";
import {
  ADMIN_RUN_DAILY_CEILING,
  kevAdminRunRateLimiter,
} from "../lib/rateLimit.js";
import { runKevIngestOnce } from "../lib/runKevIngest.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (!principal.userRoles.includes("admin")) {
    return forbidden(context, "kev ingest requires the admin role");
  }
  const config = resolveKevIngestConfig();
  const rate = kevAdminRunRateLimiter.check(config.tenantId);
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
  const outcome = await runKevIngestOnce(config, context);
  return {
    status: outcome.status === "error" ? 500 : 200,
    jsonBody: { outcome },
    headers: { "cache-control": "no-store" },
  };
};

app.http("runKevIngest", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/kev/run",
  handler,
});
