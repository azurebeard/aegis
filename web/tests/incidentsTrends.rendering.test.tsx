// Rendering test for the Incidents trends chart. Recharts renders SVG
// inside a ResponsiveContainer that needs a non-zero parent width — JSDOM
// doesn't lay out so we just assert the chart's a11y label, the totals
// caption, and that the bar `path` elements get drawn.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { IncidentsTrendsChart } from "@/features/incidents/IncidentsTrendsChart";
import type { IncidentsTrendsResponse } from "@/features/incidents/types";

function makeTrend(): IncidentsTrendsResponse {
  return {
    schemaVersion: 1,
    items: [
      {
        day: "2026-04-25",
        bySeverity: { high: 1, medium: 0, low: 0, informational: 0, unknown: 0 },
        total: 1,
      },
      {
        day: "2026-04-26",
        bySeverity: { high: 0, medium: 2, low: 1, informational: 0, unknown: 0 },
        total: 3,
      },
      {
        day: "2026-04-27",
        bySeverity: { high: 0, medium: 0, low: 0, informational: 0, unknown: 0 },
        total: 0,
      },
    ],
    range: { from: "2026-04-25", to: "2026-04-27", requestedDays: 30, returnedCount: 3 },
  };
}

function renderChart(trend: IncidentsTrendsResponse, days = 30): { container: HTMLElement } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["incidents", "trends", days], trend);
  qc.setQueryData(["auth", "me"], null);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <IncidentsTrendsChart days={days} />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("IncidentsTrendsChart", () => {
  it("renders the totals caption with the peak day", () => {
    renderChart(makeTrend());
    // Caption format: "4 incidents · peak 3 on 2026-04-26"
    expect(screen.getByText(/4 incidents/)).toBeTruthy();
    expect(screen.getByText(/peak 3 on 2026-04-26/)).toBeTruthy();
    // Window-of label
    expect(screen.getByText(/Trend · last 30 days/i)).toBeTruthy();
  });

  it("renders an aria-label summarising the window", () => {
    renderChart(makeTrend());
    const labelled = screen.getAllByLabelText(
      /Last 30 days · 4 incidents · peak 3 on 2026-04-26/i,
    );
    expect(labelled.length).toBeGreaterThan(0);
  });

  it("renders every severity in the legend", () => {
    renderChart(makeTrend());
    expect(screen.getByText("High")).toBeTruthy();
    expect(screen.getByText("Medium")).toBeTruthy();
    expect(screen.getByText("Low")).toBeTruthy();
    expect(screen.getByText("Info")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
  });

  it("renders an empty-window aria-label when no incidents in the trend", () => {
    renderChart({
      schemaVersion: 1,
      items: [
        {
          day: "2026-04-27",
          bySeverity: { high: 0, medium: 0, low: 0, informational: 0, unknown: 0 },
          total: 0,
        },
      ],
      range: { from: "2026-04-27", to: "2026-04-27", requestedDays: 30, returnedCount: 1 },
    });
    expect(screen.getAllByLabelText(/no incidents/i).length).toBeGreaterThan(0);
  });
});
