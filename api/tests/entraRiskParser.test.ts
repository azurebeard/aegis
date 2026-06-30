import { describe, it, expect } from "vitest";
import {
  parseRiskyUsersPage,
  RISKY_USER_ID_REGEX,
} from "../src/lib/entraRiskParser.js";

const OPTIONS = { ingestedAt: "2026-04-19T00:00:00.000Z", ingestRunId: "run-1" };

const VALID_USER = {
  id: "3f7da1c2-4e56-4a89-8b30-99e4a2c1d7e5",
  userPrincipalName: "alice@contoso.com",
  userDisplayName: "Alice Example",
  riskLevel: "high",
  riskState: "atRisk",
  riskDetail: "unfamiliarFeatures",
  riskLastUpdatedDateTime: "2026-04-18T19:41:08.902Z",
  isDeleted: false,
  isProcessing: false,
};

describe("parseRiskyUsersPage — happy path", () => {
  it("parses a valid page with nextLink", () => {
    const json = {
      value: [VALID_USER],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/identityProtection/riskyUsers?$skiptoken=XYZ",
    };
    const out = parseRiskyUsersPage(json, OPTIONS);
    expect(out.entries).toHaveLength(1);
    expect(out.nextLink).toMatch(/skiptoken=XYZ/);
    expect(out.unknownEnumSamples).toHaveLength(0);
    expect(out.skipped).toHaveLength(0);
    const row = out.entries[0]!;
    expect(row.id).toBe(VALID_USER.id);
    expect(row.riskLevel).toBe("high");
    expect(row.riskState).toBe("atRisk");
    expect(row.riskDetail).toBe("unfamiliarFeatures");
    expect(row.ingestedAt).toBe(OPTIONS.ingestedAt);
    expect(row.ingestRunId).toBe(OPTIONS.ingestRunId);
  });

  it("returns empty entries + null nextLink for a non-object payload", () => {
    expect(parseRiskyUsersPage(null, OPTIONS).entries).toHaveLength(0);
    expect(parseRiskyUsersPage("bad" as unknown, OPTIONS).nextLink).toBeNull();
    expect(parseRiskyUsersPage({ value: [] }, OPTIONS).nextLink).toBeNull();
  });
});

describe("parseRiskyUsersPage — evolvable enums (ADR-0023 §9)", () => {
  it("preserves unknownFutureValue on riskLevel and surfaces it as an unknownEnumSample", () => {
    const out = parseRiskyUsersPage(
      {
        value: [
          { ...VALID_USER, riskLevel: "unknownFutureValue" },
        ],
      },
      OPTIONS,
    );
    expect(out.entries).toHaveLength(1);
    const row = out.entries[0]!;
    expect(row.riskLevel).toBe("unknownFutureValue");
    expect(row.riskLevelRaw).toBe("unknownFutureValue");
    // unknownFutureValue is in the known enum set, so not surfaced as unknown.
    expect(out.unknownEnumSamples.filter((s) => s.field === "riskLevel")).toHaveLength(0);
  });

  it("surfaces a future-added riskLevel value via unknownEnumSamples", () => {
    const out = parseRiskyUsersPage(
      {
        value: [{ ...VALID_USER, riskLevel: "criticalCompromise" }],
      },
      OPTIONS,
    );
    expect(out.entries).toHaveLength(1);
    const row = out.entries[0]!;
    expect(row.riskLevel).toBe("unknown");
    expect(row.riskLevelRaw).toBe("criticalCompromise");
    const sample = out.unknownEnumSamples.find((s) => s.field === "riskLevel");
    expect(sample?.value).toBe("criticalCompromise");
    expect(sample?.userId).toBe(VALID_USER.id);
  });

  it("keeps an unknown riskDetail string verbatim (no pinning — ADR-0023 §9)", () => {
    const out = parseRiskyUsersPage(
      {
        value: [{ ...VALID_USER, riskDetail: "someBrandNewSignal" }],
      },
      OPTIONS,
    );
    expect(out.entries[0]!.riskDetail).toBe("someBrandNewSignal");
  });

  it("surfaces an unknown riskState", () => {
    const out = parseRiskyUsersPage(
      {
        value: [{ ...VALID_USER, riskState: "newlyInvestigating" }],
      },
      OPTIONS,
    );
    const sample = out.unknownEnumSamples.find((s) => s.field === "riskState");
    expect(sample?.value).toBe("newlyInvestigating");
  });
});

describe("parseRiskyUsersPage — malformed rows skipped", () => {
  it("skips rows with a malformed id", () => {
    const out = parseRiskyUsersPage(
      {
        value: [
          { ...VALID_USER, id: "bad id with spaces" },
          VALID_USER,
        ],
      },
      OPTIONS,
    );
    expect(out.entries).toHaveLength(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]!.reason).toBe("id_malformed");
  });

  it("skips rows missing riskLastUpdatedDateTime", () => {
    const { riskLastUpdatedDateTime: _, ...rest } = VALID_USER;
    void _;
    const out = parseRiskyUsersPage({ value: [rest] }, OPTIONS);
    expect(out.entries).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
  });

  it("skips non-object rows", () => {
    const out = parseRiskyUsersPage(
      { value: ["not-an-object", 42, null] },
      OPTIONS,
    );
    expect(out.entries).toHaveLength(0);
    expect(out.skipped).toHaveLength(3);
  });
});

describe("RISKY_USER_ID_REGEX", () => {
  it("accepts GUID-shaped ids", () => {
    expect(RISKY_USER_ID_REGEX.test("3f7da1c2-4e56-4a89-8b30-99e4a2c1d7e5")).toBe(true);
  });

  it("rejects spaces and forbidden chars", () => {
    expect(RISKY_USER_ID_REGEX.test("a b")).toBe(false);
    expect(RISKY_USER_ID_REGEX.test("a/b")).toBe(false);
    expect(RISKY_USER_ID_REGEX.test("")).toBe(false);
    expect(RISKY_USER_ID_REGEX.test("a".repeat(129))).toBe(false);
  });
});
