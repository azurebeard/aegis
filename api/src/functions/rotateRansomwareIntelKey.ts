// POST /api/ingest/ransomware-intel/key/rotate — admin self-service
// rotation of the ransomware.live PRO API key (ADR-0037 Option B,
// HANDOVER §6.3). Replaces the operator-CLI rotation path for the
// common case.
//
// SWA gates `/api/ingest/*` to the `admin` role; this handler runs
// `authLevel: "anonymous"` per repo convention. Defence-in-depth:
//   - 401 on missing client principal.
//   - 400 on non-empty query string (leak-into-access-log guard).
//   - 400 on missing / empty / oversize apiKey field.
//   - 413 on request body > 1024 bytes.
//   - 429 with a 5/day per-tenant ceiling (dedicated limiter; rotation
//     is rarer than ingest runs and a tighter cap shrinks the blast
//     radius of a compromised admin session DoS-ing the ingest path).
//   - 502 on validation against ransomware.live failing (key not stored).
//   - 502 on env_unset (Bicep ABAC + env wiring drifted).
//   - 503 on kv_403 / kv_write_failed.
//   - 200 + outcome JSON on success.
//
// On success: emits AIEVENT `RansomwareIntelKeyRotated` with no key
// material; logs the new version id. The next ingest fire reads the
// new key from the module-scope cache (busted by the rotation lib).
//
// Audit trail: AIEVENT only — matches the existing PATCH-handler
// pattern (patchKevSuppression / patchStackItem). The next ingest
// run's audit-chain line is implicitly tied to the new key version
// via the audit-chain hash linkage, so a forensic timeline can join
// AIEVENT.RansomwareIntelKeyRotated → next IngestRun chain seq.

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
import { ransomwareIntelKeyRotateRateLimiter } from "../lib/rateLimit.js";
import { rotateRansomwareLiveApiKey } from "../lib/rotateRansomwareLiveApiKey.js";
import { emitAievent } from "../lib/aievent.js";

const MAX_BODY_BYTES = 1024;
/** Sanity bound on the key length. The ransomware.live key today is a
 *  ~36-char UUID-like token; cap at 256 to leave room for future
 *  format changes while rejecting obviously-malformed pastes. */
const MAX_KEY_BYTES = 256;

export const rotateRansomwareIntelKeyHandler: HttpHandler = async (
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

  let parsed: { apiKey?: unknown };
  try {
    parsed = rawBody.length === 0 ? {} : (JSON.parse(rawBody) as { apiKey?: unknown });
  } catch {
    return badRequest(context, "request body must be valid JSON");
  }
  if (typeof parsed.apiKey !== "string") {
    return badRequest(context, "apiKey field must be a string");
  }
  const apiKey = parsed.apiKey.trim();
  if (apiKey.length === 0) {
    return badRequest(context, "apiKey must be non-empty");
  }
  if (Buffer.byteLength(apiKey, "utf-8") > MAX_KEY_BYTES) {
    return badRequest(context, `apiKey must be ≤ ${MAX_KEY_BYTES} bytes`);
  }

  const config = resolveRansomwareIntelIngestConfig();
  const rate = ransomwareIntelKeyRotateRateLimiter.check(config.tenantId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limit_endpoint",
          message: "key-rotation budget exhausted: 5/day per tenant",
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
    const outcome = await rotateRansomwareLiveApiKey(apiKey, context);
    if (outcome.status === "rotated") {
      emitAievent(context, "RansomwareIntelKeyRotated", {
        tenantId: config.tenantId,
        source: config.source,
        version: outcome.version ?? "",
        rotatedAt: outcome.rotatedAt ?? "",
        validateStatus: outcome.validateStatus ?? 0,
      });
      return {
        status: 200,
        jsonBody: {
          schemaVersion: 1,
          status: "rotated",
          rotatedAt: outcome.rotatedAt,
          version: outcome.version,
        },
        headers: { "cache-control": "no-store" },
      };
    }

    // Map failures to HTTP status.
    if (outcome.kind === "validation_failed") {
      emitAievent(context, "RansomwareIntelKeyRotateFailed", {
        tenantId: config.tenantId,
        kind: "validation_failed",
        validateStatus: outcome.validateStatus ?? 0,
      });
      return {
        status: 502,
        jsonBody: {
          error: {
            code: "validation_failed",
            message: `ransomware.live rejected the supplied key${
              outcome.validateStatus ? ` (HTTP ${outcome.validateStatus})` : ""
            } — not written.`,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    if (outcome.kind === "env_unset") {
      return {
        status: 502,
        jsonBody: {
          error: {
            code: "not_configured",
            message:
              "key vault binding incomplete — Bicep deploy may not have wired the api-reader MI to the ransomware-live-api-key secret",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }
    // kv_403 / kv_write_failed → 503 (operator can retry, transient class)
    emitAievent(context, "RansomwareIntelKeyRotateFailed", {
      tenantId: config.tenantId,
      kind: outcome.kind ?? "unknown",
      errorDetail: outcome.errorDetail ?? "",
    });
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: `key vault write failed (${outcome.kind ?? "unknown"})`,
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(
      `ransomwareIntel.key.rotate.error ${String((err as Error).message ?? err)}`,
    );
    return {
      status: 500,
      jsonBody: {
        error: {
          code: "internal_error",
          message: "key rotation failed",
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

function payloadTooLarge(
  context: InvocationContext,
  message: string,
): HttpResponseInit {
  return {
    status: 413,
    jsonBody: {
      error: { code: "payload_too_large", message, correlationId: context.invocationId },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("rotateRansomwareIntelKey", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/ransomware-intel/key/rotate",
  handler: rotateRansomwareIntelKeyHandler,
});
