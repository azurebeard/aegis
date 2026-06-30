// PageSubheader — title + subtitle + freshness pulse + page-level actions.
// Renders BELOW the AppHeader, ABOVE the page main content. Pattern source:
// `docs/ui-pack/aegis-ui-snapshot.html` + the Claude Design redesign.
//
// Each route declares its own page-subheader inside its component, allowing
// surface-specific copy + actions while sharing the same shell/spacing. The
// freshness pulse is the dashboard-wide signal that the data is current —
// uses the same pattern as the legacy `DashboardFreshness` component but
// with the design's pulse-dot affordance.

import type { ReactNode } from "react";

interface PageSubheaderProps {
  readonly title: string;
  readonly sub?: string | ReactNode;
  readonly freshness?: string;
  /** When the freshness exceeds the per-source ceiling, render with the
   *  warning tone (orange dot + halo) instead of the default success tone. */
  readonly stale?: boolean;
  readonly children?: ReactNode;
}

export function PageSubheader({
  title,
  sub,
  freshness,
  stale,
  children,
}: PageSubheaderProps): React.ReactElement {
  return (
    <div className="page-subheader">
      <div className="page-subheader__inner">
        <div>
          <h1 className="page-subheader__title">{title}</h1>
          {sub && <p className="page-subheader__sub">{sub}</p>}
        </div>
        <div className="page-subheader__actions">
          {freshness && (
            <span className={`freshness ${stale ? "freshness--stale" : ""}`}>
              <span className="freshness__dot" />
              <span>
                Refreshed <strong style={{ color: "var(--fg-1)" }}>{freshness}</strong>
              </span>
            </span>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
