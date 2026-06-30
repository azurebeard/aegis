// GET /api/conditional-access/policies (ADR-0034 §3.3).
//
// Returns the full per-tenant CA policy snapshot. Sortable + searchable
// client-side by the SPA — corpus is small (5–20 policies typical) so
// no server-side filter/pagination needed. Reader-or-admin per the Phase
// 8B/8C precedent.
//
// Response field hygiene: the canonicalised JSON for `conditions`,
// `grantControls`, `sessionControls` is INCLUDED so the SPA can render
// human-readable summaries (e.g. "MFA required", "compliant device
// required", "block sign-in"). The fields are bounded at the parser
// (16/16/4 KB per ADR-0034 §3.3) so the response stays small.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveConditionalAccessApiConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { conditionalAccessListRateLimiter } from "../lib/rateLimit.js";
import {
  CONDITIONAL_ACCESS_TABLE_NAME,
  listConditionalAccessPolicies,
} from "../lib/conditionalAccessStore.js";
import { getTableClient } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const rate = conditionalAccessListRateLimiter.check(principal.userId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limited",
          message: "per-principal rate limit exceeded on /api/conditional-access/policies",
          correlationId: context.invocationId,
        },
      },
      headers: {
        "retry-after": Math.ceil(rate.retryAfterMs / 1000).toString(),
        "cache-control": "no-store",
      },
    };
  }

  const config = resolveConditionalAccessApiConfig();
  const caTable = getTableClient(
    { endpoint: config.opsTableEndpoint, managedIdentityClientId: config.apiReaderMiClientId },
    CONDITIONAL_ACCESS_TABLE_NAME,
  );

  try {
    const rows = await listConditionalAccessPolicies(caTable, config.tenantId);
    // Project: drop the ingest-internal fields (ingestRunId, ingestedAt)
    // so the client doesn't take a dependency on them.
    const items = rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      state: r.state,
      createdDateTime: r.createdDateTime,
      modifiedDateTime: r.modifiedDateTime,
      conditions: r.conditions,
      grantControls: r.grantControls,
      sessionControls: r.sessionControls,
    }));
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        items,
      },
      headers: {
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`conditionalAccess.policies.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "conditional-access policies are temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("getConditionalAccessPolicies", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "conditional-access/policies",
  handler,
});
