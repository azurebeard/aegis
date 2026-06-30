// Rendering-safety test for the Incidents tile + detail drawer (ADR-0016 §6,
// ADR-0012 §5 inherited). Microsoft-authored prose fields (`displayName`,
// `description`, `summary`, alert titles/descriptions) MUST render plain-text.
// Hostile payloads MUST NOT land in the DOM as executable HTML.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { IncidentsTile } from "@/features/incidents/IncidentsTile";
import { IncidentDetailDrawer } from "@/features/incidents/IncidentDetailDrawer";
import type {
  IncidentDetailResponse,
  IncidentsSummaryResponse,
} from "@/features/incidents/types";

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function renderTile(summary: IncidentsSummaryResponse): { container: HTMLElement } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["incidents", "summary"], summary);
  qc.setQueryData(["auth", "me"], null);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <IncidentsTile />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDrawer(detail: IncidentDetailResponse): { container: HTMLElement } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["incidents", "detail", detail.incident.id], detail);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <IncidentDetailDrawer
            open={true}
            incidentId={detail.incident.id}
            onClose={() => undefined}
          />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("IncidentsTile", () => {
  it("renders counts and most-recent", () => {
    const summary: IncidentsSummaryResponse = {
      schemaVersion: 1,
      counts: {
        total: 4,
        bySeverity: { high: 1, medium: 2, low: 1, informational: 0, unknown: 0 },
        byStatus: {
          active: 3,
          inProgress: 1,
          resolved: 0,
          redirected: 0,
          awaitingAction: 0,
        },
        byClassification: {
          unknown: 2,
          truePositive: 1,
          falsePositive: 0,
          informationalExpectedActivity: 1,
        },
      },
      mostRecent: {
        id: "42",
        displayName: "Multi-stage incident",
        severity: "high",
        status: "active",
        lastUpdateDateTime: new Date().toISOString(),
      },
      health: {
        status: "healthy",
        lastSuccessAt: new Date().toISOString(),
        consecutiveFailures: 0,
      },
      ingestedAt: new Date().toISOString(),
    };
    renderTile(summary);
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText(/Multi-stage incident/)).toBeTruthy();
  });

  it("does not render a hostile displayName as HTML", () => {
    const summary: IncidentsSummaryResponse = {
      schemaVersion: 1,
      counts: {
        total: 1,
        bySeverity: { high: 0, medium: 0, low: 0, informational: 0, unknown: 1 },
        byStatus: {
          active: 1,
          inProgress: 0,
          resolved: 0,
          redirected: 0,
          awaitingAction: 0,
        },
        byClassification: {
          unknown: 1,
          truePositive: 0,
          falsePositive: 0,
          informationalExpectedActivity: 0,
        },
      },
      mostRecent: {
        id: "99",
        displayName: HOSTILE,
        severity: "unknown",
        status: "active",
        lastUpdateDateTime: new Date().toISOString(),
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
    // The hostile string MUST still be visible as text — we're not censoring
    // the content, only rendering it safely.
    expect(screen.getByText(/onerror/)).toBeTruthy();
  });

  it("renders the awaiting-first-run empty state", () => {
    const summary: IncidentsSummaryResponse = {
      schemaVersion: 1,
      counts: {
        total: 0,
        bySeverity: { high: 0, medium: 0, low: 0, informational: 0, unknown: 0 },
        byStatus: {
          active: 0,
          inProgress: 0,
          resolved: 0,
          redirected: 0,
          awaitingAction: 0,
        },
        byClassification: {
          unknown: 0,
          truePositive: 0,
          falsePositive: 0,
          informationalExpectedActivity: 0,
        },
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
    expect(screen.getByText(/Awaiting first incidents ingest run/i)).toBeTruthy();
  });
});

describe("IncidentDetailDrawer", () => {
  it("renders prose fields plain-text (no HTML execution)", () => {
    const detail: IncidentDetailResponse = {
      schemaVersion: 1,
      incident: {
        id: "42",
        displayName: HOSTILE,
        severity: "high",
        status: "active",
        classification: "truePositive",
        determination: "malware",
        priorityScore: 75,
        assignedTo: null,
        createdDateTime: "2026-04-18T00:00:00.000Z",
        lastUpdateDateTime: "2026-04-18T01:00:00.000Z",
        alertCount: 1,
        customTags: [],
        systemTags: [],
        incidentWebUrl: "",
        hasRedirect: false,
        redirectIncidentId: null,
        ingestedAt: "2026-04-18T01:00:00.000Z",
        ingestRunId: "r",
        description: `${HOSTILE} plus normal text.`,
        summary: `Summary: ${HOSTILE}`,
        alerts: [
          {
            id: "alert-1",
            title: `Hostile alert title: ${HOSTILE}`,
            severity: "high",
            description: HOSTILE,
          },
        ],
      },
      ingest: {
        ingestedAt: "2026-04-18T01:00:00.000Z",
        ingestRunId: "r",
        detailBlobPath: "incidents-detail/2026/04/18/42.json",
      },
    };
    const { container } = renderDrawer(detail);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // Content is rendered but as text. Because `HOSTILE` appears multiple
    // times, assert via getAllByText.
    expect(screen.getAllByText(/onerror/).length).toBeGreaterThan(0);
  });

  it("renders the lifecycle-trim banner when detail blob is missing (informative tone)", () => {
    const detail: IncidentDetailResponse = {
      schemaVersion: 1,
      incident: {
        id: "42",
        displayName: "Old incident",
        severity: "low",
        status: "resolved",
        classification: "informationalExpectedActivity",
        determination: "notMalicious",
        priorityScore: 10,
        assignedTo: null,
        createdDateTime: "2025-10-01T00:00:00.000Z",
        lastUpdateDateTime: "2025-10-01T00:30:00.000Z",
        alertCount: 0,
        customTags: [],
        systemTags: [],
        incidentWebUrl: "",
        hasRedirect: false,
        redirectIncidentId: null,
        ingestedAt: "2025-10-01T00:30:00.000Z",
        ingestRunId: "r",
      },
      ingest: {
        ingestedAt: "2025-10-01T00:30:00.000Z",
        ingestRunId: "r",
        detailBlobPath: "incidents-detail/2025/10/01/42.json",
        detailBlobMissing: true,
        detailBlobMissingClassification: "lifecycle-trim",
      },
    };
    renderDrawer(detail);
    expect(screen.getByText(/Detail blob has been trimmed/i)).toBeTruthy();
  });

  it("renders the unexplained banner with danger tone when blob missing within retention", () => {
    const detail: IncidentDetailResponse = {
      schemaVersion: 1,
      incident: {
        id: "42",
        displayName: "Recent incident",
        severity: "high",
        status: "active",
        classification: "unknown",
        determination: "unknown",
        priorityScore: null,
        assignedTo: null,
        createdDateTime: new Date().toISOString(),
        lastUpdateDateTime: new Date().toISOString(),
        alertCount: 0,
        customTags: [],
        systemTags: [],
        incidentWebUrl: "",
        hasRedirect: false,
        redirectIncidentId: null,
        ingestedAt: new Date().toISOString(),
        ingestRunId: "r",
      },
      ingest: {
        ingestedAt: new Date().toISOString(),
        ingestRunId: "r",
        detailBlobPath: "incidents-detail/?.json",
        detailBlobMissing: true,
        detailBlobMissingClassification: "unexplained",
      },
    };
    renderDrawer(detail);
    expect(screen.getByText(/possible out-of-band deletion/i)).toBeTruthy();
  });
});
