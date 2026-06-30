// ADR-0032 §3 — match logic tests. Pure functions only.

import { describe, expect, it } from "vitest";
import {
  applySuppressionsToMatches,
  matchesForStackItem,
  type KevRow,
} from "../src/lib/kevStore.js";
import {
  indexSuppressions,
  type KevSuppressionRow,
} from "../src/lib/kevSuppressionsStore.js";

function row(overrides: Partial<KevRow> = {}): KevRow {
  return {
    cveID: "CVE-2024-12345",
    vendorProject: "Microsoft",
    product: "Windows",
    vulnerabilityName: "Test Vuln",
    dateAdded: "2024-04-15",
    shortDescription: "",
    requiredAction: "",
    dueDate: "2024-05-06",
    knownRansomwareCampaignUse: "Unknown",
    notes: "",
    cwes: [],
    ingestedAt: "2026-04-28T00:00:00Z",
    lastSeenAt: "2026-04-28T00:00:00Z",
    removed: false,
    ingestRunId: "run-id",
    ...overrides,
  };
}

describe("matchesForStackItem", () => {
  it("finds case-insensitive matches on vendor + product", () => {
    const kev = [row(), row({ cveID: "CVE-2024-99999", product: "Office" })];
    expect(
      matchesForStackItem(kev, { vendor: "microsoft", product: "windows" }).map((m) => m.cveID),
    ).toEqual(["CVE-2024-12345"]);
    expect(
      matchesForStackItem(kev, { vendor: "MICROSOFT", product: "WINDOWS" }).map((m) => m.cveID),
    ).toEqual(["CVE-2024-12345"]);
  });

  // --- Fuzzy match (ADR-0032 Phase B+ contiguous-token subphrase) -------

  it("matches operator product = KEV product + version (Windows 11 ↔ Windows)", () => {
    const kev = [row({ vendorProject: "Microsoft", product: "Windows" })];
    expect(
      matchesForStackItem(kev, { vendor: "Microsoft", product: "Windows 11" }).map((m) => m.cveID),
    ).toEqual(["CVE-2024-12345"]);
  });

  it("matches operator product more specific than KEV (multi-word)", () => {
    const kev = [row({ vendorProject: "Microsoft", product: "Defender" })];
    expect(
      matchesForStackItem(kev, {
        vendor: "Microsoft",
        product: "Microsoft Defender for Endpoint",
      }).length,
    ).toBe(1);
  });

  it("matches KEV product more specific than operator (operator = parent product)", () => {
    const kev = [
      row({ vendorProject: "Apache", product: "HTTP Server" }),
      row({ cveID: "CVE-2024-7", vendorProject: "Apache", product: "HTTP Server 2.4" }),
    ];
    expect(
      matchesForStackItem(kev, { vendor: "Apache", product: "HTTP Server" }).map((m) => m.cveID).sort(),
    ).toEqual(["CVE-2024-12345", "CVE-2024-7"]);
  });

  it("matches VMware ESXi ↔ ESXi (operator over-qualified by vendor name)", () => {
    const kev = [row({ vendorProject: "VMware", product: "ESXi" })];
    expect(
      matchesForStackItem(kev, { vendor: "VMware", product: "VMware ESXi" }).length,
    ).toBe(1);
  });

  it("does NOT match cross-vendor on token overlap (vendor stays exact)", () => {
    const kev = [row({ vendorProject: "Microsoft", product: "Defender" })];
    expect(
      matchesForStackItem(kev, { vendor: "Mandiant", product: "Defender for X" }).length,
    ).toBe(0);
  });

  it("does NOT match unrelated products with shared keyword (Windows Server vs Windows 11)", () => {
    // Both products contain "Windows" but neither is a contiguous token
    // sequence within the other → no match.
    const kev = [row({ vendorProject: "Microsoft", product: "Windows 11" })];
    expect(
      matchesForStackItem(kev, { vendor: "Microsoft", product: "Windows Server" }).length,
    ).toBe(0);
  });

  it("does NOT match on character substring (token boundary required)", () => {
    // "Window" is a substring of "Windows" but not a token of it → no match.
    const kev = [row({ vendorProject: "Microsoft", product: "Windows" })];
    expect(
      matchesForStackItem(kev, { vendor: "Microsoft", product: "Window" }).length,
    ).toBe(0);
  });

  it("does NOT match when shorter-tokens are present but non-contiguous", () => {
    // Operator: "Microsoft Endpoint" (tokens: [microsoft, endpoint]).
    // KEV product: "Microsoft Defender for Endpoint" (tokens: [microsoft, defender, for, endpoint]).
    // [microsoft, endpoint] is not a contiguous slice of the longer → no match.
    const kev = [row({ vendorProject: "Microsoft", product: "Microsoft Defender for Endpoint" })];
    expect(
      matchesForStackItem(kev, { vendor: "Microsoft", product: "Microsoft Endpoint" }).length,
    ).toBe(0);
  });

  it("returns empty array when nothing matches", () => {
    const kev = [row()];
    expect(
      matchesForStackItem(kev, { vendor: "AcmeWare", product: "FrobnicatorPro" }).length,
    ).toBe(0);
  });

  it("excludes rows where removed=true", () => {
    const kev = [row({ removed: true })];
    expect(matchesForStackItem(kev, { vendor: "Microsoft", product: "Windows" }).length).toBe(0);
  });

  it("trims whitespace before comparison", () => {
    const kev = [row({ vendorProject: "  Microsoft  ", product: "  Windows  " })];
    expect(matchesForStackItem(kev, { vendor: "Microsoft", product: "Windows" }).length).toBe(1);
  });

  it("returns multiple matches for products with multiple CVEs", () => {
    const kev = [
      row({ cveID: "CVE-2024-1" }),
      row({ cveID: "CVE-2024-2" }),
      row({ cveID: "CVE-2024-3", vendorProject: "Apache", product: "Tomcat" }),
    ];
    const matches = matchesForStackItem(kev, { vendor: "Microsoft", product: "Windows" });
    expect(matches.length).toBe(2);
    expect(matches.map((m) => m.cveID).sort()).toEqual(["CVE-2024-1", "CVE-2024-2"]);
  });

  it("projects only the wire-shape fields (no chain SHAs / ingest metadata leaked)", () => {
    const kev = [row({ requiredAction: "Apply mitigations per vendor instructions." })];
    const matches = matchesForStackItem(kev, { vendor: "Microsoft", product: "Windows" });
    expect(matches.length).toBe(1);
    const projected = matches[0]!;
    const asRecord = projected as unknown as Record<string, unknown>;
    // Dropped — ingest internals + non-operator-facing KEV row fields.
    expect(asRecord.ingestRunId).toBeUndefined();
    expect(asRecord.lastSeenAt).toBeUndefined();
    expect(asRecord.removed).toBeUndefined();
    expect(asRecord.shortDescription).toBeUndefined();
    expect(asRecord.cwes).toBeUndefined();
    // ADR-0033 — `notes` is the SUPPRESSION notes (operator-set), not
    // KEV's `notes` field. Default null when no suppression exists.
    expect(projected.notes).toBeNull();
    // Surfaced — operator-facing CISA prose for the /kev row required-action
    // column (added in the 2026-04-28 reshape). Plain-text rendered per
    // ADR-0012 §5.
    expect(projected.requiredAction).toBe("Apply mitigations per vendor instructions.");
  });

  it("default match shape carries status='open' (ADR-0033 default)", () => {
    const matches = matchesForStackItem([row()], { vendor: "Microsoft", product: "Windows" });
    expect(matches.length).toBe(1);
    expect(matches[0]?.status).toBe("open");
    expect(matches[0]?.notes).toBeNull();
    expect(matches[0]?.expiresAt).toBeNull();
  });
});

const ITEM_ID_A = "550e8400-e29b-41d4-a716-446655440000";

describe("applySuppressionsToMatches (ADR-0033 overlay)", () => {
  function suppRow(overrides: Partial<KevSuppressionRow> = {}): KevSuppressionRow {
    return {
      stackItemId: ITEM_ID_A,
      cveID: "CVE-2024-12345",
      status: "remediated",
      notes: "patched",
      expiresAt: "",
      updatedAt: "2026-04-28T10:00:00Z",
      updatedBy: "admin-oid",
      ...overrides,
    };
  }

  it("overlays stored status onto matching CVEs", () => {
    const matches = matchesForStackItem([row()], { vendor: "Microsoft", product: "Windows" });
    const map = indexSuppressions([suppRow()]);
    const overlaid = applySuppressionsToMatches(ITEM_ID_A, matches, map);
    expect(overlaid[0]?.status).toBe("remediated");
    expect(overlaid[0]?.notes).toBe("patched");
  });

  it("leaves un-suppressed matches at status='open'", () => {
    const matches = matchesForStackItem(
      [row({ cveID: "CVE-2024-99999" })],
      { vendor: "Microsoft", product: "Windows" },
    );
    const map = indexSuppressions([suppRow()]); // suppression is for a DIFFERENT CVE
    const overlaid = applySuppressionsToMatches(ITEM_ID_A, matches, map);
    expect(overlaid[0]?.status).toBe("open");
  });

  it("expired suppression resolves to 'open'", () => {
    const matches = matchesForStackItem([row()], { vendor: "Microsoft", product: "Windows" });
    const map = indexSuppressions([
      suppRow({ status: "acknowledged", expiresAt: "2020-01-01T00:00:00Z" }),
    ]);
    const overlaid = applySuppressionsToMatches(
      ITEM_ID_A,
      matches,
      map,
      new Date("2026-04-28T00:00:00Z"),
    );
    expect(overlaid[0]?.status).toBe("open");
  });

  it("preserves all original CveMatchSummary fields", () => {
    const matches = matchesForStackItem([row()], { vendor: "Microsoft", product: "Windows" });
    const map = indexSuppressions([suppRow({ status: "risk_accepted" })]);
    const overlaid = applySuppressionsToMatches(ITEM_ID_A, matches, map);
    expect(overlaid[0]?.cveID).toBe("CVE-2024-12345");
    expect(overlaid[0]?.requiredAction).toBe("");
    expect(overlaid[0]?.knownRansomwareCampaignUse).toBe("Unknown");
  });
});
