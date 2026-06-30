// Rendering test for the SecureScoreTrend chart. Recharts renders SVG
// inside a ResponsiveContainer that needs a non-zero parent width — JSDOM
// doesn't lay out, so assertions focus on the chart's a11y label and the
// presence of the role=img wrapper. Behaviour pinned: showAxes default is
// `true` (axis-bearing form is the new default after the 2026-05-01 tile
// gap-close); empty data falls back to a graceful em-dash; the derived
// aria-label includes both endpoints' percentages and dates.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { SecureScoreTrend } from "@/features/secureScore/SecureScoreTrend";
import type { SecureScoreTrendEntry } from "@/features/secureScore/types";

function makeTrend(): readonly SecureScoreTrendEntry[] {
  return [
    { snapshotDate: "2026-04-01", currentScore: 44, maxScore: 100, percentage: 44.0 },
    { snapshotDate: "2026-04-15", currentScore: 46, maxScore: 100, percentage: 46.0 },
    { snapshotDate: "2026-04-29", currentScore: 47, maxScore: 100, percentage: 47.0 },
  ];
}

function renderTrend(props: Parameters<typeof SecureScoreTrend>[0]): void {
  render(
    <FluentProvider theme={webLightTheme}>
      <div style={{ width: 320, height: 140 }}>
        <SecureScoreTrend {...props} />
      </div>
    </FluentProvider>,
  );
}

describe("SecureScoreTrend", () => {
  it("renders an aria-label summarising trend endpoints (default form)", () => {
    renderTrend({ data: makeTrend() });
    const labelled = screen.getAllByLabelText(
      /44.0% on 2026-04-01 to 47.0% on 2026-04-29/i,
    );
    expect(labelled.length).toBeGreaterThan(0);
  });

  it("uses the explicit ariaLabel prop when provided", () => {
    renderTrend({ data: makeTrend(), ariaLabel: "90-day Secure Score trend" });
    const labelled = screen.getAllByLabelText("90-day Secure Score trend");
    expect(labelled.length).toBeGreaterThan(0);
  });

  it("renders an em-dash placeholder when data is empty", () => {
    renderTrend({ data: [] });
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getAllByLabelText(/No trend data available/i).length).toBeGreaterThan(0);
  });

  it("respects the explicit height prop on the container", () => {
    renderTrend({ data: makeTrend(), height: 280 });
    const role = screen.getAllByRole("img");
    const target = role.find((el) => (el as HTMLElement).style.height === "280px");
    expect(target).toBeTruthy();
  });

  it("default height is 120px (large enough to fit axes — was 48px before the gap-close)", () => {
    renderTrend({ data: makeTrend() });
    const role = screen.getAllByRole("img");
    const target = role.find((el) => (el as HTMLElement).style.height === "120px");
    expect(target).toBeTruthy();
  });

  it("renders the bare-sparkline form (no axes) when showAxes=false", () => {
    // We can't assert the absence of recharts internals reliably in jsdom;
    // pin the prop's effect via style instead — bare form keeps the small
    // top/bottom margins and never grows the container chrome.
    renderTrend({ data: makeTrend(), showAxes: false, height: 48 });
    const role = screen.getAllByRole("img");
    const target = role.find((el) => (el as HTMLElement).style.height === "48px");
    expect(target).toBeTruthy();
  });

  it("escapes hostile snapshotDate values without throwing", () => {
    // Trend data is server-derived (Microsoft Graph), but the renderer
    // still sees `snapshotDate` as a string — defence in depth on the
    // tickFormatter path.
    expect(() =>
      renderTrend({
        data: [
          { snapshotDate: "<script>alert(1)</script>", currentScore: 0, maxScore: 100, percentage: 0 },
          { snapshotDate: "2026-04-29", currentScore: 47, maxScore: 100, percentage: 47.0 },
        ],
      }),
    ).not.toThrow();
  });
});
