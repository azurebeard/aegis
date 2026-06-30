// ADR-0034 §3.1 — dormancy summary derivation + isDormant predicate.

import { describe, expect, it } from "vitest";
import {
  computeDormancySummary,
  DORMANCY_POLICY_DEFAULTS,
  isDormant,
  lastSignInOf,
} from "../src/lib/userDormancyStore.js";
import type { UserDormancyDomain } from "../src/lib/userDormancyParser.js";

const NOW = Date.parse("2026-05-01T00:00:00.000Z");
const ONE_DAY_MS = 86_400_000;

function row(overrides: Partial<UserDormancyDomain> = {}): UserDormancyDomain {
  return {
    id: overrides.id ?? "u1",
    userPrincipalName: overrides.userPrincipalName ?? "user@contoso.com",
    displayName: overrides.displayName ?? "User",
    accountEnabled: overrides.accountEnabled ?? true,
    lastInteractiveSignIn: overrides.lastInteractiveSignIn ?? null,
    lastNonInteractiveSignIn: overrides.lastNonInteractiveSignIn ?? null,
    lastSuccessfulSignIn: overrides.lastSuccessfulSignIn ?? null,
    ingestedAt: overrides.ingestedAt ?? "2026-05-01T01:30:00.000Z",
    ingestRunId: overrides.ingestRunId ?? "run-1",
  };
}

function isoOffset(daysAgo: number): string {
  return new Date(NOW - daysAgo * ONE_DAY_MS).toISOString();
}

describe("lastSignInOf", () => {
  it("returns the latest of the three timestamps", () => {
    const r = row({
      lastInteractiveSignIn: isoOffset(20),
      lastNonInteractiveSignIn: isoOffset(5),
      lastSuccessfulSignIn: isoOffset(15),
    });
    expect(lastSignInOf(r)).toBe(isoOffset(5));
  });

  it("returns null when all three are null", () => {
    expect(lastSignInOf(row())).toBeNull();
  });
});

describe("isDormant", () => {
  const policy = DORMANCY_POLICY_DEFAULTS;

  it("treats never-signed-in (all null) as dormant", () => {
    expect(isDormant(row(), policy, NOW)).toBe(true);
  });

  it("treats older-than-threshold sign-in as dormant", () => {
    const r = row({ lastInteractiveSignIn: isoOffset(31) });
    expect(isDormant(r, policy, NOW)).toBe(true);
  });

  it("treats within-threshold sign-in as not dormant", () => {
    const r = row({ lastInteractiveSignIn: isoOffset(5) });
    expect(isDormant(r, policy, NOW)).toBe(false);
  });

  it("excludes disabled accounts by default", () => {
    const r = row({ accountEnabled: false });
    expect(isDormant(r, policy, NOW)).toBe(false);
  });

  it("counts disabled accounts when policy.includeDisabledAccounts=true", () => {
    const r = row({ accountEnabled: false });
    expect(
      isDormant(r, { ...policy, includeDisabledAccounts: true }, NOW),
    ).toBe(true);
  });

  it("excludes accounts whose UPN matches an exclusion suffix", () => {
    const r = row({ userPrincipalName: "deploy@svc.contoso.com" });
    expect(isDormant(r, policy, NOW)).toBe(false);
  });
});

describe("computeDormancySummary", () => {
  it("counts total/dormant/enabled/disabled across a mixed cohort", () => {
    const rows: UserDormancyDomain[] = [
      // Active (within threshold) — not dormant
      row({ id: "u1", lastInteractiveSignIn: isoOffset(5) }),
      // Dormant + enabled
      row({ id: "u2", lastInteractiveSignIn: isoOffset(60) }),
      // Dormant + disabled (excluded by default policy)
      row({
        id: "u3",
        accountEnabled: false,
        lastInteractiveSignIn: isoOffset(60),
      }),
      // Service-account exclusion
      row({
        id: "u4",
        userPrincipalName: "svc@svc.contoso.com",
        lastInteractiveSignIn: isoOffset(60),
      }),
      // Never signed in — dormant by definition
      row({ id: "u5" }),
    ];
    const summary = computeDormancySummary(rows, DORMANCY_POLICY_DEFAULTS, NOW);
    expect(summary.total).toBe(5);
    expect(summary.excluded).toBe(1); // u4
    // u2 + u5 dormant (u3 disabled-default-skipped, u1 active)
    expect(summary.dormant).toBe(2);
    expect(summary.enabledDormant).toBe(2);
    expect(summary.disabledDormant).toBe(0);
    // Oldest = never-signed-in u5 (lastSignIn === null)
    expect(summary.oldestDormantUpn).toBe("user@contoso.com");
    expect(summary.oldestDormantLastSignIn).toBeNull();
  });

  it("includes disabled-dormant when policy opts in", () => {
    const rows: UserDormancyDomain[] = [
      row({ id: "u1", accountEnabled: false, lastInteractiveSignIn: isoOffset(60) }),
      row({ id: "u2", accountEnabled: true, lastInteractiveSignIn: isoOffset(60) }),
    ];
    const summary = computeDormancySummary(
      rows,
      { ...DORMANCY_POLICY_DEFAULTS, includeDisabledAccounts: true },
      NOW,
    );
    expect(summary.dormant).toBe(2);
    expect(summary.enabledDormant).toBe(1);
    expect(summary.disabledDormant).toBe(1);
  });
});
