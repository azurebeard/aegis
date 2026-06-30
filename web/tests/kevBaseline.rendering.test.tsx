// ADR-0033 Phase 2.5 — KevBaselineSection rendering + interaction tests.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { KevBaselineSection } from "@/features/settings/sections/KevBaselineSection";
import type { TenantSettings } from "@/features/settings/types";

function baseSettings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    tileVisibility: {
      secureScore: true,
      incidents: true,
      brief: true,
      riskyUsers: true,
      posture: true,
      stack: true,
      kev: true,
    },
    aiPlaneEnabled: true,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

function setup({ settings }: { settings: TenantSettings }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FluentProvider theme={webLightTheme}>
          <KevBaselineSection settings={settings} />
        </FluentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("KevBaselineSection", () => {
  it("defaults to historic when no kevBaseline record is present", () => {
    setup({ settings: baseSettings() });
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBe(2);
    const historicRadio = radios[0]!;
    expect(historicRadio.getAttribute("aria-checked")).toBe("true");
    // Date input is hidden when historic is selected.
    expect(screen.queryByLabelText(/Baseline date/i)).toBeNull();
  });

  it("reflects a stored from-deploy record", () => {
    setup({
      settings: baseSettings({
        kevBaseline: {
          mode: "from-deploy",
          baselineDate: "2026-04-15",
          updatedAt: "2026-04-15T10:00:00Z",
          updatedBy: "admin",
          source: "tenant",
        },
      }),
    });
    const fromDeploy = screen.getAllByRole("radio")[1]!;
    expect(fromDeploy.getAttribute("aria-checked")).toBe("true");
    const dateInput = screen.getByLabelText(/Baseline date/i) as HTMLInputElement;
    expect(dateInput.value).toBe("2026-04-15");
    // Footer reports the prior baseline.
    expect(screen.getByText(/cutoff 2026-04-15/i)).toBeTruthy();
  });

  it("reveals the date input when operator selects from-deploy", () => {
    setup({ settings: baseSettings() });
    expect(screen.queryByLabelText(/Baseline date/i)).toBeNull();
    const fromDeploy = screen.getAllByRole("radio")[1]!;
    fireEvent.click(fromDeploy);
    expect(screen.getByLabelText(/Baseline date/i)).toBeTruthy();
  });

  it("disables Save when nothing is dirty", () => {
    setup({ settings: baseSettings() });
    const save = screen.getByRole("button", { name: /^Save$/ });
    expect(save.hasAttribute("disabled")).toBe(true);
  });

  it("enables Save once mode flips to from-deploy with a valid date", () => {
    setup({ settings: baseSettings() });
    const fromDeploy = screen.getAllByRole("radio")[1]!;
    fireEvent.click(fromDeploy);
    const save = screen.getByRole("button", { name: /^Save$/ });
    // Default date is today (UTC) → valid → save enabled.
    expect(save.hasAttribute("disabled")).toBe(false);
  });

  it("Discard reverts a dirty form back to the server-side mode", () => {
    setup({ settings: baseSettings() });
    const fromDeploy = screen.getAllByRole("radio")[1]!;
    fireEvent.click(fromDeploy);
    expect(screen.getByLabelText(/Baseline date/i)).toBeTruthy();
    const discard = screen.getByRole("button", { name: /^Discard$/ });
    fireEvent.click(discard);
    expect(screen.queryByLabelText(/Baseline date/i)).toBeNull();
    const historicRadio = screen.getAllByRole("radio")[0]!;
    expect(historicRadio.getAttribute("aria-checked")).toBe("true");
  });

  it("submits the patch when Save is clicked from from-deploy + valid date", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(baseSettings()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    setup({ settings: baseSettings() });
    const fromDeploy = screen.getAllByRole("radio")[1]!;
    fireEvent.click(fromDeploy);
    const dateInput = screen.getByLabelText(/Baseline date/i) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-04-20" } });
    const save = screen.getByRole("button", { name: /^Save$/ });
    fireEvent.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/ingest/settings");
    expect(init?.method).toBe("PATCH");
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body).toEqual({
      kevBaseline: { mode: "from-deploy", baselineDate: "2026-04-20" },
    });
  });

  it("submits historic with empty baselineDate when reverting from from-deploy", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(baseSettings()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    setup({
      settings: baseSettings({
        kevBaseline: {
          mode: "from-deploy",
          baselineDate: "2026-04-15",
          updatedAt: "2026-04-15T10:00:00Z",
          updatedBy: "admin",
          source: "tenant",
        },
      }),
    });
    const historicRadio = screen.getAllByRole("radio")[0]!;
    fireEvent.click(historicRadio);
    const save = screen.getByRole("button", { name: /^Save$/ });
    fireEvent.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body).toEqual({
      kevBaseline: { mode: "historic", baselineDate: "" },
    });
  });
});
