import { createBrowserRouter } from "react-router-dom";
import { Layout } from "@/components/shell/Layout";
import { AgentObservabilityPage } from "@/pages/AgentObservabilityPage";
import { DiagnosticsPage } from "@/pages/DiagnosticsPage";
import { HomePage } from "@/pages/HomePage";
import { IdentitiesPage } from "@/pages/IdentitiesPage";
import { IncidentsPage } from "@/pages/IncidentsPage";
import { NarrativeHistoryPage } from "@/pages/NarrativeHistoryPage";
import { NoAccessPage } from "@/pages/NoAccessPage";
import { KevPage } from "@/pages/KevPage";
import { RansomwarePage } from "@/pages/RansomwarePage";
import { ReportEmailSendsPage } from "@/pages/ReportEmailSendsPage";
import { ReportsPage } from "@/pages/ReportsPage";
import { RiskyUsersPage } from "@/pages/RiskyUsersPage";
import { SignInsPage } from "@/pages/SignInsPage";
import { UserDormancyPage } from "@/pages/UserDormancyPage";
import { SecureScoreControlsPage } from "@/pages/SecureScoreControlsPage";
import { SecureScorePage } from "@/pages/SecureScorePage";
import { PingPage } from "@/features/ping/PingPage";
import { AdminSettingsPage } from "@/features/settings/AdminSettingsPage";

// v7 future-flags opt-in — `createBrowserRouter` only accepts the router-
// layer flag here; `v7_startTransition` belongs on the `<RouterProvider>`
// in main.tsx (react-router splits the surface). Ref:
// https://reactrouter.com/v6/upgrading/future
//
// Routes are nested under a Layout parent so AppHeader + AppFooter stay
// mounted across navigations (no flicker on tab switch). Per-page
// `<main className="app-main">` + PageSubheader live inside each page
// component. NoAccessPage is intentionally NOT wrapped — when the user
// has no roles, surfacing the AppHeader's tabs would be misleading.
// Routes are lifted into a named const so `ROUTE_PATHS` can be derived
// from the authoritative list and exposed to drift-gate tests
// (`appHeader.routerParity.test.tsx`) without parsing the router object
// at runtime. Adding a new page here is the single source of truth.
const ROUTES = [
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/ping", element: <PingPage /> },
      { path: "/secure-score", element: <SecureScorePage /> },
      { path: "/secure-score/controls", element: <SecureScoreControlsPage /> },
      { path: "/incidents", element: <IncidentsPage /> },
      { path: "/risky-users", element: <RiskyUsersPage /> },
      { path: "/user-dormancy", element: <UserDormancyPage /> },
      { path: "/sign-ins", element: <SignInsPage /> },
      { path: "/reports", element: <ReportsPage /> },
      { path: "/kev", element: <KevPage /> },
      { path: "/ransomware", element: <RansomwarePage /> },
      { path: "/identities", element: <IdentitiesPage /> },
      // Order matters defensively: list the more-specific path first so
      // react-router's matcher unambiguously prefers `/admin/agents` over
      // `/admin`. v6's matcher scores by specificity rather than order, so
      // this is belt-and-braces — but cheaper than diagnosing a refresh-404
      // again if a future bundle hits an edge case.
      { path: "/admin/agents", element: <AgentObservabilityPage /> },
      { path: "/admin/diagnostics", element: <DiagnosticsPage /> },
      { path: "/admin/email/sends", element: <ReportEmailSendsPage /> },
      // ADR-0030 Phase C — `/admin/email` is a top-level alias for the
      // "Report email" section inside AdminSettingsPage. The page reads
      // the URL pathname and auto-selects the section. Keeps URLs
      // discoverable + makes /admin/email/sends's parent route work.
      { path: "/admin/email", element: <AdminSettingsPage /> },
      { path: "/admin", element: <AdminSettingsPage /> },
      { path: "/history", element: <NarrativeHistoryPage /> },
    ],
  },
  { path: "/no-access", element: <NoAccessPage /> },
] as const;

/** Flat list of every path the router can match. Includes Layout-wrapped
 *  routes + the top-level `/no-access`. Used by the AppHeader↔router
 *  parity test to assert no nav entry points at a 404. */
export const ROUTE_PATHS: readonly string[] = ROUTES.flatMap((r) =>
  "children" in r ? r.children.map((c) => c.path) : [r.path],
);

export const router = createBrowserRouter(
  ROUTES as unknown as Parameters<typeof createBrowserRouter>[0],
  {
    future: {
      v7_relativeSplatPath: true,
    },
  },
);
