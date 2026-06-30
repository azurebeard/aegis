// POST /api/ingest/conditional-access/run — admin-only manual CA ingest
// (ADR-0034 §3.3).
//
// Shares the core orchestrator with the hourly Timer. Per-tenant 30/day
// rate limit; FA-side admin-role check enforces auth (post Phase D2 the
// SWA route gate is gone). Returns the typed outcome envelope.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveConditionalAccessIngestConfig } from "../lib/config.js";
import { forbidden, unauthenticated } from "../lib/httpAuthResponses.js";
import {
  ADMIN_RUN_DAILY_CEILING,
  conditionalAccessAdminRunRateLimiter,
} from "../lib/rateLimit.js";
import { runConditionalAccessIngestOnce } from "../lib/runConditionalAccessIngest.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (!principal.userRoles.includes("admin")) {
    return forbidden(context, "conditional-access ingest requires the admin role");
  }
  const config = resolveConditionalAccessIngestConfig();
  const rate = conditionalAccessAdminRunRateLimiter.check(config.tenantId);
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
  const outcome = await runConditionalAccessIngestOnce(config, context, {
    trigger: "admin",
  });
  return {
    status: outcome.status === "error" ? 500 : 200,
    jsonBody: { outcome },
    headers: { "cache-control": "no-store" },
  };
};

app.http("runConditionalAccessIngest", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/conditional-access/run",
  handler,
});
