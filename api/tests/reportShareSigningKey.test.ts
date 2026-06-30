// Unit tests for the share-link signing-key loader. Pure cache + env-driven
// load; Key Vault SDK mocked at the module boundary — mirrors the structure
// of recipientHashPepper.test.ts.

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
  loadReportShareSigningKey,
  resetReportShareSigningKeyCache,
} from "../src/lib/reportShareSigningKey.js";

// 32 random bytes base64-encoded (deterministic for the test).
const VALID_KEY_B64 = Buffer.alloc(32, 0xa1).toString("base64");

beforeEach(() => {
  resetReportShareSigningKeyCache();
  mocks.getSecret.mockReset();
  mocks.secretClientCtor.mockReset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadReportShareSigningKey", () => {
  it("env_unset when no env vars are set", async () => {
    const r = await loadReportShareSigningKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("env_unset");
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it("env_unset when KV name set but api-reader MI client id missing", async () => {
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_NAME", "kv-aegis-dev-weu");
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME", "report-share-signing-key");
    const r = await loadReportShareSigningKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("env_unset");
  });

  it("returns the decoded key buffer when all env vars set and KV read succeeds", async () => {
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_NAME", "kv-aegis-dev-weu");
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME", "report-share-signing-key");
    vi.stubEnv("API_READER_MI_CLIENT_ID", "api-reader-mi");
    mocks.getSecret.mockResolvedValue({ value: VALID_KEY_B64 });
    const r = await loadReportShareSigningKey();
    expect(r.key).not.toBeNull();
    expect(r.key?.length).toBe(32);
    expect(r.fallbackReason).toBeUndefined();
    expect(mocks.secretClientCtor).toHaveBeenCalledWith(
      "https://kv-aegis-dev-weu.vault.azure.net",
    );
    expect(mocks.getSecret).toHaveBeenCalledWith("report-share-signing-key");
  });

  it("empty_secret when KV returns an empty value", async () => {
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_NAME", "kv-aegis-dev-weu");
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME", "report-share-signing-key");
    vi.stubEnv("API_READER_MI_CLIENT_ID", "api-reader-mi");
    mocks.getSecret.mockResolvedValue({ value: "   " });
    const r = await loadReportShareSigningKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("empty_secret");
  });

  it("too_short when the decoded key is shorter than 32 bytes", async () => {
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_NAME", "kv-aegis-dev-weu");
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME", "report-share-signing-key");
    vi.stubEnv("API_READER_MI_CLIENT_ID", "api-reader-mi");
    const shortKey = Buffer.alloc(16, 0x42).toString("base64");
    mocks.getSecret.mockResolvedValue({ value: shortKey });
    const r = await loadReportShareSigningKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("too_short");
  });

  it("kv_read_failed when SecretClient throws — errorDetail is scrubbed", async () => {
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_NAME", "kv-aegis-dev-weu");
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME", "report-share-signing-key");
    vi.stubEnv("API_READER_MI_CLIENT_ID", "api-reader-mi");
    const err = new Error("kv read denied for vault https://kv-aegis-dev-weu...");
    (err as { name?: string }).name = "AuthenticationRequiredError";
    (err as { statusCode?: number }).statusCode = 401;
    mocks.getSecret.mockRejectedValue(err);
    const r = await loadReportShareSigningKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("kv_read_failed");
    expect(r.errorDetail).toBe("AuthenticationRequiredError 401");
    expect(r.errorDetail).not.toContain("kv-aegis-dev-weu");
    expect(r.errorDetail).not.toContain("kv read denied");
  });

  it("caches the decoded key — no second SDK invocation", async () => {
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_NAME", "kv-aegis-dev-weu");
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME", "report-share-signing-key");
    vi.stubEnv("API_READER_MI_CLIENT_ID", "api-reader-mi");
    mocks.getSecret.mockResolvedValue({ value: VALID_KEY_B64 });
    const r1 = await loadReportShareSigningKey();
    const r2 = await loadReportShareSigningKey();
    expect(r1.key?.equals(r2.key!)).toBe(true);
    expect(mocks.getSecret).toHaveBeenCalledTimes(1);
  });

  it("caches the env_unset fallback — no SDK calls on second invocation", async () => {
    const r1 = await loadReportShareSigningKey();
    const r2 = await loadReportShareSigningKey();
    expect(r1.key).toBeNull();
    expect(r2.key).toBeNull();
    expect(mocks.secretClientCtor).not.toHaveBeenCalled();
  });

  it("caches kv_read_failed — operator must restart FA to retry", async () => {
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_NAME", "kv-aegis-dev-weu");
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME", "report-share-signing-key");
    vi.stubEnv("API_READER_MI_CLIENT_ID", "api-reader-mi");
    const err = new Error("transient");
    (err as { name?: string }).name = "RestError";
    (err as { statusCode?: number }).statusCode = 503;
    mocks.getSecret.mockRejectedValue(err);
    const r1 = await loadReportShareSigningKey();
    const r2 = await loadReportShareSigningKey();
    expect(r1.fallbackReason).toBe("kv_read_failed");
    expect(r2.fallbackReason).toBe("kv_read_failed");
    expect(r2.errorDetail).toBe("RestError 503");
    expect(mocks.getSecret).toHaveBeenCalledTimes(1);
  });

  it("resetReportShareSigningKeyCache forces a re-read on next call", async () => {
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_NAME", "kv-aegis-dev-weu");
    vi.stubEnv("REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME", "report-share-signing-key");
    vi.stubEnv("API_READER_MI_CLIENT_ID", "api-reader-mi");
    const firstKey = Buffer.alloc(32, 0x11).toString("base64");
    const secondKey = Buffer.alloc(32, 0x22).toString("base64");
    mocks.getSecret.mockResolvedValueOnce({ value: firstKey });
    const r1 = await loadReportShareSigningKey();
    expect(r1.key?.[0]).toBe(0x11);
    resetReportShareSigningKeyCache();
    mocks.getSecret.mockResolvedValueOnce({ value: secondKey });
    const r2 = await loadReportShareSigningKey();
    expect(r2.key?.[0]).toBe(0x22);
    expect(mocks.getSecret).toHaveBeenCalledTimes(2);
  });
});
