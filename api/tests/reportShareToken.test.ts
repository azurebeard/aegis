// Unit tests for the share-link token sign/verify primitives. Pure crypto +
// claim-shape validation — no KV, no audit chain, no handler. The Key
// Vault loader tests live separately at reportShareSigningKey.test.ts.

import { describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import {
  signReportShareToken,
  verifyReportShareToken,
  REPORT_SHARE_TOKEN_VERSION,
} from "../src/lib/reportShareToken.js";

const KEY = randomBytes(32);
const KEY_2 = randomBytes(32);
const TENANT = "11111111-2222-3333-4444-555555555555";
const PERIOD = "2026-05";
const NOW_MS = Date.parse("2026-06-03T00:00:00Z");
const FUTURE_MS = NOW_MS + 14 * 24 * 60 * 60 * 1000;
const PAST_MS = NOW_MS - 1000;

describe("signReportShareToken", () => {
  it("produces a two-part token with a single `.` separator", () => {
    const t = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS },
      KEY,
    );
    expect(t).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(t.split(".")).toHaveLength(2);
  });

  it("is deterministic given the same input + jti", () => {
    const jti = "fixed-jti-for-this-test-aaaaaa";
    const a = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS, jti },
      KEY,
    );
    const b = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS, jti },
      KEY,
    );
    expect(a).toBe(b);
  });

  it("differs when jti is omitted (random per call)", () => {
    const a = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS },
      KEY,
    );
    const b = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS },
      KEY,
    );
    expect(a).not.toBe(b);
  });

  it("differs when the signing key differs (signature dependent on key)", () => {
    const jti = "fixed-jti-aaaaaa";
    const a = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS, jti },
      KEY,
    );
    const b = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS, jti },
      KEY_2,
    );
    expect(a.split(".")[0]).toBe(b.split(".")[0]); // body identical
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]); // signature differs
  });

  it("rejects expiresAtMs more than 90 days from now (WS10 chunk-1 A4 ceiling)", () => {
    const tooFar = Date.now() + 100 * 24 * 60 * 60 * 1000; // 100 days
    expect(() =>
      signReportShareToken(
        { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: tooFar },
        KEY,
      ),
    ).toThrow(/90 days from now/);
  });

  it("accepts expiresAtMs at the 90-day boundary (strictly-greater-than semantics)", () => {
    const atBoundary = Date.now() + 89 * 24 * 60 * 60 * 1000; // 89 days
    expect(() =>
      signReportShareToken(
        { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: atBoundary },
        KEY,
      ),
    ).not.toThrow();
  });

  it("rejects empty tenantId / periodKey / non-finite expiry / empty key", () => {
    expect(() =>
      signReportShareToken(
        { tenantId: "", periodKey: PERIOD, expiresAtMs: FUTURE_MS },
        KEY,
      ),
    ).toThrow(/tenantId required/);
    expect(() =>
      signReportShareToken(
        { tenantId: TENANT, periodKey: "", expiresAtMs: FUTURE_MS },
        KEY,
      ),
    ).toThrow(/periodKey required/);
    expect(() =>
      signReportShareToken(
        { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: Number.NaN },
        KEY,
      ),
    ).toThrow(/expiresAtMs/);
    expect(() =>
      signReportShareToken(
        { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS },
        Buffer.alloc(0),
      ),
    ).toThrow(/signingKey/);
  });

  it("encodes the configured token version into the claims", () => {
    const t = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS },
      KEY,
    );
    const result = verifyReportShareToken(t, KEY, NOW_MS);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.v).toBe(REPORT_SHARE_TOKEN_VERSION);
    }
  });
});

describe("verifyReportShareToken — happy path", () => {
  it("validates a freshly-signed token + recovers the claims", () => {
    const jti = "abcdef00-0000-4000-8000-000000000000";
    const t = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS, jti },
      KEY,
    );
    const result = verifyReportShareToken(t, KEY, NOW_MS);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims).toEqual({
        v: 1,
        t: TENANT,
        p: PERIOD,
        exp: Math.floor(FUTURE_MS / 1000),
        jti,
      });
    }
  });

  it("validates close to expiry without false-rejection (strict < comparison)", () => {
    // exp = nowSeconds + 1 — the token is still alive at `now`.
    const expMs = NOW_MS + 1_500;
    const t = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: expMs },
      KEY,
    );
    const r = verifyReportShareToken(t, KEY, NOW_MS);
    expect(r.valid).toBe(true);
  });
});

describe("verifyReportShareToken — failure paths", () => {
  it("rejects an empty string", () => {
    expect(verifyReportShareToken("", KEY, NOW_MS)).toEqual({
      valid: false,
      reason: "malformed",
    });
  });

  it("rejects a token with no `.` separator", () => {
    expect(verifyReportShareToken("nodotshere", KEY, NOW_MS)).toEqual({
      valid: false,
      reason: "malformed",
    });
  });

  it("rejects a token with multiple `.` separators", () => {
    expect(verifyReportShareToken("a.b.c", KEY, NOW_MS)).toEqual({
      valid: false,
      reason: "malformed",
    });
  });

  it("rejects when the body is tampered (signature no longer matches)", () => {
    const t = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS },
      KEY,
    );
    const [body, sig] = t.split(".");
    // Flip a single base64url char in the body.
    const tamperedChar = body[0] === "A" ? "B" : "A";
    const tampered = tamperedChar + body.slice(1) + "." + sig;
    expect(verifyReportShareToken(tampered, KEY, NOW_MS)).toEqual({
      valid: false,
      reason: "bad_signature",
    });
  });

  it("rejects when the signature is tampered", () => {
    const t = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS },
      KEY,
    );
    const [body, sig] = t.split(".");
    const tamperedChar = sig[0] === "A" ? "B" : "A";
    const tampered = body + "." + tamperedChar + sig.slice(1);
    expect(verifyReportShareToken(tampered, KEY, NOW_MS)).toEqual({
      valid: false,
      reason: "bad_signature",
    });
  });

  it("rejects a token signed with a different key", () => {
    const t = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS },
      KEY,
    );
    expect(verifyReportShareToken(t, KEY_2, NOW_MS)).toEqual({
      valid: false,
      reason: "bad_signature",
    });
  });

  it("rejects when the verifier is handed an empty signing key", () => {
    const t = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: FUTURE_MS },
      KEY,
    );
    expect(verifyReportShareToken(t, Buffer.alloc(0), NOW_MS)).toEqual({
      valid: false,
      reason: "bad_signature",
    });
  });

  it("rejects an expired token", () => {
    const t = signReportShareToken(
      { tenantId: TENANT, periodKey: PERIOD, expiresAtMs: PAST_MS },
      KEY,
    );
    expect(verifyReportShareToken(t, KEY, NOW_MS)).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  it("rejects exactly at exp boundary (strict-greater-than semantics)", () => {
    // exp seconds === nowSeconds → expired (`now >= exp`).
    const expSeconds = Math.floor(NOW_MS / 1000);
    const expMsAlignedToBoundary = expSeconds * 1000;
    const t = signReportShareToken(
      {
        tenantId: TENANT,
        periodKey: PERIOD,
        expiresAtMs: expMsAlignedToBoundary,
      },
      KEY,
    );
    expect(verifyReportShareToken(t, KEY, expMsAlignedToBoundary)).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  it("rejects a token whose body is not valid base64url (non-alphabet char)", () => {
    // Construct a plausible-looking but non-base64url body.
    expect(verifyReportShareToken("not.base64url!=.aaaa", KEY, NOW_MS)).toEqual({
      valid: false,
      reason: "malformed",
    });
  });

  it("rejects when the claims JSON is missing a required field", () => {
    // Sign over a body that decodes to a JSON without `jti` so signature
    // verification passes but claim-shape validation fails.
    const incompleteClaims = { v: 1, t: TENANT, p: PERIOD, exp: Math.floor(FUTURE_MS / 1000) };
    const { body, sig } = handCraftSignedToken(incompleteClaims);
    expect(verifyReportShareToken(`${body}.${sig}`, KEY, NOW_MS)).toEqual({
      valid: false,
      reason: "invalid_claims",
    });
  });

  it("rejects an unsupported version field", () => {
    // Sign a future-version (v=2) token and ensure today's verifier rejects.
    const futureClaims = {
      v: 2,
      t: TENANT,
      p: PERIOD,
      exp: Math.floor(FUTURE_MS / 1000),
      jti: "abcdef00-0000-4000-8000-000000000000",
    };
    const { body, sig } = handCraftSignedToken(futureClaims);
    expect(verifyReportShareToken(`${body}.${sig}`, KEY, NOW_MS)).toEqual({
      valid: false,
      reason: "unsupported_version",
    });
  });
});

/** Build a signed token from an arbitrary claims object so we can exercise
 *  claim-shape failure paths (signature valid, but contents rejected).
 *  DELIBERATELY bypasses `json-canonicalize` so we can construct claim
 *  payloads the production `signReportShareToken` would refuse to build
 *  (missing required fields, wrong `v`). A future reader who "fixes" this
 *  to use the production canonicaliser will break the test on purpose. */
function handCraftSignedToken(claims: unknown): { body: string; sig: string } {
  const body = base64UrlEncodeForTest(Buffer.from(JSON.stringify(claims), "utf-8"));
  const sig = base64UrlEncodeForTest(
    createHmac("sha256", KEY).update(body, "utf-8").digest(),
  );
  return { body, sig };
}

function base64UrlEncodeForTest(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
