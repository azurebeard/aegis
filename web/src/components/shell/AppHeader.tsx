// AppHeader — sticky 48px brand band that anchors product identity and
// primary navigation. Replaces the Card-as-header pattern from the
// pre-redesign HomePage. Pattern source: `docs/ui-pack/aegis-ui-snapshot.html`
// + the Claude Design redesign (chat 2026-04-26 → "Option C: compact
// Fluent header" per the user's choice).
//
// Layered controls (left → right):
//   Brand mark + product name → Fluent TabList (animated underline) →
//   spacer → ToolbarButtons (theme / help / notifications-with-CounterBadge)
//   → vertical divider → Persona MenuButton (avatar + name + tenant + chevron).
//
// Implementation notes:
// - We render plain HTML + the design-system classes (`.app-header`,
//   `.fui-tablist`, `.fui-toolbar-btn`, `.fui-persona-button`) instead of
//   Fluent React components. The visual contract matches Fluent v9 — same
//   tokens, sizes, hover/active/focus rules — but the markup is simpler
//   and routing is via react-router. ADR-0029 brand-ramp seed flows into
//   the header via the global `--brand-fg` CSS variable that
//   `BrandingProvider` writes onto `<html>`.
// - The selection indicator under the active tab uses a single absolutely-
//   positioned span that translates between tab bounding boxes; matches
//   Fluent's TabList canonical animation.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { useBranding } from "@/features/branding/BrandingProvider";
import { Icon } from "@/components/Icon";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import {
  countUnread,
  useNotifications,
  useNotificationsLastSeen,
} from "@/features/common/notifications";

interface TabBase {
  readonly id: string;
  readonly label: string;
  /** When true, only show the tab to users that hold the `admin` role.
   *  Non-admins clicking through would otherwise hit the AdminSettingsPage
   *  redirect and see a brief Spinner before bouncing back to `/` —
   *  surfacing that path-not-available cycle as a broken-feature impression
   *  for reader-only operators. */
  readonly adminOnly?: boolean;
}

interface TabLeaf extends TabBase {
  readonly kind: "leaf";
  /** First-segment path the tab maps to. The `dashboard` tab matches `/`. */
  readonly path: string;
}

interface TabMenu extends TabBase {
  readonly kind: "menu";
  /** Children rendered as a popover menu under the parent tab. The menu
   *  itself never navigates — clicking the parent toggles the popover. */
  readonly children: readonly TabLeaf[];
}

type Tab = TabLeaf | TabMenu;

export const TABS: readonly Tab[] = [
  { kind: "leaf", id: "dashboard", label: "Dashboard", path: "/" },
  { kind: "leaf", id: "incidents", label: "Incidents", path: "/incidents" },
  {
    kind: "menu",
    id: "solutions",
    label: "Solutions",
    children: [
      { kind: "leaf", id: "identities", label: "Identities", path: "/identities" },
      { kind: "leaf", id: "risky-users", label: "Risky users", path: "/risky-users" },
      { kind: "leaf", id: "kev", label: "KEV", path: "/kev" },
      { kind: "leaf", id: "reports", label: "Reports", path: "/reports" },
      {
        kind: "leaf",
        id: "secure-score-controls",
        label: "Microsoft Secure Score controls",
        path: "/secure-score/controls",
      },
      { kind: "leaf", id: "user-dormancy", label: "Dormant users", path: "/user-dormancy" },
      { kind: "leaf", id: "sign-ins", label: "Sign-ins", path: "/sign-ins" },
      { kind: "leaf", id: "ransomware", label: "Ransomware intel", path: "/ransomware" },
    ],
  },
  { kind: "leaf", id: "admin", label: "Admin", path: "/admin", adminOnly: true },
];

/** Map a pathname to the active tab id. `/` is the dashboard root. Menu
 *  tabs return THEIR id when any child path matches — so the indicator
 *  highlights the parent menu tab while the operator is on a child page.
 *  Unknown paths leave the indicator hidden. */
function activeTabFromPath(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return "dashboard";
  for (const t of TABS) {
    if (t.kind === "leaf") {
      if (t.path !== "/" && pathname.startsWith(t.path)) return t.id;
      continue;
    }
    for (const c of t.children) {
      if (pathname.startsWith(c.path)) return t.id;
    }
  }
  return null;
}

interface AppHeaderProps {
  /** Optional callback to open the ⌘K command palette — wired from Layout. */
  readonly onOpenCommandPalette?: () => void;
}

export function AppHeader({ onOpenCommandPalette }: AppHeaderProps = {}): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const { productName, resolvedTheme, cycleTheme, userPreference, tenantDefaultTheme } =
    useBranding();
  // Filter the static TABS list against the current user's auth state +
  // roles. Hide every nav tab from unauthenticated visitors — pre-sign-in
  // only the brand mark + Sign-in CTA should be visible (ADR-0035 Phase D2
  // hygiene; pre-D2 SWA Easy Auth redirected unauth visitors so this case
  // never surfaced). Hide adminOnly tabs from non-admins so a reader doesn't
  // see a navigation affordance they can't follow through. Filter happens
  // at render time; role data is observed via useCurrentUser, so a role
  // grant during the session re-renders the tablist on the next refetch.
  const visibleTabs = user.isAuthenticated
    ? TABS.filter((t) => !t.adminOnly || user.hasRole("admin"))
    : [];

  // Solutions menu popover state. The dropdown anchors to the parent tab
  // via absolute positioning; click-outside + Esc both close it. The menu
  // is keyboard-accessible: Enter on the parent toggles, item buttons get
  // focus on Tab, Enter/Space activates and navigates.
  const [solutionsOpen, setSolutionsOpen] = useState(false);
  const solutionsAnchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!solutionsOpen) return undefined;
    const handler = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent && e.key === "Escape") {
        setSolutionsOpen(false);
        return;
      }
      if (e instanceof MouseEvent) {
        const anchor = solutionsAnchorRef.current;
        if (anchor && !anchor.contains(e.target as Node)) setSolutionsOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", handler);
    };
  }, [solutionsOpen]);

  // Notifications popover state. The panel anchors to the bell button via
  // absolute positioning; click-outside + Esc both close it. Unread count
  // drives the badge dot. Query disabled pre-sign-in so unauthenticated
  // visitors don't generate /api/notifications 401s on the 60 s polling
  // interval (ADR-0035 Phase D2 hygiene).
  const notif = useNotifications({ enabled: user.isAuthenticated });
  const { lastSeenAt, markAllRead } = useNotificationsLastSeen();
  const [notifOpen, setNotifOpen] = useState(false);
  const notifAnchorRef = useRef<HTMLDivElement>(null);
  const unread = countUnread(notif.data?.notifications ?? [], lastSeenAt);

  useEffect(() => {
    if (!notifOpen) return undefined;
    const handler = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent && e.key === "Escape") {
        setNotifOpen(false);
        return;
      }
      if (e instanceof MouseEvent) {
        const anchor = notifAnchorRef.current;
        if (anchor && !anchor.contains(e.target as Node)) {
          setNotifOpen(false);
        }
      }
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", handler);
    };
  }, [notifOpen]);
  const active = activeTabFromPath(location.pathname);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  });

  // Re-measure the active tab on selection change OR window resize so the
  // underline indicator stays glued to the right column. layoutEffect
  // keeps it in the same paint as the tab change.
  useLayoutEffect(() => {
    const measure = () => {
      if (!active) {
        setIndicator((p) => ({ ...p, ready: false }));
        return;
      }
      const el = tabRefs.current[active];
      if (!el) return;
      // Walk up to .fui-tablist explicitly — the menu-tab variant wraps
      // the button in a .fui-tab-anchor positioning context, so el's
      // direct parent is no longer the tablist.
      const parent = el.closest(".fui-tablist") as HTMLElement | null;
      if (!parent) return;
      const pRect = parent.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      // Inset 10px each side so the underline aligns with the tab text,
      // not the full hit-target padding (matches Fluent's TabList visual).
      setIndicator({
        left: eRect.left - pRect.left + 10,
        width: eRect.width - 20,
        ready: true,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active]);

  // Theme-toggle UX: cycle system → light → dark → system. Tooltip
  // surfaces the current state so operators can predict the next click.
  const themeIcon =
    userPreference === "dark"
      ? "moon"
      : userPreference === "system" || userPreference === null
        ? "system"
        : "sun";
  const themeLabel =
    userPreference === null
      ? `Following ${tenantDefaultTheme === "system" ? "system" : tenantDefaultTheme} (current: ${resolvedTheme}). Click to override.`
      : userPreference === "dark"
        ? "Dark theme — click for system"
        : userPreference === "system"
          ? "System theme — click for light"
          : "Light theme — click for dark";

  // Avatar initials from userDetails. Two letters, uppercased, takes first
  // letter of each whitespace-separated token, falling back to first two
  // chars of the raw string.
  const initials = (() => {
    const detail = user.principal?.userDetails ?? "";
    const tokens = detail.split(/[\s@.-]+/).filter(Boolean);
    if (tokens.length >= 2) return (tokens[0]![0]! + tokens[1]![0]!).toUpperCase();
    if (tokens.length === 1) return tokens[0]!.slice(0, 2).toUpperCase();
    return "??";
  })();
  // Pick a primary + secondary line for the persona button. Primary = the
  // first token of userDetails (typically the name); secondary = the
  // tenant subdomain extracted from the email-shaped userDetails.
  const primary = (user.principal?.userDetails ?? "").split(/[@.\s]/)[0] ?? "?";
  const tenantHost = (user.principal?.userDetails ?? "").split("@")[1] ?? "";
  const secondary = tenantHost.replace(/\.onmicrosoft\.com$/i, "") || "tenant";

  return (
    <header className="app-header" role="banner">
      <div className="app-header__inner">
        <div className="app-header__brand">
          <span className="app-header__logo" aria-hidden="true">
            {productName.slice(0, 1).toUpperCase()}
          </span>
          <span>{productName}</span>
        </div>

        {/* Fluent v9 TabList (appearance="subtle") — single animated indicator */}
        <div className="fui-tablist" role="tablist" aria-label="Primary navigation">
          {visibleTabs.map((t) => {
            const sel = active === t.id;
            if (t.kind === "leaf") {
              return (
                <button
                  key={t.id}
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  role="tab"
                  aria-selected={sel}
                  tabIndex={sel ? 0 : -1}
                  className={`fui-tab ${sel ? "is-selected" : ""}`}
                  onClick={() => navigate(t.path)}
                  type="button"
                >
                  <span className="fui-tab__content">{t.label}</span>
                </button>
              );
            }
            // Menu tab — popover dropdown of child leaves.
            const open = t.id === "solutions" && solutionsOpen;
            return (
              <div
                key={t.id}
                className="fui-tab-anchor"
                ref={t.id === "solutions" ? solutionsAnchorRef : undefined}
              >
                <button
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  role="tab"
                  aria-selected={sel}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  tabIndex={sel ? 0 : -1}
                  className={`fui-tab fui-tab--menu ${sel ? "is-selected" : ""}`}
                  onClick={() => setSolutionsOpen((o) => !o)}
                  type="button"
                >
                  <span className="fui-tab__content">
                    {t.label}
                    <Icon name="chevron-down" size={11} />
                  </span>
                </button>
                {open && (
                  <div className="fui-tab-menu" role="menu" aria-label={`${t.label} menu`}>
                    {t.children.map((c) => (
                      <button
                        key={c.id}
                        role="menuitem"
                        type="button"
                        className="fui-tab-menu__item"
                        onClick={() => {
                          setSolutionsOpen(false);
                          navigate(c.path);
                        }}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <span
            className={`fui-tablist__indicator ${indicator.ready ? "is-ready" : ""}`}
            style={{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }}
            aria-hidden="true"
          />
        </div>

        <div className="app-header__spacer" />

        <div className="app-header__util">
          {/* Discoverability button for the ⌘K palette — the kbd hint
              inside makes the keyboard binding visible without occupying
              additional pixels. Click and keyboard both invoke the same
              toggle so muscle-memory either way works. Hidden pre-sign-in
              because every command targets an authenticated route. */}
          {user.isAuthenticated && onOpenCommandPalette && (
            <button
              className="fui-toolbar-btn fui-toolbar-btn--cmdk"
              title="Open command palette (⌘K)"
              aria-label="Open command palette"
              type="button"
              onClick={onOpenCommandPalette}
            >
              <Icon name="search" size={14} />
              <kbd className="fui-toolbar-btn__kbd">⌘K</kbd>
            </button>
          )}
          <button
            className="fui-toolbar-btn"
            title={themeLabel}
            onClick={cycleTheme}
            aria-label={themeLabel}
            type="button"
          >
            <Icon name={themeIcon} size={16} />
          </button>
          <button className="fui-toolbar-btn" title="Help" aria-label="Help" type="button">
            <Icon name="help" size={16} />
          </button>
          {/* Notifications popover. Aggregates ingest failures, agent
              circuit-breaker trips, and recent settings changes from
              `/api/notifications`; mark-as-read is client-side via
              localStorage (notifications.useNotificationsLastSeen).
              Hidden pre-sign-in — the underlying query is also gated by
              `enabled: user.isAuthenticated` so no /api/notifications
              401s on the polling interval. */}
          {user.isAuthenticated && (
            <div className="fui-toolbar-anchor" ref={notifAnchorRef}>
              <button
                className="fui-toolbar-btn"
                title={unread > 0 ? `Notifications · ${unread} unread` : "Notifications"}
                aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={notifOpen}
                onClick={() => setNotifOpen((o) => !o)}
              >
                <Icon name="bell" size={16} />
                {unread > 0 && (
                  <span className="fui-toolbar-btn__badge" aria-hidden="true">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </button>
              {notifOpen && (
                <NotificationsPanel
                  onClose={() => setNotifOpen(false)}
                  onMarkAllRead={markAllRead}
                  lastSeenAt={lastSeenAt}
                />
              )}
            </div>
          )}

          <span className="app-header__divider" aria-hidden="true" />

          {/* Fluent MenuButton + Persona — avatar + 2-line meta + chevron.
              The link target is /admin if the user is admin, else the
              ping diagnostic for everyone else. Click handler routes via
              react-router so the back-button history is maintained. */}
          {user.isAuthenticated ? (
            <Link
              to={user.hasRole("admin") ? "/admin" : "/ping"}
              className="fui-persona-button"
              aria-haspopup="menu"
              aria-label={`Account, ${primary} on ${secondary} tenant`}
            >
              <span className="fui-persona">
                <span className="fui-persona__avatar">
                  <span className="fui-persona__avatar-initials">{initials}</span>
                  <span className="fui-persona__presence" aria-hidden="true" />
                </span>
                <span className="fui-persona__text">
                  <span className="fui-persona__primary">{primary}</span>
                  <span className="fui-persona__secondary">{secondary}</span>
                </span>
              </span>
              <Icon name="chevron-down" size={12} />
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => void signIn("/")}
              className="fui-persona-button"
              aria-label="Sign in with Entra ID"
            >
              <span className="fui-persona">
                <span className="fui-persona__text">
                  <span className="fui-persona__primary">Sign in</span>
                </span>
              </span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

// Re-export hook for downstream re-mount tests.
export const __test__ = { activeTabFromPath };
