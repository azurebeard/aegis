// HANDOVER §6.3 — AppHeader Solutions menu ↔ router route-table drift gate.
//
// `AppHeader.TABS` (the chrome) and `router.tsx`'s flat route list are
// two independent registries. Pre-test, a Solutions menu entry could
// ship pointing at a path that has no route (404 on click), or a new
// route could ship with no chrome entry (page exists but is unreachable
// from the nav). The ADR-0037 Layer 5 rollout almost demonstrated this
// both ways — Ransomware intel landed in router before the Solutions
// nav entry caught up.
//
// Direction A (load-bearing): every TABS leaf path resolves to a route.
// Direction B (orphan guard): every route is either reachable from the
// chrome OR is in `EXPECTED_CHROMELESS_PATHS` — chromeless paths are
// legitimate (admin sub-pages, deep-link aliases, tile drilldowns, auth
// fallbacks), but adding one must be a deliberate registry edit.
//
// Pattern mirrors `dashboardFreshness.registry.test.ts`.
//
// Note: the test imports from `@/app/router` which would normally pull
// in every page component. vitest's `vi.mock` short-circuits that — we
// only need the `ROUTE_PATHS` derived string list, not the React tree.

import { describe, expect, it, vi } from "vitest";

vi.mock("react-router-dom", () => ({
  createBrowserRouter: () => ({}),
}));
vi.mock("@/components/shell/Layout", () => ({ Layout: () => null }));
vi.mock("@/pages/AgentObservabilityPage", () => ({ AgentObservabilityPage: () => null }));
vi.mock("@/pages/DiagnosticsPage", () => ({ DiagnosticsPage: () => null }));
vi.mock("@/pages/HomePage", () => ({ HomePage: () => null }));
vi.mock("@/pages/IdentitiesPage", () => ({ IdentitiesPage: () => null }));
vi.mock("@/pages/IncidentsPage", () => ({ IncidentsPage: () => null }));
vi.mock("@/pages/NarrativeHistoryPage", () => ({ NarrativeHistoryPage: () => null }));
vi.mock("@/pages/NoAccessPage", () => ({ NoAccessPage: () => null }));
vi.mock("@/pages/KevPage", () => ({ KevPage: () => null }));
vi.mock("@/pages/RansomwarePage", () => ({ RansomwarePage: () => null }));
vi.mock("@/pages/ReportEmailSendsPage", () => ({ ReportEmailSendsPage: () => null }));
vi.mock("@/pages/ReportsPage", () => ({ ReportsPage: () => null }));
vi.mock("@/pages/RiskyUsersPage", () => ({ RiskyUsersPage: () => null }));
vi.mock("@/pages/SignInsPage", () => ({ SignInsPage: () => null }));
vi.mock("@/pages/UserDormancyPage", () => ({ UserDormancyPage: () => null }));
vi.mock("@/pages/SecureScoreControlsPage", () => ({ SecureScoreControlsPage: () => null }));
vi.mock("@/pages/SecureScorePage", () => ({ SecureScorePage: () => null }));
vi.mock("@/features/ping/PingPage", () => ({ PingPage: () => null }));
vi.mock("@/features/settings/AdminSettingsPage", () => ({ AdminSettingsPage: () => null }));

import { TABS } from "@/components/shell/AppHeader";
import { ROUTE_PATHS } from "@/app/router";

/** Routes that intentionally have no AppHeader chrome entry. Adding a
 *  path here is a deliberate "this page is reached via tile drilldown,
 *  deep-link, or auth-fallback only" declaration. */
const EXPECTED_CHROMELESS_PATHS: ReadonlySet<string> = new Set([
  "/ping", // ops health-check, not user-facing
  "/secure-score", // reached via SecureScoreTile click-through
  "/admin/agents", // reached via Admin → Agents tab inside AdminSettingsPage
  "/admin/diagnostics", // reached via Admin → Diagnostics
  "/admin/email", // ADR-0030 Phase C deep-link alias
  "/admin/email/sends", // reached via Admin → Report email → Sends history
  "/history", // reached via Brief / Posture tile "View history" link
  "/no-access", // auth fallback; surfacing in chrome would be confusing
]);

/** Walk TABS into a flat array of leaf paths. */
function collectTabPaths(): readonly string[] {
  const out: string[] = [];
  for (const t of TABS) {
    if (t.kind === "leaf") {
      out.push(t.path);
    } else {
      for (const c of t.children) out.push(c.path);
    }
  }
  return out;
}

describe("AppHeader ↔ router parity (HANDOVER §6.3)", () => {
  const tabPaths = collectTabPaths();
  const routeSet = new Set(ROUTE_PATHS);
  const tabSet = new Set(tabPaths);

  it("Direction A: every TABS leaf path has a matching route", () => {
    for (const p of tabPaths) {
      expect(
        routeSet.has(p),
        `AppHeader points at '${p}' but router.tsx has no matching route — clicking the nav would 404`,
      ).toBe(true);
    }
  });

  it("Direction B: every router path is either in TABS or in EXPECTED_CHROMELESS_PATHS", () => {
    for (const p of ROUTE_PATHS) {
      const reachable = tabSet.has(p) || EXPECTED_CHROMELESS_PATHS.has(p);
      expect(
        reachable,
        `router.tsx has '${p}' but it's not in TABS and not in EXPECTED_CHROMELESS_PATHS — either add a nav entry or document the deliberate omission in the allowlist`,
      ).toBe(true);
    }
  });

  it("EXPECTED_CHROMELESS_PATHS has no stale entries (allowlist drift guard)", () => {
    for (const p of EXPECTED_CHROMELESS_PATHS) {
      expect(
        routeSet.has(p),
        `EXPECTED_CHROMELESS_PATHS lists '${p}' but no such route exists — remove the stale allowlist entry`,
      ).toBe(true);
    }
  });

  it("TABS has no duplicate leaf paths (defensive — would shadow active-tab detection)", () => {
    const counts = new Map<string, number>();
    for (const p of tabPaths) counts.set(p, (counts.get(p) ?? 0) + 1);
    for (const [p, n] of counts) {
      expect(n, `TABS leaf path '${p}' is declared ${n} times — pick one`).toBe(1);
    }
  });
});
