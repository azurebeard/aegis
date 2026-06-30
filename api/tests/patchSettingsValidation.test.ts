// Validation-surface tests for PATCH /api/settings (ADR-0025 Phase 1).
//
// We test the pure validator directly rather than the full handler to avoid
// having to mock @azure/functions + DefaultAzureCredential; the validator is
// the entire untrusted-input surface (rate-limit + upsertTileVisibility are
// covered elsewhere).

import { describe, it, expect, vi } from "vitest";
import type * as AzureFunctions from "@azure/functions";

vi.mock("@azure/functions", async () => {
  const actual = await vi.importActual<typeof AzureFunctions>("@azure/functions");
  return {
    ...actual,
    app: {
      ...actual.app,
      http: vi.fn(),
      timer: vi.fn(),
    },
  };
});

import { validatePatchBody } from "../src/functions/patchSettings.js";

describe("validatePatchBody", () => {
  it("accepts a minimal single-key patch", () => {
    const r = validatePatchBody({ tileVisibility: { secureScore: false } });
    expect(r).toEqual({ tileVisibility: { secureScore: false } });
  });

  it("accepts a multi-key patch", () => {
    const r = validatePatchBody({
      tileVisibility: { secureScore: false, brief: true, riskyUsers: false },
    });
    expect(r).toEqual({
      tileVisibility: { secureScore: false, brief: true, riskyUsers: false },
    });
  });

  it("rejects non-object body", () => {
    expect(validatePatchBody(null)).toMatchObject({ error: expect.stringContaining("object") });
    expect(validatePatchBody("string")).toMatchObject({ error: expect.stringContaining("object") });
    expect(validatePatchBody(123)).toMatchObject({ error: expect.stringContaining("object") });
  });

  it("rejects empty body (no concerns supplied)", () => {
    // Phase 3 contract: body must include at least one of tileVisibility,
    // agentBudget, or userIdentifierStrategy. Empty object → 400.
    expect(validatePatchBody({})).toMatchObject({
      error: expect.stringContaining("at least one of"),
    });
  });

  it("rejects non-object tileVisibility", () => {
    expect(validatePatchBody({ tileVisibility: "yes" })).toMatchObject({
      error: expect.stringContaining("object"),
    });
    expect(validatePatchBody({ tileVisibility: null })).toMatchObject({
      error: expect.stringContaining("object"),
    });
  });

  it("rejects empty tileVisibility (no keys to update)", () => {
    expect(validatePatchBody({ tileVisibility: {} })).toMatchObject({
      error: expect.stringContaining("at least one"),
    });
  });

  it("rejects unknown tile key", () => {
    expect(
      validatePatchBody({ tileVisibility: { unknownTile: true } }),
    ).toMatchObject({ error: expect.stringContaining("unknown tile key") });
  });

  it("rejects non-boolean value", () => {
    expect(
      validatePatchBody({ tileVisibility: { secureScore: 1 } }),
    ).toMatchObject({ error: expect.stringContaining("boolean") });
    expect(
      validatePatchBody({ tileVisibility: { secureScore: "true" } }),
    ).toMatchObject({ error: expect.stringContaining("boolean") });
  });

  it("rejects unknown top-level keys (reject-unknown contract)", () => {
    expect(
      validatePatchBody({
        tileVisibility: { secureScore: false },
        extra: "value",
      }),
    ).toMatchObject({ error: expect.stringContaining("unknown top-level") });
  });
});

describe("validatePatchBody — agentBudget (Phase 3)", () => {
  it("accepts a valid manual-run ceiling patch", () => {
    const r = validatePatchBody({ agentBudget: { briefManualRunCeiling: 50 } });
    expect(r).toEqual({ agentBudget: { briefManualRunCeiling: 50 } });
  });

  it("accepts a valid token budget patch", () => {
    const r = validatePatchBody({
      agentBudget: { briefDailyTokenBudget: 300_000 },
    });
    expect(r).toEqual({ agentBudget: { briefDailyTokenBudget: 300_000 } });
  });

  it("accepts both fields in one patch", () => {
    const r = validatePatchBody({
      agentBudget: { briefManualRunCeiling: 20, briefDailyTokenBudget: 150_000 },
    });
    expect(r).toEqual({
      agentBudget: { briefManualRunCeiling: 20, briefDailyTokenBudget: 150_000 },
    });
  });

  it("rejects ceiling below minimum (1)", () => {
    expect(
      validatePatchBody({ agentBudget: { briefManualRunCeiling: 0 } }),
    ).toMatchObject({ error: expect.stringContaining("[1, 100]") });
  });

  it("rejects ceiling above maximum (100)", () => {
    expect(
      validatePatchBody({ agentBudget: { briefManualRunCeiling: 101 } }),
    ).toMatchObject({ error: expect.stringContaining("[1, 100]") });
  });

  it("rejects token budget below minimum (50,000)", () => {
    expect(
      validatePatchBody({ agentBudget: { briefDailyTokenBudget: 49_999 } }),
    ).toMatchObject({ error: expect.stringContaining("[50000, 500000]") });
  });

  it("rejects token budget above maximum (500,000)", () => {
    expect(
      validatePatchBody({ agentBudget: { briefDailyTokenBudget: 500_001 } }),
    ).toMatchObject({ error: expect.stringContaining("[50000, 500000]") });
  });

  it("rejects non-integer ceiling", () => {
    expect(
      validatePatchBody({ agentBudget: { briefManualRunCeiling: 30.5 } }),
    ).toMatchObject({ error: expect.stringContaining("must be an integer") });
  });

  it("rejects unknown agentBudget keys", () => {
    expect(
      validatePatchBody({ agentBudget: { someFutureKnob: 42 } }),
    ).toMatchObject({ error: expect.stringContaining("unknown agentBudget key") });
  });

  it("rejects empty agentBudget object", () => {
    expect(validatePatchBody({ agentBudget: {} })).toMatchObject({
      error: expect.stringContaining("at least one"),
    });
  });
});

describe("validatePatchBody — agentBudget posture fields (ADR-0027 §Decision.4)", () => {
  it("accepts a valid postureManualRunCeiling patch", () => {
    const r = validatePatchBody({ agentBudget: { postureManualRunCeiling: 5 } });
    expect(r).toEqual({ agentBudget: { postureManualRunCeiling: 5 } });
  });

  it("accepts a valid postureWeeklyTokenBudget patch", () => {
    const r = validatePatchBody({
      agentBudget: { postureWeeklyTokenBudget: 50_000 },
    });
    expect(r).toEqual({ agentBudget: { postureWeeklyTokenBudget: 50_000 } });
  });

  it("accepts brief + posture fields together", () => {
    const r = validatePatchBody({
      agentBudget: {
        briefManualRunCeiling: 20,
        postureManualRunCeiling: 5,
        postureWeeklyTokenBudget: 40_000,
      },
    });
    expect(r).toEqual({
      agentBudget: {
        briefManualRunCeiling: 20,
        postureManualRunCeiling: 5,
        postureWeeklyTokenBudget: 40_000,
      },
    });
  });

  it("rejects postureManualRunCeiling outside [1, 50]", () => {
    expect(
      validatePatchBody({ agentBudget: { postureManualRunCeiling: 0 } }),
    ).toMatchObject({ error: expect.stringContaining("[1, 50]") });
    expect(
      validatePatchBody({ agentBudget: { postureManualRunCeiling: 51 } }),
    ).toMatchObject({ error: expect.stringContaining("[1, 50]") });
  });

  it("rejects postureWeeklyTokenBudget outside [5000, 200000]", () => {
    expect(
      validatePatchBody({ agentBudget: { postureWeeklyTokenBudget: 4_999 } }),
    ).toMatchObject({ error: expect.stringContaining("[5000, 200000]") });
    expect(
      validatePatchBody({ agentBudget: { postureWeeklyTokenBudget: 200_001 } }),
    ).toMatchObject({ error: expect.stringContaining("[5000, 200000]") });
  });

  it("rejects non-integer posture ceiling", () => {
    expect(
      validatePatchBody({ agentBudget: { postureManualRunCeiling: 3.5 } }),
    ).toMatchObject({ error: expect.stringContaining("must be an integer") });
  });
});

describe("validatePatchBody — agentBudget incidents fields (ADR-0028 §Decision.4)", () => {
  it("accepts a valid incidentsAnalysisManualRunCeiling patch", () => {
    const r = validatePatchBody({
      agentBudget: { incidentsAnalysisManualRunCeiling: 15 },
    });
    expect(r).toEqual({
      agentBudget: { incidentsAnalysisManualRunCeiling: 15 },
    });
  });

  it("accepts a valid incidentsAnalysisDailyTokenBudget patch", () => {
    const r = validatePatchBody({
      agentBudget: { incidentsAnalysisDailyTokenBudget: 25_000 },
    });
    expect(r).toEqual({
      agentBudget: { incidentsAnalysisDailyTokenBudget: 25_000 },
    });
  });

  it("accepts all three specialists' fields in one patch", () => {
    const r = validatePatchBody({
      agentBudget: {
        briefManualRunCeiling: 20,
        postureManualRunCeiling: 5,
        incidentsAnalysisManualRunCeiling: 15,
        incidentsAnalysisDailyTokenBudget: 20_000,
      },
    });
    expect(r).toEqual({
      agentBudget: {
        briefManualRunCeiling: 20,
        postureManualRunCeiling: 5,
        incidentsAnalysisManualRunCeiling: 15,
        incidentsAnalysisDailyTokenBudget: 20_000,
      },
    });
  });

  it("rejects incidentsAnalysisManualRunCeiling outside [1, 100]", () => {
    expect(
      validatePatchBody({ agentBudget: { incidentsAnalysisManualRunCeiling: 0 } }),
    ).toMatchObject({ error: expect.stringContaining("[1, 100]") });
    expect(
      validatePatchBody({ agentBudget: { incidentsAnalysisManualRunCeiling: 101 } }),
    ).toMatchObject({ error: expect.stringContaining("[1, 100]") });
  });

  it("rejects incidentsAnalysisDailyTokenBudget outside [3000, 60000] (SEC-BUG-INCIDENTS-BUDGET-MIN)", () => {
    // Bounds tied to estimateReservedTokens() in runIncidentsAgent.ts
    // (3_000 as of 2026-06-22): min = 1 × reservation, max = 20 × reservation.
    // Any value below the per-run reservation produces a guaranteed-fail
    // config — first analyse call 429s with `budget_exhausted` because the
    // reservation alone exceeds the daily token cap.
    expect(
      validatePatchBody({ agentBudget: { incidentsAnalysisDailyTokenBudget: 2_999 } }),
    ).toMatchObject({ error: expect.stringContaining("[3000, 60000]") });
    expect(
      validatePatchBody({ agentBudget: { incidentsAnalysisDailyTokenBudget: 60_001 } }),
    ).toMatchObject({ error: expect.stringContaining("[3000, 60000]") });
  });

  it("rejects non-integer incidents budget field", () => {
    expect(
      validatePatchBody({
        agentBudget: { incidentsAnalysisManualRunCeiling: 3.5 },
      }),
    ).toMatchObject({ error: expect.stringContaining("must be an integer") });
  });
});

describe("validatePatchBody — userIdentifierStrategy (Phase 3)", () => {
  it("accepts objectId / partial_mask / display_name", () => {
    for (const s of ["objectId", "partial_mask", "display_name"] as const) {
      const r = validatePatchBody({ userIdentifierStrategy: { strategy: s } });
      expect(r).toEqual({ userIdentifierStrategy: { strategy: s } });
    }
  });

  it("rejects unknown strategy value", () => {
    expect(
      validatePatchBody({ userIdentifierStrategy: { strategy: "full_upn" } }),
    ).toMatchObject({ error: expect.stringContaining("must be one of") });
  });

  it("rejects non-string strategy", () => {
    expect(
      validatePatchBody({ userIdentifierStrategy: { strategy: 42 } }),
    ).toMatchObject({ error: expect.stringContaining("must be one of") });
  });

  it("rejects unknown userIdentifierStrategy keys", () => {
    expect(
      validatePatchBody({
        userIdentifierStrategy: { strategy: "objectId", extra: true },
      }),
    ).toMatchObject({
      error: expect.stringContaining("unknown userIdentifierStrategy key"),
    });
  });
});

describe("validatePatchBody — union shape (Phase 3)", () => {
  it("accepts all three concerns in one patch", () => {
    const r = validatePatchBody({
      tileVisibility: { secureScore: false },
      agentBudget: { briefManualRunCeiling: 50 },
      userIdentifierStrategy: { strategy: "partial_mask" },
    });
    expect(r).toMatchObject({
      tileVisibility: { secureScore: false },
      agentBudget: { briefManualRunCeiling: 50 },
      userIdentifierStrategy: { strategy: "partial_mask" },
    });
  });

  it("rejects empty body (none of the four concerns supplied)", () => {
    expect(validatePatchBody({})).toMatchObject({
      error: expect.stringContaining("at least one of"),
    });
  });
});

describe("validatePatchBody — branding (ADR-0029 Phase A)", () => {
  it("accepts a minimal productName patch", () => {
    const r = validatePatchBody({ branding: { productName: "ACME Security" } });
    expect(r).toEqual({ branding: { productName: "ACME Security" } });
  });

  it("accepts a valid primaryHex patch", () => {
    const r = validatePatchBody({ branding: { primaryHex: "#FF0044" } });
    expect(r).toEqual({ branding: { primaryHex: "#FF0044" } });
  });

  it("accepts all four branding fields in one patch", () => {
    const r = validatePatchBody({
      branding: {
        productName: "ACME",
        primaryHex: "#102030",
        footerText: "© ACME 2026",
        defaultTheme: "dark",
      },
    });
    expect(r).toEqual({
      branding: {
        productName: "ACME",
        primaryHex: "#102030",
        footerText: "© ACME 2026",
        defaultTheme: "dark",
      },
    });
  });

  it("rejects productName exceeding 64 chars", () => {
    expect(
      validatePatchBody({ branding: { productName: "x".repeat(65) } }),
    ).toMatchObject({ error: expect.stringContaining("≤ 64") });
  });

  it("rejects non-string productName", () => {
    expect(validatePatchBody({ branding: { productName: 42 } })).toMatchObject({
      error: expect.stringContaining("must be a string"),
    });
  });

  it("rejects primaryHex that doesn't match #RRGGBB", () => {
    for (const bad of ["red", "#FFF", "#FFFFFFF", "FFFFFF", "#GGGGGG"]) {
      expect(
        validatePatchBody({ branding: { primaryHex: bad } }),
      ).toMatchObject({ error: expect.stringContaining("#RRGGBB") });
    }
  });

  it("rejects footerText exceeding 128 chars", () => {
    expect(
      validatePatchBody({ branding: { footerText: "x".repeat(129) } }),
    ).toMatchObject({ error: expect.stringContaining("≤ 128") });
  });

  it("rejects defaultTheme outside the enum", () => {
    for (const bad of ["auto", "sepia", "", "LIGHT"]) {
      expect(
        validatePatchBody({ branding: { defaultTheme: bad } }),
      ).toMatchObject({ error: expect.stringContaining("must be one of") });
    }
  });

  it("accepts each member of the defaultTheme enum", () => {
    for (const s of ["light", "dark", "system"] as const) {
      expect(
        validatePatchBody({ branding: { defaultTheme: s } }),
      ).toEqual({ branding: { defaultTheme: s } });
    }
  });

  it("rejects unknown branding keys", () => {
    expect(
      validatePatchBody({ branding: { tagline: "nope" } }),
    ).toMatchObject({ error: expect.stringContaining("unknown branding key") });
  });

  it("rejects empty branding object", () => {
    expect(validatePatchBody({ branding: {} })).toMatchObject({
      error: expect.stringContaining("at least one"),
    });
  });

  it("accepts branding alongside the other three concerns", () => {
    const r = validatePatchBody({
      tileVisibility: { secureScore: true },
      agentBudget: { briefDailyTokenBudget: 100_000 },
      userIdentifierStrategy: { strategy: "objectId" },
      branding: { productName: "ACME", defaultTheme: "system" },
    });
    expect(r).toMatchObject({
      tileVisibility: { secureScore: true },
      agentBudget: { briefDailyTokenBudget: 100_000 },
      userIdentifierStrategy: { strategy: "objectId" },
      branding: { productName: "ACME", defaultTheme: "system" },
    });
  });

  // ADR-0030 Phase A — reportCadence validation
  it("accepts reportCadence with each documented value", () => {
    for (const cadence of ["weekly", "monthly", "quarterly"]) {
      const r = validatePatchBody({ reportCadence: { cadence } });
      expect(r).toMatchObject({ reportCadence: { cadence } });
    }
  });

  it("rejects reportCadence with unknown / hostile cadence value", () => {
    for (const bad of ["", "WEEKLY", "daily", "annual", null, 123, "../../etc"]) {
      expect(
        validatePatchBody({ reportCadence: { cadence: bad } }),
      ).toMatchObject({
        error: expect.stringContaining("must be one of"),
      });
    }
  });

  it("rejects reportCadence as non-object", () => {
    expect(validatePatchBody({ reportCadence: "weekly" })).toMatchObject({
      error: expect.stringContaining("must be an object"),
    });
    expect(validatePatchBody({ reportCadence: null })).toMatchObject({
      error: expect.stringContaining("must be an object"),
    });
  });

  it("accepts reportCadence alongside the other concerns", () => {
    const r = validatePatchBody({
      tileVisibility: { secureScore: true },
      reportCadence: { cadence: "monthly" },
    });
    expect(r).toMatchObject({
      tileVisibility: { secureScore: true },
      reportCadence: { cadence: "monthly" },
    });
  });

  // ADR-0033 Phase 2.5 — kevBaseline validation
  it("accepts kevBaseline mode=historic with no baselineDate", () => {
    expect(validatePatchBody({ kevBaseline: { mode: "historic" } })).toMatchObject({
      kevBaseline: { mode: "historic", baselineDate: "" },
    });
  });

  it("accepts kevBaseline mode=historic with explicit empty baselineDate", () => {
    expect(
      validatePatchBody({ kevBaseline: { mode: "historic", baselineDate: "" } }),
    ).toMatchObject({
      kevBaseline: { mode: "historic", baselineDate: "" },
    });
  });

  it("rejects kevBaseline mode=historic with non-empty baselineDate", () => {
    expect(
      validatePatchBody({
        kevBaseline: { mode: "historic", baselineDate: "2026-04-29" },
      }),
    ).toMatchObject({
      error: expect.stringContaining('empty when mode is "historic"'),
    });
  });

  it("accepts kevBaseline mode=from-deploy with valid YYYY-MM-DD", () => {
    expect(
      validatePatchBody({
        kevBaseline: { mode: "from-deploy", baselineDate: "2026-04-29" },
      }),
    ).toMatchObject({
      kevBaseline: { mode: "from-deploy", baselineDate: "2026-04-29" },
    });
  });

  it("rejects kevBaseline mode=from-deploy with malformed date", () => {
    for (const bad of ["", "2026/04/29", "29-04-2026", "yesterday", "../../etc"]) {
      expect(
        validatePatchBody({
          kevBaseline: { mode: "from-deploy", baselineDate: bad },
        }),
      ).toMatchObject({ error: expect.stringContaining("YYYY-MM-DD") });
    }
  });

  it("rejects kevBaseline mode=from-deploy with unparseable date (month 13)", () => {
    expect(
      validatePatchBody({
        kevBaseline: { mode: "from-deploy", baselineDate: "2026-13-01" },
      }),
    ).toMatchObject({ error: expect.stringContaining("parseable") });
  });

  it("rejects kevBaseline with unknown mode", () => {
    for (const bad of ["", "ALL", "everything", "from_deploy", null, 1]) {
      expect(validatePatchBody({ kevBaseline: { mode: bad } })).toMatchObject({
        error: expect.stringContaining("must be one of"),
      });
    }
  });

  it("rejects kevBaseline with unknown sub-key", () => {
    expect(
      validatePatchBody({
        kevBaseline: { mode: "historic", sneaky: "x" },
      }),
    ).toMatchObject({ error: expect.stringContaining("unknown kevBaseline key") });
  });

  it("rejects kevBaseline as non-object", () => {
    expect(validatePatchBody({ kevBaseline: "historic" })).toMatchObject({
      error: expect.stringContaining("must be an object"),
    });
    expect(validatePatchBody({ kevBaseline: null })).toMatchObject({
      error: expect.stringContaining("must be an object"),
    });
  });

  it("accepts kevBaseline alongside the other concerns", () => {
    const r = validatePatchBody({
      reportCadence: { cadence: "monthly" },
      kevBaseline: { mode: "from-deploy", baselineDate: "2026-04-29" },
    });
    expect(r).toMatchObject({
      reportCadence: { cadence: "monthly" },
      kevBaseline: { mode: "from-deploy", baselineDate: "2026-04-29" },
    });
  });
});

describe("validatePatchBody — reportEmailConfig dedupe parity (WS10 SEC-X-LOWS-BATCH-02)", () => {
  it("dedupes recipients after canonicalisation (NFC + trim + lowercase)", () => {
    const r = validatePatchBody({
      reportEmailConfig: {
        enabled: true,
        recipients: ["board@x.com", "Board@x.com ", " board@x.com", "secondary@x.com"],
        allowExternalRecipients: false,
        externalRecipientDomains: [],
      },
    });
    expect(r).toMatchObject({
      reportEmailConfig: {
        recipients: ["board@x.com", "secondary@x.com"],
      },
    });
  });

  it("dedupes externalRecipientDomains likewise", () => {
    const r = validatePatchBody({
      reportEmailConfig: {
        enabled: false,
        recipients: [],
        allowExternalRecipients: true,
        externalRecipientDomains: ["Partner.com", "partner.com", "secondary.io"],
      },
    });
    expect(r).toMatchObject({
      reportEmailConfig: {
        externalRecipientDomains: ["partner.com", "secondary.io"],
      },
    });
  });

  it("preserves insertion order across dedupe (first-occurrence wins)", () => {
    const r = validatePatchBody({
      reportEmailConfig: {
        enabled: false,
        recipients: ["charlie@x.com", "alpha@x.com", "Charlie@x.com", "bravo@x.com"],
        allowExternalRecipients: false,
        externalRecipientDomains: [],
      },
    });
    expect(r).toMatchObject({
      reportEmailConfig: {
        recipients: ["charlie@x.com", "alpha@x.com", "bravo@x.com"],
      },
    });
  });
});
