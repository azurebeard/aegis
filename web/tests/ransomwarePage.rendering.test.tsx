// ADR-0037 Layer 5 — render tests for the /ransomware drilldown.
// Pins the plain-text rendering invariant + the SafeLink scheme allowlist.

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { RansomwarePage } from "@/pages/RansomwarePage";
import type {
  RansomwareIntelList,
  RansomwareIntelListItem,
  RansomwareIntelSummary,
} from "@/features/ransomware/types";

vi.mock("@/auth/useCurrentUser", () => ({
  useCurrentUser: () => ({
    isLoading: false,
    isAuthenticated: true,
    hasRole: () => false,
    roles: ["reader"],
    userId: "u1",
  }),
}));

function row(over: Partial<RansomwareIntelListItem>): RansomwareIntelListItem {
  return {
    kind: "victim",
    anchorDate: "2026-06-20T00:00:00Z",
    headline: "Acme Healthcare",
    country: "GB",
    group: "lockbit3",
    sector: "",
    activity: "Hospital provider ransomed",
    website: "https://acme.example",
    permalink: "https://ransomware.live/p/abc",
    url: "",
    source: "",
    summary: "",
    ...over,
  };
}

const SUMMARY: RansomwareIntelSummary = {
  schemaVersion: 1,
  counts: {
    victimsThisMonth: 2,
    victimsPriorMonth: 1,
    pressThisMonth: 1,
    pressPriorMonth: 0,
    distinctGroupsThisMonth: 2,
  },
  mostRecentVictim: null,
  health: { status: "healthy", lastSuccessAt: "2026-06-25T13:00:00Z", consecutiveFailures: 0 },
  country: "GB",
};

function renderPage(list: RansomwareIntelList, kind: "all" | "victim" | "press" = "all"): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["ransomwareIntel", "summary"], SUMMARY);
  qc.setQueryData(["ransomwareIntel", "list", kind, 200], list);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <FluentProvider theme={webLightTheme}>
          <RansomwarePage />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RansomwarePage — filter chips + headline counts", () => {
  it("renders the three filter chips (All / Victims / Press)", () => {
    renderPage({
      schemaVersion: 1,
      rows: [],
      page: { count: 0, limit: 200, hasMore: false },
      country: "GB",
    });
    expect(screen.getByRole("button", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Victims" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Press" })).toBeTruthy();
  });

  it("surfaces the per-month counts from the summary", () => {
    renderPage({
      schemaVersion: 1,
      rows: [],
      page: { count: 0, limit: 200, hasMore: false },
      country: "GB",
    });
    // Counts render as `<strong>N</strong> victims` so the text is split
    // across nodes; match the paragraph element by its full textContent.
    const para = document.querySelector(".t-caption");
    expect(para?.textContent ?? "").toMatch(/2 victims/);
    expect(para?.textContent ?? "").toMatch(/1 press article/);
  });
});

describe("RansomwarePage — table rendering", () => {
  it("renders a victim row with badge + headline + group", () => {
    renderPage({
      schemaVersion: 1,
      rows: [row({})],
      page: { count: 1, limit: 200, hasMore: false },
      country: "GB",
    });
    expect(screen.getByText("Acme Healthcare")).toBeTruthy();
    expect(screen.getByText(/Group: lockbit3/)).toBeTruthy();
    expect(screen.getByText("Victim")).toBeTruthy();
  });

  it("renders a press row with badge + title + source", () => {
    renderPage({
      schemaVersion: 1,
      rows: [
        row({
          kind: "press",
          headline: "Manufacturer ransomware attack reported",
          group: "",
          activity: "",
          website: "",
          permalink: "",
          url: "https://news.example/article",
          source: "Example News",
          summary: "Brief summary",
        }),
      ],
      page: { count: 1, limit: 200, hasMore: false },
      country: "GB",
    });
    expect(screen.getByText("Manufacturer ransomware attack reported")).toBeTruthy();
    expect(screen.getByText("Example News")).toBeTruthy();
    // The badge "Press" inside the row's `<td>` (not the filter chip
    // `<button>` of the same name).
    const badges = document.querySelectorAll("td .badge");
    expect(Array.from(badges).some((b) => b.textContent === "Press")).toBe(true);
  });
});

describe("RansomwarePage — plain-text rendering + XSS safety", () => {
  it("hostile victim name renders as plain text (no <img> element)", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    renderPage({
      schemaVersion: 1,
      rows: [row({ headline: hostile })],
      page: { count: 1, limit: 200, hasMore: false },
      country: "GB",
    });
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(screen.getByText(hostile)).toBeTruthy();
  });

  it("hostile activity free-text renders as plain text", () => {
    const hostile = '<script>alert(1)</script>';
    renderPage({
      schemaVersion: 1,
      rows: [row({ activity: hostile })],
      page: { count: 1, limit: 200, hasMore: false },
      country: "GB",
    });
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText((c) => c.includes(hostile))).toBeTruthy();
  });
});

describe("RansomwarePage — SafeLink scheme allowlist", () => {
  it("renders an https:// permalink as an external <a href>", () => {
    renderPage({
      schemaVersion: 1,
      rows: [row({ permalink: "https://ransomware.live/p/abc", website: "" })],
      page: { count: 1, limit: 200, hasMore: false },
      country: "GB",
    });
    const link = screen.getByRole("link", { name: /open/ });
    expect((link as HTMLAnchorElement).href).toBe("https://ransomware.live/p/abc");
    expect((link as HTMLAnchorElement).rel).toMatch(/noopener/);
    expect((link as HTMLAnchorElement).rel).toMatch(/noreferrer/);
    expect((link as HTMLAnchorElement).target).toBe("_blank");
  });

  it("javascript: scheme is dropped — no <a href> emitted", () => {
    renderPage({
      schemaVersion: 1,
      // The data layer would already drop this at Layer 3b — defence-in-
      // depth, this tests that even if a regression let it through, the
      // client renders it inert.
      rows: [row({ permalink: "javascript:alert(1)", website: "" })],
      page: { count: 1, limit: 200, hasMore: false },
      country: "GB",
    });
    // No anchor with that href anywhere
    const link = document.querySelector('a[href^="javascript:"]');
    expect(link).toBeNull();
  });

  it("empty link string → no <a href> emitted, fallback text shows", () => {
    renderPage({
      schemaVersion: 1,
      rows: [row({ permalink: "", website: "" })],
      page: { count: 1, limit: 200, hasMore: false },
      country: "GB",
    });
    // The fallback rendering still emits "open ↗" as plain text (the
    // SafeLink returns its children when the href is unsafe/empty).
    expect(screen.getByText(/open/)).toBeTruthy();
  });
});

describe("RansomwarePage — filter switching", () => {
  it("clicking the Victims chip updates aria-pressed", () => {
    renderPage({
      schemaVersion: 1,
      rows: [],
      page: { count: 0, limit: 200, hasMore: false },
      country: "GB",
    });
    const victimsChip = screen.getByRole("button", { name: "Victims" });
    expect(victimsChip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(victimsChip);
    expect(victimsChip.getAttribute("aria-pressed")).toBe("true");
  });
});
