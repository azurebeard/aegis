// ADR-0037 Layer 5 — dashboard ransomware-intel tile.
//
// Surfaces the per-country tile signal: "N victims this month (Δ vs last
// month), K distinct groups, most recent: <victim>". The Layer 3c Timer
// fires hourly; admins can force a fresh ingest via the Refresh-now
// button (same shared pattern every other populated tile uses).
//
// Empty + degraded states (matches KevTile):
//   - No health row (Timer never fired)  → admin: empty card + Refresh.
//                                          reader: tile hidden.
//   - auth_unavailable (KV secret unseeded) → admin: "configure" hint +
//                                             link to admin section.
//                                             reader: tile hidden.
//   - Healthy + 0 rows this month         → "Quiet this month" message.
//
// Plain-text rendering invariant: the tile only renders the victim NAME
// (`headline` / `victim` field). Both are control-stripped + length-
// capped at Layer 3b parse time. React's default escape closes any
// residual encoding surface.

import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import type { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { HeroStat } from "@/components/HeroStat";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/Tile";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { useRansomwareIntelSummary } from "./queries";

export function RansomwareIntelTile() {
  const user = useCurrentUser();
  const q = useRansomwareIntelSummary();
  const isAdmin = user.hasRole("admin");
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/ransomware-intel/run",
    readEndpoint: "/api/ransomware-intel/summary",
    readQueryKey: ["ransomwareIntel", "summary"],
    invalidateQueryKeys: [["ransomwareIntel"]],
  });

  if (q.isPending) {
    return (
      <Tile title="Ransomware intel" icon="alert">
        <Skeleton>
          <SkeletonItem size={48} />
          <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
        </Skeleton>
      </Tile>
    );
  }

  if (q.isError) {
    const err = q.error as ApiError | Error;
    return (
      <Tile title="Ransomware intel" icon="alert">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load ransomware intel. {err.message}
        </p>
      </Tile>
    );
  }

  const { counts, mostRecentVictim, health, country } = q.data;

  // awaiting_first_run → admin sees "not yet ingested" + Run-now; reader
  // sees nothing (tile auto-hides via this null).
  if (health.status === "awaiting_first_run") {
    if (!isAdmin) return null;
    return (
      <Tile title="Ransomware intel" icon="alert">
        <p className="t-body t-body--mute">
          Ransomware.live ingest has not run yet for <strong>{country}</strong>. The hourly Timer
          will fire on the next top-of-hour, or refresh now.
        </p>
        <div style={{ marginTop: "var(--sp-m)" }}>
          <RefreshNowButton refresh={refresh} ariaLabel="Run ransomware intel ingest now" />
        </div>
      </Tile>
    );
  }

  // Persistent failure → admin sees the status + a hint pointing to
  // admin section (where the operator can read the latest error.kind from
  // Notifications). Reader sees the tile but with a muted "feed
  // unavailable" message — no counts, no link.
  if (health.status === "failing" || health.status === "degrading") {
    return (
      <Tile title="Ransomware intel" icon="alert">
        <p className="t-body t-body--mute">
          The ransomware intel feed is currently <strong>{health.status}</strong>.
          {isAdmin && (
            <>
              {" "}
              <Link to="/admin?section=ransomware-intel">Open admin settings</Link> to diagnose, or
              refresh below.
            </>
          )}
        </p>
        {isAdmin && (
          <div style={{ marginTop: "var(--sp-m)" }}>
            <RefreshNowButton refresh={refresh} ariaLabel="Retry ransomware intel ingest now" />
          </div>
        )}
      </Tile>
    );
  }

  const tone = counts.victimsThisMonth > 0 ? "warning" : "success";

  return (
    <Tile
      title="Ransomware intel"
      icon="alert"
      footMeta={
        <>
          {country}
          {health.lastSuccessAt && <> · synced {formatRelative(health.lastSuccessAt)}</>}
        </>
      }
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <Link to="/ransomware" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            Open <Icon name="chevron-right" size={11} />
          </Link>
          {isAdmin && (
            <RefreshNowButton refresh={refresh} ariaLabel="Refresh ransomware intel now" />
          )}
        </span>
      }
    >
      {counts.victimsThisMonth === 0 && counts.pressThisMonth === 0 ? (
        <>
          <HeroStat value="0" caption={`victims in ${country} this month`} />
          <p className="t-caption" style={{ marginTop: "var(--sp-s)" }}>
            {counts.victimsPriorMonth} prior month · {counts.pressPriorMonth} press article
            {counts.pressPriorMonth === 1 ? "" : "s"}
          </p>
        </>
      ) : (
        <>
          <HeroStat
            value={String(counts.victimsThisMonth)}
            caption={`victim${counts.victimsThisMonth === 1 ? "" : "s"} in ${country} this month`}
          />
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: "var(--sp-s)" }}>
            <span className={`badge badge--${tone}`}>
              {counts.distinctGroupsThisMonth} distinct group
              {counts.distinctGroupsThisMonth === 1 ? "" : "s"}
            </span>
            {counts.pressThisMonth > 0 && (
              <span className="badge">
                {counts.pressThisMonth} press article
                {counts.pressThisMonth === 1 ? "" : "s"}
              </span>
            )}
            {counts.victimsPriorMonth > 0 && (
              <span className="badge badge--mute">vs {counts.victimsPriorMonth} last month</span>
            )}
          </div>
          {mostRecentVictim && (
            <p className="t-caption" style={{ marginTop: "var(--sp-s)" }}>
              Latest: <strong>{mostRecentVictim.victim}</strong> · {mostRecentVictim.group}
            </p>
          )}
        </>
      )}
    </Tile>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
