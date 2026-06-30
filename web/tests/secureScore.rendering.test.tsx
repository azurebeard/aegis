// Rendering-safety test per ADR-0012 §5 — prose from Microsoft-authored fields
// must never land in the DOM as executable HTML. We assert against a hostile
// description string in a SecureScoreSnapshot that is passed through the tile's
// types; since v1 does NOT render `controlScores[].description` on the tile,
// this test guards the wire-shape handling and documents the intent.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { SecureScoreTile } from "@/features/secureScore/SecureScoreTile";
import type { SecureScoreLatestResponse } from "@/features/secureScore/types";

function renderWithProviders(
  latest: SecureScoreLatestResponse,
  options: { isAdmin?: boolean } = {},
): { container: HTMLElement } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["secure-score", "latest"], latest);
  qc.setQueryData(["secure-score", "trend", 90], { schemaVersion: 1, snapshots: [], range: { from: null, to: null, requestedDays: 90, returnedCount: 0 } });
  if (options.isAdmin) {
    qc.setQueryData(["auth", "me"], {
      identityProvider: "aad",
      userId: "u1",
      userDetails: "test",
      userRoles: ["authenticated", "reader", "admin"],
    });
  } else {
    qc.setQueryData(["auth", "me"], null);
  }
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <SecureScoreTile />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SecureScoreTile", () => {
  it("renders the current / max score when a snapshot is present", () => {
    const latest: SecureScoreLatestResponse = {
      schemaVersion: 1,
      snapshot: {
        snapshotDate: "2026-04-18",
        createdDateTime: "2026-04-18T00:12:03Z",
        ingestedAt: new Date().toISOString(),
        currentScore: 412,
        maxScore: 697,
        percentage: 59.1,
        activeUserCount: 0,
        licensedUserCount: 100,
        enabledServices: [],
        averageComparativeScores: [],
        controlScores: [
          {
            controlCategory: "Identity",
            controlName: "AdminMFA",
            // Hostile payload — must never round-trip through innerHTML.
            description: '<img src=x onerror="alert(1)">javascript:alert(2)',
            score: 35,
          },
        ],
      },
      health: { status: "healthy", lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 },
    };
    const { container } = renderWithProviders(latest);
    expect(screen.getAllByText(/secure score/i).length).toBeGreaterThan(0);
    // Post-redesign + portal-parity refactor: HeroStat leads with the
    // percentage (matching the Microsoft Defender portal's headline);
    // the absolute score lands in the caption as "412 of 697 controls".
    // Both the visible HeroStat caption and the visually-hidden a11y span
    // mention the absolute score, so use getAllByText to tolerate either.
    expect(screen.getAllByText(/59\.1.*percent|59\.1%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/412 of 697/).length).toBeGreaterThan(0);
    // Guard: no <img> or inline script landed in the DOM via the tile.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("renders the awaiting-first-run state when there is no snapshot", () => {
    const latest: SecureScoreLatestResponse = {
      schemaVersion: 1,
      snapshot: null,
      health: { status: "awaiting_first_run", lastSuccessAt: null, consecutiveFailures: 0 },
    };
    renderWithProviders(latest);
    expect(screen.getByText(/Awaiting first ingest run/i)).toBeTruthy();
  });

  it("offers the run-history expand to admins on a failing tile", () => {
    const latest: SecureScoreLatestResponse = {
      schemaVersion: 1,
      snapshot: null,
      health: { status: "failing", lastSuccessAt: null, consecutiveFailures: 5 },
    };
    renderWithProviders(latest, { isAdmin: true });
    expect(screen.getByText(/Recent ingest runs/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show last 20/i })).toBeTruthy();
  });

  it("hides the run-history expand from non-admin readers on a failing tile", () => {
    const latest: SecureScoreLatestResponse = {
      schemaVersion: 1,
      snapshot: null,
      health: { status: "failing", lastSuccessAt: null, consecutiveFailures: 5 },
    };
    renderWithProviders(latest);
    expect(screen.queryByText(/Recent ingest runs/i)).toBeNull();
  });

  it("does not offer run-history on the awaiting-first-run state (no audit yet)", () => {
    const latest: SecureScoreLatestResponse = {
      schemaVersion: 1,
      snapshot: null,
      health: { status: "awaiting_first_run", lastSuccessAt: null, consecutiveFailures: 0 },
    };
    renderWithProviders(latest, { isAdmin: true });
    expect(screen.queryByText(/Recent ingest runs/i)).toBeNull();
  });

  it("renders the no-data state when Graph legitimately has no score", () => {
    const latest: SecureScoreLatestResponse = {
      schemaVersion: 1,
      snapshot: null,
      health: { status: "no_data", lastSuccessAt: null, consecutiveFailures: 0 },
    };
    renderWithProviders(latest);
    expect(
      screen.getByText(/No Secure Score is published for this tenant yet/i),
    ).toBeTruthy();
  });
});
