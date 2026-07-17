// SEC-L-D2-02 — non-InteractionRequiredAuthError throws from
// acquireApiToken must be normalised to ApiError(401) at the
// authHeader() boundary so TanStack Query consumers can rely on a
// single error shape across token-acquire and HTTP-response failures.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/authActions", () => ({
  acquireApiToken: vi.fn(),
}));

import { api, ApiError } from "@/api/client";
import { acquireApiToken } from "@/auth/authActions";

const acquireApiTokenMock = vi.mocked(acquireApiToken);

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  acquireApiTokenMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("api client — authHeader normalises MSAL throws (SEC-L-D2-02)", () => {
  it("wraps a BrowserAuthError-shaped throw in ApiError(401)", async () => {
    // Mimic an MSAL BrowserAuthError without importing @azure/msal-browser
    // at test scope (the runtime import lives behind authActions which is
    // already mocked). Only the .name + .message surface are read.
    class FakeBrowserAuthError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "BrowserAuthError";
      }
    }
    acquireApiTokenMock.mockRejectedValueOnce(
      new FakeBrowserAuthError("interaction_in_progress"),
    );
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    let caught: unknown;
    try {
      await api.get("/api/ping");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const err = caught as ApiError;
    expect(err.status).toBe(401);
    expect(err.message).toBe("auth-token-acquire-failed");
    expect(err.payload).toEqual({
      reason: "interaction_in_progress",
      kind: "BrowserAuthError",
    });
    // fetch must NOT have been invoked — token-acquire failed first.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wraps a generic Error throw in ApiError(401) with kind='Error'", async () => {
    acquireApiTokenMock.mockRejectedValueOnce(new Error("boom"));
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    await expect(api.get("/api/ping")).rejects.toMatchObject({
      status: 401,
      message: "auth-token-acquire-failed",
      payload: { reason: "boom", kind: "Error" },
    });
  });

  it("does NOT wrap when acquireApiToken resolves null (anonymous request)", async () => {
    // null is the no-active-account case — no Authorization header is
    // attached, and the request proceeds. Server-side returns 401 in
    // production; the test asserts we don't pre-empt that with a
    // synthetic ApiError.
    acquireApiTokenMock.mockResolvedValueOnce(null);
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await api.get("/api/ping");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("scrubs AADSTS reason text — keeps the AADSTSxxxxx code, drops the human description", async () => {
    // WS10 SEC-MED-D2-02-01 regression — Entra ServerError messages embed
    // UPN, tenant ID, and sign-in timestamps after the AADSTS code. Only
    // the bare error code should reach component code.
    class FakeServerError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "ServerError";
      }
    }
    acquireApiTokenMock.mockRejectedValueOnce(
      new FakeServerError(
        "AADSTS50173: The provided grant has expired. user@tenant.onmicrosoft.com last signed in 2026-04-01.",
      ),
    );
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    await expect(api.get("/api/ping")).rejects.toMatchObject({
      status: 401,
      payload: { reason: "AADSTS50173", kind: "ServerError" },
    });
  });

  it("scrubs free-form messages — keeps only the first whitespace-delimited token", async () => {
    acquireApiTokenMock.mockRejectedValueOnce(
      new Error("network failure: DNS resolution for login.microsoftonline.com failed"),
    );
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    await expect(api.get("/api/ping")).rejects.toMatchObject({
      status: 401,
      payload: { reason: "network", kind: "Error" },
    });
  });

  it("attaches Authorization: Bearer when a token is acquired", async () => {
    acquireApiTokenMock.mockResolvedValueOnce("real-token");
    const fetchSpy = vi.fn().mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await api.get("/api/ping");
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe("Bearer real-token");
  });
});
