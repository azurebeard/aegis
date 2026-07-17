// Render-level test for the User dormancy tile (ADR-0034 §3.1, Phase 8B).
// Pins the licence_required dedicated empty state, the active hero state,
// and the no-data fallback. Plain-text-only rendering on UPN.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { UserDormancyTile } from "@/features/user-dormancy/UserDormancyTile";
import type { UserDormancySummaryResponse } from "@/features/user-dormancy/types";

// Stub useAdminTileRefresh to avoid the admin-role plumbing.
vi.mock("@/features/common/useAdminTileRefresh", () => ({
  useAdminTileRefresh: () => ({
    isRefreshing: false,
    isAdmin: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/auth/useCurrentUser", () => ({
  useCurrentUser: () => ({
    isLoading: false,
    isAuthenticated: true,
    hasRole: () => false,
    roles: ["reader"],
    userId: "u1",
  }),
}));

function renderTile(seed: UserDormancySummaryResponse): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["user-dormancy", "summary"], seed);
  qc.setQueryData(["auth", "me"], { roles: ["reader"], userId: "u1" });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <FluentProvider theme={webLightTheme}>
          <UserDormancyTile />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("UserDormancyTile", () => {
  it("renders the licence_required dedicated empty state", () => {
    renderTile({
      schemaVersion: 1,
      counts: null,
      policy: null,
      health: { status: "licence_required", lastSuccessAt: null, consecutiveFailures: 0 },
      ingestedAt: null,
    });
    expect(screen.getByText("Entra ID P1 required")).toBeTruthy();
    expect(screen.getByText(/Upgrade to unlock/)).toBeTruthy();
  });

  it("renders dormant count + caption when counts are present", () => {
    renderTile({
      schemaVersion: 1,
      counts: {
        total: 100,
        dormant: 12,
        enabledDormant: 10,
        disabledDormant: 2,
        excluded: 3,
        oldestDormantUpn: "ancient@contoso.com",
        oldestDormantLastSignIn: "2025-01-01T00:00:00Z",
      },
      policy: {
        thresholdDays: 30,
        includeDisabledAccounts: false,
        excludeServiceAccountSuffixes: ["@svc."],
        source: "default",
      },
      health: {
        status: "healthy",
        lastSuccessAt: "2026-05-01T01:30:00Z",
        consecutiveFailures: 0,
      },
      ingestedAt: "2026-05-01T01:30:00Z",
    });
    // Hero figure
    expect(screen.getByText("12")).toBeTruthy();
    // Caption surface
    expect(screen.getByText(/12% of 100 users/)).toBeTruthy();
    expect(screen.getByText(/>30d threshold/)).toBeTruthy();
    expect(screen.getByText(/2 disabled/)).toBeTruthy();
    expect(screen.getByText(/3 excluded/)).toBeTruthy();
    // Oldest UPN surfaced
    expect(screen.getByText("ancient@contoso.com")).toBeTruthy();
  });

  it("renders the empty-state fallback when counts.total === 0", () => {
    renderTile({
      schemaVersion: 1,
      counts: {
        total: 0,
        dormant: 0,
        enabledDormant: 0,
        disabledDormant: 0,
        excluded: 0,
        oldestDormantUpn: null,
        oldestDormantLastSignIn: null,
      },
      policy: null,
      health: {
        status: "awaiting_first_run",
        lastSuccessAt: null,
        consecutiveFailures: 0,
      },
      ingestedAt: null,
    });
    expect(screen.getByText(/Awaiting first dormancy ingest run/)).toBeTruthy();
  });

  it("escapes hostile UPN content (XSS-safe via React text-node)", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    renderTile({
      schemaVersion: 1,
      counts: {
        total: 1,
        dormant: 1,
        enabledDormant: 1,
        disabledDormant: 0,
        excluded: 0,
        oldestDormantUpn: hostile,
        oldestDormantLastSignIn: null,
      },
      policy: {
        thresholdDays: 30,
        includeDisabledAccounts: false,
        excludeServiceAccountSuffixes: [],
        source: "default",
      },
      health: {
        status: "healthy",
        lastSuccessAt: "2026-05-01T01:30:00Z",
        consecutiveFailures: 0,
      },
      ingestedAt: "2026-05-01T01:30:00Z",
    });
    // The hostile text appears as text content, not as a parsed <img>.
    expect(document.querySelector("img[src='x']")).toBeNull();
    // The literal string is still in the DOM as text.
    expect(screen.getByText(hostile)).toBeTruthy();
  });
});
