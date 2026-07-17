// Unit tests for the recipient-hash pepper loader. Pure cache + env-driven
// load path; the Key Vault SDK is mocked at the module boundary so the
// tests run without an actual Key Vault.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  secretClientCtor: vi.fn(),
}));

vi.mock("@azure/keyvault-secrets", async () => {
  const actual = await vi.importActual<typeof import("@azure/keyvault-secrets")>(
    "@azure/keyvault-secrets",
  );
  return {
    ...actual,
    SecretClient: vi.fn(function (this: unknown, vaultUrl: string) {
      mocks.secretClientCtor(vaultUrl);
      return { getSecret: mocks.getSecret };
    }),
  };
});

vi.mock("@azure/identity", async () => {
  const actual = await vi.importActual<typeof import("@azure/identity")>(
    "@azure/identity",
  );
  return {
    ...actual,
    DefaultAzureCredential: vi.fn(function (this: unknown) {
      return {};
    }),
  };
});

import {
  loadRecipientHashPepper,
  resetRecipientHashPepperCache,
  RecipientHashPepperRequiredError,
} from "../src/lib/recipientHashPepper.js";

beforeEach(() => {
  resetRecipientHashPepperCache();
  mocks.getSecret.mockReset();
  mocks.secretClientCtor.mockReset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadRecipientHashPepper", () => {
  it("returns env_unset fallback when any of the three required env vars is missing", async () => {
    // No env stubs at all.
    const r = await loadRecipientHashPepper();
    expect(r.pepper).toBeNull();
    expect(r.fallbackReason).toBe("env_unset");
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it("returns env_unset when KV name is set but secret name is missing", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-dev-uks");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    const r = await loadRecipientHashPepper();
    expect(r.pepper).toBeNull();
    expect(r.fallbackReason).toBe("env_unset");
  });

  it("returns the pepper from KV when all three env vars are set and secret read succeeds", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-dev-uks");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    mocks.getSecret.mockResolvedValue({ value: "  pepper-bytes-base64  " }); // trim test
    const r = await loadRecipientHashPepper();
    expect(r.pepper).toBe("pepper-bytes-base64");
    expect(r.fallbackReason).toBeUndefined();
    expect(mocks.secretClientCtor).toHaveBeenCalledWith(
      "https://kv-aegis-dev-uks.vault.azure.net",
    );
    expect(mocks.getSecret).toHaveBeenCalledWith("recipient-hash-pepper");
  });

  it("returns empty_secret fallback when KV returns an empty value", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-dev-uks");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    mocks.getSecret.mockResolvedValue({ value: "   " }); // whitespace only
    const r = await loadRecipientHashPepper();
    expect(r.pepper).toBeNull();
    expect(r.fallbackReason).toBe("empty_secret");
  });

  it("returns kv_read_failed fallback when SecretClient throws", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-dev-uks");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    const err = new Error("kv read denied");
    (err as { name?: string }).name = "AuthenticationRequiredError";
    (err as { statusCode?: number }).statusCode = 401;
    mocks.getSecret.mockRejectedValue(err);
    const r = await loadRecipientHashPepper();
    expect(r.pepper).toBeNull();
    expect(r.fallbackReason).toBe("kv_read_failed");
    // WS10 — errorDetail must be a SCRUBBED summary, not the raw KV URL or
    // auth payload. We expect classname + statusCode only.
    expect(r.errorDetail).toBe("AuthenticationRequiredError 401");
    expect(r.errorDetail).not.toContain("kv-aegis-dev-uks");
    expect(r.errorDetail).not.toContain("kv read denied");
  });

  it("caches the loaded pepper across calls (no second SDK invocation)", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-dev-uks");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    mocks.getSecret.mockResolvedValue({ value: "cached-pepper" });
    const r1 = await loadRecipientHashPepper();
    const r2 = await loadRecipientHashPepper();
    expect(r1.pepper).toBe("cached-pepper");
    expect(r2.pepper).toBe("cached-pepper");
    expect(mocks.getSecret).toHaveBeenCalledTimes(1);
  });

  it("caches the env_unset fallback too — no SDK calls on second invocation", async () => {
    const r1 = await loadRecipientHashPepper();
    const r2 = await loadRecipientHashPepper();
    expect(r1.pepper).toBeNull();
    expect(r2.pepper).toBeNull();
    expect(mocks.secretClientCtor).not.toHaveBeenCalled();
  });

  it("caches the kv_read_failed fallback — operator must restart FA to retry", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-dev-uks");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    const err = new Error("transient");
    (err as { name?: string }).name = "RestError";
    (err as { statusCode?: number }).statusCode = 503;
    mocks.getSecret.mockRejectedValue(err);
    const r1 = await loadRecipientHashPepper();
    const r2 = await loadRecipientHashPepper();
    expect(r1.fallbackReason).toBe("kv_read_failed");
    expect(r2.fallbackReason).toBe("kv_read_failed");
    expect(r2.errorDetail).toBe("RestError 503");
    expect(mocks.getSecret).toHaveBeenCalledTimes(1);
  });

  it("resetRecipientHashPepperCache forces a re-read on next call", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-dev-uks");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    mocks.getSecret.mockResolvedValueOnce({ value: "first-pepper" });
    const r1 = await loadRecipientHashPepper();
    expect(r1.pepper).toBe("first-pepper");
    resetRecipientHashPepperCache();
    mocks.getSecret.mockResolvedValueOnce({ value: "second-pepper" });
    const r2 = await loadRecipientHashPepper();
    expect(r2.pepper).toBe("second-pepper");
    expect(mocks.getSecret).toHaveBeenCalledTimes(2);
  });
});

// SEC-L-L12-01 — RECIPIENT_HASH_PEPPER_REQUIRED hard-fail flag.
describe("RECIPIENT_HASH_PEPPER_REQUIRED hard-fail flag (SEC-L-L12-01)", () => {
  it("throws RecipientHashPepperRequiredError when flag=true and env is unset", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_REQUIRED", "true");
    await expect(loadRecipientHashPepper()).rejects.toBeInstanceOf(
      RecipientHashPepperRequiredError,
    );
  });

  it("error carries the underlying fallbackReason for handler diagnostics", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_REQUIRED", "true");
    try {
      await loadRecipientHashPepper();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RecipientHashPepperRequiredError);
      const e = err as RecipientHashPepperRequiredError;
      expect(e.fallbackReason).toBe("env_unset");
      expect(e.errorDetail).toBeUndefined();
    }
  });

  it("throws when flag=true and KV read fails (kv_read_failed)", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_REQUIRED", "true");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-prod-weu");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    const err = new Error("kv down");
    (err as { name?: string }).name = "RestError";
    (err as { statusCode?: number }).statusCode = 503;
    mocks.getSecret.mockRejectedValue(err);
    try {
      await loadRecipientHashPepper();
      throw new Error("expected throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(RecipientHashPepperRequiredError);
      const e = caught as RecipientHashPepperRequiredError;
      expect(e.fallbackReason).toBe("kv_read_failed");
      // Scrubbed errorDetail (classname + statusCode) must propagate so the
      // handler can surface it, but the raw payload/URL must NOT.
      expect(e.errorDetail).toBe("RestError 503");
      expect(e.message).not.toContain("kv-aegis-prod-weu");
      expect(e.message).not.toContain("kv down");
    }
  });

  it("throws when flag=true and KV returns empty secret (empty_secret)", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_REQUIRED", "true");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-prod-weu");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    mocks.getSecret.mockResolvedValue({ value: "" });
    await expect(loadRecipientHashPepper()).rejects.toMatchObject({
      fallbackReason: "empty_secret",
    });
  });

  it("does NOT throw when flag=true and KV read succeeds (happy path preserved)", async () => {
    vi.stubEnv("RECIPIENT_HASH_PEPPER_REQUIRED", "true");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-prod-weu");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    mocks.getSecret.mockResolvedValue({ value: "live-pepper" });
    const r = await loadRecipientHashPepper();
    expect(r.pepper).toBe("live-pepper");
  });

  it("preserves fail-soft posture when flag is unset (default behaviour)", async () => {
    // No RECIPIENT_HASH_PEPPER_REQUIRED env stub at all.
    const r = await loadRecipientHashPepper();
    expect(r.pepper).toBeNull();
    expect(r.fallbackReason).toBe("env_unset");
  });

  it.each(["false", "False", "FALSE", "0", "1", "yes", "no", "  ", "TRUE_ish"])(
    "preserves fail-soft posture when flag is non-literal-true value (%s)",
    async (val) => {
      vi.stubEnv("RECIPIENT_HASH_PEPPER_REQUIRED", val);
      const r = await loadRecipientHashPepper();
      expect(r.pepper).toBeNull();
      expect(r.fallbackReason).toBe("env_unset");
    },
  );

  it.each(["true", "TRUE", "True", " true ", "tRuE", "\ttrue\n"])(
    "activates hard-fail when flag is case-insensitive whitespace-trimmed `true` (%s)",
    async (val) => {
      vi.stubEnv("RECIPIENT_HASH_PEPPER_REQUIRED", val);
      await expect(loadRecipientHashPepper()).rejects.toBeInstanceOf(
        RecipientHashPepperRequiredError,
      );
    },
  );

  it("uses the cached fallback when flag flips on mid-process (cache survives)", async () => {
    // First call with flag off — caches null fallback.
    const r1 = await loadRecipientHashPepper();
    expect(r1.pepper).toBeNull();
    // Operator flips the flag on; next call sees the cached null and throws.
    vi.stubEnv("RECIPIENT_HASH_PEPPER_REQUIRED", "true");
    await expect(loadRecipientHashPepper()).rejects.toBeInstanceOf(
      RecipientHashPepperRequiredError,
    );
    // Cache hit — no SDK invocation between the two calls.
    expect(mocks.secretClientCtor).not.toHaveBeenCalled();
  });
});
