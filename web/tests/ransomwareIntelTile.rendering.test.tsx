// ADR-0037 Layer 5 — render tests for RansomwareIntelTile.
// Pins:
//   - awaiting_first_run (admin sees configure card; reader sees nothing)
//   - failing/degrading (admin sees diagnose link, reader sees muted)
//   - no-rows healthy → "0 victims this month" hero
//   - populated state → counts + distinct groups + most recent victim
//   - XSS-safe: a hostile victim name renders as text (no `<img>` element)

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { RansomwareIntelTile } from "@/features/ransomware/RansomwareIntelTile";
import type { RansomwareIntelSummary } from "@/features/ransomware/types";

vi.mock("@/features/common/useAdminTileRefresh", () => ({
  useAdminTileRefresh: () => ({
    canRefresh: false,
    state: { status: "idle" },
    refresh: vi.fn(),
  }),
}));

let mockRoles: readonly string[] = ["reader"];

vi.mock("@/auth/useCurrentUser", () => ({
  useCurrentUser: () => ({
    isLoading: false,
    isAuthenticated: true,
    hasRole: (r: string) => mockRoles.includes(r),
    roles: mockRoles,
    userId: "u1",
  }),
}));

function renderTile(seed: RansomwareIntelSummary, roles: readonly string[] = ["reader"]): void {
  mockRoles = roles;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["ransomwareIntel", "summary"], seed);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <FluentProvider theme={webLightTheme}>
          <RansomwareIntelTile />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const EMPTY: RansomwareIntelSummary = {
  schemaVersion: 1,
  counts: {
    victimsThisMonth: 0,
    victimsPriorMonth: 0,
    pressThisMonth: 0,
    pressPriorMonth: 0,
    distinctGroupsThisMonth: 0,
  },
  mostRecentVictim: null,
  health: { status: "awaiting_first_run", lastSuccessAt: null, consecutiveFailures: 0 },
  country: "GB",
};

describe("RansomwareIntelTile — awaiting_first_run", () => {
  it("admin sees a configure-card explaining the Timer cadence", () => {
    renderTile(EMPTY, ["admin"]);
    expect(screen.getByText(/Ransomware intel/)).toBeTruthy();
    expect(screen.getByText(/has not run yet for/)).toBeTruthy();
    expect(screen.getByText("GB")).toBeTruthy();
  });

  it("reader sees nothing — tile is auto-hidden", () => {
    renderTile(EMPTY, ["reader"]);
    expect(screen.queryByText("Ransomware intel")).toBeNull();
  });
});

describe("RansomwareIntelTile — failing / degrading", () => {
  it("reader sees a muted 'feed currently failing' message + no counts", () => {
    renderTile({
      ...EMPTY,
      health: { status: "failing", lastSuccessAt: null, consecutiveFailures: 3 },
    }, ["reader"]);
    expect(screen.getByText(/currently/)).toBeTruthy();
    expect(screen.getByText("failing")).toBeTruthy();
  });

  it("admin sees the diagnose-link to admin section", () => {
    renderTile({
      ...EMPTY,
      health: { status: "degrading", lastSuccessAt: null, consecutiveFailures: 1 },
    }, ["admin"]);
    expect(screen.getByText("Open admin settings")).toBeTruthy();
  });
});

describe("RansomwareIntelTile — populated", () => {
  const populated: RansomwareIntelSummary = {
    schemaVersion: 1,
    counts: {
      victimsThisMonth: 7,
      victimsPriorMonth: 4,
      pressThisMonth: 12,
      pressPriorMonth: 8,
      distinctGroupsThisMonth: 3,
    },
    mostRecentVictim: {
      victim: "Acme Healthcare",
      group: "lockbit3",
      discoveredDate: "2026-06-20T00:00:00Z",
      country: "GB",
    },
    health: { status: "healthy", lastSuccessAt: "2026-06-25T13:00:00Z", consecutiveFailures: 0 },
    country: "GB",
  };

  it("renders the victim count hero", () => {
    renderTile(populated);
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("renders the distinct-groups badge + press count + prior-month comparison", () => {
    renderTile(populated);
    expect(screen.getByText(/3 distinct groups/)).toBeTruthy();
    expect(screen.getByText(/12 press articles/)).toBeTruthy();
    expect(screen.getByText(/vs 4 last month/)).toBeTruthy();
  });

  it("surfaces the most-recent victim name + group", () => {
    renderTile(populated);
    expect(screen.getByText("Acme Healthcare")).toBeTruthy();
    expect(screen.getByText(/lockbit3/)).toBeTruthy();
  });

  it("renders 'Open' link to /ransomware drilldown", () => {
    renderTile(populated);
    const link = screen.getByRole("link", { name: /Open/ });
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("/ransomware");
  });
});

describe("RansomwareIntelTile — no rows but healthy", () => {
  it("renders a zero-count hero + prior-month context", () => {
    renderTile({
      ...EMPTY,
      counts: {
        victimsThisMonth: 0,
        victimsPriorMonth: 3,
        pressThisMonth: 0,
        pressPriorMonth: 5,
        distinctGroupsThisMonth: 0,
      },
      health: { status: "healthy", lastSuccessAt: "2026-06-25T13:00:00Z", consecutiveFailures: 0 },
    });
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText(/3 prior month/)).toBeTruthy();
  });
});

describe("RansomwareIntelTile — XSS safety on victim name", () => {
  it("hostile victim name renders as plain text, not as an `<img>`", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    renderTile({
      schemaVersion: 1,
      counts: {
        victimsThisMonth: 1,
        victimsPriorMonth: 0,
        pressThisMonth: 0,
        pressPriorMonth: 0,
        distinctGroupsThisMonth: 1,
      },
      mostRecentVictim: {
        victim: hostile,
        group: "lockbit3",
        discoveredDate: "2026-06-20T00:00:00Z",
        country: "GB",
      },
      health: { status: "healthy", lastSuccessAt: "2026-06-25T13:00:00Z", consecutiveFailures: 0 },
      country: "GB",
    });
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(screen.getByText(hostile)).toBeTruthy();
  });
});
