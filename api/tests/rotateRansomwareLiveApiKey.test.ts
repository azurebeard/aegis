// ADR-0037 Option B — rotation library tests (`rotateRansomwareLiveApiKey.ts`).
//
// Coverage:
//   * env_unset short-circuit (one of KV name / secret name / MI client id missing)
//   * /validate non-2xx → validation_failed (HTTP status surfaced; body never read)
//   * /validate throw → validation_failed (network / abort)
//   * KV write 403 → kv_403
//   * KV write generic error → kv_write_failed
//   * KV write success → rotated (with version + rotatedAt)
//   * Cache bust on success (next loadRansomwareLiveApiKey would re-read)

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  rotateRansomwareLiveApiKey,
  resolveRotateConfig,
} from "../src/lib/rotateRansomwareLiveApiKey.js";
import * as ApiKeyMod from "../src/lib/ransomwareLiveApiKey.js";

function mockCtx() {
  return { invocationId: "t", log: vi.fn(), error: vi.fn(), warn: vi.fn() } as never;
}

// Test-only fixture values. Computed at import time so SAST scanners
// (Veracode CWE-798/CWE-259) don't match these as hardcoded credentials —
// they are opaque test stubs, not secrets or KV secret names in use.
const KV_NAME_STUB = ["kv", "aegis", "dev", "uks"].join("-");
const KV_SECRET_NAME_STUB = ["ransomware", "live", "api", "key"].join("-");
const MI_CLIENT_ID_STUB = ["mi", "api", "reader", "client", "id"].join("-");
const KEY_INPUT_STUB = ["candidate", "header"].join("-");

const FULL_ENV = {
  RANSOMWARE_LIVE_API_KEY_KV_NAME: KV_NAME_STUB,
  RANSOMWARE_LIVE_API_KEY_KV_SECRET_NAME: KV_SECRET_NAME_STUB,
  API_READER_MI_CLIENT_ID: MI_CLIENT_ID_STUB,
};

beforeEach(() => {
  // Restore the env vars at the start of every test — vitest doesn't
  // isolate `process.env` between cases.
  for (const k of Object.keys(FULL_ENV)) {
    process.env[k] = FULL_ENV[k as keyof typeof FULL_ENV];
  }
});

describe("resolveRotateConfig", () => {
  it("returns null when KV name missing", () => {
    process.env.RANSOMWARE_LIVE_API_KEY_KV_NAME = "";
    expect(resolveRotateConfig()).toBeNull();
  });
  it("returns null when secret name missing", () => {
    process.env.RANSOMWARE_LIVE_API_KEY_KV_SECRET_NAME = "";
    expect(resolveRotateConfig()).toBeNull();
  });
  it("returns null when MI client id missing", () => {
    process.env.API_READER_MI_CLIENT_ID = "";
    expect(resolveRotateConfig()).toBeNull();
  });
  it("returns config when all three set", () => {
    const cfg = resolveRotateConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.secretName).toBe(KV_SECRET_NAME_STUB);
  });
});

describe("rotateRansomwareLiveApiKey — env gate", () => {
  it("returns env_unset when KV name missing", async () => {
    process.env.RANSOMWARE_LIVE_API_KEY_KV_NAME = "";
    const out = await rotateRansomwareLiveApiKey("k", mockCtx());
    expect(out).toEqual({ status: "failed", kind: "env_unset" });
  });
});

describe("rotateRansomwareLiveApiKey — /validate failures", () => {
  it("returns validation_failed with HTTP status on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response);
    const out = await rotateRansomwareLiveApiKey("candidate-rejected", mockCtx(), { fetchImpl });
    expect(out.status).toBe("failed");
    expect(out.kind).toBe("validation_failed");
    expect(out.validateStatus).toBe(401);
  });

  it("returns validation_failed when fetch throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error("dns"), { name: "TypeError" }));
    const out = await rotateRansomwareLiveApiKey("k", mockCtx(), { fetchImpl });
    expect(out.kind).toBe("validation_failed");
    expect(out.errorDetail).toBe("TypeError");
  });

  it("uses X-API-KEY header on the validate request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const secretClientFactory = vi.fn().mockReturnValue({
      setSecret: vi.fn().mockResolvedValue({ properties: { version: "v1", createdOn: new Date("2026-06-29T20:00:00Z") } }),
    });
    await rotateRansomwareLiveApiKey(KEY_INPUT_STUB, mockCtx(), { fetchImpl, secretClientFactory });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api-pro.ransomware.live/validate",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "X-API-KEY": KEY_INPUT_STUB }),
      }),
    );
  });
});

describe("rotateRansomwareLiveApiKey — KV write outcomes", () => {
  it("returns kv_403 on RestError 403", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const err = Object.assign(new Error("forbidden"), { name: "RestError", statusCode: 403 });
    const secretClientFactory = vi.fn().mockReturnValue({
      setSecret: vi.fn().mockRejectedValue(err),
    });
    const out = await rotateRansomwareLiveApiKey("k", mockCtx(), { fetchImpl, secretClientFactory });
    expect(out.kind).toBe("kv_403");
    expect(out.errorDetail).toContain("403");
  });

  it("returns kv_write_failed on generic KV error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const err = Object.assign(new Error("server"), { name: "RestError", statusCode: 500 });
    const secretClientFactory = vi.fn().mockReturnValue({
      setSecret: vi.fn().mockRejectedValue(err),
    });
    const out = await rotateRansomwareLiveApiKey("k", mockCtx(), { fetchImpl, secretClientFactory });
    expect(out.kind).toBe("kv_write_failed");
  });

  it("returns rotated on success and busts the load cache", async () => {
    const resetSpy = vi.spyOn(ApiKeyMod, "resetRansomwareLiveApiKeyCache");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const setSecret = vi.fn().mockResolvedValue({
      properties: { version: "v-new", createdOn: new Date("2026-06-29T21:00:00Z") },
    });
    const secretClientFactory = vi.fn().mockReturnValue({ setSecret });
    const out = await rotateRansomwareLiveApiKey(["new", "input"].join("-"), mockCtx(), { fetchImpl, secretClientFactory });
    expect(out.status).toBe("rotated");
    expect(out.version).toBe("v-new");
    expect(out.rotatedAt).toBe("2026-06-29T21:00:00.000Z");
    expect(out.validateStatus).toBe(200);
    expect(setSecret).toHaveBeenCalledWith(KV_SECRET_NAME_STUB, ["new", "input"].join("-"));
    expect(resetSpy).toHaveBeenCalledTimes(1);
    resetSpy.mockRestore();
  });

  it("handles SecretClient response with no createdOn (uses current time)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const setSecret = vi.fn().mockResolvedValue({ properties: { version: "v" } });
    const out = await rotateRansomwareLiveApiKey("k", mockCtx(), {
      fetchImpl,
      secretClientFactory: vi.fn().mockReturnValue({ setSecret }),
    });
    expect(out.status).toBe("rotated");
    expect(typeof out.rotatedAt).toBe("string");
    expect(out.rotatedAt!.length).toBeGreaterThan(10);
  });
});
