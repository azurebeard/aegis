// /admin route — operator-controlled tenant settings (ADR-0025 Phases 1–3).
// Aegis UI Phase 4 redesign: admin-shell (240px sticky left nav + content
// panel surface). Each section renders one at a time based on the active
// nav item; section components retain their own dirty/save mutation state.
//
// Admin-role-gated at three layers:
//   1. This page redirects non-admins to `/` inside useEffect.
//   2. SWA route rule on `PATCH /api/ingest/settings` enforces `["admin"]`.
//   3. The PATCH handler re-validates the client-principal header.

import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { MessageBar, MessageBarBody, Spinner } from "@fluentui/react-components";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { Icon, type IconName } from "@/components/Icon";
import { PageSubheader } from "@/components/shell/PageSubheader";
import { useTenantSettings } from "./queries";
import { AgentBudgetSection } from "./sections/AgentBudgetSection";
import { BrandingSection } from "./sections/BrandingSection";
import { GeoFenceSection } from "./sections/GeoFenceSection";
import { KevBaselineSection } from "./sections/KevBaselineSection";
import { RansomwareIntelSection } from "./sections/RansomwareIntelSection";
import { ReportCadenceSection } from "./sections/ReportCadenceSection";
import { ReportEmailSection } from "./sections/ReportEmailSection";
import { StackInventorySection } from "./sections/StackInventorySection";
import { TileVisibilitySection } from "./sections/TileVisibilitySection";
import { UserIdentifierStrategySection } from "./sections/UserIdentifierStrategySection";

type AdminTab =
  | "visibility"
  | "budget"
  | "userid"
  | "branding"
  | "reports"
  | "report-email"
  | "stack"
  | "kev"
  | "geo-fence"
  | "ransomware-intel";

interface AdminNavItem {
  readonly id: AdminTab;
  readonly label: string;
  readonly hint: string;
  readonly icon: IconName;
  readonly aiPlaneOnly?: boolean;
}

const NAV: readonly AdminNavItem[] = [
  { id: "visibility", label: "Tile visibility", hint: "5 tiles", icon: "tile" },
  { id: "budget", label: "Agent budget", hint: "3 agents", icon: "wallet", aiPlaneOnly: true },
  { id: "userid", label: "User identifier", hint: "Default", icon: "key", aiPlaneOnly: true },
  { id: "branding", label: "Branding", hint: "Custom", icon: "palette" },
  { id: "reports", label: "Reports", hint: "Cadence", icon: "doc" },
  { id: "report-email", label: "Report email", hint: "Send config", icon: "doc" },
  { id: "stack", label: "Stack inventory", hint: "Inventory", icon: "tile" },
  { id: "kev", label: "KEV baseline", hint: "Day-1 ack", icon: "shield" },
  { id: "geo-fence", label: "Geo-fence", hint: "Sign-ins", icon: "globe" },
  { id: "ransomware-intel", label: "Ransomware intel", hint: "Threat intel", icon: "alert" },
];

export function AdminSettingsPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const settingsQ = useTenantSettings();
  const [search] = useSearchParams();
  const location = useLocation();
  // ?section=stack | visibility | budget | userid | branding | reports —
  // initial tab from URL param so other pages (e.g. StackTile footer link)
  // can deep-link an admin to the right section.
  // ADR-0030 Phase C — `/admin/email` is also a top-level alias that
  // auto-selects the "report-email" section.
  const pathnameInitial: AdminTab | null =
    location.pathname === "/admin/email" ? "report-email" : null;
  const initialFromUrl = parseTabParam(search.get("section"));
  const [active, setActive] = useState<AdminTab>(pathnameInitial ?? initialFromUrl ?? "visibility");

  useEffect(() => {
    if (!user.isLoading && !user.hasRole("admin")) {
      navigate("/", { replace: true });
    }
  }, [user.isLoading, user, navigate]);

  if (user.isLoading || !user.hasRole("admin")) {
    return (
      <main className="app-main">
        <Spinner label="Loading…" />
      </main>
    );
  }

  // HANDOVER §6.3 `deployAiAgents` — hide agent-plane sections when the
  // AI plane is disabled. Strict `=== true` since SEC-INFO-DAAA-02
  // resolution; the field is server-required, and during
  // the brief settings-loading window we suppress the agent-plane nav
  // items rather than render + re-hide them on first paint.
  // Branding + TileVisibility stay visible — they're independent of
  // the AI plane.
  const aiPlaneEnabled = settingsQ.data?.aiPlaneEnabled === true;
  const visibleNav = NAV.filter((item) => !item.aiPlaneOnly || aiPlaneEnabled);
  // Auto-redirect away from a hidden tab (covers the case where the AI
  // plane flips false while the user is on Budget or User identifier).
  const activeIsVisible = visibleNav.some((n) => n.id === active);
  const effectiveActive = activeIsVisible ? active : "visibility";

  return (
    <>
      <PageSubheader
        title="Admin settings"
        sub="Tenant-wide settings. Changes propagate to every signed-in user within 30 seconds via the client cache."
      />
      <main className="app-main">
        {settingsQ.isPending && <Spinner label="Loading settings…" />}

        {settingsQ.isError && (
          <MessageBar intent="error">
            <MessageBarBody>
              Could not load settings. {(settingsQ.error as Error).message}
            </MessageBarBody>
          </MessageBar>
        )}

        {settingsQ.data && (
          <div className="admin-shell">
            <nav className="admin-nav" aria-label="Admin sections">
              {visibleNav.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`admin-nav__item ${effectiveActive === s.id ? "is-active" : ""}`}
                  onClick={() => setActive(s.id)}
                  aria-current={effectiveActive === s.id ? "page" : undefined}
                >
                  <Icon name={s.icon} size={14} />
                  <span>{s.label}</span>
                  <span className="admin-nav__hint">{s.hint}</span>
                </button>
              ))}
              <div
                aria-hidden
                style={{ height: 1, background: "var(--stroke-2)", margin: "6px 0" }}
              />
              {/* Cross-link into the live agent observability page — admin-only,
               *  AI-plane only (the underlying endpoint short-circuits on the
               *  deployAiAgents flag, so we only surface the link when at least
               *  one AI-plane section is visible — matches the SWA gate). */}
              {aiPlaneEnabled && (
                <Link
                  to="/admin/agents"
                  className="admin-nav__item"
                  style={{ textDecoration: "none" }}
                >
                  <Icon name="trend-up" size={14} />
                  <span>Agent observability</span>
                  <span className="admin-nav__hint">Live</span>
                </Link>
              )}
              {/* Ingest diagnostics — separate from agent observability so
               *  the latter remains AI-plane-only while diagnostics covers
               *  every audit-chain ingest source regardless of `aiPlaneEnabled`. */}
              <Link
                to="/admin/diagnostics"
                className="admin-nav__item"
                style={{ textDecoration: "none" }}
              >
                <Icon name="clock" size={14} />
                <span>Ingest diagnostics</span>
              </Link>
              <div
                style={{
                  padding: "var(--sp-s) var(--sp-m)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <span
                  className="t-caption"
                  style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}
                >
                  Tenant
                </span>
                <span
                  style={{
                    fontSize: "var(--fs-200)",
                    color: "var(--fg-2)",
                  }}
                >
                  Single-tenant deployment
                </span>
              </div>
            </nav>

            <div className="surface" style={{ padding: "var(--sp-xl) var(--sp-xxl)" }}>
              {effectiveActive === "visibility" && (
                <TileVisibilitySection settings={settingsQ.data} />
              )}
              {effectiveActive === "budget" && aiPlaneEnabled && (
                <AgentBudgetSection settings={settingsQ.data} />
              )}
              {effectiveActive === "userid" && aiPlaneEnabled && (
                <UserIdentifierStrategySection settings={settingsQ.data} />
              )}
              {effectiveActive === "branding" && <BrandingSection settings={settingsQ.data} />}
              {effectiveActive === "reports" && <ReportCadenceSection settings={settingsQ.data} />}
              {effectiveActive === "report-email" && (
                <ReportEmailSection settings={settingsQ.data} />
              )}
              {effectiveActive === "stack" && <StackInventorySection />}
              {effectiveActive === "kev" && <KevBaselineSection settings={settingsQ.data} />}
              {effectiveActive === "geo-fence" && <GeoFenceSection settings={settingsQ.data} />}
              {effectiveActive === "ransomware-intel" && <RansomwareIntelSection />}
            </div>
          </div>
        )}
      </main>
    </>
  );
}

function parseTabParam(raw: string | null): AdminTab | null {
  switch (raw) {
    case "visibility":
    case "budget":
    case "userid":
    case "branding":
    case "reports":
    case "report-email":
    case "stack":
    case "kev":
    case "geo-fence":
    case "ransomware-intel":
      return raw;
    default:
      return null;
  }
}
