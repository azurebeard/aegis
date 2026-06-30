import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";

describe("RefreshNowButton", () => {
  it("renders nothing when canRefresh is false", () => {
    const { container } = render(
      <RefreshNowButton
        ariaLabel="Refresh now"
        refresh={{
          canRefresh: false,
          state: { status: "idle" },
          refresh: vi.fn(),
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the button + invokes refresh on click when admin", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    render(
      <RefreshNowButton
        ariaLabel="Refresh secure score now"
        refresh={{ canRefresh: true, state: { status: "idle" }, refresh: spy }}
      />,
    );
    const btn = screen.getByRole("button", { name: /refresh secure score/i });
    await userEvent.click(btn);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("disables the button + shows 'Refreshing…' while running", () => {
    render(
      <RefreshNowButton
        ariaLabel="Refresh"
        refresh={{
          canRefresh: true,
          state: { status: "running" },
          refresh: vi.fn(),
        }}
      />,
    );
    const btn = screen.getByRole("button", { name: /refresh/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/refreshing/i);
  });

  it("shows error kind + message on error state", () => {
    render(
      <RefreshNowButton
        ariaLabel="Refresh"
        refresh={{
          canRefresh: true,
          state: { status: "error", kind: "http", message: "503 Service Unavailable" },
          refresh: vi.fn(),
        }}
      />,
    );
    expect(screen.getByText(/refresh failed \(http\)/i)).toBeInTheDocument();
    expect(screen.getByText(/503 service unavailable/i)).toBeInTheDocument();
  });

  it("shows success confirmation on success state", () => {
    render(
      <RefreshNowButton
        ariaLabel="Refresh"
        refresh={{ canRefresh: true, state: { status: "success" }, refresh: vi.fn() }}
      />,
    );
    expect(screen.getByText(/refreshed — loading new data/i)).toBeInTheDocument();
  });
});
