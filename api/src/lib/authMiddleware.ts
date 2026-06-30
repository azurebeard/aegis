// ADR-0035 Phase E — native Microsoft Identity Platform JWT validation.
//
// Bearer-only auth. The legacy `x-ms-client-principal` header path was
// retired in Phase E (§10.66) — Easy Auth on the Function App is gone, the
// SPA authenticates via MSAL Bearer, and every handler validates the
// resulting JWT through `authenticate()` below. Pre-Phase-E history of the
// dual-mode dispatcher lived here; see `git log -- api/src/lib/authMiddleware.ts`
// or ADR-0035 §Phase D/E for the migration timeline.
//
// JWT validation requirements (ADR-0035 §3, all REQUIRED — token rejected if
// any fail):
//   - Signature verifies against current JWKS (cacheMaxAge 10 min,
//     cooldownDuration 30 s — pinned per SEC-L-05; auto-refresh on `kid` miss
//     with built-in jitter).
//   - iss === "https://login.microsoftonline.com/<tenantId>/v2.0"
//   - aud === <api-app-id> (bare GUID — v2.0 form). The v1.0 form
//     "api://<api-app-id>" is REJECTED to force `requestedAccessTokenVersion=2`
//     discipline on the API app manifest.
//   - ver === "2.0" (SEC-H-01 — defends against API-app manifest drift).
//   - exp > now. nbf REQUIRED + nbf <= now (RFC 9068 §2.2).
//   - tid === <tenantId> (defence in depth atop iss literal).
//   - roles is an array; values are filtered against ["admin", "reader"].
//     Admin implies reader.

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { HttpRequest } from "@azure/functions";
import type { ClientPrincipal } from "./clientPrincipal.js";

export interface AuthConfig {
  readonly tenantId: string;
  readonly apiAppId: string;
  readonly issuer: string;
}

export class AuthError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "AuthError";
  }
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

// SEC-M-04 — empty by design. Future-proofing only; any addition is WS10-gated.
export const ANONYMOUS_ROUTES: readonly string[] = [];

// SEC-L-05 — pin JWKS cache settings; jose v5 defaults have shifted between
// minor versions, so the explicit values are the contract.
const JWKS_CACHE_MAX_AGE_MS = 600_000;
const JWKS_COOLDOWN_DURATION_MS = 30_000;

const ROLE_VALUES = new Set(["admin", "reader"]);
// SEC-L-PC-01 — structural RFC 4122 8-4-4-4-12 GUID match. Charset-only
// `^[0-9a-f-]{36}$` would accept e.g. "------------------------------------"
// or any malformed hyphen layout. Real tenant/app GUIDs from Entra are v4,
// but we don't gate on the version nibble — Microsoft hasn't promised that
// shape forever, and a structural check is sufficient.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_GUID_RE = GUID_RE;
const API_APP_ID_RE = GUID_RE;

export function resolveAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const tenantId = env.AZURE_TENANT_ID ?? "";
  if (!TENANT_GUID_RE.test(tenantId)) {
    throw new AuthConfigError(
      `AZURE_TENANT_ID must be a GUID (got ${JSON.stringify(env.AZURE_TENANT_ID ?? null)})`,
    );
  }
  const apiAppId = env.AEGIS_API_APP_ID ?? "";
  if (!API_APP_ID_RE.test(apiAppId)) {
    throw new AuthConfigError(
      `AEGIS_API_APP_ID must be a GUID (got ${JSON.stringify(env.AEGIS_API_APP_ID ?? null)})`,
    );
  }
  return {
    tenantId,
    apiAppId,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  };
}

// JWKS singleton — created lazily on first Bearer validation. Dispose via
// `_resetJwksCacheForTesting()` between tests to avoid cross-test leakage when
// a test uses a different tenantId.
let jwksSingleton: JWTVerifyGetKey | null = null;
let jwksTenantId: string | null = null;
// When the test seam is active, getJwks() always returns the test resolver,
// independent of the requested tenantId — avoids the test fixture leaking to
// login.microsoftonline.com if the cache key check would otherwise miss.
let testModeActive = false;

function getJwks(tenantId: string): JWTVerifyGetKey {
  if (testModeActive && jwksSingleton) return jwksSingleton;
  if (jwksSingleton && jwksTenantId === tenantId) return jwksSingleton;
  const jwksUrl = new URL(
    `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
  );
  jwksSingleton = createRemoteJWKSet(jwksUrl, {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_DURATION_MS,
  });
  jwksTenantId = tenantId;
  return jwksSingleton;
}

// Test seam — replaces the JWKS resolver with one provided by the caller.
// Used by api/tests/authMiddleware.test.ts to validate against a locally-
// signed test JWK rather than hitting login.microsoftonline.com.
//
// SEC-L-PC-03 — guarded behind NODE_ENV === "test" so a production code path
// can't accidentally swap the resolver and silently bypass JWKS validation.
// Vitest sets NODE_ENV automatically; for direct runs `process.env.NODE_ENV
// = "test"` must be set before calling.
function assertTestEnvOnly(fn: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `${fn} may only be called when NODE_ENV === "test" (got ${JSON.stringify(process.env.NODE_ENV)})`,
    );
  }
}

export function _setJwksResolverForTesting(resolver: JWTVerifyGetKey | null): void {
  assertTestEnvOnly("_setJwksResolverForTesting");
  jwksSingleton = resolver;
  jwksTenantId = null;
  testModeActive = resolver !== null;
}

export function _resetJwksCacheForTesting(): void {
  assertTestEnvOnly("_resetJwksCacheForTesting");
  jwksSingleton = null;
  jwksTenantId = null;
  testModeActive = false;
}

export async function authenticate(
  req: HttpRequest,
  cfg?: AuthConfig,
): Promise<ClientPrincipal | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !/^bearer\s+/i.test(authHeader)) {
    // §10.66 Phase E — Bearer is the only auth path. No Authorization
    // header → unauthenticated (caller MUST respond 401).
    return null;
  }
  const config = cfg ?? resolveAuthConfig();
  const token = authHeader.replace(/^bearer\s+/i, "").trim();
  return await validateBearer(token, config);
}

async function validateBearer(
  token: string,
  cfg: AuthConfig,
): Promise<ClientPrincipal> {
  const jwks = getJwks(cfg.tenantId);
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: cfg.issuer,
      audience: cfg.apiAppId,
      // SEC-H-01 — RFC 9068 §2.2 marks nbf as REQUIRED. jose's default treats
      // it as optional; we add it to requiredClaims to enforce presence.
      requiredClaims: ["nbf", "ver", "tid", "oid", "preferred_username"],
    });
    payload = result.payload;
  } catch (err) {
    throw new AuthError(`jwt verify failed: ${(err as Error).message}`);
  }

  // SEC-H-01 — pin token version to v2.0. Defends against API-app manifest
  // drift back to v1.0 silently changing claim shapes.
  if (payload.ver !== "2.0") {
    throw new AuthError(
      `token version mismatch: expected "2.0" got ${JSON.stringify(payload.ver)}`,
    );
  }

  // Defence in depth atop the iss literal check.
  if (payload.tid !== cfg.tenantId) {
    throw new AuthError("tid claim does not match configured tenantId");
  }

  // Roles — array of strings, filtered to admin/reader. Admin implies reader.
  const rolesRaw = Array.isArray(payload.roles) ? payload.roles : [];
  const roles = rolesRaw
    .filter((r): r is string => typeof r === "string")
    .filter((r) => ROLE_VALUES.has(r));
  if (roles.includes("admin") && !roles.includes("reader")) {
    roles.push("reader");
  }

  // oid + preferred_username are required claims (set above); narrow types now.
  const oid = payload.oid;
  const upn = payload.preferred_username;
  if (typeof oid !== "string" || typeof upn !== "string") {
    throw new AuthError("missing oid or preferred_username claim");
  }

  return {
    identityProvider: "aad",
    userId: oid,
    userDetails: upn,
    userRoles: roles,
    claims: roles.map((r) => ({ typ: "roles", val: r })),
  };
}

