// Secure Score dashboard tile (ADR-0012 §2).
//
// - Renders plain-text-only for every Microsoft-authored prose field
//   (`controlScores[].description` is not rendered in this view, but the
//   tile's rendering-safety rule is enforced at the feature boundary).
// - Server-computed `percentage` is used verbatim; no client-side rounding.
// - Skeleton on loading, informative card on empty, warning card on stale,
//   error card on API failure.
//
// Visual surface uses the design-system Tile + HeroStat + FreshnessMeta
// primitives (Phase 2 redesign). Pre-redesign Card scaffold is replaced
// by `<Tile>` with the freshness indicator in the head meta row.

import { useState } from "react";
import { Button, Skeleton, SkeletonItem, Spinner } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { ApiError } from "@/api/client";
import { FreshnessMeta, type FreshnessSegment } from "@/components/FreshnessMeta";
import { HeroStat } from "@/components/HeroStat";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/Tile";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { useSecureScoreLatest, useSecureScoreTrend } from "./queries";
import { deriveBadge, formatRelative } from "./freshness";
import { SecureScoreTrend } from "./SecureScoreTrend";
import { IngestRunHistoryBlock } from "./IngestRunHistoryBlock";

function freshnessSegmentFromIngest(iso: string | null | undefined): FreshnessSegment | null {
  if (!iso) return null;
  const rel = formatRelative(iso).replace(/^(ingested|generated|fired)\s+/i, "");
  return { icon: "clock", label: rel, tone: "accent" };
}

export function SecureScoreTile() {
  const latest = useSecureScoreLatest();
  const trend = useSecureScoreTrend(90);
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/secure-score/run",
    readEndpoint: "/api/secure-score/latest",
    readQueryKey: ["secure-score", "latest"],
    invalidateQueryKeys: [["secure-score"]],
  });

  if (latest.isPending) {
    return (
      <Tile title="Microsoft Secure Score" icon="shield">
        <Skeleton>
          <SkeletonItem size={48} />
          <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
          <SkeletonItem size={48} style={{ marginTop: "var(--sp-s)" }} />
        </Skeleton>
      </Tile>
    );
  }

  if (latest.isError) {
    const err = latest.error as ApiError | Error;
    const correlationId =
      err instanceof ApiError && typeof err.payload === "object" && err.payload !== null
        ? (err.payload as { error?: { correlationId?: string } }).error?.correlationId
        : undefined;
    return (
      <Tile title="Microsoft Secure Score" icon="shield">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load the latest snapshot. {err.message}
        </p>
        {correlationId && (
          <p className="t-caption">
            correlation id: <code>{correlationId}</code>
          </p>
        )}
        <div style={{ marginTop: "var(--sp-m)" }}>
          <Button onClick={() => latest.refetch()}>Retry</Button>
        </div>
      </Tile>
    );
  }

  const data = latest.data;
  const trendData = trend.data?.snapshots ?? [];

  if (!data.snapshot) {
    return (
      <Tile title="Microsoft Secure Score" icon="shield">
        <EmptyState
          status={data.health.status}
          onManualRun={() => void refresh.refresh()}
          isAdmin={refresh.canRefresh}
          ingest={refresh.state}
        />
      </Tile>
    );
  }

  const seg = freshnessSegmentFromIngest(data.snapshot.ingestedAt);

  return (
    <Tile
      title="Microsoft Secure Score"
      icon="shield"
      headMeta={seg ? <FreshnessMeta segments={[seg]} /> : undefined}
      footMeta={
        <>
          Last ingest <strong style={{ color: "var(--fg-2)" }}>{data.snapshot.snapshotDate}</strong>
        </>
      }
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <Link
            to="/secure-score/controls"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            Controls <Icon name="chevron-right" size={11} />
          </Link>
          <Link to="/secure-score" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            Trend <Icon name="chevron-right" size={11} />
          </Link>
          <RefreshNowButton refresh={refresh} ariaLabel="Refresh Microsoft Secure Score now" />
        </span>
      }
    >
      {/* Lead with the percentage to mirror the Microsoft Defender portal's
       *  framing — operators recognise the headline % across both surfaces.
       *  The absolute score moves to caption so a maxScore shift (Microsoft
       *  occasionally re-shapes the control set) stays visible. */}
      <HeroStat
        value={`${data.snapshot.percentage.toFixed(1)}%`}
        caption={`${data.snapshot.currentScore} of ${data.snapshot.maxScore} controls`}
      />
      <span style={visuallyHidden}>
        {`Current Microsoft Secure Score ${data.snapshot.percentage.toFixed(1)} percent (${data.snapshot.currentScore} of ${data.snapshot.maxScore} controls).`}
      </span>
      <div className="trend">
        <SecureScoreTrend data={trendData} ariaLabel={deriveTrendAriaLabel(trendData)} />
      </div>
      {/* Health-derived advisory badge as a banner when present and not
          a success tone — the tile head's freshness meta already covers
          the time signal, so we only surface the badge when it carries
          additional advisory weight. */}
      {(() => {
        const badge = deriveBadge({
          healthStatus: data.health.status,
          ingestedAt: data.snapshot?.ingestedAt ?? null,
        });
        if (!badge || badge.tone === "success") return null;
        const cls =
          badge.tone === "danger"
            ? "banner banner--danger"
            : badge.tone === "warning"
              ? "banner banner--warning"
              : "banner banner--info";
        return (
          <div className={cls} role="status">
            {badge.text}
          </div>
        );
      })()}
    </Tile>
  );
}

function EmptyState({
  status,
  onManualRun,
  isAdmin,
  ingest,
}: {
  status: "awaiting_first_run" | "no_data" | "degrading" | "failing" | string;
  onManualRun: () => void;
  isAdmin: boolean;
  ingest: IngestState;
}) {
  const [showRuns, setShowRuns] = useState(false);
  if (status === "no_data") {
    return <p className="t-body t-body--mute">No Secure Score is published for this tenant yet.</p>;
  }
  const message =
    status === "failing"
      ? "Ingest is failing — no snapshot has been written yet. Admins can retry using Run now."
      : status === "degrading"
        ? "Ingest is retrying after a transient failure — no snapshot yet. Admins can retry sooner using Run now."
        : "Awaiting first ingest run. Next scheduled run: ~03:00 UTC tomorrow.";
  // Run-history expand is only useful when audit lines exist — i.e. the
  // ingest has actually fired. Awaiting-first-run state means the timer
  // hasn't run yet, so there's nothing to show.
  const showRunHistory = isAdmin && (status === "failing" || status === "degrading");
  return (
    <>
      <p className="t-body t-body--mute">{message}</p>
      {isAdmin && (
        <div
          style={{
            marginTop: "var(--sp-m)",
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-s)",
          }}
        >
          <Button appearance="primary" onClick={onManualRun} disabled={ingest.status === "running"}>
            {ingest.status === "running" ? "Running…" : "Run now"}
          </Button>
          {ingest.status === "running" && <Spinner size="tiny" />}
        </div>
      )}
      {ingest.status === "error" && (
        <p className="t-caption" style={{ color: "var(--red-fg)", marginTop: "var(--sp-s)" }}>
          Ingest failed ({ingest.kind}): {ingest.message}
        </p>
      )}
      {ingest.status === "success" && (
        <p className="t-caption" style={{ color: "var(--green-fg)", marginTop: "var(--sp-s)" }}>
          Ingest succeeded — refreshing…
        </p>
      )}
      {showRunHistory && (
        <IngestRunHistoryBlock
          source="secure-score"
          expanded={showRuns}
          onToggle={() => setShowRuns((s) => !s)}
        />
      )}
    </>
  );
}

import type { AdminRefreshState } from "@/features/common/useAdminTileRefresh";
type IngestState = AdminRefreshState;

function deriveTrendAriaLabel(
  data: readonly { snapshotDate: string; currentScore: number }[],
): string {
  if (data.length < 2) return "Secure Score trend unavailable";
  const first = data[0];
  const last = data[data.length - 1];
  if (!first || !last) return "Secure Score trend unavailable";
  const direction =
    last.currentScore > first.currentScore
      ? "increased"
      : last.currentScore < first.currentScore
        ? "decreased"
        : "unchanged";
  return `${data.length}-day trend: current score ${direction} from ${first.currentScore} on ${first.snapshotDate} to ${last.currentScore} on ${last.snapshotDate}.`;
}

const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};
