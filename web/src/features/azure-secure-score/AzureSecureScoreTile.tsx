// ADR-0036 — dashboard tile for Defender for Cloud Secure Score.
//
// Hero: percentage of the (single, in v1) tracked subscription.
// Caption: score / max + subscription name.
// Sub-meta: snapshot date + consecutive-failure indicator if ingest is
// degrading.
// Refresh-now: admin only — same useAdminTileRefresh pattern as KevTile.

import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import type { ApiError } from "@/api/client";
import { HeroStat } from "@/components/HeroStat";
import { Tile } from "@/components/Tile";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { AzureSecureScoreTrend } from "./AzureSecureScoreTrend";
import { useAzureSecureScoreSummary } from "./queries";

export function AzureSecureScoreTile() {
  const q = useAzureSecureScoreSummary();
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/azure-secure-score/run",
    readEndpoint: "/api/azure-secure-score/summary",
    readQueryKey: ["azure-secure-score", "summary"],
    invalidateQueryKeys: [["azure-secure-score"]],
  });

  if (q.isPending) {
    return (
      <Tile title="Defender for Cloud Secure Score" icon="shield">
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
      <Tile title="Defender for Cloud Secure Score" icon="shield">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load. {err.message}
        </p>
      </Tile>
    );
  }

  const subs = q.data.subscriptions;
  if (subs.length === 0) {
    return (
      <Tile
        title="Defender for Cloud Secure Score"
        icon="shield"
        footAction={
          <RefreshNowButton refresh={refresh} ariaLabel="Run Defender for Cloud ingest now" />
        }
      >
        <p className="t-body t-body--mute">
          Awaiting first ingest. Daily Timer fires at 02:30 UTC; admins can force a run with the
          button below.
        </p>
      </Tile>
    );
  }

  // v1 single-subscription rendering. Multi-sub becomes a list view in v2.
  const sub = subs[0]!;
  const latest = sub.latest;

  return (
    <Tile
      title="Defender for Cloud Secure Score"
      icon="shield"
      footMeta={
        <>
          {sub.subscriptionName} · snapshot {latest.snapshotDate}
        </>
      }
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <RefreshNowButton
            refresh={refresh}
            ariaLabel="Refresh Defender for Cloud Secure Score now"
          />
        </span>
      }
    >
      <HeroStat
        value={`${latest.percentage.toFixed(1)}%`}
        caption={`${latest.currentScore.toFixed(1)} of ${latest.maxScore} points`}
      />
      <div className="trend">
        <AzureSecureScoreTrend
          data={sub.trend}
          ariaLabel={`Defender for Cloud Secure Score trend, ${sub.trend.length} daily snapshots`}
        />
      </div>
    </Tile>
  );
}
