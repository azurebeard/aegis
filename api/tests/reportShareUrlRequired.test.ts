// SEC-L-L12-02 — REPORT_SHARE_URL_REQUIRED hard-fail flag.
//
// Mirror of the L12-01 (RECIPIENT_HASH_PEPPER_REQUIRED) regression test
// surface. Pins:
//   1. Strict literal `"true"` (case-insensitive, whitespace-trimmed) —
//      anything else falls through to fail-soft.
//   2. The hard-fail flag escalates each fail-soft branch in
//      `buildShareUrlOrAievent` (url_base_unset / url_base_not_https /
//      kv_read_failed / empty_secret / too_short / sign_threw) into a
//      `ReportShareUrlRequiredError` that the HTTP handler maps to 502.
//   3. The fail-soft branches still emit `report.email.share_link.fallback`
//      AIEVENT when the flag is off — the L12-02 change must NOT break
//      the established dev/rollout posture.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ReportShareSigningKeyModule from "../src/lib/reportShareSigningKey.js";
import type * as ReportShareTokenModule from "../src/lib/reportShareToken.js";
import type * as AievModule from "../src/lib/aievent.js";

const {
  loadReportShareSigningKeyMock,
  signReportShareTokenMock,
  emitAieventMock,
} = vi.hoisted(() => ({
  loadReportShareSigningKeyMock: vi.fn(),
  signReportShareTokenMock: vi.fn(),
  emitAieventMock: vi.fn(),
}));

vi.mock("../src/lib/reportShareSigningKey.js", async () => {
  const actual = await vi.importActual<typeof ReportShareSigningKeyModule>(
    "../src/lib/reportShareSigningKey.js",
  );
  return {
    ...actual,
    loadReportShareSigningKey: loadReportShareSigningKeyMock,
  };
});

vi.mock("../src/lib/reportShareToken.js", async () => {
  const actual = await vi.importActual<typeof ReportShareTokenModule>(
    "../src/lib/reportShareToken.js",
  );
  return {
    ...actual,
    signReportShareToken: signReportShareTokenMock,
  };
});

vi.mock("../src/lib/aievent.js", async () => {
  const actual = await vi.importActual<typeof AievModule>(
    "../src/lib/aievent.js",
  );
  return {
    ...actual,
    emitAievent: emitAieventMock,
  };
});

// `app.timer`/`app.http` would otherwise register handlers at module load.
vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

import {
  buildShareUrlOrAievent,
  ReportShareUrlRequiredError,
} from "../src/lib/reportEmail.js";

const TENANT = "tenant-l12-02";
const PERIOD = "2026-06";
const VALID_HTTPS_BASE = "https://aegis.example.com/reports/share";

function ctx() {
  return {
    invocationId: "inv-l12-02",
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof buildShareUrlOrAievent>[0];
}

beforeEach(() => {
  loadReportShareSigningKeyMock.mockReset();
  signReportShareTokenMock.mockReset();
  emitAieventMock.mockReset();
  // Default to a healthy key + sign — individual tests override.
  loadReportShareSigningKeyMock.mockResolvedValue({
    key: Buffer.alloc(32, 0x01),
  });
  signReportShareTokenMock.mockReturnValue("tok.payload.sig");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
describe("REPORT_SHARE_URL_REQUIRED — env-flag parsing (mirror of isPepperRequired)", () => {
  // Each case drives the env to a forced-fail branch (url_base_unset is the
  // cheapest, no KV mock needed) so we can prove the flag's interpretation
  // without spinning up the full path.
  beforeEach(() => {
    vi.stubEnv("REPORT_SHARE_URL_BASE", ""); // forces url_base_unset
  });

  it("unset → fail-soft (returns null, fallback AIEVENT emitted, no throw)", async () => {
    vi.stubEnv("REPORT_SHARE_URL_REQUIRED", "");
    const url = await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
    expect(url).toBeNull();
    expect(emitAieventMock).toHaveBeenCalledTimes(1);
    expect(emitAieventMock.mock.calls[0]![1]).toBe(
      "report.email.share_link.fallback",
    );
  });

  it.each([
    ["true", true],
    ["TRUE", true],
    ["  true  ", true],
    ["True", true],
    // Strict-match negatives — these must NOT activate hard-fail.
    ["1", false],
    ["yes", false],
    ["on", false],
    ["false", false],
    ["", false],
    ["truee", false],
  ])("REPORT_SHARE_URL_REQUIRED=%j → hardFail=%s", async (raw, hardFail) => {
    vi.stubEnv("REPORT_SHARE_URL_REQUIRED", raw);
    if (hardFail) {
      await expect(
        buildShareUrlOrAievent(ctx(), TENANT, PERIOD),
      ).rejects.toBeInstanceOf(ReportShareUrlRequiredError);
      // SEC-L-L12-02 WS10 Q8 — hard-fail path also emits an AIEVENT
      // (distinct name) for SOC telemetry parity with the fail-soft
      // path. Pin the event name so a future refactor that swallows
      // the hard-fail AIEVENT is caught here.
      expect(emitAieventMock).toHaveBeenCalledTimes(1);
      expect(emitAieventMock.mock.calls[0]![1]).toBe(
        "report.email.share_link.hard_fail",
      );
    } else {
      const url = await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
      expect(url).toBeNull();
      expect(emitAieventMock).toHaveBeenCalledTimes(1);
      expect(emitAieventMock.mock.calls[0]![1]).toBe(
        "report.email.share_link.fallback",
      );
    }
  });
});

describe("REPORT_SHARE_URL_REQUIRED — fallback-reason coverage when hard-fail is ON", () => {
  beforeEach(() => {
    vi.stubEnv("REPORT_SHARE_URL_REQUIRED", "true");
  });

  it("throws ReportShareUrlRequiredError(url_base_unset) when REPORT_SHARE_URL_BASE is empty", async () => {
    vi.stubEnv("REPORT_SHARE_URL_BASE", "");
    try {
      await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReportShareUrlRequiredError);
      expect((err as ReportShareUrlRequiredError).fallbackReason).toBe(
        "url_base_unset",
      );
    }
    // WS10 Q8 — hard-fail path emits the parity AIEVENT before throwing.
    expect(emitAieventMock).toHaveBeenCalledTimes(1);
    expect(emitAieventMock.mock.calls[0]![1]).toBe(
      "report.email.share_link.hard_fail",
    );
  });

  it("throws fallbackReason=url_base_not_https when the base is a plaintext scheme", async () => {
    // Deliberately pass a non-HTTPS scheme to drive the regex-guarded
    // rejection branch — the function MUST refuse to mint a link, and
    // with the flag on MUST throw rather than fail-soft.
    vi.stubEnv("REPORT_SHARE_URL_BASE", "http://aegis.example.com/r/s");
    try {
      await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReportShareUrlRequiredError);
      expect((err as ReportShareUrlRequiredError).fallbackReason).toBe(
        "url_base_not_https",
      );
    }
    // CRITICAL: the function must NOT have called loadReportShareSigningKey
    // or signReportShareToken on the rejected base — the HTTPS guard
    // short-circuits before any KV / token I/O.
    expect(loadReportShareSigningKeyMock).not.toHaveBeenCalled();
    expect(signReportShareTokenMock).not.toHaveBeenCalled();
  });

  it("throws fallbackReason=kv_read_failed when the signing-key loader returns null with kv_read_failed", async () => {
    vi.stubEnv("REPORT_SHARE_URL_BASE", VALID_HTTPS_BASE);
    loadReportShareSigningKeyMock.mockResolvedValue({
      key: null,
      fallbackReason: "kv_read_failed",
      errorDetail: "RestError 503",
    });
    try {
      await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReportShareUrlRequiredError);
      const e = err as ReportShareUrlRequiredError;
      expect(e.fallbackReason).toBe("kv_read_failed");
      expect(e.errorDetail).toBe("RestError 503");
    }
  });

  it.each(["env_unset", "empty_secret", "too_short"] as const)(
    "throws fallbackReason=%s when the signing-key loader returns that reason",
    async (reason) => {
      vi.stubEnv("REPORT_SHARE_URL_BASE", VALID_HTTPS_BASE);
      loadReportShareSigningKeyMock.mockResolvedValue({
        key: null,
        fallbackReason: reason,
      });
      try {
        await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReportShareUrlRequiredError);
        expect((err as ReportShareUrlRequiredError).fallbackReason).toBe(reason);
      }
    },
  );

  it("throws fallbackReason=sign_threw when signReportShareToken throws", async () => {
    vi.stubEnv("REPORT_SHARE_URL_BASE", VALID_HTTPS_BASE);
    signReportShareTokenMock.mockImplementation(() => {
      throw new Error("hmac key length invalid");
    });
    try {
      await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReportShareUrlRequiredError);
      const e = err as ReportShareUrlRequiredError;
      expect(e.fallbackReason).toBe("sign_threw");
      // errorDetail is the Error class name only — message body is NOT
      // included to keep KV-side hints off the wire.
      expect(e.errorDetail).toBe("Error");
    }
  });
});

describe("REPORT_SHARE_URL_REQUIRED — happy path is unaffected when hard-fail is ON", () => {
  beforeEach(() => {
    vi.stubEnv("REPORT_SHARE_URL_REQUIRED", "true");
    vi.stubEnv("REPORT_SHARE_URL_BASE", VALID_HTTPS_BASE);
  });

  it("returns the share URL and emits NO AIEVENT when key load + sign both succeed", async () => {
    const url = await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
    expect(url).toBe(`${VALID_HTTPS_BASE}/${encodeURIComponent("tok.payload.sig")}`);
    expect(emitAieventMock).not.toHaveBeenCalled();
  });

  it("strips a trailing slash from the URL base when minting the share link", async () => {
    vi.stubEnv("REPORT_SHARE_URL_BASE", `${VALID_HTTPS_BASE}///`);
    const url = await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
    expect(url).toBe(`${VALID_HTTPS_BASE}/${encodeURIComponent("tok.payload.sig")}`);
  });
});

describe("REPORT_SHARE_URL_REQUIRED — fail-soft posture preserved when flag is OFF", () => {
  beforeEach(() => {
    vi.stubEnv("REPORT_SHARE_URL_REQUIRED", ""); // explicit off
  });

  it.each([
    [
      "url_base_unset",
      () => vi.stubEnv("REPORT_SHARE_URL_BASE", ""),
    ],
    [
      "url_base_not_https",
      () => vi.stubEnv("REPORT_SHARE_URL_BASE", "http://aegis.example.com/r/s"),
    ],
  ])("returns null + emits AIEVENT for %s", async (expectedReason, stub) => {
    stub();
    const url = await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
    expect(url).toBeNull();
    expect(emitAieventMock).toHaveBeenCalledTimes(1);
    const [, eventName, payload] = emitAieventMock.mock.calls[0]!;
    expect(eventName).toBe("report.email.share_link.fallback");
    expect(payload).toMatchObject({
      tenantId: TENANT,
      periodKey: PERIOD,
      reason: expectedReason,
    });
  });

  it("returns null + emits AIEVENT with errorDetail when KV-read fails", async () => {
    vi.stubEnv("REPORT_SHARE_URL_BASE", VALID_HTTPS_BASE);
    loadReportShareSigningKeyMock.mockResolvedValue({
      key: null,
      fallbackReason: "kv_read_failed",
      errorDetail: "RestError 503",
    });
    const url = await buildShareUrlOrAievent(ctx(), TENANT, PERIOD);
    expect(url).toBeNull();
    expect(emitAieventMock).toHaveBeenCalledTimes(1);
    const [, , payload] = emitAieventMock.mock.calls[0]!;
    expect(payload).toMatchObject({
      reason: "kv_read_failed",
      errorDetail: "RestError 503",
    });
  });
});
