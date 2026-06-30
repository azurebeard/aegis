import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { NoAccessPage } from "@/pages/NoAccessPage";

describe("NoAccessPage", () => {
  it("renders the neutral, non-leaking message (WS10 SEC-M-ADR-09-02)", () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <NoAccessPage />
      </FluentProvider>,
    );
    expect(screen.getByText(/not been granted access/i)).toBeInTheDocument();
    expect(screen.getByText(/contact the administrator/i)).toBeInTheDocument();
    // Sign-out is a Fluent Link rendered as button (jsx-a11y/anchor-is-valid).
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});
