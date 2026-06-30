import { describe, it, expect, vi } from "vitest";
import type { TableClient } from "@azure/data-tables";
import {
  BRANDING_DEFAULTS,
  capabilityFromStatus,
  clearBrandingLogo,
  computeBrandingLogoUrl,
  computeEffectiveVisibility,
  DEFAULT_TILE_VISIBILITY,
  DEFAULT_USER_IDENTIFIER_STRATEGY,
  maskDisplayName,
  readAgentBudget,
  readBranding,
  readTenantSettings,
  readUserIdentifierStrategy,
  upsertAgentBudget,
  upsertBranding,
  upsertBrandingLogo,
  upsertTileVisibility,
  upsertUserIdentifierStrategy,
  type TileCapabilities,
  type TileVisibility,
} from "../src/lib/tenantSettingsStore.js";

const TENANT = "tenant-1";

function mkTable(
  overrides: Partial<{
    getEntity: TableClient["getEntity"];
    upsertEntity: TableClient["upsertEntity"];
  }> = {},
): TableClient {
  return {
    getEntity: overrides.getEntity ?? vi.fn(),
    upsertEntity: overrides.upsertEntity ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as TableClient;
}

describe("readTenantSettings", () => {
  it("returns defaults when the row is missing (all tiles visible)", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const table = mkTable({ getEntity });
    const got = await readTenantSettings(table, TENANT);
    expect(got.tileVisibility).toEqual(DEFAULT_TILE_VISIBILITY);
    expect(got.updatedAt).toBeNull();
    expect(got.updatedBy).toBeNull();
  });

  it("maps column booleans to tileVisibility keys", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "tile-visibility",
      SecureScore: true,
      Incidents: false,
      Brief: true,
      RiskyUsers: false,
      UpdatedAt: "2026-04-20T10:00:00.000Z",
      UpdatedBy: "alice@contoso.com",
    });
    const table = mkTable({ getEntity });
    const got = await readTenantSettings(table, TENANT);
    expect(got.tileVisibility).toEqual({
      secureScore: true,
      incidents: false,
      brief: true,
      riskyUsers: false,
      posture: true, // column absent from legacy row → defaults to true (ADR-0027 additive)
      stack: true,   // column absent from legacy row → defaults to true (ADR-0031)
      kev: true,     // column absent from legacy row → defaults to true (ADR-0032)
      userDormancy: true, // column absent from legacy row → defaults to true (ADR-0034 Phase 8B)
      conditionalAccess: true, // column absent from legacy row → defaults to true (ADR-0034 Phase 8D)
      signIns: true,      // column absent from legacy row → defaults to true (ADR-0034 Phase 8C)
      azureSecureScore: true, // column absent from legacy row → defaults to true (ADR-0036)
      ransomwareIntel: true, // column absent from legacy row → defaults to true (ADR-0037)
    });
    expect(got.updatedAt).toBe("2026-04-20T10:00:00.000Z");
    expect(got.updatedBy).toBe("alice@contoso.com");
  });

  it("coerces legacy string 'true'/'false' values to booleans", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "tile-visibility",
      SecureScore: "true",
      Incidents: "false",
      Brief: true,
      RiskyUsers: false,
      UpdatedAt: "2026-04-20T10:00:00.000Z",
      UpdatedBy: "alice@contoso.com",
    });
    const table = mkTable({ getEntity });
    const got = await readTenantSettings(table, TENANT);
    expect(got.tileVisibility.secureScore).toBe(true);
    expect(got.tileVisibility.incidents).toBe(false);
  });

  it("propagates non-404 errors", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const table = mkTable({ getEntity });
    await expect(readTenantSettings(table, TENANT)).rejects.toThrow("forbidden");
  });
});

describe("upsertTileVisibility", () => {
  it("merges a partial patch over defaults when row is absent", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ getEntity, upsertEntity });
    const got = await upsertTileVisibility(table, {
      tenantId: TENANT,
      patch: { incidents: false },
      updatedBy: "alice@contoso.com",
      updatedAt: "2026-04-20T10:00:00.000Z",
    });
    expect(got.tileVisibility).toEqual({
      secureScore: true,
      incidents: false,
      brief: true,
      riskyUsers: true,
      posture: true,
      stack: true,
      kev: true,
      userDormancy: true,
      signIns: true,
      conditionalAccess: true,
      azureSecureScore: true,
      ransomwareIntel: true,
    });
    const [entity, mode] = upsertEntity.mock.calls[0] as [
      {
        partitionKey: string;
        rowKey: string;
        SecureScore: boolean;
        Incidents: boolean;
        Brief: boolean;
        RiskyUsers: boolean;
        UpdatedAt: string;
        UpdatedBy: string;
      },
      string,
    ];
    expect(entity.partitionKey).toBe(TENANT);
    expect(entity.rowKey).toBe("tile-visibility");
    expect(entity.Incidents).toBe(false);
    expect(entity.SecureScore).toBe(true);
    expect(entity.UpdatedBy).toBe("alice@contoso.com");
    expect(entity.UpdatedAt).toBe("2026-04-20T10:00:00.000Z");
    expect(mode).toBe("Replace");
  });

  it("merges on top of an existing row without clobbering untouched keys", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "tile-visibility",
      SecureScore: false,
      Incidents: false,
      Brief: true,
      RiskyUsers: true,
      UpdatedAt: "2026-04-19T00:00:00.000Z",
      UpdatedBy: "prev@contoso.com",
    });
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ getEntity, upsertEntity });
    const got = await upsertTileVisibility(table, {
      tenantId: TENANT,
      patch: { brief: false }, // toggle only one
      updatedBy: "alice@contoso.com",
      updatedAt: "2026-04-20T10:00:00.000Z",
    });
    expect(got.tileVisibility).toEqual({
      secureScore: false,
      incidents: false,
      brief: false,
      riskyUsers: true,
      posture: true,
      stack: true,
      kev: true,
      userDormancy: true,
      signIns: true,
      conditionalAccess: true,
      azureSecureScore: true,
      ransomwareIntel: true,
    });
  });
});

describe("capabilityFromStatus — Phase 2 derivation", () => {
  it("maps `licence_required` to licence_required", () => {
    expect(capabilityFromStatus("licence_required")).toBe("licence_required");
  });

  it("maps `healthy` / `degrading` / `failing` to present", () => {
    expect(capabilityFromStatus("healthy")).toBe("present");
    expect(capabilityFromStatus("degrading")).toBe("present");
    expect(capabilityFromStatus("failing")).toBe("present");
  });

  it("maps null / undefined (row missing) to unknown", () => {
    expect(capabilityFromStatus(null)).toBe("unknown");
    expect(capabilityFromStatus(undefined)).toBe("unknown");
  });
});

describe("computeEffectiveVisibility — Phase 2", () => {
  const allCapabilitiesPresent: TileCapabilities = {
    secureScore: "present",
    incidents: "present",
    brief: "present",
    riskyUsers: "present",
    posture: "present",
    stack: "present",
    kev: "present",
    userDormancy: "present",
    signIns: "present",
    conditionalAccess: "present",
    azureSecureScore: "present",
    ransomwareIntel: "present",
  };

  it("passes visibility through unchanged when all capabilities present", () => {
    const vis: TileVisibility = {
      secureScore: true,
      incidents: false,
      brief: true,
      riskyUsers: true,
      posture: true,
      stack: true,
      kev: true,
      userDormancy: true,
      signIns: true,
      conditionalAccess: true,
      azureSecureScore: true,
      ransomwareIntel: true,
    };
    expect(computeEffectiveVisibility(vis, allCapabilitiesPresent)).toEqual(vis);
  });

  it("auto-hides a licence_required tile even if operator toggle is true", () => {
    const vis: TileVisibility = DEFAULT_TILE_VISIBILITY;
    const caps: TileCapabilities = {
      ...allCapabilitiesPresent,
      riskyUsers: "licence_required",
    };
    const got = computeEffectiveVisibility(vis, caps);
    expect(got.riskyUsers).toBe(false);
    expect(got.secureScore).toBe(true);
    expect(got.incidents).toBe(true);
    expect(got.brief).toBe(true);
  });

  it("keeps an operator-disabled tile hidden even if capability is present", () => {
    const vis: TileVisibility = { ...DEFAULT_TILE_VISIBILITY, incidents: false };
    const got = computeEffectiveVisibility(vis, allCapabilitiesPresent);
    expect(got.incidents).toBe(false);
  });

  it("an unknown capability does NOT trigger auto-hide (conservative)", () => {
    // A fresh tenant whose Timer hasn't fired yet should still render;
    // licence-based hiding requires an affirmative `licence_required` signal.
    const vis: TileVisibility = DEFAULT_TILE_VISIBILITY;
    const caps: TileCapabilities = {
      ...allCapabilitiesPresent,
      riskyUsers: "unknown",
    };
    const got = computeEffectiveVisibility(vis, caps);
    expect(got.riskyUsers).toBe(true);
  });
});

describe("readAgentBudget — Phase 3", () => {
  const DEFAULTS = {
    briefManualRunCeiling: 30,
    briefDailyTokenBudget: 200_000,
    postureManualRunCeiling: 10,
    postureWeeklyTokenBudget: 20_000,
    incidentsAnalysisManualRunCeiling: 20,
    incidentsAnalysisDailyTokenBudget: 15_000,
  };

  it("returns env defaults with source=default when row is absent", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const table = mkTable({ getEntity });
    const got = await readAgentBudget(table, TENANT, DEFAULTS);
    expect(got.briefManualRunCeiling).toBe(30);
    expect(got.briefDailyTokenBudget).toBe(200_000);
    expect(got.postureManualRunCeiling).toBe(10);
    expect(got.postureWeeklyTokenBudget).toBe(20_000);
    expect(got.source).toBe("default");
    expect(got.updatedAt).toBeNull();
  });

  it("returns stored values with source=tenant when row present", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "agent-budget",
      BriefManualRunCeiling: 50,
      BriefDailyTokenBudget: 300_000,
      PostureManualRunCeiling: 7,
      PostureWeeklyTokenBudget: 40_000,
      UpdatedAt: "2026-04-20T10:00:00.000Z",
      UpdatedBy: "alice@contoso.com",
    });
    const table = mkTable({ getEntity });
    const got = await readAgentBudget(table, TENANT, DEFAULTS);
    expect(got.briefManualRunCeiling).toBe(50);
    expect(got.briefDailyTokenBudget).toBe(300_000);
    expect(got.postureManualRunCeiling).toBe(7);
    expect(got.postureWeeklyTokenBudget).toBe(40_000);
    expect(got.source).toBe("tenant");
  });

  it("falls back to defaults for posture columns missing from legacy row (ADR-0027 additive)", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "agent-budget",
      BriefManualRunCeiling: 50,
      BriefDailyTokenBudget: 300_000,
      // PostureManualRunCeiling + PostureWeeklyTokenBudget absent
      UpdatedAt: "",
      UpdatedBy: "",
    });
    const table = mkTable({ getEntity });
    const got = await readAgentBudget(table, TENANT, DEFAULTS);
    expect(got.postureManualRunCeiling).toBe(DEFAULTS.postureManualRunCeiling);
    expect(got.postureWeeklyTokenBudget).toBe(DEFAULTS.postureWeeklyTokenBudget);
  });

  it("falls back to legacy PostureDailyTokenBudget column when PostureWeeklyTokenBudget is absent (SEC-L-B2-01 read-side compat)", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "agent-budget",
      BriefManualRunCeiling: 50,
      BriefDailyTokenBudget: 300_000,
      PostureManualRunCeiling: 7,
      // Pre-rename legacy column ONLY:
      PostureDailyTokenBudget: 35_000,
      UpdatedAt: "",
      UpdatedBy: "",
    });
    const table = mkTable({ getEntity });
    const got = await readAgentBudget(table, TENANT, DEFAULTS);
    expect(got.postureWeeklyTokenBudget).toBe(35_000);
  });

  it("coerces legacy string ints to numbers", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "agent-budget",
      BriefManualRunCeiling: "50",
      BriefDailyTokenBudget: "250000",
      UpdatedAt: "",
      UpdatedBy: "",
    });
    const table = mkTable({ getEntity });
    const got = await readAgentBudget(table, TENANT, DEFAULTS);
    expect(got.briefManualRunCeiling).toBe(50);
    expect(got.briefDailyTokenBudget).toBe(250_000);
  });
});

describe("upsertAgentBudget — Phase 3", () => {
  const DEFAULTS = {
    briefManualRunCeiling: 30,
    briefDailyTokenBudget: 200_000,
    postureManualRunCeiling: 10,
    postureWeeklyTokenBudget: 20_000,
    incidentsAnalysisManualRunCeiling: 20,
    incidentsAnalysisDailyTokenBudget: 15_000,
  };

  it("merges partial patch over defaults when row is absent", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ getEntity, upsertEntity });
    const got = await upsertAgentBudget(table, {
      tenantId: TENANT,
      patch: { briefManualRunCeiling: 50 },
      defaults: DEFAULTS,
      updatedBy: "alice@contoso.com",
      updatedAt: "2026-04-20T10:00:00.000Z",
    });
    expect(got.briefManualRunCeiling).toBe(50);
    expect(got.briefDailyTokenBudget).toBe(200_000); // unchanged from default
    expect(got.postureManualRunCeiling).toBe(DEFAULTS.postureManualRunCeiling);
    expect(got.postureWeeklyTokenBudget).toBe(DEFAULTS.postureWeeklyTokenBudget);
    expect(got.source).toBe("tenant");
    const [entity] = upsertEntity.mock.calls[0] as [{
      BriefManualRunCeiling: number;
      BriefDailyTokenBudget: number;
      PostureManualRunCeiling: number;
      PostureWeeklyTokenBudget: number;
    }];
    expect(entity.BriefManualRunCeiling).toBe(50);
    expect(entity.BriefDailyTokenBudget).toBe(200_000);
    expect(entity.PostureManualRunCeiling).toBe(DEFAULTS.postureManualRunCeiling);
    expect(entity.PostureWeeklyTokenBudget).toBe(DEFAULTS.postureWeeklyTokenBudget);
  });
});

describe("readUserIdentifierStrategy — Phase 3", () => {
  it("returns objectId default with source=default when absent", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const table = mkTable({ getEntity });
    const got = await readUserIdentifierStrategy(table, TENANT);
    expect(got.strategy).toBe(DEFAULT_USER_IDENTIFIER_STRATEGY);
    expect(got.strategy).toBe("objectId");
    expect(got.source).toBe("default");
  });

  it("returns stored strategy with source=tenant when present", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "user-identifier-strategy",
      Strategy: "display_name",
      UpdatedAt: "2026-04-20T10:00:00.000Z",
      UpdatedBy: "alice@contoso.com",
    });
    const table = mkTable({ getEntity });
    const got = await readUserIdentifierStrategy(table, TENANT);
    expect(got.strategy).toBe("display_name");
    expect(got.source).toBe("tenant");
  });

  it("falls back to objectId when stored value is not a known strategy", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "user-identifier-strategy",
      Strategy: "malformed_value",
      UpdatedAt: "",
      UpdatedBy: "",
    });
    const table = mkTable({ getEntity });
    const got = await readUserIdentifierStrategy(table, TENANT);
    expect(got.strategy).toBe("objectId");
  });
});

describe("upsertUserIdentifierStrategy — Phase 3", () => {
  it("writes the strategy column verbatim (already-validated by handler)", async () => {
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ upsertEntity });
    await upsertUserIdentifierStrategy(table, {
      tenantId: TENANT,
      strategy: "partial_mask",
      updatedBy: "alice@contoso.com",
      updatedAt: "2026-04-20T10:00:00.000Z",
    });
    const [entity, mode] = upsertEntity.mock.calls[0] as [
      { Strategy: string; UpdatedBy: string },
      string,
    ];
    expect(entity.Strategy).toBe("partial_mask");
    expect(mode).toBe("Replace");
  });
});

describe("readBranding — ADR-0029 Phase B logo columns", () => {
  const FAKE_SHA = "a".repeat(64);

  it("returns no-logo defaults when row is absent", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const table = mkTable({ getEntity });
    const got = await readBranding(table, TENANT);
    expect(got.productName).toBe(BRANDING_DEFAULTS.productName);
    expect(got.logoSha256).toBe("");
    expect(got.logoContentType).toBe("");
    expect(got.logoSize).toBe(0);
    expect(got.logoUrl).toBeNull();
    expect(got.source).toBe("default");
  });

  it("surfaces logo columns + computed URL when triple is intact", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "branding",
      ProductName: "Acme",
      PrimaryHex: "#112233",
      FooterText: "",
      DefaultTheme: "system",
      LogoSha256: FAKE_SHA,
      LogoContentType: "image/png",
      LogoSize: 42_000,
      UpdatedAt: "2026-04-21T10:00:00.000Z",
      UpdatedBy: "alice@contoso.com",
    });
    const table = mkTable({ getEntity });
    const got = await readBranding(table, TENANT);
    expect(got.logoSha256).toBe(FAKE_SHA);
    expect(got.logoContentType).toBe("image/png");
    expect(got.logoSize).toBe(42_000);
    expect(got.logoUrl).toBe(
      `/api/branding/${encodeURIComponent(TENANT)}/logo?v=${FAKE_SHA}`,
    );
  });

  it("falls back to no-logo when triple is inconsistent (sha length wrong)", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "branding",
      ProductName: "Acme",
      PrimaryHex: "#112233",
      FooterText: "",
      DefaultTheme: "system",
      LogoSha256: "not-a-sha",
      LogoContentType: "image/png",
      LogoSize: 42_000,
      UpdatedAt: "",
      UpdatedBy: "",
    });
    const table = mkTable({ getEntity });
    const got = await readBranding(table, TENANT);
    expect(got.logoSha256).toBe("");
    expect(got.logoUrl).toBeNull();
  });

  it("falls back to no-logo when MIME not in allowlist", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "branding",
      ProductName: "Acme",
      PrimaryHex: "#112233",
      FooterText: "",
      DefaultTheme: "system",
      LogoSha256: FAKE_SHA,
      LogoContentType: "image/svg+xml", // excluded
      LogoSize: 42_000,
      UpdatedAt: "",
      UpdatedBy: "",
    });
    const table = mkTable({ getEntity });
    const got = await readBranding(table, TENANT);
    expect(got.logoSha256).toBe("");
    expect(got.logoContentType).toBe("");
  });

  it("falls back to no-logo when size exceeds cap", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "branding",
      ProductName: "Acme",
      PrimaryHex: "#112233",
      FooterText: "",
      DefaultTheme: "system",
      LogoSha256: FAKE_SHA,
      LogoContentType: "image/png",
      LogoSize: 10_000_000, // 10 MB — well over 1 MB cap
      UpdatedAt: "",
      UpdatedBy: "",
    });
    const table = mkTable({ getEntity });
    const got = await readBranding(table, TENANT);
    expect(got.logoSha256).toBe("");
  });
});

describe("computeBrandingLogoUrl", () => {
  it("returns null when sha is empty", () => {
    expect(computeBrandingLogoUrl("tenant-1", "")).toBeNull();
  });

  it("returns null when tenantId is empty", () => {
    expect(computeBrandingLogoUrl("", "abc")).toBeNull();
  });

  it("uri-encodes the tenantId segment", () => {
    const got = computeBrandingLogoUrl("weird/tenant", "abc");
    expect(got).toBe("/api/branding/weird%2Ftenant/logo?v=abc");
  });
});

describe("upsertBranding — preserves Phase B logo columns (text-path patch)", () => {
  const FAKE_SHA = "b".repeat(64);

  it("carries logo triple forward when patch touches only text columns", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "branding",
      ProductName: "Old",
      PrimaryHex: "#112233",
      FooterText: "",
      DefaultTheme: "system",
      LogoSha256: FAKE_SHA,
      LogoContentType: "image/png",
      LogoSize: 42_000,
      UpdatedAt: "2026-04-21T09:00:00.000Z",
      UpdatedBy: "prev@contoso.com",
    });
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ getEntity, upsertEntity });
    const got = await upsertBranding(table, {
      tenantId: TENANT,
      patch: { productName: "NewName" },
      updatedBy: "alice@contoso.com",
      updatedAt: "2026-04-21T10:00:00.000Z",
    });
    expect(got.productName).toBe("NewName");
    expect(got.logoSha256).toBe(FAKE_SHA);
    expect(got.logoContentType).toBe("image/png");
    expect(got.logoSize).toBe(42_000);
    expect(got.logoUrl).not.toBeNull();
    const [entity] = upsertEntity.mock.calls[0] as [
      {
        LogoSha256: string;
        LogoContentType: string;
        LogoSize: number;
        ProductName: string;
      },
    ];
    expect(entity.LogoSha256).toBe(FAKE_SHA);
    expect(entity.LogoContentType).toBe("image/png");
    expect(entity.LogoSize).toBe(42_000);
    expect(entity.ProductName).toBe("NewName");
  });
});

describe("upsertBrandingLogo — preserves text columns", () => {
  const FAKE_SHA = "c".repeat(64);

  it("carries text columns forward when writing the logo triple", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "branding",
      ProductName: "Acme",
      PrimaryHex: "#ABCDEF",
      FooterText: "© Acme",
      DefaultTheme: "dark",
      UpdatedAt: "2026-04-21T09:00:00.000Z",
      UpdatedBy: "prev@contoso.com",
    });
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ getEntity, upsertEntity });
    const got = await upsertBrandingLogo(table, {
      tenantId: TENANT,
      logoSha256: FAKE_SHA,
      logoContentType: "image/webp",
      logoSize: 123_456,
      updatedBy: "alice@contoso.com",
      updatedAt: "2026-04-21T10:00:00.000Z",
    });
    expect(got.productName).toBe("Acme");
    expect(got.primaryHex).toBe("#ABCDEF");
    expect(got.footerText).toBe("© Acme");
    expect(got.defaultTheme).toBe("dark");
    expect(got.logoSha256).toBe(FAKE_SHA);
    expect(got.logoContentType).toBe("image/webp");
    expect(got.logoSize).toBe(123_456);
    const [entity] = upsertEntity.mock.calls[0] as [
      { ProductName: string; LogoSha256: string; LogoContentType: string },
    ];
    expect(entity.ProductName).toBe("Acme");
    expect(entity.LogoSha256).toBe(FAKE_SHA);
    expect(entity.LogoContentType).toBe("image/webp");
  });
});

describe("clearBrandingLogo — idempotent, preserves text", () => {
  const FAKE_SHA = "d".repeat(64);

  it("zeroes the triple while preserving text columns", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "branding",
      ProductName: "Acme",
      PrimaryHex: "#ABCDEF",
      FooterText: "© Acme",
      DefaultTheme: "light",
      LogoSha256: FAKE_SHA,
      LogoContentType: "image/png",
      LogoSize: 42_000,
      UpdatedAt: "2026-04-21T09:00:00.000Z",
      UpdatedBy: "prev@contoso.com",
    });
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ getEntity, upsertEntity });
    const got = await clearBrandingLogo(table, {
      tenantId: TENANT,
      updatedBy: "alice@contoso.com",
      updatedAt: "2026-04-21T10:00:00.000Z",
    });
    expect(got.logoSha256).toBe("");
    expect(got.logoContentType).toBe("");
    expect(got.logoSize).toBe(0);
    expect(got.logoUrl).toBeNull();
    expect(got.productName).toBe("Acme");
    expect(got.primaryHex).toBe("#ABCDEF");
    expect(got.footerText).toBe("© Acme");
    expect(got.defaultTheme).toBe("light");
  });

  it("is safe to call when no logo exists (idempotent)", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ getEntity, upsertEntity });
    const got = await clearBrandingLogo(table, {
      tenantId: TENANT,
      updatedBy: "alice@contoso.com",
      updatedAt: "2026-04-21T10:00:00.000Z",
    });
    expect(got.logoSha256).toBe("");
    expect(upsertEntity).toHaveBeenCalled();
  });
});

describe("readKevBaseline — ADR-0033 Phase 2.5", () => {
  it("returns mode=historic + empty date when row is missing", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const table = mkTable({ getEntity });
    const { readKevBaseline } = await import("../src/lib/tenantSettingsStore.js");
    const got = await readKevBaseline(table, TENANT);
    expect(got.mode).toBe("historic");
    expect(got.baselineDate).toBe("");
    expect(got.source).toBe("default");
    expect(got.updatedAt).toBeNull();
  });

  it("returns the stored from-deploy row + baselineDate", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "kev-baseline",
      Mode: "from-deploy",
      BaselineDate: "2026-04-29",
      UpdatedAt: "2026-04-29T10:00:00Z",
      UpdatedBy: "admin",
    });
    const table = mkTable({ getEntity });
    const { readKevBaseline } = await import("../src/lib/tenantSettingsStore.js");
    const got = await readKevBaseline(table, TENANT);
    expect(got.mode).toBe("from-deploy");
    expect(got.baselineDate).toBe("2026-04-29");
    expect(got.source).toBe("tenant");
    expect(got.updatedBy).toBe("admin");
  });

  it("falls back to default mode if Mode column is malformed", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "kev-baseline",
      Mode: "DROP TABLE",
      BaselineDate: "2026-04-29",
      UpdatedAt: "2026-04-29T10:00:00Z",
      UpdatedBy: "admin",
    });
    const table = mkTable({ getEntity });
    const { readKevBaseline } = await import("../src/lib/tenantSettingsStore.js");
    const got = await readKevBaseline(table, TENANT);
    expect(got.mode).toBe("historic");
  });

  it("strips malformed BaselineDate (does not surface garbage)", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "kev-baseline",
      Mode: "from-deploy",
      BaselineDate: "yesterday",
      UpdatedAt: "2026-04-29T10:00:00Z",
      UpdatedBy: "admin",
    });
    const table = mkTable({ getEntity });
    const { readKevBaseline } = await import("../src/lib/tenantSettingsStore.js");
    const got = await readKevBaseline(table, TENANT);
    expect(got.baselineDate).toBe("");
  });
});

describe("upsertKevBaseline — ADR-0033 Phase 2.5", () => {
  it("writes the entity with all five columns", async () => {
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ upsertEntity });
    const { upsertKevBaseline } = await import("../src/lib/tenantSettingsStore.js");
    const got = await upsertKevBaseline(table, {
      tenantId: TENANT,
      mode: "from-deploy",
      baselineDate: "2026-04-29",
      updatedBy: "admin",
      updatedAt: "2026-04-29T10:00:00Z",
    });
    expect(upsertEntity).toHaveBeenCalledWith(
      {
        partitionKey: TENANT,
        rowKey: "kev-baseline",
        Mode: "from-deploy",
        BaselineDate: "2026-04-29",
        UpdatedAt: "2026-04-29T10:00:00Z",
        UpdatedBy: "admin",
      },
      "Replace",
    );
    expect(got.mode).toBe("from-deploy");
    expect(got.source).toBe("tenant");
  });
});

describe("maskDisplayName — Phase 3 §9.6", () => {
  it("produces fixed-length suffix regardless of token length", () => {
    expect(maskDisplayName("J")).toBe("J***");
    expect(maskDisplayName("Ji")).toBe("J***");
    expect(maskDisplayName("Jin")).toBe("J***");
    expect(maskDisplayName("Jane")).toBe("J***");
    expect(maskDisplayName("Jonathan")).toBe("J***");
  });

  it("masks each whitespace-separated token independently", () => {
    expect(maskDisplayName("Jane Doe")).toBe("J*** D***");
    expect(maskDisplayName("Jean-Paul Sartre")).toBe("J*** S***");
    expect(maskDisplayName("A B C")).toBe("A*** B*** C***");
  });

  it("collapses repeated whitespace", () => {
    expect(maskDisplayName("Jane   Doe")).toBe("J*** D***");
    expect(maskDisplayName("  Jane\tDoe  ")).toBe("J*** D***");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(maskDisplayName("")).toBe("");
    expect(maskDisplayName("   ")).toBe("");
  });

  it("handles unicode tokens (emoji-safe code-point iteration)", () => {
    // Name with a leading non-ASCII character — should keep the full
    // code point, not a broken half-surrogate.
    expect(maskDisplayName("Éric Dupont")).toBe("É*** D***");
    expect(maskDisplayName("张伟")).toBe("张***");
  });
});
