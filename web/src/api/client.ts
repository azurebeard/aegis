// ADR-0035 Phase D2 — single fetch wrapper for all /api/* calls. The wrapper
// acquires a Bearer JWT via MSAL `acquireTokenSilent` (falls back to
// `acquireTokenRedirect` on InteractionRequiredAuthError) and attaches it to
// every outbound request. The Function App's `authMiddleware.ts` validates
// the token (Phase C/D1) per ADR-0035 §3.
//
// Phase D-soak compatibility note: while AEGIS_LEGACY_CLIENT_PRINCIPAL is
// `enabled` on the Function App, requests without a Bearer ALSO succeed via
// the legacy x-ms-client-principal header (forwarded by the SWA linked-
// backend proxy). After the soak window the legacy path is retired and
// Bearer is the only auth.

import { acquireApiToken } from "@/auth/authActions";

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;
  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.name = "ApiError";
  }
}

// SEC-L-D2-02 / WS10 SEC-MED-D2-02-01 — strip embedded human-readable AADSTS
// description text (which can include UPN, tenant ID, scope, sign-in
// timestamps) before exposing the reason to caller code. Keep code-keyed
// MSAL identifiers verbatim (interaction_in_progress, network_error, etc.)
// because those have no PII content. Anything else: keep only the first
// whitespace-delimited token. Future contributors: this `payload.reason` is
// surfaced into TanStack Query error objects and visible to component code
// — do NOT forward to external telemetry (App Insights, Sentry, etc.)
// without re-scrubbing.
function scrubAuthReason(raw: string): string {
  if (!raw) return "unknown";
  const aadsts = raw.match(/^AADSTS\d+/);
  if (aadsts) return aadsts[0];
  if (!/\s/.test(raw)) return raw;
  return raw.split(/\s+/)[0] ?? "unknown";
}

async function authHeader(): Promise<Record<string, string>> {
  // SEC-L-D2-02 — any non-InteractionRequiredAuthError throw from MSAL
  // (BrowserAuthError, ClientAuthError, ServerError, etc.) is normalised to
  // an ApiError(401) so TanStack Query callers can rely on a single error
  // shape across token-acquire and HTTP-response failures.
  //
  // Status-code choice: 401 is
  // uniformly applied even to ServerError (Entra-side 5xx) and network
  // errors. No call site today branches on status (`grep "status === 401"`
  // → 0 hits in web/src/), so 401-vs-503 is not behaviourally observable;
  // if a status-aware retry policy is added later, branch by `e.name` here.
  //
  // The IRA case usually doesn't reach here — acquireTokenRedirect navigates
  // away before the promise resolves — but a synchronous reject (e.g. MSAL
  // `redirect_in_iframe`) does fall through to this wrapper, which is the
  // correct behaviour: the caller sees a normalised 401.
  let token: string | null;
  try {
    token = await acquireApiToken();
  } catch (err) {
    const e = err as Error;
    throw new ApiError(401, "auth-token-acquire-failed", {
      reason: scrubAuthReason(e?.message ?? String(err)),
      kind: e?.name ?? "Error",
    });
  }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const auth = await authHeader();
  const init: RequestInit = {
    method,
    credentials: "include",
    // WS10 Slice 1(d)/C MEDIUM #2 — `auth` spread AFTER `extraHeaders` so a
    // caller cannot override the MSAL-derived Authorization (or Accept) header
    // via the optional `extraHeaders` param. `Content-Type` likewise wins.
    headers: {
      Accept: "application/json",
      ...(extraHeaders ?? {}),
      ...auth,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(path, init);
  const ct = res.headers.get("content-type") ?? "";
  const parsed: unknown = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, `${method} ${path} → ${res.status}`, parsed);
  }
  return parsed as T;
}

/**
 * Binary-body variant for file uploads (ADR-0029 Phase B logo upload).
 * The API layer ships the raw bytes with the caller-provided MIME type —
 * no multipart wrapper, no FormData. This matches the handler's
 * `request.arrayBuffer()` read + magic-byte validation path and avoids the
 * FormData parser dependency on the server.
 */
async function requestBinary<T>(
  method: string,
  path: string,
  body: Blob | ArrayBuffer,
  contentType: string,
): Promise<T> {
  const auth = await authHeader();
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...auth,
      "Content-Type": contentType,
    },
    body,
  };
  const res = await fetch(path, init);
  const ct = res.headers.get("content-type") ?? "";
  const parsed: unknown = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, `${method} ${path} → ${res.status}`, parsed);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>("POST", path, body, headers),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
  upload: <T>(path: string, body: Blob | ArrayBuffer, contentType: string) =>
    requestBinary<T>("POST", path, body, contentType),
};
