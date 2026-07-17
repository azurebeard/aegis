// POST /api/ingest/entra-risk/run — admin manual EntraRisk ingest (ADR-0024 §1.3).
//
// SWA gates `/api/ingest/*` to the `admin` role; Easy Auth gates the Function
// App to the SWA MI. This handler is `authLevel: "anonymous"` per the repo
// convention. Route note: the Functions host reserves `/admin/*` for its
// management API, so user routes must not begin `admin/` — we piggy-back on
// the existing `ingest/*` SWA gate (shared with secureScore / incidents).
//
// Defence-in-depth beyond the role gate:
//   - 401 on missing client principal.
//  - 400 on non-empty query string.
//   - 413 on request-body > 1024 bytes (header pre-check + post-parse gate).
//   - 30 runs/day per tenant (ADR-0024 §1.3).
//   - Unconditional licence re-probe on every admin invocation.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveEntraRiskIngestConfig } from "../lib/config.js";
import { entraRiskAdminRunRateLimiter } from "../lib/rateLimit.js";
import { runEntraRiskIngestOnce } from "../lib/runEntraRiskIngest.js";

const MAX_BODY_BYTES = 1024;

export const runEntraRiskIngestHandler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) {
    return unauthenticated(context);
  }

  // WS10 SEC-M-ADR-24-02: reject any query string to bound accidental
  // PII-in-query-string leakage into SWA / Function App access logs.
  if (hasAnyQueryParam(request)) {
    return badRequest(context, "query string must be empty");
  }

  // mirror the
  // `runDailyBrief.ts` two-gate pattern. The header peek is an early-reject
  // for polite clients; a chunked-transfer client may omit Content-Length,
  // which bypasses the header check. After `request.text()` we re-verify the
  // in-memory byte length to close the bypass.
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

  const config = resolveEntraRiskIngestConfig();
  const rate = entraRiskAdminRunRateLimiter.check(config.tenantId);
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
    const outcome = await runEntraRiskIngestOnce(config, context, { trigger: "admin" });
    if (outcome.error?.kind === "license_probe_failed") {
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "dependency_unavailable",
            message: "licence probe failed — retry after confirming MI Graph roles",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
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
        riskyUsersIngested: outcome.riskyUsersIngested ?? 0,
        riskyUsersProcessing: outcome.riskyUsersProcessing ?? 0,
        licenceState: outcome.licenceState ?? "unknown",
      },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`entraRisk.admin.run.error ${String((err as Error).message ?? err)}`);
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

app.http("runEntraRiskIngest", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/entra-risk/run",
  handler: runEntraRiskIngestHandler,
});
