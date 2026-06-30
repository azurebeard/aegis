// ADR-0030 §C.22 (forthcoming) — signed share-link token for the HTML report
// email-delivery model.
//
// The email body no longer carries the rendered report; it carries a link to
// `GET /api/reports/share/{token}` instead. The token is opaque to the
// recipient, time-limited, HMAC-SHA256 signed against a Key Vault secret,
// and carries the (tenantId, periodKey, expiry, jti) claims needed for the
// share endpoint to resolve and render the snapshot.
//
// Token wire format:
//   <body>.<sig>
//   body = base64url(canonicalized-JSON(claims))
//   sig  = base64url(HMAC-SHA256(key, body-bytes))
//
// Claims:
//   v   — format version (currently 1). Future format changes bump the
//         version and the verifier rejects unrecognised versions.
//   t   — tenantId GUID.
//   p   — periodKey (cadence string per ADR-0030 §B.1, e.g. "2026-05" or
//         "2026-Q2").
//   exp — unix-seconds expiry (typically issued-time + 14 days).
//   jti — UUID per token. Reserved for future per-link revocation via a
//         deny-list table; not consulted by the verifier today.
//
// Trust model:
//   - The signing key is a 256-bit random secret in Key Vault. An attacker
//     without KV read access cannot forge tokens; an attacker with KV read
//     access can forge anything, so the KV grant on the signing-key secret
//     is the security boundary.
//   - Recipients can forward the link; anyone with the link can read until
//     `exp`. This matches the existing trust model — the email body itself
//     already carried the same data and was forwardable.
//   - Key rotation (operator-triggered) invalidates ALL outstanding links
//     issued before the rotation. Use sparingly; the rotation runbook is
//     the incident-response path.
//
// WS10 surfaces explicitly addressed:
//   - Constant-time HMAC compare via `crypto.timingSafeEqual`.
//   - Claims are JCS-canonicalised before signing/verifying so JSON
//     key-order variance can't break the signature (ADR-0015 §2 pattern).
//   - The verifier returns a discriminated union so callers can branch on
//     `valid: false` without exception flow control.
//   - Signing-key argument is `Buffer` only — callers pass the decoded KV
//     value, never a placeholder string. Empty buffer causes the constant-
//     time compare to fail cleanly.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalize } from "json-canonicalize";

/** Current token format version. Verifier rejects any other value. */
export const REPORT_SHARE_TOKEN_VERSION = 1 as const;

/** Default link lifetime — 14 days from issue. Operator-configurable in a
 *  future TenantSettings extension; v1 is fixed. */
export const DEFAULT_SHARE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Hard ceiling on issuer-side TTL — 90 days from now. Tokens minted with
 *  a longer expiry are rejected at sign time. Prevents
 *  a caller mistake or compromised-issuer-process from producing a year+
 *  long link that bypasses operational rotation hygiene. */
export const MAX_SHARE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface ReportShareTokenClaims {
  readonly v: typeof REPORT_SHARE_TOKEN_VERSION;
  readonly t: string;
  readonly p: string;
  readonly exp: number;
  readonly jti: string;
}

export interface SignReportShareTokenInput {
  readonly tenantId: string;
  readonly periodKey: string;
  readonly expiresAtMs: number;
  /** Optional caller-supplied UUID. Generated when omitted — typical caller
   *  path. Tests pin a value for determinism. */
  readonly jti?: string;
}

export type VerifyReportShareTokenResult =
  | { readonly valid: true; readonly claims: ReportShareTokenClaims }
  | {
      readonly valid: false;
      readonly reason:
        | "malformed"
        | "bad_signature"
        | "expired"
        | "unsupported_version"
        | "invalid_claims";
    };

export function signReportShareToken(
  input: SignReportShareTokenInput,
  signingKey: Buffer,
): string {
  if (!input.tenantId) throw new Error("signReportShareToken: tenantId required");
  if (!input.periodKey) throw new Error("signReportShareToken: periodKey required");
  if (!Number.isFinite(input.expiresAtMs) || input.expiresAtMs <= 0) {
    throw new Error("signReportShareToken: expiresAtMs must be a positive finite number");
  }
  // WS10 chunk-1 A4: cap issuer-side TTL at 90 days from now. Bound check
  // uses Date.now() so callers don't have to thread it; tests inject via
  // `vi.useFakeTimers()` when they need determinism.
  if (input.expiresAtMs > Date.now() + MAX_SHARE_TOKEN_TTL_MS) {
    throw new Error(
      `signReportShareToken: expiresAtMs is more than ${MAX_SHARE_TOKEN_TTL_MS / (24 * 60 * 60 * 1000)} days from now (issuer-side ceiling)`,
    );
  }
  if (signingKey.length === 0) {
    throw new Error("signReportShareToken: signingKey must be non-empty");
  }
  const claims: ReportShareTokenClaims = {
    v: REPORT_SHARE_TOKEN_VERSION,
    t: input.tenantId,
    p: input.periodKey,
    exp: Math.floor(input.expiresAtMs / 1000),
    jti: input.jti ?? randomUUID(),
  };
  const canonical = canonicalize(claims);
  const body = base64UrlEncode(Buffer.from(canonical, "utf-8"));
  const sig = base64UrlEncode(
    createHmac("sha256", signingKey).update(body, "utf-8").digest(),
  );
  return `${body}.${sig}`;
}

/**
 * Verify a share-link token against the KV-loaded signing key.
 *
 * Check ordering (intentional, do not reorder): malformed → bad_signature
 * → invalid_claims → unsupported_version → expired. Signature validation
 * runs before claim parsing so an attacker without the key cannot probe
 * claim-shape semantics through error-reason variance. WS10 chunk-1 A1.
 *
 * @param nowMs Wall-clock milliseconds. Callers MUST pass `Date.now()` —
 *   never a request-derived value (avoids clock-skew attacks via spoofed
 *   `Date` headers). WS10 chunk-1 A2.
 */
export function verifyReportShareToken(
  token: string,
  signingKey: Buffer,
  nowMs: number,
): VerifyReportShareTokenResult {
  if (signingKey.length === 0) {
    return { valid: false, reason: "bad_signature" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { valid: false, reason: "malformed" };
  }
  const dotIndex = token.indexOf(".");
  // Exactly one separator + at least one byte on each side.
  if (
    dotIndex <= 0 ||
    dotIndex === token.length - 1 ||
    token.indexOf(".", dotIndex + 1) !== -1
  ) {
    return { valid: false, reason: "malformed" };
  }
  const body = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);

  // Recompute the expected signature over the wire bytes (the base64url body
  // string), not the decoded payload. Mirrors the sign path verbatim.
  const expected = createHmac("sha256", signingKey).update(body, "utf-8").digest();
  let actual: Buffer;
  try {
    actual = base64UrlDecode(sig);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (expected.length !== actual.length) {
    return { valid: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(expected, actual)) {
    return { valid: false, reason: "bad_signature" };
  }

  // Signature is valid — decode claims.
  let payloadBytes: Buffer;
  try {
    payloadBytes = base64UrlDecode(body);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf-8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!isClaimsShape(parsed)) {
    return { valid: false, reason: "invalid_claims" };
  }
  if (parsed.v !== REPORT_SHARE_TOKEN_VERSION) {
    return { valid: false, reason: "unsupported_version" };
  }
  if (Math.floor(nowMs / 1000) >= parsed.exp) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, claims: parsed };
}

function isClaimsShape(x: unknown): x is ReportShareTokenClaims {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.v === "number" &&
    typeof o.t === "string" &&
    o.t.length > 0 &&
    typeof o.p === "string" &&
    o.p.length > 0 &&
    typeof o.exp === "number" &&
    Number.isFinite(o.exp) &&
    o.exp > 0 &&
    typeof o.jti === "string" &&
    o.jti.length > 0
  );
}

// RFC 4648 §5 base64url — no padding, `-` and `_` substitutions.

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(s: string): Buffer {
  // Reject characters outside the alphabet — Buffer.from with `base64`
  // ignores them silently, which would let an attacker append junk without
  // affecting the decoded bytes (signature still valid).
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new Error("invalid base64url");
  }
  let padded = s.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4 !== 0) padded += "=";
  return Buffer.from(padded, "base64");
}
