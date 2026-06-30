// Daily-brief dashboard tile (ADR-0022 §read-path).
//
// States:
//   - loading              → skeleton
//   - awaiting_first_run   → empty-state copy
//   - fresh                → headline + sections, no banner
//   - stale_serviceable    → warning banner + content
//   - stale_unservable     → danger banner + content + retry hint
//   - error                → ApiError display
//
// Headline + section headings render as plain text (Microsoft-prose-grade
// safety). Bullet text passes through SafeMarkdown — controlled inline
// formatting only, no HTML execution path.
//
// Visual surface uses the design-system Tile + FreshnessMeta primitives
// (Phase 2 redesign per `docs/ui-pack/`). The pre-redesign Card +
// CardHeader scaffold is replaced by `<Tile ai>` with the AI mark in
// the head meta row.

import { Button, Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { ApiError } from "@/api/client";
import { FreshnessMeta, type FreshnessSegment } from "@/components/FreshnessMeta";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/Tile";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { useTenantSettings } from "@/features/settings/queries";
import { useBriefLatest } from "./queries";
import { formatRelative } from "./freshness";
import { SafeMarkdown } from "./SafeMarkdown";
import type { BriefLatestResponse } from "./types";

/** Format an ISO timestamp into the FreshnessMeta-friendly relative
 *  segment ("Generated 4h ago"). */
function generatedSegment(isoOrNull: string | null | undefined): FreshnessSegment | null {
  if (!isoOrNull) return null;
  const rel = formatRelative(isoOrNull).replace(/^(generated|fired)\s+/i, "");
  return { icon: "clock", label: `Generated ${rel}`, tone: "accent" };
}

/** Format the next-fire ISO into a meta segment ("Next in 20h"). */
function nextFireSegment(nextFireAt: string | null): FreshnessSegment | null {
  if (!nextFireAt) return null;
  const t = new Date(nextFireAt).getTime();
  if (!Number.isFinite(t)) return null;
  const deltaMs = t - Date.now();
  if (deltaMs <= 0) return { icon: "calendar", label: "Next: overdue", tone: "mute" };
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 60) return { icon: "calendar", label: `Next in ${mins} min`, tone: "mute" };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { icon: "calendar", label: `Next in ${hrs}h`, tone: "mute" };
  const days = Math.floor(hrs / 24);
  return { icon: "calendar", label: `Next in ${days}d`, tone: "mute" };
}

export function BriefTile() {
  const q = useBriefLatest();
  const settings = useTenantSettings();
  const nextFireAt = settings.data?.agentSchedules?.brief?.nextFireAt ?? null;
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/brief/run",
    readEndpoint: "/api/brief/latest",
    readQueryKey: ["brief", "latest"],
    invalidateQueryKeys: [["brief"]],
  });

  if (q.isPending) {
    return (
      <Tile title="Daily Brief" icon="sparkle" ai>
        <Skeleton>
          <SkeletonItem size={24} />
          <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
          <SkeletonItem size={48} style={{ marginTop: "var(--sp-s)" }} />
        </Skeleton>
      </Tile>
    );
  }

  if (q.isError) {
    const err = q.error as ApiError | Error;
    const correlationId =
      err instanceof ApiError && typeof err.payload === "object" && err.payload !== null
        ? (err.payload as { error?: { correlationId?: string } }).error?.correlationId
        : undefined;
    return (
      <Tile title="Daily Brief" icon="sparkle" ai>
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load brief. {err.message}
        </p>
        {correlationId && (
          <p className="t-caption">
            correlation id: <code>{correlationId}</code>
          </p>
        )}
        <div style={{ marginTop: "var(--sp-m)" }}>
          <Button onClick={() => q.refetch()}>Retry</Button>
        </div>
      </Tile>
    );
  }

  const data = q.data as BriefLatestResponse;
  if (data.health?.status === "awaiting_first_run") {
    return (
      <Tile title="Daily Brief" icon="sparkle" ai>
        <p className="t-body t-body--mute">
          Awaiting first daily-brief run. The agent fires once a day at 05:00 UTC by default; an
          admin can also trigger a one-off run.
        </p>
        {/* §6.3 quick-sweep 2026-06-22 — the empty-state copy promises
            "admin can trigger a one-off run" but pre-fix there was no
            button to actually do it. The RefreshNowButton self-gates
            on `canRefresh` so non-admins see no widget; admins get
            the one-click trigger the copy promised. */}
        <RefreshNowButton refresh={refresh} ariaLabel="Refresh Daily Brief now" />
      </Tile>
    );
  }

  const headline = data.headline ?? "";
  const sections = data.sections ?? [];
  const freshness = data.freshness;

  // Build the head meta row: AI mark + (optional) freshness + next-fire
  const segments: FreshnessSegment[] = [];
  const gen = generatedSegment(data.generatedAt);
  if (gen) segments.push(gen);
  const next = nextFireSegment(nextFireAt);
  if (next) segments.push(next);

  return (
    <Tile
      title="Daily Brief"
      icon="sparkle"
      ai
      headMeta={
        <>
          <span className="ai-mark">AI</span>
          {segments.length > 0 && <FreshnessMeta segments={segments} />}
        </>
      }
      footMeta={
        <>{data.modelDeployment && <span className="t-mono">{data.modelDeployment}</span>}</>
      }
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <Link to="/history" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            History <Icon name="chevron-right" size={11} />
          </Link>
          <RefreshNowButton refresh={refresh} ariaLabel="Refresh Daily Brief now" />
        </span>
      }
    >
      {freshness === "stale_unservable" && (
        <div className="banner banner--danger" role="alert">
          This brief is older than the serviceability ceiling. The next scheduled run will refresh
          it{data.retryHintSeconds ? ` in ~${Math.ceil(data.retryHintSeconds / 60)} minutes.` : "."}
        </div>
      )}

      <div className="narrative">
        {/* Headline — plain text (model prose, top-level display) */}
        <p className="narrative__lede">{headline}</p>

        {sections.map((s, idx) => (
          <div key={`${s.heading}-${idx}`} className="narrative__section">
            <h4>{s.heading}</h4>
            <ul>
              {s.bullets.map((b, j) => (
                <li key={j}>
                  {/* SafeMarkdown — emphasis allowed, no HTML execution */}
                  <SafeMarkdown>{b}</SafeMarkdown>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Tile>
  );
}
