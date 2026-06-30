// ADR-0032 — dashboard KEV tile.
//
// Surfaces the cross-reference signal: "X CVEs across Y items, Z due this
// week". Hides itself for readers when the catalog has nothing or no
// stack items match — admins always see it so they can spot ingest
// failures or empty inventories.

import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import type { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { HeroStat } from "@/components/HeroStat";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/Tile";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { useKevSummary } from "./queries";

export function KevTile() {
  const user = useCurrentUser();
  const q = useKevSummary();
  const isAdmin = user.hasRole("admin");
  // Admin "Refresh now" wiring — daily Timer is the primary loader, but
  // operators occasionally need to force a fresh CISA KEV pull (catalog
  // change after a high-profile disclosure). `/api/ingest/kev/run` is the
  // shared admin-trigger endpoint; the hook invalidates the kev cache so
  // the tile + /kev page reflect the new catalog snapshot post-run.
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/kev/run",
    readEndpoint: "/api/kev/summary",
    readQueryKey: ["kev", "summary"],
    invalidateQueryKeys: [["kev"]],
  });

  if (q.isPending) {
    return (
      <Tile title="KEV exposure" icon="alert">
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
      <Tile title="KEV exposure" icon="alert">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load KEV summary. {err.message}
        </p>
      </Tile>
    );
  }

  const { catalog, matches, health } = q.data;
  // ADR-0033 — prefer the per-status `open` count if the server is
  // Phase-2-aware. Falls back to `totalPairs` for older servers.
  const openCount = matches.open ?? matches.totalPairs;

  // No catalog yet (KEV ingest never run / failing) → admin sees an
  // explicit empty state with a Run-now button, reader sees the tile hidden.
  if (catalog.totalEntries === 0) {
    if (!isAdmin) return null;
    return (
      <Tile title="KEV exposure" icon="alert">
        <p className="t-body t-body--mute">
          KEV catalog has not been ingested yet. The daily Timer fires at 02:00 UTC.
        </p>
        {health.status && (
          <p className="t-caption">
            Ingest status: <strong>{health.status}</strong>
          </p>
        )}
        <div style={{ marginTop: "var(--sp-m)" }}>
          <RefreshNowButton refresh={refresh} ariaLabel="Run KEV ingest now" />
        </div>
      </Tile>
    );
  }

  // Catalog present but no open matches → reader sees a clean "no
  // exposure" state. ADR-0033: tone reflects open queue urgency.
  const tone = matches.dueThisWeek > 0 ? "danger" : openCount > 0 ? "warning" : "success";

  return (
    <Tile
      title="KEV exposure"
      icon="alert"
      footMeta={
        <>
          {catalog.totalEntries.toLocaleString()} CVEs in catalog
          {health.lastSuccessAt && <> · synced {formatRelative(health.lastSuccessAt)}</>}
        </>
      }
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <Link to="/kev" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            Open <Icon name="chevron-right" size={11} />
          </Link>
          {isAdmin && <RefreshNowButton refresh={refresh} ariaLabel="Refresh KEV catalog now" />}
        </span>
      }
    >
      {openCount === 0 && matches.totalPairs === 0 ? (
        <>
          <HeroStat value="0" caption="known-exploited CVEs in your stack" />
          <p className="t-body t-body--mute" style={{ marginTop: "var(--sp-s)" }}>
            No CISA KEV entries match your registered stack inventory.
          </p>
        </>
      ) : openCount === 0 ? (
        <>
          <HeroStat value="0" caption="open · all matches handled" />
          <p className="t-caption" style={{ marginTop: "var(--sp-s)" }}>
            {matches.totalPairs} historical match{matches.totalPairs === 1 ? "" : "es"} — see /kev
            for the resolved cohort.
          </p>
        </>
      ) : (
        <>
          <HeroStat
            value={String(openCount)}
            caption={`open · across ${matches.matchedItemCount} stack item${
              matches.matchedItemCount === 1 ? "" : "s"
            }`}
          />
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: "var(--sp-s)" }}>
            <span className={`badge badge--${tone}`}>{matches.dueThisWeek} due this week</span>
          </div>
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
