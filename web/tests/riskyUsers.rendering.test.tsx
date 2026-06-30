// Rendering-safety test for the Risky Users tile (ADR-0024 §6). Directory-
// authored fields (`userPrincipalName`, `userDisplayName`) render plain-text.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { RiskyUsersTile } from "@/features/risky-users/RiskyUsersTile";
import type { RiskyUsersSummaryResponse } from "@/features/risky-users/types";

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function renderTile(summary: RiskyUsersSummaryResponse): { container: HTMLElement } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["risky-users", "summary"], summary);
  qc.setQueryData(["auth", "me"], null);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <RiskyUsersTile />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RiskyUsersTile", () => {
  it("renders counts and most-recent", () => {
    const summary: RiskyUsersSummaryResponse = {
      schemaVersion: 1,
      counts: {
        total: 5,
        byRiskLevel: { high: 2, medium: 1, low: 1, hidden: 0, none: 1, unknown: 0 },
        byRiskState: {
          none: 0,
          atRisk: 4,
          confirmedSafe: 0,
          confirmedCompromised: 1,
          remediated: 0,
          dismissed: 0,
          unknown: 0,
        },
        processing: 0,
        softDeleted: 0,
      },
      mostRecent: {
        id: "u1",
        userPrincipalName: "alice@contoso.com",
        userDisplayName: "Alice Example",
        riskLevel: "high",
        riskState: "atRisk",
        riskDetail: "unfamiliarFeatures",
        riskLastUpdatedDateTime: new Date().toISOString(),
        isDeleted: false,
        isProcessing: false,
      },
      health: {
        status: "healthy",
        lastSuccessAt: new Date().toISOString(),
        consecutiveFailures: 0,
      },
      ingestedAt: new Date().toISOString(),
    };
    renderTile(summary);
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText(/Alice Example/)).toBeTruthy();
  });

  it("does not render a hostile userDisplayName as HTML", () => {
    const summary: RiskyUsersSummaryResponse = {
      schemaVersion: 1,
      counts: {
        total: 1,
        byRiskLevel: { high: 0, medium: 0, low: 0, hidden: 0, none: 0, unknown: 1 },
        byRiskState: {
          none: 0,
          atRisk: 1,
          confirmedSafe: 0,
          confirmedCompromised: 0,
          remediated: 0,
          dismissed: 0,
          unknown: 0,
        },
        processing: 0,
        softDeleted: 0,
      },
      mostRecent: {
        id: "u1",
        userPrincipalName: `upn-${HOSTILE}`,
        userDisplayName: HOSTILE,
        riskLevel: "unknown",
        riskState: "atRisk",
        riskDetail: "",
        riskLastUpdatedDateTime: new Date().toISOString(),
        isDeleted: false,
        isProcessing: false,
      },
      health: {
        status: "healthy",
        lastSuccessAt: new Date().toISOString(),
        consecutiveFailures: 0,
      },
      ingestedAt: new Date().toISOString(),
    };
    const { container } = renderTile(summary);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getAllByText(/onerror/).length).toBeGreaterThan(0);
  });

  it("renders the licence_required empty state with P2 copy + Learn more link", () => {
    const summary: RiskyUsersSummaryResponse = {
      schemaVersion: 1,
      counts: null,
      mostRecent: null,
      health: {
        status: "licence_required",
        lastSuccessAt: null,
        consecutiveFailures: 0,
      },
      ingestedAt: null,
    };
    renderTile(summary);
    expect(screen.getByText(/Entra ID P2 required/i)).toBeTruthy();
    const link = screen.getByText(/Learn more/i) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toMatch(/learn\.microsoft\.com/);
  });

  it("renders awaiting-first-run empty state", () => {
    const summary: RiskyUsersSummaryResponse = {
      schemaVersion: 1,
      counts: {
        total: 0,
        byRiskLevel: { high: 0, medium: 0, low: 0, hidden: 0, none: 0, unknown: 0 },
        byRiskState: {
          none: 0,
          atRisk: 0,
          confirmedSafe: 0,
          confirmedCompromised: 0,
          remediated: 0,
          dismissed: 0,
          unknown: 0,
        },
        processing: 0,
        softDeleted: 0,
      },
      mostRecent: null,
      health: {
        status: "awaiting_first_run",
        lastSuccessAt: null,
        consecutiveFailures: 0,
      },
      ingestedAt: null,
    };
    renderTile(summary);
    expect(screen.getByText(/Awaiting first risky-users ingest run/i)).toBeTruthy();
  });
});
