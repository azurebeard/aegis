// ADR-0030 Phase A — rendering tests for ReportsPage.
//
// Covers:
//   - Live current-period view with envelope present
//   - Historical view via ?period=2026-W17
//   - "Recent reports" sidebar list links to ?period=…&version=…
//   - Admin sees "Capture this period"; reader does not
//   - Hostile content from envelope sections renders as text, not HTML
//     (ADR-0012 §5 plain-text-only invariant)

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { ReportsPage } from "@/pages/ReportsPage";
import type {
  ReportEnvelope,
  ReportSnapshotListResponse,
} from "@/features/reports/types";
import {
  REPORT_QUERY_KEYS,
} from "@/features/reports/queries";

const HOSTILE = '<img src=x onerror="alert(1)">';

function makeEnvelope(periodKey = "2026-W17"): ReportEnvelope {
  return {
    schemaVersion: 1,
    contentType: "application/json",
    tenantId: "tenant-1",
    periodKey,
    periodCadence: "weekly",
    periodStart: "2026-04-20T00:00:00.000Z",
    periodEnd: "2026-04-26T23:59:59.999Z",
    capturedAt: "2026-04-28T12:00:00.000Z",
    capturedBy: "admin-oid",
    version: 1,
    sections: {
      secureScore: { snapshot: { hostile: HOSTILE }, trend: [] },
      incidents: { counts: { total: 0 }, trend: [], preview: [] },
      entraRisk: { counts: { total: 0 } },
      brief: { briefDate: null, body: null, modelDeployment: null },
      posture: { isoWeek: null, body: null, modelDeployment: null },
      ingestHealth: [],
    },
    derived: {},
  };
}

function renderWith({
  envelope,
  list,
  initialUrl,
  isAdmin,
  cadence = "weekly",
  historicalEnvelope,
}: {
  envelope: ReportEnvelope | null;
  list: ReportSnapshotListResponse;
  initialUrl: string;
  isAdmin: boolean;
  cadence?: ReportEnvelope["periodCadence"];
  historicalEnvelope?: ReportEnvelope;
}): { container: HTMLElement } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["settings", "tenant"], {
    tileVisibility: { secureScore: true, incidents: true, brief: true, riskyUsers: true, posture: true, stack: true, kev: true },
    reportCadence: { cadence, source: "tenant", updatedAt: null, updatedBy: null },
    aiPlaneEnabled: true,
    updatedAt: null,
    updatedBy: null,
  });
  qc.setQueryData(["auth", "me"], {
    identityProvider: "aad",
    userId: "u1",
    userDetails: "test@example.com",
    userRoles: isAdmin
      ? ["authenticated", "reader", "admin"]
      : ["authenticated", "reader"],
  });
  if (envelope) qc.setQueryData(REPORT_QUERY_KEYS.current(cadence), envelope);
  if (historicalEnvelope)
    qc.setQueryData(
      REPORT_QUERY_KEYS.snapshot(historicalEnvelope.periodKey, historicalEnvelope.version),
      historicalEnvelope,
    );
  qc.setQueryData(REPORT_QUERY_KEYS.list(cadence), list);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[initialUrl]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <FluentProvider theme={webLightTheme}>
          <ReportsPage />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ReportsPage", () => {
  it("renders the current-period envelope with section headings", () => {
    renderWith({
      envelope: makeEnvelope(),
      list: { schemaVersion: 1, cadence: "weekly", items: [], range: { requestedLimit: 12, returnedCount: 0 } },
      initialUrl: "/reports",
      isAdmin: true,
    });
    expect(screen.getByText("2026-W17")).toBeTruthy();
    expect(screen.getByText("Microsoft Secure Score")).toBeTruthy();
    expect(screen.getByText("Incidents")).toBeTruthy();
    expect(screen.getByText("Risky Users")).toBeTruthy();
    expect(screen.getByText("Daily Brief")).toBeTruthy();
    expect(screen.getByText("Weekly Posture")).toBeTruthy();
    expect(screen.getByText("Ingest health")).toBeTruthy();
  });

  it("does not render hostile envelope content as HTML", () => {
    const { container } = renderWith({
      envelope: makeEnvelope(),
      list: { schemaVersion: 1, cadence: "weekly", items: [], range: { requestedLimit: 12, returnedCount: 0 } },
      initialUrl: "/reports",
      isAdmin: false,
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // The hostile string still appears as serialised text inside the
    // <pre> JSON dump — escape-by-default keeps it inert.
    const matches = screen.getAllByText(/onerror/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("offers Capture this period to admins on the live view", () => {
    renderWith({
      envelope: makeEnvelope(),
      list: { schemaVersion: 1, cadence: "weekly", items: [], range: { requestedLimit: 12, returnedCount: 0 } },
      initialUrl: "/reports",
      isAdmin: true,
    });
    expect(
      screen.getByRole("button", { name: /Capture weekly report/i }),
    ).toBeTruthy();
  });

  it("hides Capture this period from non-admin readers", () => {
    renderWith({
      envelope: makeEnvelope(),
      list: { schemaVersion: 1, cadence: "weekly", items: [], range: { requestedLimit: 12, returnedCount: 0 } },
      initialUrl: "/reports",
      isAdmin: false,
    });
    expect(screen.queryByRole("button", { name: /Capture weekly report/i })).toBeNull();
  });

  it("renders the recent-reports list with version-permalinks", () => {
    renderWith({
      envelope: makeEnvelope(),
      list: {
        schemaVersion: 1,
        cadence: "weekly",
        items: [
          {
            periodKey: "2026-W16",
            cadence: "weekly",
            version: 2,
            capturedAt: "2026-04-21T08:00:00.000Z",
            capturedBy: "admin-oid",
            contentType: "application/json",
            envelopeBytes: 12345,
            periodStart: "2026-04-13T00:00:00.000Z",
            periodEnd: "2026-04-19T23:59:59.999Z",
          },
        ],
        range: { requestedLimit: 12, returnedCount: 1 },
      },
      initialUrl: "/reports",
      isAdmin: false,
    });
    expect(screen.getByText("2026-W16")).toBeTruthy();
    const link = screen.getByRole("link", { name: /2026-W16/ });
    expect(link.getAttribute("href")).toBe("/reports?period=2026-W16&version=2");
  });

  it("renders a historical snapshot when ?period= is set", () => {
    const hist = { ...makeEnvelope("2026-W16"), version: 3 };
    renderWith({
      envelope: makeEnvelope(),
      historicalEnvelope: hist,
      list: { schemaVersion: 1, cadence: "weekly", items: [], range: { requestedLimit: 12, returnedCount: 0 } },
      initialUrl: "/reports?period=2026-W16&version=3",
      isAdmin: true,
    });
    expect(screen.getByText("2026-W16")).toBeTruthy();
    // Capture button is hidden on historical views.
    expect(screen.queryByRole("button", { name: /Capture weekly report/i })).toBeNull();
  });

  it("shows the Print button regardless of admin role when an envelope is loaded", () => {
    renderWith({
      envelope: makeEnvelope(),
      list: { schemaVersion: 1, cadence: "weekly", items: [], range: { requestedLimit: 12, returnedCount: 0 } },
      initialUrl: "/reports",
      isAdmin: false,
    });
    expect(screen.getByRole("button", { name: /Print report/i })).toBeTruthy();
  });
});
