// Tests for the bell-icon notifications panel.
//
// Coverage:
//   - countUnread: empty lastSeenAt counts everything; non-empty filters
//     strict-greater-than.
//   - NotificationsPanel: empty-state copy, populated rendering, danger
//     vs info dot tone, mark-all-read button enables only with content.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import {
  countUnread,
  type Notification,
  type NotificationsResponse,
} from "@/features/common/notifications";

function n(
  id: string,
  kind: Notification["kind"],
  tone: Notification["tone"],
  title: string,
  detail: string,
  timestamp: string,
): Notification {
  return { id, kind, tone, title, detail, timestamp };
}

describe("notifications.countUnread", () => {
  const items: readonly Notification[] = [
    n("a", "ingest-failure", "danger", "A", "x", "2026-04-27T10:00:00Z"),
    n("b", "agent-circuit-half-open", "warning", "B", "x", "2026-04-27T11:00:00Z"),
    n("c", "settings-changed", "info", "C", "x", "2026-04-27T12:00:00Z"),
  ];

  it("counts every notification when lastSeenAt is empty", () => {
    expect(countUnread(items, "")).toBe(3);
  });

  it("counts only strict-greater-than lastSeenAt", () => {
    expect(countUnread(items, "2026-04-27T10:30:00Z")).toBe(2);
    expect(countUnread(items, "2026-04-27T11:30:00Z")).toBe(1);
    expect(countUnread(items, "2026-04-27T12:00:00Z")).toBe(0);
  });

  it("returns 0 for an empty list regardless of lastSeenAt", () => {
    expect(countUnread([], "")).toBe(0);
    expect(countUnread([], "2026-04-27T10:00:00Z")).toBe(0);
  });
});

function renderPanel(
  data: NotificationsResponse,
  lastSeenAt = "",
  onMarkAllRead: () => void = () => undefined,
): { container: HTMLElement } {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["notifications"], data);
  qc.setQueryData(["auth", "me"], null);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <NotificationsPanel
            onClose={() => undefined}
            onMarkAllRead={onMarkAllRead}
            lastSeenAt={lastSeenAt}
          />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NotificationsPanel", () => {
  it("renders the empty state when the API returns zero notifications", () => {
    renderPanel({
      schemaVersion: 1,
      notifications: [],
      generatedAt: "2026-04-27T12:00:00Z",
    });
    expect(screen.getByText(/All quiet/i)).toBeTruthy();
    // Mark-all-read disabled when there's nothing to mark.
    const markBtn = screen.getByRole("button", { name: /Mark all read/i });
    expect((markBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders titles + details for every notification", () => {
    renderPanel({
      schemaVersion: 1,
      notifications: [
        n(
          "ingest-failure:graph.security.incidents",
          "ingest-failure",
          "danger",
          "Incidents ingest is failing",
          "5 consecutive failures · last at 2026-04-27T10:00:00Z",
          "2026-04-27T10:00:00Z",
        ),
        n(
          "settings-changed:branding:2026-04-27T11:00:00Z",
          "settings-changed",
          "info",
          "Branding updated",
          "Changed by alice@picnicdev at 2026-04-27T11:00:00Z",
          "2026-04-27T11:00:00Z",
        ),
      ],
      generatedAt: "2026-04-27T12:00:00Z",
    });
    expect(screen.getByText(/Incidents ingest is failing/i)).toBeTruthy();
    expect(screen.getByText(/Branding updated/i)).toBeTruthy();
    expect(screen.getByText(/5 consecutive failures/i)).toBeTruthy();
  });

  it("calls onMarkAllRead when the foot button is clicked", () => {
    const markAllRead = vi.fn();
    renderPanel(
      {
        schemaVersion: 1,
        notifications: [
          n("a", "ingest-failure", "danger", "X", "x", "2026-04-27T10:00:00Z"),
        ],
        generatedAt: "2026-04-27T12:00:00Z",
      },
      "",
      markAllRead,
    );
    const btn = screen.getByRole("button", { name: /Mark all read/i });
    fireEvent.click(btn);
    expect(markAllRead).toHaveBeenCalledOnce();
  });

  it("marks notifications strictly newer than lastSeenAt as unread", () => {
    const { container } = renderPanel(
      {
        schemaVersion: 1,
        notifications: [
          n("a", "ingest-failure", "danger", "Old", "x", "2026-04-27T09:00:00Z"),
          n("b", "settings-changed", "info", "Recent", "x", "2026-04-27T11:00:00Z"),
        ],
        generatedAt: "2026-04-27T12:00:00Z",
      },
      "2026-04-27T10:00:00Z",
    );
    const items = container.querySelectorAll(".notif-item");
    expect(items).toHaveLength(2);
    // Only the second item is unread.
    const unread = container.querySelectorAll(".notif-item.is-unread");
    expect(unread).toHaveLength(1);
    expect((unread[0] as HTMLElement).textContent).toContain("Recent");
  });
});
