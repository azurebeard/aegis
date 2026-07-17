// ADR-0032 — rendering tests for KevTile + KevPage + StackInventorySection
// (the 2026-04-28 reshape: /stack removed, KEV chip moved to /kev row +
// admin Stack inventory section).

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { KevTile } from "@/features/kev/KevTile";
import { KevPage } from "@/pages/KevPage";
import { StackInventorySection } from "@/features/settings/sections/StackInventorySection";
import type { KevSummaryResponse } from "@/features/kev/types";
import type { StackItem, StackItemsResponse } from "@/features/stack/types";

function tileSetup({
  summary,
  isAdmin,
}: {
  summary: KevSummaryResponse;
  isAdmin: boolean;
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["kev", "summary"], summary);
  qc.setQueryData(["auth", "me"], {
    identityProvider: "aad",
    userId: "u1",
    userDetails: "test@example.com",
    userRoles: isAdmin
      ? ["authenticated", "reader", "admin"]
      : ["authenticated", "reader"],
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <KevTile />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("KevTile", () => {
  it("renders the match count + due-this-week badge when matches exist", () => {
    tileSetup({
      summary: {
        schemaVersion: 1,
        catalog: { totalEntries: 1100, removedEntries: 0 },
        matches: { totalPairs: 47, matchedItemCount: 23, dueThisWeek: 5 },
        health: { status: "healthy", lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 },
      },
      isAdmin: false,
    });
    expect(screen.getByText("47")).toBeTruthy();
    expect(screen.getByText(/across 23 stack items/i)).toBeTruthy();
    expect(screen.getByText(/5 due this week/i)).toBeTruthy();
  });

  it("renders zero-exposure state when matches are empty", () => {
    tileSetup({
      summary: {
        schemaVersion: 1,
        catalog: { totalEntries: 1100, removedEntries: 0 },
        matches: { totalPairs: 0, matchedItemCount: 0, dueThisWeek: 0 },
        health: { status: "healthy", lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 },
      },
      isAdmin: false,
    });
    expect(screen.getByText(/No CISA KEV entries match your registered stack inventory/i)).toBeTruthy();
  });

  it("hides itself from readers when catalog is empty", () => {
    const { container } = tileSetup({
      summary: {
        schemaVersion: 1,
        catalog: { totalEntries: 0, removedEntries: 0 },
        matches: { totalPairs: 0, matchedItemCount: 0, dueThisWeek: 0 },
        health: { status: "awaiting_first_run", lastSuccessAt: null, consecutiveFailures: 0 },
      },
      isAdmin: false,
    });
    expect(container.textContent).not.toMatch(/KEV exposure/);
  });

  it("shows ingest-not-yet-run state to admins when catalog is empty", () => {
    tileSetup({
      summary: {
        schemaVersion: 1,
        catalog: { totalEntries: 0, removedEntries: 0 },
        matches: { totalPairs: 0, matchedItemCount: 0, dueThisWeek: 0 },
        health: { status: "awaiting_first_run", lastSuccessAt: null, consecutiveFailures: 0 },
      },
      isAdmin: true,
    });
    expect(screen.getByText(/KEV catalog has not been ingested yet/i)).toBeTruthy();
  });
});

// --- /kev page rendering --------------------------------------------------

const baseItem: StackItem = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  vendor: "Microsoft",
  product: "Windows Server 2022",
  version: "21H2",
  category: "os",
  environment: "production",
  notes: "",
  tags: [],
  canonical: true,
  addedAt: "2026-04-28T10:00:00.000Z",
  addedBy: "admin-oid",
  updatedAt: "2026-04-28T10:00:00.000Z",
  updatedBy: "admin-oid",
};

function pageSetup({
  items,
  summary,
  isAdmin,
  initialUrl = "/kev",
}: {
  items: readonly StackItem[];
  summary?: KevSummaryResponse;
  isAdmin: boolean;
  initialUrl?: string;
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["stack", "items"], {
    schemaVersion: 1,
    items,
    cap: 100,
  } satisfies StackItemsResponse);
  if (summary) qc.setQueryData(["kev", "summary"], summary);
  qc.setQueryData(["auth", "me"], {
    identityProvider: "aad",
    userId: "u1",
    userDetails: "test@example.com",
    userRoles: isAdmin
      ? ["authenticated", "reader", "admin"]
      : ["authenticated", "reader"],
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[initialUrl]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <FluentProvider theme={webLightTheme}>
          <KevPage />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("KevPage", () => {
  it("shows the empty state when nothing matches", () => {
    pageSetup({ items: [baseItem], isAdmin: false });
    // Empty-state message wraps the item count in <strong>, so the
    // surrounding prose splits across nodes — match the suffix text.
    expect(
      screen.getByText(/match an entry on/i),
    ).toBeTruthy();
  });

  it("renders the no-stack empty state when inventory is empty", () => {
    pageSetup({ items: [], isAdmin: false });
    expect(screen.getByText(/No stack items registered yet/i)).toBeTruthy();
  });

  it("renders one row per (item, CVE) pair, sorted by due-date asc", () => {
    pageSetup({
      items: [
        {
          ...baseItem,
          kevMatches: [
            {
              cveID: "CVE-2024-LATER",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "Later",
              dateAdded: "",
              dueDate: "2099-12-31",
              knownRansomwareCampaignUse: "Unknown",
              requiredAction: "Apply later patch.",
              status: "open",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
            {
              cveID: "CVE-2024-SOON",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "Soon",
              dateAdded: "",
              dueDate: "2024-05-06",
              knownRansomwareCampaignUse: "Known",
              requiredAction: "Apply hotfix immediately.",
              status: "open",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        },
      ],
      isAdmin: false,
    });
    const rows = screen.getAllByRole("row");
    // Row 0 is header; row 1 should be the SOON CVE (earlier due date).
    expect(rows[1]?.textContent).toContain("CVE-2024-SOON");
    expect(rows[2]?.textContent).toContain("CVE-2024-LATER");
  });

  it("renders the ransomware badge on ransomware-linked CVEs", () => {
    pageSetup({
      items: [
        {
          ...baseItem,
          kevMatches: [
            {
              cveID: "CVE-2024-RANSOM",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "Ransomware-linked",
              dateAdded: "",
              dueDate: "2024-12-31",
              knownRansomwareCampaignUse: "Known",
              requiredAction: "Patch.",
              status: "open",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        },
      ],
      isAdmin: false,
    });
    expect(screen.getByText("ransomware")).toBeTruthy();
  });

  it("shows the admin Run-now button only to admins", () => {
    pageSetup({
      items: [baseItem],
      summary: {
        schemaVersion: 1,
        catalog: { totalEntries: 1100, removedEntries: 0 },
        matches: { totalPairs: 0, matchedItemCount: 0, dueThisWeek: 0 },
        health: { status: "healthy", lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 },
      },
      isAdmin: true,
    });
    expect(screen.getByRole("button", { name: /Run KEV ingest now/i })).toBeTruthy();
  });

  it("hides the Run-now button from non-admin readers", () => {
    pageSetup({
      items: [baseItem],
      summary: {
        schemaVersion: 1,
        catalog: { totalEntries: 1100, removedEntries: 0 },
        matches: { totalPairs: 0, matchedItemCount: 0, dueThisWeek: 0 },
        health: { status: "healthy", lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 },
      },
      isAdmin: false,
    });
    expect(screen.queryByRole("button", { name: /Run KEV ingest now/i })).toBeNull();
  });

  // --- ADR-0033 status workflow ---

  it("default view shows only `open` matches; remediated cohort hidden", () => {
    pageSetup({
      items: [
        {
          ...baseItem,
          kevMatches: [
            {
              cveID: "CVE-2024-OPEN1",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "Open",
              dateAdded: "",
              dueDate: "2024-12-31",
              knownRansomwareCampaignUse: "Unknown",
              requiredAction: "Patch.",
              status: "open",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
            {
              cveID: "CVE-2024-FIXED",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "Fixed",
              dateAdded: "",
              dueDate: "2024-12-31",
              knownRansomwareCampaignUse: "Unknown",
              requiredAction: "Patch.",
              status: "remediated",
              notes: "Patched 2026-04-15",
              expiresAt: null,
              updatedAt: "2026-04-15T00:00:00Z",
              updatedBy: "admin-oid",
            },
          ],
        },
      ],
      isAdmin: false,
    });
    // OPEN row visible, FIXED row hidden by default chip selection.
    expect(screen.getByText("CVE-2024-OPEN1")).toBeTruthy();
    expect(screen.queryByText("CVE-2024-FIXED")).toBeNull();
    // The chip count for `Remediated` should still show (1).
    expect(screen.getByRole("button", { name: /Remediated \(1\)/ })).toBeTruthy();
  });

  it("renders status filter chips with per-cohort counts", () => {
    pageSetup({
      items: [
        {
          ...baseItem,
          kevMatches: [
            {
              cveID: "CVE-2024-A",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "A",
              dateAdded: "",
              dueDate: "",
              knownRansomwareCampaignUse: "Unknown",
              requiredAction: "",
              status: "acknowledged",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        },
      ],
      isAdmin: false,
    });
    expect(screen.getByRole("button", { name: /Open \(0\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Acknowledged \(1\)/ })).toBeTruthy();
  });

  it("admin sees a status <select> per row instead of a static badge", () => {
    pageSetup({
      items: [
        {
          ...baseItem,
          kevMatches: [
            {
              cveID: "CVE-2024-OPEN",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "Open",
              dateAdded: "",
              dueDate: "2024-12-31",
              knownRansomwareCampaignUse: "Unknown",
              requiredAction: "",
              status: "open",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        },
      ],
      isAdmin: true,
    });
    expect(screen.getByLabelText(/Set status for CVE-2024-OPEN/i)).toBeTruthy();
  });

  // --- Sort (clickable column headers) ---

  it("renders sortable column headers (Stack item, CVE, Due date, Status)", () => {
    pageSetup({
      items: [
        {
          ...baseItem,
          kevMatches: [
            {
              cveID: "CVE-2024-A",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "A",
              dateAdded: "",
              dueDate: "2024-12-31",
              knownRansomwareCampaignUse: "Unknown",
              requiredAction: "",
              status: "open",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        },
      ],
      isAdmin: false,
    });
    expect(screen.getByRole("button", { name: /Sort by Stack item/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sort by CVE/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sort by Due date/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sort by Status/i })).toBeTruthy();
  });

  it("default sort is dueDate ascending; ?sortBy=cveID&sortDir=desc honoured", () => {
    const items = [
      {
        ...baseItem,
        kevMatches: [
          {
            cveID: "CVE-2024-AAA",
            vendorProject: "Microsoft",
            product: "Windows Server 2022",
            vulnerabilityName: "A",
            dateAdded: "",
            dueDate: "2024-01-01",
            knownRansomwareCampaignUse: "Unknown",
            requiredAction: "",
            status: "open" as const,
            notes: null,
            expiresAt: null,
            updatedAt: null,
            updatedBy: null,
          },
          {
            cveID: "CVE-2024-ZZZ",
            vendorProject: "Microsoft",
            product: "Windows Server 2022",
            vulnerabilityName: "Z",
            dateAdded: "",
            dueDate: "2024-12-31",
            knownRansomwareCampaignUse: "Unknown",
            requiredAction: "",
            status: "open" as const,
            notes: null,
            expiresAt: null,
            updatedAt: null,
            updatedBy: null,
          },
        ],
      },
    ];
    // Default URL: dueDate asc → AAA (2024-01-01) before ZZZ (2024-12-31).
    const { unmount } = pageSetup({ items, isAdmin: false });
    let rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("CVE-2024-AAA");
    expect(rows[2]?.textContent).toContain("CVE-2024-ZZZ");
    unmount();

    // Override: sort by cveID desc → ZZZ before AAA.
    pageSetup({ items, isAdmin: false, initialUrl: "/kev?sortBy=cveID&sortDir=desc" });
    rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("CVE-2024-ZZZ");
    expect(rows[2]?.textContent).toContain("CVE-2024-AAA");
  });

  it("aria-sort attribute reflects the active column + direction", () => {
    pageSetup({
      items: [
        {
          ...baseItem,
          kevMatches: [
            {
              cveID: "CVE-2024-A",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "",
              dateAdded: "",
              dueDate: "2024-12-31",
              knownRansomwareCampaignUse: "Unknown",
              requiredAction: "",
              status: "open",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        },
      ],
      isAdmin: false,
      initialUrl: "/kev?sortBy=status&sortDir=desc",
    });
    const headers = screen.getAllByRole("columnheader");
    const statusHeader = headers.find((h) => h.textContent?.startsWith("Status"));
    expect(statusHeader?.getAttribute("aria-sort")).toBe("descending");
    const dueDateHeader = headers.find((h) => h.textContent?.startsWith("Due date"));
    expect(dueDateHeader?.getAttribute("aria-sort")).toBe("none");
  });

  it("non-admin sees a static status badge (no select)", () => {
    pageSetup({
      items: [
        {
          ...baseItem,
          kevMatches: [
            {
              cveID: "CVE-2024-OPEN",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "Open",
              dateAdded: "",
              dueDate: "2024-12-31",
              knownRansomwareCampaignUse: "Unknown",
              requiredAction: "",
              status: "open",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        },
      ],
      isAdmin: false,
    });
    expect(screen.queryByLabelText(/Set status/i)).toBeNull();
  });
});

// --- StackInventorySection (admin) ----------------------------------------

function adminSectionSetup({
  items,
}: {
  items: readonly StackItem[];
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["stack", "items"], {
    schemaVersion: 1,
    items,
    cap: 100,
  } satisfies StackItemsResponse);
  qc.setQueryData(["stack", "catalog"], { schemaVersion: 1, pairs: [] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <StackInventorySection />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StackInventorySection (admin)", () => {
  it("renders the add form + table heading", () => {
    adminSectionSetup({ items: [] });
    expect(screen.getByRole("heading", { name: /^Add stack item$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Add item$/i })).toBeTruthy();
  });

  it("flags non-canonical items with a warning chip", () => {
    adminSectionSetup({
      items: [{ ...baseItem, vendor: "AcmeWare", product: "FrobnicatorPro", canonical: false }],
    });
    expect(screen.getByText("non-canonical")).toBeTruthy();
  });

  it("shows the cap warning at 100 items", () => {
    const items: StackItem[] = [];
    for (let i = 0; i < 100; i++) {
      items.push({ ...baseItem, id: `id-${i}`, product: `Product ${i}` });
    }
    adminSectionSetup({ items });
    expect(screen.getByText(/Stack inventory is at the 100-item cap/i)).toBeTruthy();
  });

  it("renders the KEV chip when an item has matches", () => {
    adminSectionSetup({
      items: [
        {
          ...baseItem,
          kevMatches: [
            {
              cveID: "CVE-2024-12345",
              vendorProject: "Microsoft",
              product: "Windows Server 2022",
              vulnerabilityName: "Test",
              dateAdded: "2024-04-15",
              dueDate: "2024-05-06",
              knownRansomwareCampaignUse: "Known",
              requiredAction: "Apply hotfix.",
              status: "open",
              notes: null,
              expiresAt: null,
              updatedAt: null,
              updatedBy: null,
            },
          ],
        },
      ],
    });
    expect(screen.getByText(/^KEV \(1\)$/)).toBeTruthy();
  });

  it("does not render hostile vendor / product strings as HTML", () => {
    const HOSTILE = '<img src=x onerror="alert(1)">';
    const { container } = adminSectionSetup({
      items: [{ ...baseItem, vendor: HOSTILE, product: HOSTILE, canonical: false }],
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getAllByText(/onerror/).length).toBeGreaterThan(0);
  });
});
