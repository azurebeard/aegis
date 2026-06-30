// ADR-0037 Layer 3a — ransomwareIntelStore unit tests.
// Pure-function coverage: RowKey helpers + summary derivation.
// TableClient interactions are exercised at integration time in Layer 3c.

import { describe, expect, it } from "vitest";
import {
  computeRansomwareIntelSummary,
  pressRowKey,
  victimRowKey,
  type RansomwareIntelRow,
  type RansomwarePress,
  type RansomwareVictim,
} from "../src/lib/ransomwareIntelStore.js";

// 2026-06-25 14:30 UTC — anchors "current month" at June 2026, "prior
// month" at May 2026 for the summary tests below.
const NOW = new Date("2026-06-25T14:30:00.000Z");

function victim(o: Partial<RansomwareVictim>): RansomwareVictim {
  return {
    id: o.id ?? "QWJjLWNvcnAtMUBsb2NrYml0Mw", // base64url-shaped sample
    victim: o.victim ?? "Acme Corp",
    group: o.group ?? "lockbit3",
    attackDate: o.attackDate ?? null,
    discoveredDate: o.discoveredDate ?? "2026-06-20T00:00:00Z",
    country: o.country ?? "GB",
    sector: o.sector ?? "Healthcare",
    activity: o.activity ?? "",
    website: o.website ?? "",
    permalink: o.permalink ?? "",
    ingestedAt: o.ingestedAt ?? "2026-06-25T13:00:00Z",
  };
}

function press(o: Partial<RansomwarePress>): RansomwarePress {
  return {
    id: o.id ?? "abc",
    title: o.title ?? "Healthcare provider hit by ransomware",
    url: o.url ?? "https://news.example.com/article-1",
    publishedAt: o.publishedAt ?? "2026-06-22T08:00:00Z",
    source: o.source ?? "Example News",
    country: o.country ?? "GB",
    summary: o.summary ?? "",
    ingestedAt: o.ingestedAt ?? "2026-06-25T13:00:00Z",
  };
}

describe("victimRowKey", () => {
  it("prefixes the supplied id with 'victim.' verbatim when already base64url", () => {
    expect(victimRowKey("AbcDef-123_xyz")).toBe("victim.AbcDef-123_xyz");
  });

  it("converts standard base64 to base64url (+ → -, / → _, strip =)", () => {
    expect(victimRowKey("ab+cd/ef==")).toBe("victim.ab-cd_ef");
  });

  it("rejects an id containing characters outside the Table-RowKey set", () => {
    // After base64url normalisation, ' ' (space) is still invalid.
    expect(() => victimRowKey("has space")).toThrow(/out of pattern/);
  });

  it("rejects an empty id", () => {
    expect(() => victimRowKey("")).toThrow(/out of pattern/);
  });
});

describe("pressRowKey", () => {
  it("returns sha256-hex prefixed with 'press.'", () => {
    const rk = pressRowKey("https://example.com/a");
    expect(rk).toMatch(/^press\.[0-9a-f]{64}$/);
  });

  it("is deterministic for the same URL", () => {
    const url = "https://news.example.com/article-1";
    expect(pressRowKey(url)).toBe(pressRowKey(url));
  });

  it("differs across URLs", () => {
    expect(pressRowKey("https://a.example/x")).not.toBe(
      pressRowKey("https://b.example/x"),
    );
  });

  it("rejects an empty url", () => {
    expect(() => pressRowKey("")).toThrow(/non-empty/);
  });
});

describe("computeRansomwareIntelSummary", () => {
  function row<T extends RansomwareVictim | RansomwarePress>(
    kind: "victim" | "press",
    base: T,
  ): RansomwareIntelRow {
    return { kind, ...base } as RansomwareIntelRow;
  }

  it("counts victims + press in current month vs prior month", () => {
    const rows: RansomwareIntelRow[] = [
      row("victim", victim({ id: "v1", discoveredDate: "2026-06-20T00:00:00Z" })),
      row("victim", victim({ id: "v2", discoveredDate: "2026-06-15T00:00:00Z" })),
      row("victim", victim({ id: "v3", discoveredDate: "2026-05-30T00:00:00Z" })),
      row("press", press({ url: "https://x.example/1", publishedAt: "2026-06-22T08:00:00Z" })),
      row("press", press({ url: "https://x.example/2", publishedAt: "2026-05-10T08:00:00Z" })),
    ];
    const s = computeRansomwareIntelSummary(rows, NOW);
    expect(s.victimsThisMonth).toBe(2);
    expect(s.victimsPriorMonth).toBe(1);
    expect(s.pressThisMonth).toBe(1);
    expect(s.pressPriorMonth).toBe(1);
  });

  it("counts distinct groups in the current month", () => {
    const rows: RansomwareIntelRow[] = [
      row("victim", victim({ id: "v1", group: "lockbit3" })),
      row("victim", victim({ id: "v2", group: "lockbit3" })),
      row("victim", victim({ id: "v3", group: "blackbasta" })),
      row("victim", victim({ id: "v4", group: "blackbasta" })),
      row("victim", victim({ id: "v5", group: "akira" })),
      // Prior-month group must not count
      row(
        "victim",
        victim({
          id: "v6",
          group: "noescape",
          discoveredDate: "2026-05-10T00:00:00Z",
        }),
      ),
    ];
    const s = computeRansomwareIntelSummary(rows, NOW);
    expect(s.distinctGroupsThisMonth).toBe(3);
  });

  it("picks the most-recent victim by chrono anchor (any month)", () => {
    const rows: RansomwareIntelRow[] = [
      row("victim", victim({ id: "v1", victim: "Earlier", discoveredDate: "2026-06-01T00:00:00Z" })),
      row("victim", victim({ id: "v2", victim: "Latest", discoveredDate: "2026-06-20T00:00:00Z" })),
      row("victim", victim({ id: "v3", victim: "Older", discoveredDate: "2026-05-30T00:00:00Z" })),
    ];
    const s = computeRansomwareIntelSummary(rows, NOW);
    expect(s.mostRecentVictim?.victim).toBe("Latest");
  });

  it("falls back to attackDate then ingestedAt when discoveredDate is null (chrono anchor)", () => {
    const rows: RansomwareIntelRow[] = [
      row(
        "victim",
        victim({
          id: "v1",
          discoveredDate: null,
          attackDate: "2026-06-10T00:00:00Z",
        }),
      ),
      row(
        "victim",
        victim({
          id: "v2",
          discoveredDate: null,
          attackDate: null,
          ingestedAt: "2026-06-12T00:00:00Z",
        }),
      ),
    ];
    const s = computeRansomwareIntelSummary(rows, NOW);
    expect(s.victimsThisMonth).toBe(2);
  });

  it("returns zero counts + null mostRecentVictim for empty input", () => {
    const s = computeRansomwareIntelSummary([], NOW);
    expect(s.victimsThisMonth).toBe(0);
    expect(s.pressThisMonth).toBe(0);
    expect(s.victimsPriorMonth).toBe(0);
    expect(s.pressPriorMonth).toBe(0);
    expect(s.distinctGroupsThisMonth).toBe(0);
    expect(s.mostRecentVictim).toBeNull();
  });

  it("handles January → December prior-month boundary", () => {
    const jan = new Date("2027-01-15T00:00:00Z");
    const rows: RansomwareIntelRow[] = [
      row("victim", victim({ id: "v1", discoveredDate: "2027-01-05T00:00:00Z" })),
      row("victim", victim({ id: "v2", discoveredDate: "2026-12-20T00:00:00Z" })),
    ];
    const s = computeRansomwareIntelSummary(rows, jan);
    expect(s.victimsThisMonth).toBe(1);
    expect(s.victimsPriorMonth).toBe(1);
  });

  it("skips rows with no chrono anchor (defensive)", () => {
    // Bypass the victim() helper because its `??` default replaces
    // explicit nulls with the default ISO string. Construct the row
    // literally so we can pin null + empty-string semantics.
    const rows: RansomwareIntelRow[] = [
      {
        kind: "victim",
        id: "v1",
        victim: "Acme",
        group: "lockbit3",
        discoveredDate: null,
        attackDate: null,
        country: "GB",
        sector: "",
        activity: "",
        website: "",
        permalink: "",
        ingestedAt: "", // empty defeats the YYYY-MM regex
      },
    ];
    const s = computeRansomwareIntelSummary(rows, NOW);
    expect(s.victimsThisMonth).toBe(0);
  });

  it("does NOT bleed group counts from victim rows into press rows", () => {
    const rows: RansomwareIntelRow[] = [
      row("victim", victim({ id: "v1", group: "lockbit3" })),
      row("press", press({ url: "https://x.example/1" })),
    ];
    const s = computeRansomwareIntelSummary(rows, NOW);
    expect(s.distinctGroupsThisMonth).toBe(1);
    expect(s.victimsThisMonth).toBe(1);
    expect(s.pressThisMonth).toBe(1);
  });
});
