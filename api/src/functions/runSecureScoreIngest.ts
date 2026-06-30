// POST /api/ingest/secure-score/run — admin-only manual trigger (ADR-0011 §1).
//
// SEC-H-INGEST-AUTH-MIGRATION — post ADR-0035 Phase D2 the SWA route gate
// `/api/ingest/* → ["admin"]` is gone (SPA→FA proxy with FA-side JWT
// authoritative). Auth must be enforced server-side here. Returns 401 on
// missing principal, 403 on non-admin. The Function itself remains
// `authLevel: "anonymous"` per repo convention (SWA→FA proxy is the only
// caller path).
//
// Per-tenant 30/day rate limit —
// matches the entra-risk + brief admin endpoints so a misbehaving Refresh-
// now button can't burn Graph quota faster on SecureScore than on any
// other tile. Keyed by tenantId so multiple admins share the budget.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden, unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveIngestConfig } from "../lib/config.js";
import {
  ADMIN_RUN_DAILY_CEILING,
  secureScoreAdminRunRateLimiter,
} from "../lib/rateLimit.js";
import { runSecureScoreIngestOnce } from "../lib/runSecureScoreIngest.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (!principal.userRoles.includes("admin")) {
    return forbidden(context, "secure-score ingest requires the admin role");
  }
  const config = resolveIngestConfig();
  const rate = secureScoreAdminRunRateLimiter.check(config.tenantId);
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
  const outcome = await runSecureScoreIngestOnce(config, context);
  return {
    status: outcome.status === "error" ? 500 : 200,
    jsonBody: { outcome },
    headers: { "cache-control": "no-store" },
  };
};

app.http("runSecureScoreIngest", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/secure-score/run",
  handler,
});
