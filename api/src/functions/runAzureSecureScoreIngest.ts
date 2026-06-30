// POST /api/ingest/azure-secure-score/run — admin-only manual trigger
// (ADR-0036). Shares the orchestrator with the daily Timer.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveAzureSecureScoreIngestConfig } from "../lib/config.js";
import { forbidden, unauthenticated } from "../lib/httpAuthResponses.js";
import {
  ADMIN_RUN_DAILY_CEILING,
  azureSecureScoreAdminRunRateLimiter,
} from "../lib/rateLimit.js";
import { runAzureSecureScoreIngestOnce } from "../lib/runAzureSecureScoreIngest.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (!principal.userRoles.includes("admin")) {
    return forbidden(context, "Defender for Cloud Secure Score ingest requires the admin role");
  }
  const config = resolveAzureSecureScoreIngestConfig();
  const rate = azureSecureScoreAdminRunRateLimiter.check(config.tenantId);
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
  const outcome = await runAzureSecureScoreIngestOnce(config, context, {
    trigger: "admin",
  });
  return {
    status: outcome.status === "error" ? 500 : 200,
    jsonBody: { outcome },
    headers: { "cache-control": "no-store" },
  };
};

app.http("runAzureSecureScoreIngest", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/azure-secure-score/run",
  handler,
});
