// ADR-0034 §3.3 — dashboard tile for Conditional Access policy state.
//
// Hero stat: count of enabled policies (the most operationally meaningful
// number — disabled / report-only are surfaced as caption stripes).
// Drift badge: count of `ca.policy.changed` audit events in the last 24h
// (surfaces operator-visible policy churn at a glance — the prime signal
// for "did someone disable a policy?").
// Hidden for readers when no policies exist; admins always see it so they
// can spot a missed first-run / failing ingest.

import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import type { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { HeroStat } from "@/components/HeroStat";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/Tile";
import { useConditionalAccessSummary } from "./queries";

export function ConditionalAccessTile() {
  const user = useCurrentUser();
  const q = useConditionalAccessSummary();
  const isAdmin = user.hasRole("admin");

  if (q.isPending) {
    return (
      <Tile title="Conditional Access" icon="shield">
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
      <Tile title="Conditional Access" icon="shield">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load CA summary. {err.message}
        </p>
      </Tile>
    );
  }

  const { counts, recentChanges } = q.data;

  // Empty/awaiting state — admin sees the empty card with a deep link;
  // reader sees nothing (matches StackTile/KevTile pattern).
  if (counts.total === 0) {
    if (!isAdmin) return null;
    return (
      <Tile title="Conditional Access" icon="shield">
        <p className="t-body t-body--mute">
          No CA policies configured. Recommend enabling at least an admin-MFA policy to baseline
          tenant security.
        </p>
        <p className="t-caption" style={{ marginTop: "var(--sp-s)" }}>
          <Link to="/admin/diagnostics">Open diagnostics →</Link>
        </p>
      </Tile>
    );
  }

  // Tone of the drift badge: deletes are danger, modify/create are warning.
  const driftTone =
    recentChanges.count === 0
      ? null
      : recentChanges.samples.some((s) => s.diffKind === "deleted")
        ? "danger"
        : "warning";

  return (
    <Tile
      title="Conditional Access"
      icon="shield"
      footMeta={
        <>
          {counts.total} polic{counts.total === 1 ? "y" : "ies"}
          {counts.disabled > 0 ? ` · ${counts.disabled} disabled` : ""}
          {counts.reportOnly > 0 ? ` · ${counts.reportOnly} report-only` : ""}
        </>
      }
      footAction={
        <Link
          to="/admin/diagnostics"
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          Open <Icon name="chevron-right" size={11} />
        </Link>
      }
    >
      <HeroStat value={String(counts.enabled)} caption={`enabled · ${counts.total} total`} />
      {driftTone !== null && (
        <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: "var(--sp-s)" }}>
          <span className={`badge badge--${driftTone}`}>
            {recentChanges.count} change{recentChanges.count === 1 ? "" : "s"} in last 24h
          </span>
        </div>
      )}
    </Tile>
  );
}
