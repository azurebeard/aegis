// ADR-0034 §3.2 — summary derivation focused tests.

import { describe, expect, it } from "vitest";
import { computeSignInsSummary } from "../src/lib/signInsStore.js";
import type { SignInDomain } from "../src/lib/signInsParser.js";

const NOW = new Date("2026-05-08T20:00:00.000Z");

function row(o: Partial<SignInDomain>): SignInDomain {
  return {
    id: o.id ?? "u-sign-1",
    createdDateTime: o.createdDateTime ?? "2026-05-08T19:00:00Z",
    userId: o.userId ?? "u1",
    userPrincipalName: o.userPrincipalName ?? "u1@contoso.com",
    userDisplayName: o.userDisplayName ?? "User One",
    appDisplayName: o.appDisplayName ?? "Office 365",
    ipAddress: o.ipAddress ?? "203.0.113.5",
    country: o.country ?? "gb",
    city: o.city ?? "",
    state: o.state ?? "",
    status: o.status ?? "",
    conditionalAccessStatus: o.conditionalAccessStatus ?? "success",
    outOfArea: o.outOfArea ?? false,
    ingestedAt: o.ingestedAt ?? "2026-05-08T19:30:00Z",
    ingestRunId: o.ingestRunId ?? "run-1",
  };
}

describe("computeSignInsSummary", () => {
  it("counts totalToday + outOfAreaToday + caFailuresToday correctly", () => {
    const rows = [
      row({ id: "1", createdDateTime: "2026-05-08T19:55:00Z" }),
      row({
        id: "2",
        createdDateTime: "2026-05-08T19:50:00Z",
        country: "ie",
        outOfArea: true,
      }),
      row({
        id: "3",
        createdDateTime: "2026-05-08T19:00:00Z",
        conditionalAccessStatus: "failure",
      }),
      row({
        id: "4",
        // 25h ago — outside the 24h window
        createdDateTime: "2026-05-07T18:00:00Z",
        outOfArea: true,
      }),
    ];
    const s = computeSignInsSummary(rows, NOW);
    expect(s.totalToday).toBe(3);
    expect(s.outOfAreaToday).toBe(1);
    expect(s.caFailuresToday).toBe(1);
  });

  it("returns null mostRecent when all rows are outside the window", () => {
    const s = computeSignInsSummary(
      [row({ createdDateTime: "2026-05-01T00:00:00Z" })],
      NOW,
    );
    // mostRecent looks at ALL rows (no window) so picks the only row
    expect(s.mostRecent).not.toBeNull();
    // mostRecentOutOfArea respects the 24h window AND outOfArea flag
    expect(s.mostRecentOutOfArea).toBeNull();
    expect(s.totalToday).toBe(0);
  });

  it("picks the latest mostRecentOutOfArea by createdDateTime", () => {
    const rows = [
      row({
        id: "1",
        createdDateTime: "2026-05-08T18:00:00Z",
        outOfArea: true,
        userPrincipalName: "older@x.com",
      }),
      row({
        id: "2",
        createdDateTime: "2026-05-08T19:55:00Z",
        outOfArea: true,
        userPrincipalName: "newer@x.com",
      }),
    ];
    const s = computeSignInsSummary(rows, NOW);
    expect(s.mostRecentOutOfArea?.userPrincipalName).toBe("newer@x.com");
  });

  it("returns zero counts for an empty input", () => {
    const s = computeSignInsSummary([], NOW);
    expect(s.totalToday).toBe(0);
    expect(s.outOfAreaToday).toBe(0);
    expect(s.caFailuresToday).toBe(0);
    expect(s.mostRecent).toBeNull();
    expect(s.mostRecentOutOfArea).toBeNull();
  });
});
