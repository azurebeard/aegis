// POST /api/ingest/ransomware-intel/run — admin manual ransomware.live ingest
// (ADR-0037 Layer 3c). Mirrors `runEntraRiskIngest.ts` / `runSignInsIngest.ts`.
//
// SWA gates `/api/ingest/*` to the `admin` role; Easy Auth gates the FA
// to the SWA MI. This handler is `authLevel: "anonymous"` per repo
// convention. Route note: the Functions host reserves `/admin/*` for its
// management API, so user routes must not begin `admin/`.
//
// Defence-in-depth beyond the SWA role gate:
//   - 401 on missing client principal.
//   - 400 on non-empty query string (avoids accidental PII-in-query leak
//     into SWA / FA access logs).
//   - 413 on request body > 1024 bytes (header pre-check + post-parse gate
//     to close chunked-transfer bypass).
//   - 30 runs/day per tenant (shared cross-vertical admin-run budget).
//
// On orchestrator return:
//   - 202 + outcome JSON on success / no_data
//   - 503 on dependency_unavailable (auth_unavailable / 5xx / network /
//     timeout / throttle / schema_invalid)
//   - 500 on internal exception

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveRansomwareIntelIngestConfig } from "../lib/config.js";
import { ransomwareIntelAdminRunRateLimiter } from "../lib/rateLimit.js";
import { runRansomwareIntelIngestOnce } from "../lib/runRansomwareIntelIngest.js";

const MAX_BODY_BYTES = 1024;

export const runRansomwareIntelIngestHandler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) {
    return unauthenticated(context);
  }

  if (hasAnyQueryParam(request)) {
    return badRequest(context, "query string must be empty");
  }

  const lenHeader = request.headers.get("content-length");
  if (lenHeader !== null) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return payloadTooLarge(
        context,
        `request body must be ≤ ${MAX_BODY_BYTES} bytes`,
      );
    }
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return badRequest(context, "unable to read request body");
  }
  if (Buffer.byteLength(rawBody, "utf-8") > MAX_BODY_BYTES) {
    return payloadTooLarge(
      context,
      `request body must be ≤ ${MAX_BODY_BYTES} bytes`,
    );
  }

  const config = resolveRansomwareIntelIngestConfig();
  const rate = ransomwareIntelAdminRunRateLimiter.check(config.tenantId);
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
    const outcome = await runRansomwareIntelIngestOnce(config, context, {
      trigger: "admin",
    });

    if (outcome.status === "error") {
      // Distinguish "configure me" (auth_unavailable) from generic upstream
      // failure so the SPA can route the operator to the admin section
      // with the right CTA instead of a generic "retry" toast.
      const code =
        outcome.error?.kind === "auth_unavailable"
          ? "not_configured"
          : "dependency_unavailable";
      return {
        status: 503,
        jsonBody: {
          error: {
            code,
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
        victimsIngested: outcome.victimsIngested,
        pressIngested: outcome.pressIngested,
        retentionDeleted: outcome.retentionRowsDeleted,
        country: outcome.country,
        period: outcome.period,
      },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`ransomwareIntel.admin.run.error ${String((err as Error).message ?? err)}`);
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
      error: {
        code: "bad_request",
        message,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

function payloadTooLarge(
  context: InvocationContext,
  message: string,
): HttpResponseInit {
  return {
    status: 413,
    jsonBody: {
      error: {
        code: "payload_too_large",
        message,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("runRansomwareIntelIngest", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/ransomware-intel/run",
  handler: runRansomwareIntelIngestHandler,
});
