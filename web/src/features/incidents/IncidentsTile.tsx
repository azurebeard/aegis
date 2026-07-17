// Incidents dashboard tile (ADR-0016 §1.1).
//
// Severity count grid + most-recent incident row + health/freshness badge.
// Plain-text-only rendering for all Microsoft-authored prose fields
// (ADR-0012 §5 + ADR-0016 §6). No `dangerouslySetInnerHTML`; ESLint
// `react/no-danger` override is applied on `src/features/incidents/**`.
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
import { useIncidentsSummary } from "./queries";
import { formatRelative } from "./freshness";
import type { IncidentSeverity } from "./types";

function freshnessSegment(iso: string | null | undefined): FreshnessSegment | null {
  if (!iso) return null;
  const rel = formatRelative(iso).replace(/^(ingested|generated|fired)\s+/i, "");
  return { icon: "clock", label: rel, tone: "accent" };
}

function severityTone(sev: string): SevTone {
  switch (sev.toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "informational":
      return "info";
    default:
      return "zero";
  }
}

function badgeToneForSeverity(sev: string): string {
  const s = sev.toLowerCase();
  if (s === "high") return "danger";
  if (s === "medium") return "warning";
  if (s === "low") return "info";
  return "neutral";
}

export function IncidentsTile() {
  const summary = useIncidentsSummary();
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/incidents/run",
    readEndpoint: "/api/incidents/summary",
    readQueryKey: ["incidents", "summary"],
    invalidateQueryKeys: [["incidents"]],
  });

  if (summary.isPending) {
    return (
      <Tile title="Incidents" icon="alert">
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
      <Tile title="Incidents" icon="alert">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load incidents. {err.message}
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
  const isEmpty = data.counts.total === 0;
  const seg = freshnessSegment(data.ingestedAt);

  if (isEmpty) {
    return (
      <Tile
        title="Incidents"
        icon="alert"
        headMeta={seg ? <FreshnessMeta segments={[seg]} /> : undefined}
      >
        <p className="t-body t-body--mute">
          {data.health.status === "failing"
            ? "Ingest is failing — no incidents have been written yet."
            : data.health.status === "degrading"
              ? "Ingest is retrying after a transient failure — no incidents yet."
              : data.health.status === "awaiting_first_run"
                ? "Awaiting first incidents ingest run."
                : "No open incidents for this tenant right now."}
        </p>
      </Tile>
    );
  }

  // Build severity strip in canonical order.
  const order: readonly IncidentSeverity[] = ["high", "medium", "low", "informational", "unknown"];
  const sevItems = order.map((sev) => ({
    label: sev === "informational" ? "Info" : sev[0]!.toUpperCase() + sev.slice(1),
    count: data.counts.bySeverity[sev] ?? 0,
    tone: severityTone(sev),
  }));

  return (
    <Tile
      title="Incidents"
      icon="alert"
      headMeta={seg ? <FreshnessMeta segments={[seg]} /> : undefined}
      footMeta={
        <>
          Last ingest{" "}
          <strong style={{ color: "var(--fg-2)" }}>{formatRelative(data.ingestedAt)}</strong>
        </>
      }
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <Link to="/incidents" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            Open list <Icon name="chevron-right" size={11} />
          </Link>
          <RefreshNowButton refresh={refresh} ariaLabel="Refresh incidents now" />
        </span>
      }
    >
      <HeroStat value={data.counts.total} caption="total incidents (redirected excluded)" />
      <SevStrip items={sevItems} />
      {data.mostRecent && (
        <RecentRow
          label="Most recent"
          time={formatRelative(data.mostRecent.lastUpdateDateTime)}
          title={data.mostRecent.displayName}
          badges={[
            {
              label: data.mostRecent.severity,
              tone: badgeToneForSeverity(data.mostRecent.severity),
            },
            { label: data.mostRecent.status, tone: "neutral" },
          ]}
        />
      )}
    </Tile>
  );
}
