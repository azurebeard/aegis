// Sign-ins dashboard tile (ADR-0034 §3.2).
//
// Hero stat: out-of-area count over last 24h. Caption: total today + CA
// failures. Licence_required dedicated empty state ("Entra ID P1 required").
// Plain-text-only rendering throughout (ADR-0012 §5).

import { Button, Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import type { ApiError } from "@/api/client";
import { HeroStat } from "@/components/HeroStat";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/Tile";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { useSignInsSummary } from "./queries";

const LEARN_MORE_URL =
  "https://learn.microsoft.com/en-us/entra/identity/monitoring-health/concept-sign-ins";

export function SignInsTile() {
  const summary = useSignInsSummary();
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/sign-ins/run",
    readEndpoint: "/api/sign-ins/summary",
    readQueryKey: ["sign-ins", "summary"],
    invalidateQueryKeys: [["sign-ins"]],
  });

  if (summary.isPending) {
    return (
      <Tile title="Sign-ins" icon="user">
        <Skeleton>
          <SkeletonItem size={48} />
          <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
        </Skeleton>
      </Tile>
    );
  }
  if (summary.isError) {
    const err = summary.error as ApiError | Error;
    return (
      <Tile title="Sign-ins" icon="user">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load sign-ins. {err.message}
        </p>
        <div style={{ marginTop: "var(--sp-m)" }}>
          <Button onClick={() => summary.refetch()}>Retry</Button>
        </div>
      </Tile>
    );
  }
  const data = summary.data;
  if (data.health.status === "licence_required") {
    return (
      <Tile
        title="Sign-ins"
        icon="user"
        headMeta={<span className="badge badge--warning">Entra ID P1 required</span>}
      >
        <p className="t-body">Upgrade to unlock the sign-in audit log and geo-fence alerting.</p>
        <p className="t-caption" style={{ marginTop: "var(--sp-s)" }}>
          <a href={LEARN_MORE_URL} target="_blank" rel="noreferrer noopener">
            Learn more →
          </a>
        </p>
      </Tile>
    );
  }
  const counts = data.counts;
  if (!counts || counts.totalToday === 0) {
    return (
      <Tile title="Sign-ins" icon="user">
        <p className="t-body t-body--mute">
          {data.health.status === "awaiting_first_run"
            ? "Awaiting first sign-ins ingest run."
            : data.health.status === "failing"
              ? "Ingest is failing — no sign-in data has been written yet."
              : "No sign-ins recorded in the last 24h."}
        </p>
        <div style={{ marginTop: "var(--sp-m)" }}>
          <RefreshNowButton refresh={refresh} ariaLabel="Run sign-ins ingest now" />
        </div>
      </Tile>
    );
  }
  // Hero is the OutOfArea count when geo-fence is enabled, else fall back
  // to total today (still informative when policy is disabled).
  const policy = data.policy;
  const fenceEnabled = policy?.enabled === true;
  const heroValue = fenceEnabled ? String(counts.outOfAreaToday) : String(counts.totalToday);
  const heroSub = fenceEnabled
    ? `out-of-area (last 24h) · ${counts.totalToday} total · ${counts.caFailuresToday} CA failures`
    : `total (last 24h) · ${counts.caFailuresToday} CA failures · geo-fence disabled`;

  return (
    <Tile
      title="Sign-ins"
      icon="user"
      headMeta={
        fenceEnabled ? (
          <span className="badge badge--info">
            Geo-fence: {policy.allowedCountries.length}{" "}
            {policy.allowedCountries.length === 1 ? "country" : "countries"}
          </span>
        ) : undefined
      }
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <Link to="/sign-ins" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            Open list <Icon name="chevron-right" size={11} />
          </Link>
          <RefreshNowButton refresh={refresh} ariaLabel="Refresh sign-ins now" />
        </span>
      }
    >
      <HeroStat value={heroValue} caption={heroSub} />
      {data.mostRecentOutOfArea && (
        <p className="t-caption" style={{ marginTop: "var(--sp-s)" }}>
          Most-recent out-of-area: <strong>{data.mostRecentOutOfArea.userPrincipalName}</strong>{" "}
          from {data.mostRecentOutOfArea.country.toUpperCase() || "unknown"}
          {" · "}
          {new Date(data.mostRecentOutOfArea.createdDateTime).toLocaleString()}
        </p>
      )}
    </Tile>
  );
}
