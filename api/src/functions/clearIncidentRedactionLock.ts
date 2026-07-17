// DELETE /api/ingest/incidents/{id}/redaction-lock — admin-only clear of the
// per-incident redaction lock (ADR-0028 §Decision.7d operator override).
//
// Admin-gated via SWA `/api/ingest/*` → ["admin"] rule. 200 on cleared,
// 200 on no-op (already unlocked), 404 when no cache row exists for the
// incident.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { emitAievent } from "../lib/aievent.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import {
  INCIDENT_ID_REGEX,
  IncidentIdRejectedError,
  validateIncidentId,
} from "../lib/incidentsParser.js";
import {
  clearRedactionLock,
  INCIDENT_ANALYSIS_CACHE_TABLE_NAME,
  isRedactionLockActive,
  readCache,
} from "../lib/incidentAnalysisCache.js";
import { getTableClient } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);

  const rawId = request.params.id;
  const decodedId = rawId ? decodeURIComponent(rawId) : "";
  try {
    validateIncidentId(decodedId);
  } catch (err) {
    if (err instanceof IncidentIdRejectedError) {
      return badRequest(
        context,
        `path parameter \`id\` does not match ${INCIDENT_ID_REGEX.source}: ${err.reason}`,
      );
    }
    return badRequest(context, "path parameter `id` is invalid");
  }

  const agentConfig = resolveBriefAgentConfig();
  // Write via the agent MI (Contributor on IncidentAnalysisCache) — not the
  // ingest MI (which does not hold that grant). Keeps the table's writer
  // identity consistent with runIncidentsAgent.ts. Single resolver call —
  // BriefAgentConfig already carries opsTableEndpoint.
  const opsCtx = {
    endpoint: agentConfig.opsTableEndpoint,
    managedIdentityClientId: agentConfig.agentMiClientId,
  };
  const cacheTable = getTableClient(opsCtx, INCIDENT_ANALYSIS_CACHE_TABLE_NAME);

  try {
    const existing = await readCache(cacheTable, agentConfig.tenantId, decodedId);
    if (!existing) {
      return {
        status: 404,
        jsonBody: {
          error: {
            code: "incident_analysis_not_found",
            message: `no analysis row for incident ${decodedId}`,
            correlationId: context.invocationId,
          },
          incidentId: decodedId,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    const wasLocked = isRedactionLockActive(existing, new Date());
    const after = await clearRedactionLock(cacheTable, agentConfig.tenantId, decodedId);
    emitAievent(context, "IncidentsRedactionLockCleared", {
      tenantId: agentConfig.tenantId,
      incidentId: decodedId,
      wasLocked,
      principal: principal.userDetails ?? principal.userId,
    });
    return {
      status: 200,
      jsonBody: {
        incidentId: decodedId,
        wasLocked,
        redactionLock: {
          active: false,
          until: after?.redactionLockUntil ?? null,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`incidents.redaction_lock_clear.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "incidents analysis store is temporarily unavailable",
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
    jsonBody: {
      error: {
        code: "bad_request",
        message,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("clearIncidentRedactionLock", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "ingest/incidents/{id}/redaction-lock",
  handler,
});
