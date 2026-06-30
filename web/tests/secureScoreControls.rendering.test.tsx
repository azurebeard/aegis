// Rendering test for the Secure Score controls drill-down page.
// Per ADR-0012 §5, every Microsoft-authored field that lands in the DOM
// must be plain-text only. The page renders `controlCategory` and
// `controlName` directly — feed a hostile control name to assert no
// HTML execution path opens up.
//
// Also pins the default sort behaviour: score ascending so the lowest-
// scoring controls (the operator's remediation backlog) appear first.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { SecureScoreControlsPage } from "@/pages/SecureScoreControlsPage";
import type { SecureScoreLatestResponse } from "@/features/secureScore/types";

const HOSTILE = '<img src=x onerror="alert(1)">';

function makeSnapshot(
  controls: readonly { category: string; name: string; score: number }[],
): SecureScoreLatestResponse {
  return {
    schemaVersion: 1,
    snapshot: {
      snapshotDate: "2026-04-27",
      createdDateTime: "2026-04-27T03:00:00Z",
      ingestedAt: "2026-04-27T03:01:00Z",
      currentScore: 59.19,
      maxScore: 74,
      percentage: 80,
      activeUserCount: 24,
      licensedUserCount: 100,
      enabledServices: [],
      averageComparativeScores: [],
      controlScores: controls.map((c) => ({
        controlCategory: c.category,
        controlName: c.name,
        description: "",
        score: c.score,
      })),
    },
    health: { status: "healthy", lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 },
  };
}

function renderWithProviders(latest: SecureScoreLatestResponse): { container: HTMLElement } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["secure-score", "latest"], latest);
  // Pretend the user is admin-authenticated — the page redirects on
  // unauthenticated, but does not require admin specifically.
  qc.setQueryData(["auth", "me"], {
    identityProvider: "aad",
    userId: "u1",
    userDetails: "test",
    userRoles: ["authenticated", "reader", "admin"],
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <SecureScoreControlsPage />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SecureScoreControlsPage", () => {
  it("renders every control name with the controlCategory badge", () => {
    renderWithProviders(
      makeSnapshot([
        { category: "Identity", name: "AdminMFAV2", score: 10 },
        { category: "Apps", name: "meeting_autoadmitusers_v1", score: 0 },
        { category: "Identity", name: "BlockLegacyAuthentication", score: 8 },
      ]),
    );
    // Each controlName appears twice when no profile is loaded: once as
    // the row-title fallback (when profile.title is null) and once as
    // the muted `id` line below it. getAllByText tolerates the
    // duplication.
    expect(screen.getAllByText("AdminMFAV2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("meeting_autoadmitusers_v1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BlockLegacyAuthentication").length).toBeGreaterThan(0);
    // Category appears once per control; getAllByText handles the duplicate.
    expect(screen.getAllByText("Identity").length).toBeGreaterThan(0);
  });

  it("does not render a hostile controlName as HTML", () => {
    const { container } = renderWithProviders(
      makeSnapshot([
        { category: "Apps", name: HOSTILE, score: 0 },
      ]),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // The hostile string MUST still be visible as text. It surfaces in
    // both the row-title fallback and the muted id line — getAllByText
    // covers both.
    expect(screen.getAllByText(/onerror/).length).toBeGreaterThan(0);
  });

  it("default sort puts lowest-scoring controls first (remediation backlog)", () => {
    renderWithProviders(
      makeSnapshot([
        { category: "Identity", name: "AdminMFAV2", score: 10 },
        { category: "Apps", name: "meeting_autoadmitusers_v1", score: 0 },
        { category: "Identity", name: "BlockLegacyAuthentication", score: 8 },
        { category: "Identity", name: "SelfServicePasswordReset", score: 0.19 },
      ]),
    );
    // The first data row is whichever control has the lowest score.
    const rows = screen.getAllByRole("row");
    // Row 0 is the thead; rows 1+ are the data rows in render order.
    const firstDataRow = rows[1];
    expect(firstDataRow).toBeTruthy();
    expect(firstDataRow!.textContent).toContain("meeting_autoadmitusers_v1");
    // Second-lowest is the 0.19 score.
    expect(rows[2]!.textContent).toContain("SelfServicePasswordReset");
  });

  it("renders an empty-snapshot message when no controls exist", () => {
    renderWithProviders({
      schemaVersion: 1,
      snapshot: null,
      health: { status: "awaiting_first_run", lastSuccessAt: null, consecutiveFailures: 0 },
    });
    expect(screen.getByText(/No Secure Score snapshot has been ingested yet/i)).toBeTruthy();
  });
});
