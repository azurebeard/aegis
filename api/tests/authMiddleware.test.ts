// ADR-0035 §3 — validation contract for authMiddleware (Bearer-only since
// §10.66 Phase E). Covers all seven §3 JWT validation requirements + the
// SEC-H-02 negative case for an invalid Bearer (no fall-through to any
// legacy path) + the resolveAuthConfig GUID sanity checks.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWTPayload, type KeyLike } from "jose";
import {
  ANONYMOUS_ROUTES,
  AuthConfigError,
  AuthError,
  _resetJwksCacheForTesting,
  _setJwksResolverForTesting,
  authenticate,
  resolveAuthConfig,
  type AuthConfig,
} from "../src/lib/authMiddleware.js";

// Test fixtures — public Entra identifiers (tenantId + app GUIDs).
// These are NOT secrets; tenantId + appId are visible to any caller of any
// Entra-protected endpoint, and they're the actual dev-tenant values from
// HANDOVER §10.44. Suppressed: gitleaks heuristic flags any 36-char hex
// hyphenated string above an entropy threshold.
const TENANT_ID = "764279e8-66e9-49b4-901f-a7592435ae1d"; // gitleaks:allow
const API_APP_ID = "8809046f-d8af-47cc-b45e-64b498f1a36d"; // gitleaks:allow
const SPA_APP_ID = "45d091b2-ac29-4c37-b229-d029073f55c1"; // gitleaks:allow
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

function baseConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    tenantId: TENANT_ID,
    apiAppId: API_APP_ID,
    issuer: ISSUER,
    ...overrides,
  };
}

interface Signer {
  privateKey: KeyLike;
  resolver: () => Promise<KeyLike>;
}

async function makeSigner(): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  // Sanity-check: exportJWK round-trips so we know the key is usable.
  await exportJWK(publicKey);
  return {
    privateKey,
    // Test resolver: jose passes the JWS protected header as the first arg;
    // we always return our test public key regardless of `kid`.
    resolver: async () => publicKey,
  };
}

interface TokenOpts {
  iss?: string;
  aud?: string | string[];
  ver?: string;
  tid?: string;
  oid?: string;
  preferred_username?: string;
  roles?: string[];
  exp?: number;     // seconds from now, default +3600
  nbf?: number;     // seconds from now, default 0; pass null to omit
  omitNbf?: boolean;
  omitVer?: boolean;
  omitTid?: boolean;
  omitOid?: boolean;
  omitUpn?: boolean;
  algOverride?: string;
}

async function signToken(privateKey: KeyLike, opts: TokenOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload & Record<string, unknown> = {
    ver: opts.ver ?? "2.0",
    tid: opts.tid ?? TENANT_ID,
    oid: opts.oid ?? "user-guid-aaaaaaaaaaaaaaaaaaaaaa",
    preferred_username: opts.preferred_username ?? "user@example.com",
    roles: opts.roles ?? [],
  };
  if (opts.omitVer) delete payload.ver;
  if (opts.omitTid) delete payload.tid;
  if (opts.omitOid) delete payload.oid;
  if (opts.omitUpn) delete payload.preferred_username;

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: opts.algOverride ?? "RS256" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? API_APP_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.exp ?? 3600));
  if (!opts.omitNbf) {
    jwt.setNotBefore(now + (opts.nbf ?? 0));
  }
  return await jwt.sign(privateKey);
}

function reqWithBearer(token: string): { headers: Headers } {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  return { headers };
}

function reqWithoutHeaders(): { headers: Headers } {
  return { headers: new Headers() };
}

describe("authMiddleware — resolveAuthConfig", () => {
  it("rejects non-GUID tenantId", () => {
    expect(() =>
      resolveAuthConfig({ AZURE_TENANT_ID: "not-a-guid", AEGIS_API_APP_ID: API_APP_ID } as never),
    ).toThrow(AuthConfigError);
  });

  it("rejects non-GUID apiAppId", () => {
    expect(() =>
      resolveAuthConfig({ AZURE_TENANT_ID: TENANT_ID, AEGIS_API_APP_ID: "" } as never),
    ).toThrow(AuthConfigError);
  });

  // SEC-L-PC-01 — structural 8-4-4-4-12 check. The pre-fix charset-only regex
  // `/^[0-9a-f-]{36}$/i` would accept these malformed-but-on-charset strings.
  it("rejects 36-char hex/hyphen strings that don't match RFC 4122 8-4-4-4-12", () => {
    const malformed = [
      "------------------------------------", // 36 hyphens
      "abcdef0123456789abcdef0123456789abcd", // 36 hex, no hyphens
      "0000000-00000-0000-0000-00000000000a", // hyphens in wrong positions
      "00000000-0000-0000-0000-00000000000",  // 35 chars (length-only nominal)
      // SEC-INFO-PC-01-02 — out-of-charset + boundary additions:
      "g0000000-0000-0000-0000-000000000000", // non-hex char (g) at offset 0
      "00000000-0000-0000-0000-00000000000Z", // non-hex char (Z) at end
      " 8809046f-d8af-47cc-b45e-64b498f1a36d", // leading whitespace
      "8809046f-d8af-47cc-b45e-64b498f1a36d ", // trailing whitespace
      "8809046f-d8af-47cc-b45e-64b498f1a36d\n", // trailing newline
      "8809046f_d8af_47cc_b45e_64b498f1a36d", // underscores instead of hyphens
    ];
    for (const v of malformed) {
      expect(() =>
        resolveAuthConfig({ AZURE_TENANT_ID: v, AEGIS_API_APP_ID: API_APP_ID } as never),
        `tenantId ${JSON.stringify(v)} should reject`,
      ).toThrow(AuthConfigError);
      expect(() =>
        resolveAuthConfig({ AZURE_TENANT_ID: TENANT_ID, AEGIS_API_APP_ID: v } as never),
        `apiAppId ${JSON.stringify(v)} should reject`,
      ).toThrow(AuthConfigError);
    }
  });

  it("issuer is built from tenantId", () => {
    const cfg = resolveAuthConfig({
      AZURE_TENANT_ID: TENANT_ID,
      AEGIS_API_APP_ID: API_APP_ID,
    } as never);
    expect(cfg.issuer).toBe(`https://login.microsoftonline.com/${TENANT_ID}/v2.0`);
  });
});

describe("authMiddleware — Bearer JWT validation (positive)", () => {
  let signer: Signer;

  beforeEach(async () => {
    signer = await makeSigner();
    _setJwksResolverForTesting(signer.resolver);
  });
  afterEach(() => {
    _resetJwksCacheForTesting();
  });

  it("accepts a well-formed v2.0 token and returns a ClientPrincipal", async () => {
    const token = await signToken(signer.privateKey, {
      oid: "user-guid",
      preferred_username: "user@example.com",
      roles: ["reader"],
    });
    const principal = await authenticate(reqWithBearer(token) as never, baseConfig());
    expect(principal).not.toBeNull();
    expect(principal!.identityProvider).toBe("aad");
    expect(principal!.userId).toBe("user-guid");
    expect(principal!.userDetails).toBe("user@example.com");
    expect(principal!.userRoles).toEqual(["reader"]);
  });

  it("admin role implies reader", async () => {
    const token = await signToken(signer.privateKey, { roles: ["admin"] });
    const principal = await authenticate(reqWithBearer(token) as never, baseConfig());
    expect(principal!.userRoles).toEqual(expect.arrayContaining(["admin", "reader"]));
  });

  it("filters out non-allowed role values", async () => {
    const token = await signToken(signer.privateKey, {
      roles: ["admin", "reader", "GlobalAdmin", "anonymous", "unknown"],
    });
    const principal = await authenticate(reqWithBearer(token) as never, baseConfig());
    expect(principal!.userRoles.sort()).toEqual(["admin", "reader"]);
  });

  it("returns empty userRoles when token has no roles claim", async () => {
    const token = await signToken(signer.privateKey, { roles: [] });
    const principal = await authenticate(reqWithBearer(token) as never, baseConfig());
    expect(principal!.userRoles).toEqual([]);
  });
});

describe("authMiddleware — Bearer JWT validation (negative — ADR §3 + SEC-H-01)", () => {
  let signer: Signer;

  beforeEach(async () => {
    signer = await makeSigner();
    _setJwksResolverForTesting(signer.resolver);
  });
  afterEach(() => {
    _resetJwksCacheForTesting();
  });

  it("rejects token with wrong issuer", async () => {
    const token = await signToken(signer.privateKey, {
      iss: "https://login.microsoftonline.com/other-tenant/v2.0",
    });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects token with v1.0 audience form (api://<guid>)", async () => {
    const token = await signToken(signer.privateKey, { aud: `api://${API_APP_ID}` });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects token with wrong audience (different app)", async () => {
    const token = await signToken(signer.privateKey, { aud: SPA_APP_ID });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects v1.0 token (ver === '1.0')", async () => {
    const token = await signToken(signer.privateKey, { ver: "1.0" });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects token missing ver claim entirely", async () => {
    const token = await signToken(signer.privateKey, { omitVer: true });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects token with mismatched tid", async () => {
    const token = await signToken(signer.privateKey, { tid: "00000000-0000-0000-0000-000000000000" });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects token missing nbf entirely (RFC 9068 §2.2)", async () => {
    const token = await signToken(signer.privateKey, { omitNbf: true });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects expired token", async () => {
    const token = await signToken(signer.privateKey, { exp: -3600 });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects token whose nbf is in the future", async () => {
    const token = await signToken(signer.privateKey, { nbf: 3600 });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects token missing oid claim", async () => {
    const token = await signToken(signer.privateKey, { omitOid: true });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects token missing preferred_username claim", async () => {
    const token = await signToken(signer.privateKey, { omitUpn: true });
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });

  it("rejects garbage as Bearer token", async () => {
    await expect(
      authenticate(reqWithBearer("not.a.jwt") as never, baseConfig()),
    ).rejects.toThrow(AuthError);
  });

  it("rejects token signed by a different key", async () => {
    const otherSigner = await makeSigner();
    const token = await signToken(otherSigner.privateKey);
    // Note: our resolver still serves the original signer's public key.
    await expect(authenticate(reqWithBearer(token) as never, baseConfig())).rejects.toThrow(AuthError);
  });
});

describe("authMiddleware — §10.66 Phase E unauthenticated paths", () => {
  it("returns null when no Authorization header is present", async () => {
    const principal = await authenticate(reqWithoutHeaders() as never, baseConfig());
    expect(principal).toBeNull();
  });

  it("returns null when Authorization header is non-Bearer (e.g. Basic)", async () => {
    const headers = new Headers();
    headers.set("authorization", "Basic dXNlcjpwYXNz");
    const principal = await authenticate({ headers } as never, baseConfig());
    expect(principal).toBeNull();
  });

  it("legacy x-ms-client-principal header is IGNORED (no auth granted)", async () => {
    // Pre-Phase-E this header could authenticate when the env flag was set.
    // Post-Phase-E it has no effect; presence of the header without a Bearer
    // returns null (caller MUST 401).
    const forgedAdmin = Buffer.from(
      JSON.stringify({
        identityProvider: "aad",
        userId: "forged-admin",
        userDetails: "attacker@example.com",
        userRoles: ["admin", "reader"],
      }),
      "utf-8",
    ).toString("base64");
    const headers = new Headers();
    headers.set("x-ms-client-principal", forgedAdmin);
    const principal = await authenticate({ headers } as never, baseConfig());
    expect(principal).toBeNull();
  });
});

describe("authMiddleware — invariants", () => {
  it("ANONYMOUS_ROUTES is empty by design (SEC-M-04)", () => {
    expect(ANONYMOUS_ROUTES).toEqual([]);
  });
});

// SEC-L-PC-03 — test seam guard. _setJwksResolverForTesting +
// _resetJwksCacheForTesting MUST throw if NODE_ENV !== "test" so a production
// code path can't accidentally bypass JWKS validation by swapping the
// resolver.
describe("authMiddleware — test seam NODE_ENV guard (SEC-L-PC-03)", () => {
  const origNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    // Must restore test mode to keep the rest of the suite working — call
    // reset under NODE_ENV=test, not whatever this test temporarily set.
    if (origNodeEnv === "test") _resetJwksCacheForTesting();
  });

  it("_setJwksResolverForTesting throws when NODE_ENV !== 'test'", () => {
    process.env.NODE_ENV = "production";
    expect(() => _setJwksResolverForTesting(null)).toThrow(/NODE_ENV/);
  });

  it("_resetJwksCacheForTesting throws when NODE_ENV !== 'test'", () => {
    process.env.NODE_ENV = "production";
    expect(() => _resetJwksCacheForTesting()).toThrow(/NODE_ENV/);
  });

  it("_setJwksResolverForTesting throws when NODE_ENV is undefined", () => {
    delete process.env.NODE_ENV;
    expect(() => _setJwksResolverForTesting(null)).toThrow(/NODE_ENV/);
  });

  it("both seams succeed when NODE_ENV === 'test' (sanity)", () => {
    process.env.NODE_ENV = "test";
    expect(() => _setJwksResolverForTesting(null)).not.toThrow();
    expect(() => _resetJwksCacheForTesting()).not.toThrow();
  });
});
