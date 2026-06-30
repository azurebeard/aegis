// ADR-0037 Layer 3b — ransomware.live API key loader tests.
// Mirrors the recipientHashPepper test shape: KV SDK mocked at the module
// boundary so tests run without a live vault.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as KvSecretsModule from "@azure/keyvault-secrets";
import type * as IdentityModule from "@azure/identity";

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  secretClientCtor: vi.fn(),
}));

vi.mock("@azure/keyvault-secrets", async () => {
  const actual = await vi.importActual<typeof KvSecretsModule>(
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
  const actual = await vi.importActual<typeof IdentityModule>(
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
  loadRansomwareLiveApiKey,
  resetRansomwareLiveApiKeyCache,
} from "../src/lib/ransomwareLiveApiKey.js";

beforeEach(() => {
  resetRansomwareLiveApiKeyCache();
  mocks.getSecret.mockReset();
  mocks.secretClientCtor.mockReset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubFullEnv(): void {
  vi.stubEnv("RANSOMWARE_LIVE_API_KEY_KV_NAME", "kv-aegis-dev-uks");
  vi.stubEnv("RANSOMWARE_LIVE_API_KEY_KV_SECRET_NAME", "ransomware-live-api-key");
  vi.stubEnv("THREAT_INTEL_MI_CLIENT_ID", "mi-threat-intel");
}

describe("loadRansomwareLiveApiKey", () => {
  it("returns env_unset when no env vars set", async () => {
    const r = await loadRansomwareLiveApiKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("env_unset");
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it("returns env_unset when KV name is set but MI client id is missing", async () => {
    vi.stubEnv("RANSOMWARE_LIVE_API_KEY_KV_NAME", "kv-aegis-dev-uks");
    vi.stubEnv("RANSOMWARE_LIVE_API_KEY_KV_SECRET_NAME", "ransomware-live-api-key");
    const r = await loadRansomwareLiveApiKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("env_unset");
  });

  it("returns the key from KV on the happy path", async () => {
    stubFullEnv();
    mocks.getSecret.mockResolvedValue({ value: "  live-api-key-bytes  " });
    const r = await loadRansomwareLiveApiKey();
    expect(r.key).toBe("live-api-key-bytes"); // trimmed
    expect(r.fallbackReason).toBeUndefined();
    expect(mocks.secretClientCtor).toHaveBeenCalledWith(
      "https://kv-aegis-dev-uks.vault.azure.net",
    );
    expect(mocks.getSecret).toHaveBeenCalledWith("ransomware-live-api-key");
  });

  it("returns secret_unavailable when KV returns an empty value", async () => {
    stubFullEnv();
    mocks.getSecret.mockResolvedValue({ value: "   " });
    const r = await loadRansomwareLiveApiKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("secret_unavailable");
  });

  it("returns kv_403 on KV ABAC denial", async () => {
    stubFullEnv();
    const err = new Error("Forbidden");
    (err as { name?: string }).name = "RestError";
    (err as { statusCode?: number }).statusCode = 403;
    mocks.getSecret.mockRejectedValue(err);
    const r = await loadRansomwareLiveApiKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("kv_403");
    expect(r.errorDetail).toBe("RestError 403");
  });

  it("returns kv_timeout on AbortError", async () => {
    stubFullEnv();
    const err = new Error("aborted");
    (err as { name?: string }).name = "AbortError";
    mocks.getSecret.mockRejectedValue(err);
    const r = await loadRansomwareLiveApiKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("kv_timeout");
  });

  it("returns kv_timeout on ETIMEDOUT code", async () => {
    stubFullEnv();
    const err = new Error("network");
    (err as { code?: string }).code = "ETIMEDOUT";
    mocks.getSecret.mockRejectedValue(err);
    const r = await loadRansomwareLiveApiKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("kv_timeout");
  });

  it("returns kv_read_failed for other KV errors", async () => {
    stubFullEnv();
    const err = new Error("unknown");
    (err as { name?: string }).name = "RestError";
    (err as { statusCode?: number }).statusCode = 503;
    mocks.getSecret.mockRejectedValue(err);
    const r = await loadRansomwareLiveApiKey();
    expect(r.key).toBeNull();
    expect(r.fallbackReason).toBe("kv_read_failed");
    expect(r.errorDetail).toBe("RestError 503");
  });

  it("scrubs the errorDetail so KV URLs / payload do not leak", async () => {
    stubFullEnv();
    const err = new Error("kv read denied at https://kv-aegis-dev-uks.vault.azure.net/secrets/foo");
    (err as { name?: string }).name = "AuthenticationRequiredError";
    (err as { statusCode?: number }).statusCode = 401;
    mocks.getSecret.mockRejectedValue(err);
    const r = await loadRansomwareLiveApiKey();
    expect(r.errorDetail).toBe("AuthenticationRequiredError 401");
    expect(r.errorDetail).not.toContain("kv-aegis-dev-uks");
    expect(r.errorDetail).not.toContain("kv read denied");
  });

  it("caches the live key across calls (one SDK invocation)", async () => {
    stubFullEnv();
    mocks.getSecret.mockResolvedValue({ value: "cached-key" });
    const r1 = await loadRansomwareLiveApiKey();
    const r2 = await loadRansomwareLiveApiKey();
    expect(r1.key).toBe("cached-key");
    expect(r2.key).toBe("cached-key");
    expect(mocks.getSecret).toHaveBeenCalledTimes(1);
  });

  it("caches the env_unset fallback — no SDK calls on second invocation", async () => {
    const r1 = await loadRansomwareLiveApiKey();
    const r2 = await loadRansomwareLiveApiKey();
    expect(r1.key).toBeNull();
    expect(r2.key).toBeNull();
    expect(mocks.secretClientCtor).not.toHaveBeenCalled();
  });

  it("caches the kv_403 fallback — operator must restart FA to retry", async () => {
    stubFullEnv();
    const err = new Error("forbidden");
    (err as { name?: string }).name = "RestError";
    (err as { statusCode?: number }).statusCode = 403;
    mocks.getSecret.mockRejectedValue(err);
    const r1 = await loadRansomwareLiveApiKey();
    const r2 = await loadRansomwareLiveApiKey();
    expect(r1.fallbackReason).toBe("kv_403");
    expect(r2.fallbackReason).toBe("kv_403");
    expect(r2.errorDetail).toBe("RestError 403");
    expect(mocks.getSecret).toHaveBeenCalledTimes(1);
  });

  it("resetRansomwareLiveApiKeyCache forces a re-read on next call", async () => {
    stubFullEnv();
    mocks.getSecret.mockResolvedValueOnce({ value: "first-key" });
    const r1 = await loadRansomwareLiveApiKey();
    expect(r1.key).toBe("first-key");
    resetRansomwareLiveApiKeyCache();
    mocks.getSecret.mockResolvedValueOnce({ value: "second-key" });
    const r2 = await loadRansomwareLiveApiKey();
    expect(r2.key).toBe("second-key");
    expect(mocks.getSecret).toHaveBeenCalledTimes(2);
  });
});
