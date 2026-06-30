// ADR-0034 §3.1 — narrow + skip-not-throw on malformed Graph user payloads.

import { describe, expect, it } from "vitest";
import {
  isLicenceRequiredBatch,
  parseUsersPage,
  parseUsersPages,
} from "../src/lib/userDormancyParser.js";

const CTX = {
  ingestedAt: "2026-05-01T01:30:00.000Z",
  ingestRunId: "run-1",
};

describe("parseUsersPage", () => {
  it("parses a well-formed user row with full signInActivity", () => {
    const out = parseUsersPage(
      {
        value: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            displayName: "Alice",
            userPrincipalName: "alice@contoso.com",
            accountEnabled: true,
            signInActivity: {
              lastSignInDateTime: "2026-04-15T08:00:00Z",
              lastNonInteractiveSignInDateTime: "2026-04-20T08:00:00Z",
              lastSuccessfulSignInDateTime: "2026-04-20T08:00:00Z",
            },
          },
        ],
      },
      CTX,
    );
    expect(out.skippedMalformed).toBe(0);
    expect(out.rows.length).toBe(1);
    const r = out.rows[0]!;
    expect(r.userPrincipalName).toBe("alice@contoso.com");
    expect(r.lastInteractiveSignIn).toBe("2026-04-15T08:00:00Z");
    expect(r.lastSuccessfulSignIn).toBe("2026-04-20T08:00:00Z");
  });

  it("treats missing signInActivity as null fields (P1 absence)", () => {
    const out = parseUsersPage(
      {
        value: [
          {
            id: "u1",
            displayName: "B",
            userPrincipalName: "b@x.com",
            accountEnabled: true,
          },
        ],
      },
      CTX,
    );
    expect(out.rows.length).toBe(1);
    const r = out.rows[0]!;
    expect(r.lastInteractiveSignIn).toBeNull();
    expect(r.lastNonInteractiveSignIn).toBeNull();
    expect(r.lastSuccessfulSignIn).toBeNull();
  });

  it("skips rows with malformed id", () => {
    const out = parseUsersPage(
      {
        value: [
          { id: "", userPrincipalName: "a@x.com" },
          { id: "<script>", userPrincipalName: "b@x.com" },
          { userPrincipalName: "c@x.com" }, // missing id
        ],
      },
      CTX,
    );
    expect(out.rows.length).toBe(0);
    expect(out.skippedMalformed).toBe(3);
  });

  it("skips rows with missing UPN", () => {
    const out = parseUsersPage(
      { value: [{ id: "u1", displayName: "no-upn" }] },
      CTX,
    );
    expect(out.skippedMalformed).toBe(1);
  });

  it("returns empty + skip=0 on completely-malformed page envelope", () => {
    const out = parseUsersPage("not-an-object", CTX);
    expect(out.rows.length).toBe(0);
    expect(out.skippedMalformed).toBe(0);
  });

  it("treats malformed ISO timestamps as null", () => {
    const out = parseUsersPage(
      {
        value: [
          {
            id: "u1",
            userPrincipalName: "a@x.com",
            displayName: "A",
            accountEnabled: true,
            signInActivity: {
              lastSignInDateTime: "not-a-date",
              lastNonInteractiveSignInDateTime: 123,
              lastSuccessfulSignInDateTime: null,
            },
          },
        ],
      },
      CTX,
    );
    const r = out.rows[0]!;
    expect(r.lastInteractiveSignIn).toBeNull();
    expect(r.lastNonInteractiveSignIn).toBeNull();
    expect(r.lastSuccessfulSignIn).toBeNull();
  });
});

describe("parseUsersPages", () => {
  it("aggregates rows + skips across pages", () => {
    const out = parseUsersPages(
      [
        { value: [{ id: "u1", userPrincipalName: "a@x.com" }] },
        { value: [{ id: "u2", userPrincipalName: "b@x.com" }, { id: "" }] },
      ],
      CTX,
    );
    expect(out.rows.length).toBe(2);
    expect(out.skippedMalformed).toBe(1);
  });
});

describe("isLicenceRequiredBatch", () => {
  it("returns true when every row has all three signInActivity fields null", () => {
    expect(
      isLicenceRequiredBatch([
        {
          id: "u1",
          userPrincipalName: "a@x.com",
          displayName: "A",
          accountEnabled: true,
          lastInteractiveSignIn: null,
          lastNonInteractiveSignIn: null,
          lastSuccessfulSignIn: null,
          ingestedAt: "",
          ingestRunId: "",
        },
      ]),
    ).toBe(true);
  });

  it("returns false when at least one row has a non-null timestamp", () => {
    expect(
      isLicenceRequiredBatch([
        {
          id: "u1",
          userPrincipalName: "a@x.com",
          displayName: "A",
          accountEnabled: true,
          lastInteractiveSignIn: null,
          lastNonInteractiveSignIn: null,
          lastSuccessfulSignIn: null,
          ingestedAt: "",
          ingestRunId: "",
        },
        {
          id: "u2",
          userPrincipalName: "b@x.com",
          displayName: "B",
          accountEnabled: true,
          lastInteractiveSignIn: "2026-04-15T08:00:00Z",
          lastNonInteractiveSignIn: null,
          lastSuccessfulSignIn: null,
          ingestedAt: "",
          ingestRunId: "",
        },
      ]),
    ).toBe(false);
  });

  it("returns false on empty batch", () => {
    expect(isLicenceRequiredBatch([])).toBe(false);
  });
});
