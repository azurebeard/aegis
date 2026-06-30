// §10.66 Phase E — readClientPrincipal now delegates to a Bearer-only
// authMiddleware.authenticate. Pre-Phase-E this file covered the legacy
// x-ms-client-principal header path; that surface is gone. Bearer-path
// coverage lives in authMiddleware.test.ts; this file pins the
// readClientPrincipal-boundary behaviour: null on unauthenticated +
// AuthError diagnostics routed via InvocationContext.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readClientPrincipal } from "../src/lib/clientPrincipal.js";
import {
  _resetJwksCacheForTesting,
  _setJwksResolverForTesting,
} from "../src/lib/authMiddleware.js";

function reqWithoutHeaders(): { headers: Headers } {
  return { headers: new Headers() };
}

describe("readClientPrincipal — Bearer-only (post Phase E)", () => {
  it("returns null when no Authorization header is present", async () => {
    expect(await readClientPrincipal(reqWithoutHeaders() as never)).toBeNull();
  });

  it("returns null when a forged x-ms-client-principal is present without a Bearer", async () => {
    const forgedAdmin = Buffer.from(
      JSON.stringify({
        identityProvider: "aad",
        userId: "attacker",
        userDetails: "attacker@example.com",
        userRoles: ["admin", "reader"],
      }),
      "utf-8",
    ).toString("base64");
    const headers = new Headers();
    headers.set("x-ms-client-principal", forgedAdmin);
    expect(await readClientPrincipal({ headers } as never)).toBeNull();
  });
});

// SEC-L-D1-01 — auth-failure diagnostics route to context.warn when
// InvocationContext is supplied. Falls back to console.warn when absent so
// the test surface and any non-Functions caller still gets the line.
describe("readClientPrincipal — InvocationContext logging (SEC-L-D1-01)", () => {
  // Public dev tenant + app GUIDs (from HANDOVER §10.44 — not secrets).
  const TENANT_ID = "764279e8-66e9-49b4-901f-a7592435ae1d"; // gitleaks:allow
  const API_APP_ID = "8809046f-d8af-47cc-b45e-64b498f1a36d"; // gitleaks:allow

  beforeEach(() => {
    process.env.AZURE_TENANT_ID = TENANT_ID;
    process.env.AEGIS_API_APP_ID = API_APP_ID;
    // JWKS resolver throws — guarantees the bearer path raises AuthError
    // ("jwt verify failed: ...") without hitting login.microsoftonline.com.
    _setJwksResolverForTesting(async () => {
      throw new Error("test-resolver-rejects");
    });
  });
  afterEach(() => {
    _resetJwksCacheForTesting();
    delete process.env.AZURE_TENANT_ID;
    delete process.env.AEGIS_API_APP_ID;
  });

  function reqWithBearer(token: string): { headers: Headers } {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${token}`);
    return { headers };
  }

  it("calls context.warn with the rejection reason when context is supplied", async () => {
    const warn = vi.fn();
    const ctx = { warn } as unknown as Parameters<typeof readClientPrincipal>[1];
    const result = await readClientPrincipal(reqWithBearer("not.a.real.jwt") as never, ctx);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/\[auth\] bearer token rejected:/);
  });

  it("falls back to console.warn when context is omitted", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await readClientPrincipal(reqWithBearer("not.a.real.jwt") as never);
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleSpy.mock.calls[0][0])).toMatch(/\[auth\] bearer token rejected:/);
    consoleSpy.mockRestore();
  });
});
