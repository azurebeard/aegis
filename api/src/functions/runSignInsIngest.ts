// POST /api/ingest/sign-ins/run — admin manual Sign-ins ingest
// (ADR-0034 §1). Same defence-in-depth as Phase 8B run-trigger.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveSignInsIngestConfig } from "../lib/config.js";
import { signInsAdminRunRateLimiter } from "../lib/rateLimit.js";
import { runSignInsIngestOnce } from "../lib/runSignInsIngest.js";

const MAX_BODY_BYTES = 1024;

export const runSignInsIngestHandler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (hasAnyQueryParam(request)) return badRequest(context, "query string must be empty");
  const lenHeader = request.headers.get("content-length");
  if (lenHeader !== null) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return payloadTooLarge(context, `request body must be ≤ ${MAX_BODY_BYTES} bytes`);
    }
  }
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return badRequest(context, "unable to read request body");
  }
  if (Buffer.byteLength(rawBody, "utf-8") > MAX_BODY_BYTES) {
    return payloadTooLarge(context, `request body must be ≤ ${MAX_BODY_BYTES} bytes`);
  }

  const config = resolveSignInsIngestConfig();
  const rate = signInsAdminRunRateLimiter.check(config.tenantId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limit_endpoint",
          message: `admin-endpoint budget exhausted: ${config.adminDailyRunCeiling}/day per tenant`,
          correlationId: context.invocationId,
        },
      },
      headers: {
        "retry-after": Math.ceil(rate.retryAfterMs / 1000).toString(),
        "cache-control": "no-store",
      },
    };
  }

  try {
    const outcome = await runSignInsIngestOnce(config, context, { trigger: "admin" });
    if (outcome.status === "error") {
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "dependency_unavailable",
            message: outcome.error?.message ?? "ingest run failed",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    return {
      status: 202,
      jsonBody: {
        schemaVersion: 1,
        runId: outcome.runId,
        startedAt: outcome.startedAt,
        status: outcome.status,
        signInsIngested: outcome.signInsIngested,
        outOfAreaCount: outcome.outOfAreaCount,
        retentionDeleted: outcome.signInsRetentionDeleted,
        licenceState: outcome.licenceState,
      },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`signIns.admin.run.error ${String((err as Error).message ?? err)}`);
    return {
      status: 500,
      jsonBody: {
        error: {
          code: "internal_error",
          message: "ingest run failed",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

function hasAnyQueryParam(request: HttpRequest): boolean {
  for (const _ of request.query.keys()) return true;
  return false;
}

function badRequest(context: InvocationContext, message: string): HttpResponseInit {
  return {
    status: 400,
    jsonBody: {
      error: { code: "bad_request", message, correlationId: context.invocationId },
    },
    headers: { "cache-control": "no-store" },
  };
}

function payloadTooLarge(context: InvocationContext, message: string): HttpResponseInit {
  return {
    status: 413,
    jsonBody: {
      error: { code: "payload_too_large", message, correlationId: context.invocationId },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("runSignInsIngest", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/sign-ins/run",
  handler: runSignInsIngestHandler,
});
