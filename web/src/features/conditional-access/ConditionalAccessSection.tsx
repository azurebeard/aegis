// ADR-0034 §3.3 + §10 — Conditional Access policy state section, rendered
// inside /admin/diagnostics. Shows: counts (enabled / disabled / report-only),
// last-ingest health, and a small table of every policy with its current
// state + last-modified time. Plain-text-only render throughout (ADR-0012 §5).

import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useAdminTileRefresh } from "@/features/common/useAdminTileRefresh";
import { RefreshNowButton } from "@/features/common/RefreshNowButton";
import { useConditionalAccessPolicies, useConditionalAccessSummary } from "./queries";
import type { ConditionalAccessPolicy, ConditionalAccessState } from "./types";

const STATE_LABEL: Record<ConditionalAccessState, string> = {
  enabled: "Enabled",
  disabled: "Disabled",
  enabledForReportingButNotEnforced: "Report-only",
};

const STATE_TONE: Record<ConditionalAccessState, "success" | "danger" | "warning"> = {
  enabled: "success",
  disabled: "danger",
  enabledForReportingButNotEnforced: "warning",
};

export function ConditionalAccessSection() {
  const summary = useConditionalAccessSummary();
  const list = useConditionalAccessPolicies();
  // Manual ingest trigger for admin operators. Same pattern as KevTile etc;
  // the hook handles the role check (button only renders for admins),
  // POSTs to the admin-gated /api/ingest endpoint, refetches the read
  // endpoint with `cache: "no-store"`, and rehydrates both query keys
  // so the section reflects the new run without a hard reload.
  const refresh = useAdminTileRefresh({
    runEndpoint: "/api/ingest/conditional-access/run",
    readEndpoint: "/api/conditional-access/summary",
    readQueryKey: ["conditional-access", "summary"],
    invalidateQueryKeys: [["conditional-access"]],
  });

  if (summary.isPending || list.isPending) {
    return (
      <article className="tile">
        <div className="tile__head">
          <h2 className="tile__title">Conditional Access policies</h2>
        </div>
        <Skeleton>
          <SkeletonItem size={20} />
          <SkeletonItem size={20} style={{ marginTop: "var(--sp-s)" }} />
        </Skeleton>
      </article>
    );
  }

  if (summary.isError || list.isError) {
    const err = (summary.error ?? list.error) as ApiError | Error;
    return (
      <article className="tile">
        <div className="tile__head">
          <h2 className="tile__title">Conditional Access policies</h2>
        </div>
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load CA policies.{" "}
          {err instanceof ApiError ? `(${err.status}) ${err.message}` : err.message}
        </p>
      </article>
    );
  }

  const counts = summary.data.counts;
  const health = summary.data.health;
  const items = list.data.items;

  return (
    <article className="tile">
      <div className="tile__head">
        <h2 className="tile__title">Conditional Access policies</h2>
        <div
          className="tile__head-meta"
          style={{ display: "flex", alignItems: "center", gap: "var(--sp-m)" }}
        >
          <span className="t-caption">
            Last ingest:{" "}
            {health.lastSuccessAt ? new Date(health.lastSuccessAt).toLocaleString() : "never"}
            {" · "}
            <span style={{ textTransform: "capitalize" }}>{health.status}</span>
          </span>
          <RefreshNowButton refresh={refresh} ariaLabel="Run Conditional Access ingest now" />
        </div>
      </div>

      {counts.total === 0 ? (
        <p className="t-body t-body--mute" style={{ marginTop: "var(--sp-m)" }}>
          No CA policies configured. We recommend enabling at least an admin-MFA policy to baseline
          tenant security posture.
        </p>
      ) : (
        <>
          <div
            className="row"
            style={{ flexWrap: "wrap", gap: "var(--sp-m)", marginTop: "var(--sp-m)" }}
          >
            <Stat label="Total" value={counts.total} tone="neutral" />
            <Stat label="Enabled" value={counts.enabled} tone="success" />
            <Stat label="Report-only" value={counts.reportOnly} tone="warning" />
            <Stat label="Disabled" value={counts.disabled} tone="danger" />
          </div>
          <div style={{ overflowX: "auto", marginTop: "var(--sp-l)" }}>
            <table className="data-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Display name</th>
                  <th style={th}>State</th>
                  <th style={th}>Last modified</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <PolicyRow key={p.id} policy={p} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </article>
  );
}

function PolicyRow({ policy }: { readonly policy: ConditionalAccessPolicy }) {
  const tone = STATE_TONE[policy.state];
  return (
    <tr>
      <td style={td}>
        <strong>{policy.displayName}</strong>
        <br />
        <span className="t-caption">{policy.id}</span>
      </td>
      <td style={td}>
        <span className={`badge badge--${tone}`}>{STATE_LABEL[policy.state]}</span>
      </td>
      <td style={td}>
        {policy.modifiedDateTime ? new Date(policy.modifiedDateTime).toLocaleDateString() : "—"}
      </td>
    </tr>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: "neutral" | "success" | "warning" | "danger";
}) {
  const colour =
    tone === "success"
      ? "var(--green-fg)"
      : tone === "warning"
        ? "var(--yellow-fg)"
        : tone === "danger"
          ? "var(--red-fg)"
          : "var(--fg-1)";
  return (
    <div>
      <div style={{ fontSize: "var(--fs-700)", fontWeight: 600, color: colour }}>{value}</div>
      <div className="t-caption">{label}</div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "var(--sp-s) var(--sp-m)",
  borderBottom: "1px solid var(--bd)",
  fontWeight: 600,
  fontSize: "var(--fs-200)",
  color: "var(--fg-2)",
};
const td: React.CSSProperties = {
  padding: "var(--sp-s) var(--sp-m)",
  borderBottom: "1px solid var(--bd)",
  verticalAlign: "top",
};
