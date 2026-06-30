// POST /api/ingest/incidents/{id}/analyse — admin-only on-demand incidents-
// agent trigger (ADR-0028 §Decision.3).
//
// Body is empty; the `{id}` path param identifies the incident. Admin gate
// via SWA `/api/ingest/*` → ["admin"] rule. Returns the JSON envelope on
// success (committed/cache_hit/redaction_locked), 404 on incident-not-found,
// 429 on budget exhaustion, 503 on circuit-open.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import {
  INCIDENT_ID_REGEX,
  IncidentIdRejectedError,
  validateIncidentId,
} from "../lib/incidentsParser.js";
import { runIncidentsAgent } from "../lib/runIncidentsAgent.js";

const MAX_BODY_BYTES = 256;

export const analyseIncidentHandler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);

  // Body MUST be empty for this endpoint (ADR-0028 §Decision.3 — the
  // `{id}` path param identifies the incident; no other shape). The
  // 256-byte cap catches polite clients; the stricter empty-check below
  // rejects any body content before we spend any budget. Two-gate pattern
  // mirrors SEC-M-STEP5-CODE-05 for Content-Length + post-buffer-parse.
  const lenHeader = request.headers.get("content-length");
  if (lenHeader !== null) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return payloadTooLarge(context);
    }
  }
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    return badRequest(context, "unable to read request body");
  }
  if (Buffer.byteLength(rawBody, "utf-8") > MAX_BODY_BYTES) {
    return payloadTooLarge(context);
  }
  // SEC-L-B3-02 resolution — enforce the empty-body contract. Whitespace
  // tolerance is defensive; any non-whitespace content is a contract
  // violation and we fail loud before running the agent.
  if (rawBody.trim().length > 0) {
    return badRequest(context, "request body must be empty");
  }

  // Incident ID path param — validate under ADR-0014 §3.2.
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

  try {
    const result = await runIncidentsAgent({
      trigger: "admin",
      incidentId: decodedId,
      context,
    });
    if (result.status === "not_found") {
      return {
        status: 404,
        jsonBody: {
          error: {
            code: "incident_not_found",
            message: `incident ${decodedId} not found`,
            correlationId: context.invocationId,
          },
          incidentId: decodedId,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    if (result.status === "budget_exhausted") {
      return {
        status: 429,
        jsonBody: {
          error: {
            code: "rate_limited",
            message: `manual incidents-agent ceiling exceeded: ${result.reason ?? "budget"}`,
            correlationId: context.invocationId,
          },
          incidentId: decodedId,
        },
        headers: { "retry-after": "3600", "cache-control": "no-store" },
      };
    }
    if (result.status === "circuit_open") {
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "agent_unavailable",
            message: "incidents agent circuit is open",
            correlationId: context.invocationId,
          },
          incidentId: decodedId,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    if (result.status === "error") {
      return {
        status: 500,
        jsonBody: {
          error: {
            code: "agent_error",
            message: result.reason ?? "agent run failed",
            correlationId: context.invocationId,
          },
          incidentId: decodedId,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    return {
      status: 202,
      jsonBody: {
        status: result.status,
        incidentId: decodedId,
        runId: result.runId,
        ...(result.outputSha256 ? { outputSha256: result.outputSha256 } : {}),
        ...(result.supersedingRunId
          ? { supersedingRunId: result.supersedingRunId }
          : {}),
        ...(result.degraded ? { degraded: true } : {}),
        ...(result.redactedFields && result.redactedFields.length > 0
          ? { redactedFields: result.redactedFields }
          : {}),
        ...(result.redactionLockUntil
          ? { redactionLockUntil: result.redactionLockUntil }
          : {}),
      },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(
      `incidents.analyse.error ${(err as Error).message ?? String(err)}`,
    );
    return {
      status: 500,
      jsonBody: {
        error: {
          code: "agent_error",
          message: "incidents agent run failed",
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

function payloadTooLarge(context: InvocationContext): HttpResponseInit {
  return {
    status: 413,
    jsonBody: {
      error: {
        code: "payload_too_large",
        message: `request body must be ≤ ${MAX_BODY_BYTES} bytes`,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("analyseIncident", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/incidents/{id}/analyse",
  handler: analyseIncidentHandler,
});
