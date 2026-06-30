// Weekly-posture dashboard tile (ADR-0027 §Decision.5 read path).
//
// States:
//   - loading              → skeleton
//   - awaiting_first_run   → empty-state copy
//   - fresh                → headline + three sections, no banner
//   - stale_serviceable    → warning banner + content
//   - stale_unservable     → danger banner + content + retry hint
//   - error                → ApiError display
//
// Headline + section prose render via SafeMarkdown — no raw HTML execution
// path. `severity` is shown as a Fluent-toned badge in the head.
//
// Visual surface uses the design-system Tile + FreshnessMeta primitives
// (Phase 2 redesign). The pre-redesign Card scaffold is replaced by
// `<Tile ai>` with the AI mark + severity badge in the head meta row.

import { Button, Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { ApiError } from "@/api/client";
import { FreshnessMeta, type FreshnessSegment } from "@/components/FreshnessMeta";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/Tile";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { SafeMarkdown } from "@/features/brief/SafeMarkdown";
import { useTenantSettings } from "@/features/settings/queries";
import { usePostureLatest } from "./queries";
import { formatRelative, severityLabel } from "./freshness";
import type { PostureLatestResponse } from "./types";

/** Map the legacy severityLabel tone (Fluent badge tone) → design's
 *  badge--<tone> class. */
function sevToDesignTone(sevTone: string): string {
  switch (sevTone) {
    case "danger":
      return "danger";
    case "warning":
      return "warning";
    case "important":
    case "info":
      return "info";
    case "success":
      return "success";
    default:
      return "neutral";
  }
}

function generatedSegment(iso: string | null | undefined): FreshnessSegment | null {
  if (!iso) return null;
  const rel = formatRelative(iso).replace(/^(generated|fired)\s+/i, "");
  return { icon: "clock", label: `Generated ${rel}`, tone: "accent" };
}

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

export function PostureTile() {
  const q = usePostureLatest();
  const settings = useTenantSettings();
  const nextFireAt = settings.data?.agentSchedules?.posture?.nextFireAt ?? null;
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/posture/run",
    readEndpoint: "/api/posture/latest",
    readQueryKey: ["posture", "latest"],
    invalidateQueryKeys: [["posture"]],
  });

  if (q.isPending) {
    return (
      <Tile title="Weekly Posture" icon="shield" ai>
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
      <Tile title="Weekly Posture" icon="shield" ai>
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load posture. {err.message}
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

  const data = q.data as PostureLatestResponse;
  if (data.health?.status === "awaiting_first_run") {
    return (
      <Tile title="Weekly Posture" icon="shield" ai>
        <p className="t-body t-body--mute">
          Awaiting first posture narrative. The agent fires weekly on Mondays at 06:00 UTC by
          default; an admin can also trigger a one-off run.
        </p>
        {/* §6.3 quick-sweep 2026-06-22 — same promise-mismatch fix as
            BriefTile's awaiting_first_run branch (the empty-state copy
            promised "admin can trigger" but no button existed).
            RefreshNowButton self-gates on `canRefresh`. */}
        <RefreshNowButton refresh={refresh} ariaLabel="Refresh Weekly Posture now" />
      </Tile>
    );
  }

  const headline = data.headline ?? "";
  const sections = data.sections;
  const freshness = data.freshness;
  const severity = data.severity;
  const sevBadge = severityLabel(severity);

  const segments: FreshnessSegment[] = [];
  const gen = generatedSegment(data.generatedAt);
  if (gen) segments.push(gen);
  const next = nextFireSegment(nextFireAt);
  if (next) segments.push(next);

  return (
    <Tile
      title="Weekly Posture"
      icon="shield"
      ai
      headMeta={
        <>
          <span className="ai-mark">AI</span>
          {sevBadge && (
            <span className={`badge badge--${sevToDesignTone(sevBadge.tone)}`}>
              {sevBadge.text}
            </span>
          )}
          {segments.length > 0 && <FreshnessMeta segments={segments} />}
        </>
      }
      footMeta={
        <>
          {data.isoWeek && <span>Week {data.isoWeek}</span>}
          {data.isoWeek && data.modelDeployment && <span> · </span>}
          {data.modelDeployment && <span className="t-mono">{data.modelDeployment}</span>}
        </>
      }
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <Link to="/history" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            History <Icon name="chevron-right" size={11} />
          </Link>
          <RefreshNowButton refresh={refresh} ariaLabel="Refresh Weekly Posture now" />
        </span>
      }
    >
      {freshness === "stale_unservable" && (
        <div className="banner banner--danger" role="alert">
          This posture narrative is older than the serviceability ceiling. The next scheduled Monday
          run will refresh it.
        </div>
      )}

      <div className="narrative">
        <p className="narrative__lede">{headline}</p>

        {sections && <PostureSection heading="Current posture" body={sections.currentPosture} />}
        {sections && <PostureSection heading="Recent movement" body={sections.recentMovement} />}
        {sections && (
          <PostureSection
            heading="Priority actions"
            body={sections.priorityActions}
            variant="warn"
          />
        )}
      </div>
    </Tile>
  );
}

function PostureSection({
  heading,
  body,
  variant,
}: {
  heading: string;
  body: string;
  variant?: "warn" | "danger";
}) {
  if (!body || body.length === 0) return null;
  const variantClass = variant ? ` narrative__section--${variant}` : "";
  return (
    <div className={`narrative__section${variantClass}`}>
      <h4>{heading}</h4>
      <SafeMarkdown>{body}</SafeMarkdown>
    </div>
  );
}
