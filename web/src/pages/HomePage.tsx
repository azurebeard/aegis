import { Link } from "react-router-dom";
import { Link as FluentLink } from "@fluentui/react-components";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { PageSubheader } from "@/components/shell/PageSubheader";
import { AzureSecureScoreTile } from "@/features/azure-secure-score/AzureSecureScoreTile";
import { BriefTile } from "@/features/brief/BriefTile";
import { useDashboardFreshness } from "@/features/common/DashboardFreshness";
import { ConditionalAccessTile } from "@/features/conditional-access/ConditionalAccessTile";
import { IncidentsTile } from "@/features/incidents/IncidentsTile";
import { PostureTile } from "@/features/posture/PostureTile";
import { KevTile } from "@/features/kev/KevTile";
import { RansomwareIntelTile } from "@/features/ransomware/RansomwareIntelTile";
import { RiskyUsersTile } from "@/features/risky-users/RiskyUsersTile";
import { SignInsTile } from "@/features/sign-ins/SignInsTile";
import { UserDormancyTile } from "@/features/user-dormancy/UserDormancyTile";
import { SecureScoreTile } from "@/features/secureScore/SecureScoreTile";
import { StackTile } from "@/features/stack/StackTile";
import { useTenantSettings } from "@/features/settings/queries";

// ADR-0035 Phase D2 hygiene — pre-sign-in rendering is split out so the
// dashboard hooks (useTenantSettings, useDashboardFreshness, every tile's
// own query) DO NOT mount for unauthenticated visitors. Pre-D2 SWA Easy
// Auth redirected anonymous traffic to the IdP so this case never
// surfaced; post-D2 the SPA stays mounted while signed-out.
//
// Two-component split is deliberate: hooks must be called unconditionally
// in React, so the only way to suspend them is to NOT render the hosting
// component at all. The PageSubheader "Dashboard" framing is also held
// behind sign-in so the landing page doesn't pretend there's content
// behind the sign-in card.

export function HomePage() {
  const user = useCurrentUser();

  if (user.isLoading) {
    // MSAL still resolving (handleRedirectPromise + active-account pin).
    // Render nothing rather than flash the unauth state then re-render.
    return null;
  }

  if (!user.isAuthenticated) {
    return (
      <main className="app-main">
        <div className="surface" style={{ padding: "var(--sp-xl)", maxWidth: 720 }}>
          <p className="t-body">
            <FluentLink as="button" onClick={() => void signIn("/")}>
              Sign in with Entra ID
            </FluentLink>{" "}
            to view the dashboard.
          </p>
        </div>
      </main>
    );
  }

  return <AuthenticatedDashboard />;
}

function AuthenticatedDashboard() {
  const user = useCurrentUser();
  // Tile visibility (ADR-0025 Phase 1 + 2). `effectiveVisibility` is the
  // server-derived shape: `visibility && capability !== "licence_required"`.
  // Falls back to `tileVisibility` for safety if an old API response omits
  // the Phase 2 field. Defaults render all four tiles until the settings
  // query resolves — the default shape matches what the store returns for a
  // missing row, so there's no "everything flashes, then hides" on first
  // paint. A disabled tile doesn't mount at all, so its own data query
  // never fires.
  const settings = useTenantSettings();
  const visibility = settings.data?.effectiveVisibility ??
    settings.data?.tileVisibility ?? {
      brief: true,
      secureScore: true,
      incidents: true,
      riskyUsers: true,
      posture: true,
      stack: true,
      kev: true,
      userDormancy: true,
      signIns: true,
      conditionalAccess: true,
      azureSecureScore: true,
      ransomwareIntel: true,
    };
  // HANDOVER §6.3 `deployAiAgents` — strict `=== true` since
  // SEC-INFO-DAAA-02 resolution. The field is server-required;
  // the only path returning a falsy value here is the brief settings-
  // loading window, during which we suppress AI tiles rather than render
  // them and re-hide them on first paint. BriefTile + PostureTile
  // short-circuit at this gate so the corresponding query handlers never
  // fire when the AI plane is disabled.
  const aiPlaneEnabled = settings.data?.aiPlaneEnabled === true;
  const showBrief = visibility.brief && aiPlaneEnabled;
  const showPosture = visibility.posture && aiPlaneEnabled;
  const anyVisible =
    showBrief ||
    visibility.secureScore ||
    visibility.incidents ||
    visibility.riskyUsers ||
    visibility.userDormancy ||
    visibility.signIns ||
    showPosture ||
    visibility.stack ||
    visibility.kev ||
    visibility.conditionalAccess ||
    visibility.azureSecureScore ||
    visibility.ransomwareIntel;
  // Dashboard-wide freshness — derived from the same query cache as the
  // tiles, surfaced via PageSubheader. Returns null when nothing is loaded
  // yet (PageSubheader hides the freshness pulse when the prop is absent).
  const freshness = useDashboardFreshness();

  return (
    <>
      <PageSubheader
        title="Dashboard"
        sub="Single-tenant Microsoft Defender XDR overview."
        {...(freshness ? { freshness } : {})}
      />
      <main className="app-main">
        {anyVisible &&
          // Asymmetric 2:1 dashboard grid: AI narratives 2fr left,
          // number tiles 1fr right. Below 1100px the grid collapses to
          // 1-column (CSS in `aegis.css#dash-grid` handles the breakpoint).
          // When BOTH narrative tiles are hidden (deployAiAgents=false +
          // tile-visibility off) we drop the left column to single-col so
          // the number tiles still fill the canvas.
          (() => {
            const hasNarrative = showBrief || showPosture;
            const numberTiles = (
              <>
                {visibility.secureScore && <SecureScoreTile />}
                {visibility.incidents && <IncidentsTile />}
                {visibility.riskyUsers && <RiskyUsersTile />}
                {visibility.userDormancy && <UserDormancyTile />}
                {visibility.signIns && <SignInsTile />}
                {visibility.stack && <StackTile />}
                {visibility.kev && <KevTile />}
                {visibility.conditionalAccess && <ConditionalAccessTile />}
                {visibility.azureSecureScore && <AzureSecureScoreTile />}
                {visibility.ransomwareIntel && <RansomwareIntelTile />}
              </>
            );
            if (!hasNarrative) {
              return (
                <div className="dash-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                  {numberTiles}
                </div>
              );
            }
            return (
              <div className="dash-grid">
                <div className="dash-col">
                  {showBrief && <BriefTile />}
                  {showPosture && <PostureTile />}
                </div>
                <div className="dash-col">{numberTiles}</div>
              </div>
            );
          })()}

        {!anyVisible && (
          <div className="surface" style={{ padding: "var(--sp-xl)", maxWidth: 720 }}>
            <p className="t-body">
              All tiles are disabled for this tenant.
              {user.hasRole("admin") ? (
                <>
                  {" "}
                  Open <Link to="/admin">Admin settings</Link> to re-enable one.
                </>
              ) : (
                " Ask an admin to re-enable a tile in Admin settings."
              )}
            </p>
          </div>
        )}
      </main>
    </>
  );
}
