// §10.66 Phase E — Bearer-only public auth contract used by every handler.
//
// `readClientPrincipal(req, context?)` delegates to
// `authMiddleware.authenticate()` which validates an MSAL-issued v2.0 JWT
// against the API app's audience + the tenant issuer + JWKS-served public
// keys. Pre-Phase-E this function dispatched between JWT and a legacy
// x-ms-client-principal header path; the legacy path is gone.
//
// Behaviour at the handler boundary:
//   - Returns a ClientPrincipal on successful Bearer validation.
//   - Returns null when no Bearer is present OR JWT validation fails.
//     Caller MUST respond 401 in both cases.
//   - Throws AuthConfigError on a startup misconfig (caller's 500 path).
//   - JWT validation failures are caught here (NOT propagated as throws) —
//     the AuthError reason is logged via context.warn / console.warn for
//     diagnostics, the null return surfaces a generic 401 at the handler.
//     SEC-L-PC-02 (opaque 401 body — never echo the AuthError reason) is
//     honoured by keeping the reason inside this function.

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { AuthError, authenticate } from "./authMiddleware.js";

export interface ClientPrincipal {
  readonly identityProvider: string;
  readonly userId: string;
  readonly userDetails: string;
  readonly userRoles: readonly string[];
  readonly claims?: readonly { typ: string; val: string }[];
}

// SEC-L-D1-01 — handlers SHOULD pass `context` so auth-failure diagnostics are
// emitted via context.warn (correlation-id stamped, picked up by App Insights
// invocationId). The fallback to console.warn is preserved for callers that
// don't have an InvocationContext (e.g. unit-test direct invocations) so we
// don't break the unit-test surface area.
export async function readClientPrincipal(
  req: HttpRequest,
  context?: InvocationContext,
): Promise<ClientPrincipal | null> {
  try {
    return await authenticate(req);
  } catch (err) {
    if (err instanceof AuthError) {
      // Diagnostic only; the caller must NOT echo this reason in the 401
      // response body (SEC-L-PC-02 / ADR-0035 §3 "do not echo claim-shape
      // detail"). Application Insights captures stdout/stderr.
      const msg = `[auth] bearer token rejected: ${err.reason}`;
      if (context) context.warn(msg);
      else console.warn(msg);
      return null;
    }
    // AuthConfigError + any other unexpected error — surface to handler 500.
    throw err;
  }
}
