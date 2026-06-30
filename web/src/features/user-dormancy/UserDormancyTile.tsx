// User dormancy dashboard tile (ADR-0034 §3.1).
//
// Hero stat: dormant count. Caption: total tracked + threshold days.
// Licence-required dedicated empty state ("Entra ID P1 required") with
// Learn more link. Plain-text-only rendering throughout (ADR-0012 §5).

import { Button, Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import type { ApiError } from "@/api/client";
import { HeroStat } from "@/components/HeroStat";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/Tile";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { useUserDormancySummary } from "./queries";

const LEARN_MORE_URL = "https://learn.microsoft.com/en-us/entra/identity/users/users-revoke-access";

export function UserDormancyTile() {
  const summary = useUserDormancySummary();
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/user-dormancy/run",
    readEndpoint: "/api/user-dormancy/summary",
    readQueryKey: ["user-dormancy", "summary"],
    invalidateQueryKeys: [["user-dormancy"]],
  });

  if (summary.isPending) {
    return (
      <Tile title="Dormant accounts" icon="user">
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
      <Tile title="Dormant accounts" icon="user">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load dormancy. {err.message}
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
        title="Dormant accounts"
        icon="user"
        headMeta={<span className="badge badge--warning">Entra ID P1 required</span>}
      >
        <p className="t-body">
          Upgrade to unlock per-user sign-in activity and the dormancy report.
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
  if (!counts || counts.total === 0) {
    return (
      <Tile title="Dormant accounts" icon="user">
        <p className="t-body t-body--mute">
          {data.health.status === "awaiting_first_run"
            ? "Awaiting first dormancy ingest run."
            : data.health.status === "failing"
              ? "Ingest is failing — no dormancy data has been written yet."
              : "No users tracked for this tenant."}
        </p>
        <div style={{ marginTop: "var(--sp-m)" }}>
          <RefreshNowButton refresh={refresh} ariaLabel="Run dormancy ingest now" />
        </div>
      </Tile>
    );
  }

  const threshold = data.policy?.thresholdDays ?? 30;
  const dormantPct = counts.total > 0 ? Math.round((counts.dormant / counts.total) * 100) : 0;
  const subBits: string[] = [`${counts.total} total`, `>${threshold}d threshold`];
  if (counts.disabledDormant > 0) {
    subBits.push(`${counts.disabledDormant} disabled`);
  }
  if (counts.excluded > 0) {
    subBits.push(`${counts.excluded} excluded`);
  }

  return (
    <Tile
      title="Dormant accounts"
      icon="user"
      footAction={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <Link
            to="/user-dormancy"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            Open list <Icon name="chevron-right" size={11} />
          </Link>
          <RefreshNowButton refresh={refresh} ariaLabel="Refresh dormancy now" />
        </span>
      }
    >
      <HeroStat
        value={String(counts.dormant)}
        caption={`${dormantPct}% of ${counts.total} users · ${subBits.slice(1).join(" · ")}`}
      />
      {counts.oldestDormantUpn && (
        <p className="t-caption" style={{ marginTop: "var(--sp-s)" }}>
          Oldest: <strong>{counts.oldestDormantUpn}</strong>
          {counts.oldestDormantLastSignIn === null
            ? " · never signed in"
            : ` · last seen ${new Date(counts.oldestDormantLastSignIn).toLocaleDateString()}`}
        </p>
      )}
    </Tile>
  );
}
