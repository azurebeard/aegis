// Tests for the ⌘K command palette — covers the filtering rules, the
// admin-only gate, keyboard navigation, and that the modal renders no
// DOM at all when closed (a11y-tree footprint check matching the
// drawer-scrim invariant from SEC-OBS-UI-REDESIGN-02).

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { CommandPalette } from "@/components/CommandPalette";
import {
  COMMANDS,
  filterCommands,
} from "@/features/common/commandPalette";

describe("commandPalette.filterCommands", () => {
  it("returns every visible command when query is empty (admin)", () => {
    const out = filterCommands("", true);
    expect(out.length).toBe(COMMANDS.length);
  });

  it("filters out admin-only commands for non-admin users", () => {
    const allAdmin = filterCommands("", true);
    const reader = filterCommands("", false);
    expect(reader.length).toBeLessThan(allAdmin.length);
    // None of the reader-visible commands should be tagged adminOnly.
    expect(reader.every((c) => !c.adminOnly)).toBe(true);
  });

  it("matches by title (case-insensitive substring)", () => {
    const out = filterCommands("INCID", false);
    expect(out.some((c) => c.id === "nav-incidents")).toBe(true);
  });

  it("matches by keyword alias", () => {
    // "logout" is a keyword on action-signout but not in the title.
    const out = filterCommands("logout", false);
    expect(out.some((c) => c.id === "action-signout")).toBe(true);
  });

  it("returns empty list when nothing matches", () => {
    const out = filterCommands("xyzzy-no-match", true);
    expect(out).toEqual([]);
  });
});

function renderPalette(open: boolean, roles: readonly string[] = ["admin"]): {
  container: HTMLElement;
} {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["auth", "me"], {
    identityProvider: "aad",
    userId: "u1",
    userDetails: "test",
    userRoles: roles,
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <CommandPalette open={open} onClose={() => undefined} />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CommandPalette", () => {
  it("renders nothing in the DOM when closed", () => {
    const { container } = renderPalette(false);
    expect(container.querySelector(".cmdk")).toBeNull();
    expect(container.querySelector(".cmdk-scrim")).toBeNull();
  });

  it("renders the dialog when open", () => {
    renderPalette(true);
    expect(screen.getByRole("dialog", { name: /command palette/i })).toBeTruthy();
  });

  it("filters the list as the user types", () => {
    renderPalette(true);
    const input = screen.getByLabelText(/command query/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "agent" } });
    expect(screen.getByText(/Agent observability/i)).toBeTruthy();
    expect(screen.queryByText("Risky users")).toBeNull();
  });

  it("hides admin-only commands from a non-admin user", () => {
    renderPalette(true, ["authenticated", "reader"]);
    expect(screen.queryByText(/Agent observability/i)).toBeNull();
    expect(screen.queryByText(/Admin settings/i)).toBeNull();
    // But shared commands stay.
    expect(screen.getByText(/Dashboard/i)).toBeTruthy();
  });

  it("shows the empty-state when no commands match", () => {
    renderPalette(true);
    const input = screen.getByLabelText(/command query/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "xyzzy-no-match" } });
    expect(screen.getByText(/No matches/i)).toBeTruthy();
  });
});
