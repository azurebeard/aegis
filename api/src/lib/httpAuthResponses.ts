// Shared 401/403 response helpers for handlers that gate on
// `readClientPrincipal` + admin role.
//
// SEC-INFO-D2-02-INGEST-HELPERS — extracted from five SEC-H-INGEST-AUTH-
// MIGRATION handlers (runKevIngest, runSecureScoreIngest,
// runSecureScoreControlProfilesIngest, runIncidentsIngest,
// runIncidentsBackfill) that previously each kept byte-identical local
// copies. Other handlers (~25 more across the function tree) still use
// per-file copies; migrating them is a separate sweep.
//
// Response shape contract (matches the established pattern in
// runPostureAgent.ts and the rest of the function tree):
//   { error: { code, message, correlationId }, ... }
// + `cache-control: no-store` so a CDN/proxy cannot cache an authn/authz
//   failure under a shared key (per OWASP ASVS V13.2.5 / WS10
//   SEC-L-STEP4-CODE-04).

import type { HttpResponseInit, InvocationContext } from "@azure/functions";

export function unauthenticated(context: InvocationContext): HttpResponseInit {
  return {
    status: 401,
    jsonBody: {
      error: {
        code: "unauthenticated",
        message: "authentication required",
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

export function forbidden(
  context: InvocationContext,
  message: string,
): HttpResponseInit {
  return {
    status: 403,
    jsonBody: {
      error: {
        code: "forbidden",
        message,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}
