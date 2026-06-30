// Risky Users dashboard tile (ADR-0024 §1.1).
//
// Risk-level count grid + most-recent + health/freshness badge +
// dedicated `licence_required` empty state ("Entra ID P2 required" +
// Learn more link). Plain-text-only rendering for all fields.
//
// Visual surface: design-system Tile + HeroStat + SevStrip + RecentRow.

import { Button, Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { ApiError } from "@/api/client";
import { FreshnessMeta, type FreshnessSegment } from "@/components/FreshnessMeta";
import { HeroStat } from "@/components/HeroStat";
import { Icon } from "@/components/Icon";
import { RecentRow } from "@/components/RecentRow";
import { SevStrip, type SevTone } from "@/components/SevStrip";
import { Tile } from "@/components/Tile";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { useRiskyUsersSummary } from "./queries";
import { formatRelative } from "./freshness";
import type { EntraRiskLevel } from "./types";

const LEARN_MORE_URL =
  "https://learn.microsoft.com/en-us/entra/id-protection/overview-identity-protection";

function freshnessSegment(iso: string | null | undefined): FreshnessSegment | null {
  if (!iso) return null;
  const rel = formatRelative(iso).replace(/^(ingested|generated|fired)\s+/i, "");
  return { icon: "clock", label: rel, tone: "accent" };
}

function riskTone(lvl: string): SevTone {
  switch (lvl.toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "zero";
  }
}

function badgeToneForRiskLevel(lvl: string): string {
  const s = lvl.toLowerCase();
  if (s === "high") return "danger";
  if (s === "medium") return "warning";
  if (s === "low") return "info";
  return "neutral";
}

export function RiskyUsersTile() {
  const summary = useRiskyUsersSummary();
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/entra-risk/run",
    readEndpoint: "/api/risky-users/summary",
    readQueryKey: ["risky-users", "summary"],
    invalidateQueryKeys: [["risky-users"]],
  });

  if (summary.isPending) {
    return (
      <Tile title="Risky users" icon="user">
        <Skeleton>
          <SkeletonItem size={48} />
          <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
          <SkeletonItem size={48} style={{ marginTop: "var(--sp-s)" }} />
        </Skeleton>
      </Tile>
    );
  }

  if (summary.isError) {
    const err = summary.error as ApiError | Error;
    const correlationId =
      err instanceof ApiError && typeof err.payload === "object" && err.payload !== null
        ? (err.payload as { error?: { correlationId?: string } }).error?.correlationId
        : undefined;
    return (
      <Tile title="Risky users" icon="user">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load risky users. {err.message}
        </p>
        {correlationId && (
          <p className="t-caption">
            correlation id: <code>{correlationId}</code>
          </p>
        )}
        <div style={{ marginTop: "var(--sp-m)" }}>
          <Button onClick={() => summary.refetch()}>Retry</Button>
        </div>
      </Tile>
    );
  }

  const data = summary.data;

  // Licence-required dedicated empty state (ADR-0023 §7 + ADR-0024 §1.1).
  if (data.health.status === "licence_required") {
    return (
      <Tile
        title="Risky users"
        icon="user"
        headMeta={<span className="badge badge--warning">Entra ID P2 required</span>}
      >
        <p className="t-body">
          Upgrade to unlock sign-in risk detections and risky user surfacing.
        </p>
        <p className="t-caption" style={{ marginTop: "var(--sp-s)" }}>
          <a href={LEARN_MORE_URL} target="_blank" rel="noreferrer noopener">
            Learn more →
          </a>
        </p>
      </Tile>
    );
  }

  const counts = data.counts;
  const isEmpty = counts === null || counts.total === 0;
  const seg = freshnessSegment(data.ingestedAt);

  if (isEmpty) {
    return (
      <Tile
        title="Risky users"
        icon="user"
        headMeta={seg ? <FreshnessMeta segments={[seg]} /> : undefined}
      >
        <p className="t-body t-body--mute">
          {data.health.status === "failing"
            ? "Ingest is failing — no risky users have been written yet."
            : data.health.status === "degrading"
              ? "Ingest is retrying after a transient failure — no risky users yet."
              : data.health.status === "awaiting_first_run"
                ? "Awaiting first risky-users ingest run."
                : "No open risky users for this tenant right now."}
        </p>
      </Tile>
    );
  }

  const order: readonly EntraRiskLevel[] = ["high", "medium", "low", "hidden", "none", "unknown"];
  const sevItems = order.map((lvl) => ({
    label: lvl[0]!.toUpperCase() + lvl.slice(1),
    count: counts!.byRiskLevel[lvl] ?? 0,
    tone: riskTone(lvl),
  }));

  // Subcaption: processing + soft-deleted counters
  const subBits: string[] = [];
  if (counts!.processing > 0) subBits.push(`${counts!.processing} recalculating`);
  if (counts!.softDeleted > 0) subBits.push(`${counts!.softDeleted} soft-deleted`);
  const caption = `total risky users${subBits.length ? ` · ${subBits.join(" · ")}` : ""}`;

  return (
    <Tile
      title="Risky users"
      icon="user"
      headMeta={seg ? <FreshnessMeta segments={[seg]} /> : undefined}
      footMeta={
        <>
          Last ingest{" "}
          <strong style={{ color: "var(--fg-2)" }}>{formatRelative(data.ingestedAt)}</strong>
        </>
      }
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <Link to="/risky-users" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            Open list <Icon name="chevron-right" size={11} />
          </Link>
          <RefreshNowButton refresh={refresh} ariaLabel="Refresh risky users now" />
        </span>
      }
    >
      <HeroStat value={counts!.total} caption={caption} />
      <SevStrip items={sevItems} />
      {data.mostRecent && (
        <RecentRow
          label="Most recent"
          time={formatRelative(data.mostRecent.riskLastUpdatedDateTime)}
          title={data.mostRecent.userDisplayName || data.mostRecent.userPrincipalName}
          badges={[
            {
              label: data.mostRecent.riskLevel,
              tone: badgeToneForRiskLevel(data.mostRecent.riskLevel),
            },
            { label: data.mostRecent.riskState, tone: "neutral" },
          ]}
        />
      )}
    </Tile>
  );
}
