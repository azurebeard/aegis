import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom doesn't ship ResizeObserver (used by Fluent UI's MessageBar reflow
// hook). Tests that render success/error MessageBars otherwise log
// "TypeError: win.ResizeObserver is not a constructor" — the test still
// passes because the error is thrown from a layout-effect, but it pollutes
// the output. No-op polyfill is safe — the layout effect would only resize
// the message bar's responsive layout, which is irrelevant in jsdom.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}

// ADR-0035 Phase D2 — default `useCurrentUser` mock. The pre-Phase-D2 hook
// read the principal from the React Query cache key ["auth","me"]; a large
// body of rendering tests pre-populated that key via `qc.setQueryData`.
// Post-D2 the hook reads from MSAL active-account claims instead. This mock
// preserves the test-side API: it still reads from the cache key, so every
// existing `qc.setQueryData(["auth","me"], ...)` continues to drive role-
// gated rendering paths without per-test mocking.
//
// Tests that explicitly mock `@/auth/useCurrentUser` at file scope override
// this default — vi's mocking semantics (file-scope > setupFile) ensure no
// regression for the diagnosticsPage / userDormancyTile tests that already
// supply their own admin/reader mocks.
//
// Production code path (real MSAL) is exercised by integration testing in
// the live SPA — not by unit tests in jsdom.
vi.mock("@/auth/useCurrentUser", async () => {
  const { useQueryClient } = await import("@tanstack/react-query");
  return {
    useCurrentUser: () => {
      try {
        const qc = useQueryClient();
        const cached = qc.getQueryData<{
          identityProvider: string;
          userId: string;
          userDetails: string;
          userRoles: readonly string[];
        }>(["auth", "me"]);
        if (cached) {
          return {
            isLoading: false,
            isAuthenticated: true,
            principal: cached,
            roles: cached.userRoles,
            hasRole: (r: string) => cached.userRoles.includes(r),
          };
        }
      } catch {
        // No QueryClient context — fall through to unauthenticated state.
      }
      return {
        isLoading: false,
        isAuthenticated: false,
        principal: null,
        roles: [] as readonly string[],
        hasRole: (_r: string) => false,
      };
    },
  };
});

// Stub the MSAL helpers so any test that imports them doesn't try to
// construct a real PublicClientApplication (which fails without VITE_*).
vi.mock("@/auth/authActions", () => ({
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
  acquireApiToken: vi.fn(() => Promise.resolve("test-token")),
  getActiveAccount: vi.fn(() => null),
}));
