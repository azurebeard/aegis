// ADR-0034 §3.2 — narrow + skip-not-throw on malformed Graph signIn payloads.
// OutOfArea computation under each policy axis is the load-bearing logic.

import { describe, expect, it } from "vitest";
import {
  computeOutOfArea,
  parseSignInsPage,
  parseSignInsPages,
  type GeoFencePolicy,
} from "../src/lib/signInsParser.js";

const CTX = (policy: GeoFencePolicy) => ({
  ingestedAt: "2026-05-08T20:00:00.000Z",
  ingestRunId: "run-1",
  policy,
});

const POLICY_DISABLED: GeoFencePolicy = {
  enabled: false,
  allowedCountries: [],
  unknownLocationPolicy: "alert",
};

const POLICY_GB_ALERT: GeoFencePolicy = {
  enabled: true,
  allowedCountries: ["gb"],
  unknownLocationPolicy: "alert",
};

const POLICY_GB_IGNORE: GeoFencePolicy = {
  enabled: true,
  allowedCountries: ["gb"],
  unknownLocationPolicy: "ignore",
};

describe("computeOutOfArea", () => {
  it("returns false when policy is disabled regardless of country", () => {
    expect(computeOutOfArea("ie", POLICY_DISABLED)).toBe(false);
    expect(computeOutOfArea("", POLICY_DISABLED)).toBe(false);
  });

  it("returns false for in-area country", () => {
    expect(computeOutOfArea("gb", POLICY_GB_ALERT)).toBe(false);
  });

  it("returns true for out-of-area country", () => {
    expect(computeOutOfArea("ie", POLICY_GB_ALERT)).toBe(true);
    expect(computeOutOfArea("us", POLICY_GB_ALERT)).toBe(true);
  });

  it("treats unknown country as out-of-area when policy=alert", () => {
    expect(computeOutOfArea("", POLICY_GB_ALERT)).toBe(true);
  });

  it("treats unknown country as in-area when policy=ignore", () => {
    expect(computeOutOfArea("", POLICY_GB_IGNORE)).toBe(false);
  });
});

describe("parseSignInsPage", () => {
  it("parses a well-formed sign-in row with location", () => {
    const out = parseSignInsPage(
      {
        value: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            createdDateTime: "2026-05-08T19:30:00Z",
            userId: "u1",
            userPrincipalName: "alice@contoso.com",
            userDisplayName: "Alice",
            appDisplayName: "Office 365",
            ipAddress: "203.0.113.5",
            location: { countryOrRegion: "GB", city: "London", state: "" },
            status: { errorCode: 0, failureReason: null },
            conditionalAccessStatus: "success",
          },
        ],
      },
      CTX(POLICY_GB_ALERT),
    );
    expect(out.skippedMalformed).toBe(0);
    expect(out.rows.length).toBe(1);
    expect(out.outOfAreaCount).toBe(0);
    expect(out.rows[0]!.country).toBe("gb");
    expect(out.rows[0]!.outOfArea).toBe(false);
  });

  it("flags out-of-area sign-ins per the policy", () => {
    const out = parseSignInsPage(
      {
        value: [
          {
            id: "u1-sign-1",
            createdDateTime: "2026-05-08T19:30:00Z",
            userId: "u1",
            userPrincipalName: "alice@contoso.com",
            location: { countryOrRegion: "IE" },
            status: {},
          },
        ],
      },
      CTX(POLICY_GB_ALERT),
    );
    expect(out.outOfAreaCount).toBe(1);
    expect(out.rows[0]!.outOfArea).toBe(true);
  });

  it("skips rows with missing id / userId / createdDateTime", () => {
    const out = parseSignInsPage(
      {
        value: [
          { id: "", createdDateTime: "2026-05-08T19:30:00Z", userId: "u" },
          { id: "x", userId: "u" }, // no createdDateTime
          { id: "x", createdDateTime: "2026-05-08T19:30:00Z" }, // no userId
          { id: "<bad>", createdDateTime: "2026-05-08T19:30:00Z", userId: "u" },
        ],
      },
      CTX(POLICY_DISABLED),
    );
    expect(out.rows.length).toBe(0);
    expect(out.skippedMalformed).toBe(4);
  });

  it("treats malformed createdDateTime as skipped", () => {
    const out = parseSignInsPage(
      {
        value: [
          {
            id: "u1",
            userId: "u1",
            createdDateTime: "not-a-date",
          },
        ],
      },
      CTX(POLICY_DISABLED),
    );
    expect(out.rows.length).toBe(0);
    expect(out.skippedMalformed).toBe(1);
  });

  it("normalises country to lowercase ISO alpha-2", () => {
    const out = parseSignInsPage(
      {
        value: [
          {
            id: "u1",
            userId: "u1",
            createdDateTime: "2026-05-08T19:30:00Z",
            location: { countryOrRegion: "Us" },
          },
          {
            id: "u2",
            userId: "u2",
            createdDateTime: "2026-05-08T19:31:00Z",
            location: { countryOrRegion: "USA" }, // 3-letter code rejected
          },
        ],
      },
      CTX(POLICY_DISABLED),
    );
    expect(out.rows.length).toBe(2);
    expect(out.rows[0]!.country).toBe("us");
    expect(out.rows[1]!.country).toBe(""); // 3-letter dropped to empty
  });

  it("returns empty + skip=0 on malformed envelope", () => {
    const out = parseSignInsPage("not-an-object", CTX(POLICY_DISABLED));
    expect(out.rows.length).toBe(0);
    expect(out.skippedMalformed).toBe(0);
  });

  it("bounds Status JSON at 2KB", () => {
    const longStatus = { errorCode: 0, failureReason: "x".repeat(5000) };
    const out = parseSignInsPage(
      {
        value: [
          {
            id: "u1",
            userId: "u1",
            createdDateTime: "2026-05-08T19:30:00Z",
            status: longStatus,
          },
        ],
      },
      CTX(POLICY_DISABLED),
    );
    expect(out.rows.length).toBe(1);
    expect(out.rows[0]!.status.length).toBeLessThanOrEqual(2048);
  });
});

describe("parseSignInsPages — aggregate", () => {
  it("aggregates across pages with skip + outOfArea counts", () => {
    const out = parseSignInsPages(
      [
        {
          value: [
            {
              id: "u1",
              userId: "u1",
              createdDateTime: "2026-05-08T19:30:00Z",
              location: { countryOrRegion: "ie" },
            },
          ],
        },
        {
          value: [
            { id: "" }, // skipped
            {
              id: "u2",
              userId: "u2",
              createdDateTime: "2026-05-08T19:31:00Z",
              location: { countryOrRegion: "gb" },
            },
          ],
        },
      ],
      CTX(POLICY_GB_ALERT),
    );
    expect(out.rows.length).toBe(2);
    expect(out.skippedMalformed).toBe(1);
    expect(out.outOfAreaCount).toBe(1); // the IE sign-in
  });
});
