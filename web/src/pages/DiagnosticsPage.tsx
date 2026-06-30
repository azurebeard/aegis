// /admin/diagnostics — operator view of "are the ingest sources healthy?"
//
// One tile per audit-chain-emitting ingest source. Each tile surfaces:
//   - Health badge derived from the most recent run (success/error/no-data)
//   - 14-day stacked bar chart (success vs error per day) — recharts pattern
//     mirrors IncidentsTrendsChart for visual + behavioural consistency
//   - Recent-runs table (last 20 audit lines), reusing the existing
//     `/api/agents/observability/ingest-runs` endpoint
//
// Why a dedicated page exists:
// the SecureScore "failing for 3 days" surface earlier today happened
// because the dashboard tile only showed the LATEST run state, not the
// run history. Operators returning after time off had no way to see the
// failure pattern at a glance. This page is that view.
//
// `secure-score-control-profiles` is deliberately omitted — that timer
// doesn't write to the audit chain (idempotent catalogue refresh,
// AIEVENT only). Surface its run history via App Insights if needed.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { Icon } from "@/components/Icon";
import { PageSubheader } from "@/components/shell/PageSubheader";
import { ConditionalAccessSection } from "@/features/conditional-access/ConditionalAccessSection";
import {
  useIngestSources,
  toIconName,
  type IngestSource,
} from "@/features/diagnostics/ingestSources";
import {
  useIngestRunHistory,
  type IngestRunHistoryItem,
  type IngestSourceKey,
} from "@/features/secureScore/ingestRunHistory";

export function DiagnosticsPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  // Server-driven source catalogue — adding a new ingest source is now a
  // one-file server-side edit; this SPA picks it up at mount time. The
  // hook is admin-gated on the server, so a non-admin path here returns
  // 403 (and the navigate() above sends them away anyway).
  const sourcesQ = useIngestSources();
  useEffect(() => {
    if (!user.isLoading && !user.hasRole("admin")) {
      navigate("/", { replace: true });
    }
  }, [user.isLoading, user, navigate]);
  if (user.isLoading || !user.hasRole("admin")) return null;

  return (
    <>
      <PageSubheader
        title="Ingest diagnostics"
        sub="Per-source run history and 14-day health view across the audit-chain ingest pipelines."
      />
      <main className="app-main">
        {sourcesQ.isPending && (
          <div className="agent-cards">
            <Skeleton>
              <SkeletonItem size={64} />
            </Skeleton>
          </div>
        )}
        {sourcesQ.isError && (
          <p className="t-body" style={{ color: "var(--red-fg)" }}>
            Could not load the ingest-source catalogue.{" "}
            {sourcesQ.error instanceof ApiError
              ? `(${sourcesQ.error.status}) ${sourcesQ.error.message}`
              : (sourcesQ.error as Error).message}
          </p>
        )}
        {sourcesQ.data && (
          <div className="agent-cards">
            {sourcesQ.data.sources.map((s) => (
              <SourceCard key={s.key} source={s} />
            ))}
          </div>
        )}
        <div className="agent-cards" style={{ marginTop: "var(--sp-l)" }}>
          {/* ADR-0034 §3.3 (Phase 8D) — CA policy state sub-section. Renders
              outside the SOURCES grid because the data shape is policy-by-
              policy (not run-history per the other tiles). */}
          <ConditionalAccessSection />
        </div>
      </main>
    </>
  );
}

function SourceCard({ source }: { readonly source: IngestSource }) {
  const [showRuns, setShowRuns] = useState(false);
  // The runtime list comes from the server; cast the opaque key into
  // the typed union for the existing run-history hook. If a future
  // server adds a key the SPA bundle doesn't know about, the request
  // still works — it's a URL path segment at the wire level.
  const query = useIngestRunHistory(source.key as IngestSourceKey, 100);
  const icon = toIconName(source.iconName);

  return (
    <article className="tile">
      <div className="tile__head">
        <h2 className="tile__title">
          <Icon name={icon} size={14} className="tile__title-icon" />
          {source.label}
        </h2>
        <div className="tile__head-meta">
          <HealthBadge query={query} />
        </div>
      </div>
      <div
        className="tile__body"
        style={{ display: "flex", flexDirection: "column", gap: "var(--sp-l)" }}
      >
        <p className="t-caption t-body--mute">{source.description}</p>
        {query.isPending && <CardSkeleton />}
        {query.isError && (
          <p className="t-body" style={{ color: "var(--red-fg)" }}>
            Could not load run history.{" "}
            {query.error instanceof ApiError
              ? `(${query.error.status}) ${query.error.message}`
              : (query.error as Error).message}
          </p>
        )}
        {query.isSuccess && (
          <>
            <SummaryBlock items={query.data.items} lookbackDays={query.data.range.lookbackDays} />
            <RunTrendChart items={query.data.items} lookbackDays={query.data.range.lookbackDays} />
            <RecentRunsBlock
              items={query.data.items}
              expanded={showRuns}
              onToggle={() => setShowRuns((s) => !s)}
            />
          </>
        )}
      </div>
    </article>
  );
}

function HealthBadge({ query }: { readonly query: ReturnType<typeof useIngestRunHistory> }) {
  if (query.isPending) return <span className="badge badge--neutral">Loading</span>;
  if (query.isError) return <span className="badge badge--danger">Unknown</span>;
  const items = query.data.items;
  if (items.length === 0) return <span className="badge badge--neutral">No runs yet</span>;
  // The most recent run drives the badge — items are returned newest-first
  // by the audit walker.
  const latest = items[0];
  if (!latest) return <span className="badge badge--neutral">No runs yet</span>;
  if (latest.errorKind || latest.status === "error") {
    return <span className="badge badge--danger">Failing</span>;
  }
  if (latest.status === "no_data") {
    return <span className="badge badge--info">No data</span>;
  }
  return <span className="badge badge--success">Healthy</span>;
}

function SummaryBlock({
  items,
  lookbackDays,
}: {
  readonly items: readonly IngestRunHistoryItem[];
  readonly lookbackDays: number;
}) {
  const successes = items.filter((r) => r.status === "success").length;
  const errors = items.filter((r) => r.errorKind || r.status === "error").length;
  const noData = items.filter((r) => r.status === "no_data").length;
  const lastSuccess = items.find((r) => r.status === "success");
  const lastError = items.find((r) => r.errorKind || r.status === "error");

  return (
    <section>
      <p className="t-eyebrow">Last {lookbackDays} days</p>
      <div className="row" style={{ gap: "var(--sp-l)", flexWrap: "wrap" }}>
        <span className="t-body">
          <strong>{successes}</strong> <span className="t-body--mute">success</span>
        </span>
        <span className="t-body">
          <strong>{errors}</strong> <span className="t-body--mute">error</span>
        </span>
        {noData > 0 && (
          <span className="t-body">
            <strong>{noData}</strong> <span className="t-body--mute">no-data</span>
          </span>
        )}
      </div>
      {lastSuccess && (
        <p className="t-caption" style={{ marginTop: 4 }}>
          <span className="t-body--mute">Last success:</span>{" "}
          {new Date(lastSuccess.startedAt).toLocaleString()}
        </p>
      )}
      {lastError && (
        <p className="t-caption" style={{ marginTop: 2 }}>
          <span className="t-body--mute">Last error:</span>{" "}
          {new Date(lastError.startedAt).toLocaleString()}
          {lastError.errorKind && (
            <>
              {" · "}
              <span className="badge badge--warning">{lastError.errorKind}</span>
            </>
          )}
        </p>
      )}
    </section>
  );
}

interface DayBucket {
  readonly day: string;
  readonly success: number;
  readonly error: number;
  readonly noData: number;
}

function RunTrendChart({
  items,
  lookbackDays,
}: {
  readonly items: readonly IngestRunHistoryItem[];
  readonly lookbackDays: number;
}) {
  const buckets = useMemo<readonly DayBucket[]>(
    () => bucketByDay(items, lookbackDays),
    [items, lookbackDays],
  );
  const totalRuns = buckets.reduce((s, b) => s + b.success + b.error + b.noData, 0);
  if (totalRuns === 0) return null;
  const ariaLabel = `Run outcomes per day · last ${lookbackDays} days`;
  return (
    <section aria-label={ariaLabel}>
      <p className="t-eyebrow">Outcomes per day</p>
      <div style={{ width: "100%", height: 160 }} role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={buckets as DayBucket[]}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            barCategoryGap={2}
          >
            <CartesianGrid stroke="var(--stroke-3, #e5e5e5)" vertical={false} />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 10, fill: "var(--fg-3)" }}
              tickFormatter={shortDay}
              minTickGap={28}
              stroke="var(--stroke-3, #e5e5e5)"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--fg-3)" }}
              allowDecimals={false}
              width={28}
              stroke="var(--stroke-3, #e5e5e5)"
            />
            <Tooltip content={<TrendTooltip />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
            <Bar
              dataKey="success"
              stackId="run"
              fill="var(--green-fg, #107c10)"
              isAnimationActive={false}
            />
            <Bar
              dataKey="error"
              stackId="run"
              fill="var(--red-strong, #b71c1c)"
              isAnimationActive={false}
            />
            <Bar
              dataKey="noData"
              stackId="run"
              fill="var(--gray-border, #b1b1b1)"
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

interface TooltipPayload {
  readonly name: string;
  readonly value: number;
  readonly color: string;
}
interface TooltipProps {
  readonly active?: boolean;
  readonly label?: string;
  readonly payload?: readonly TooltipPayload[];
}

function TrendTooltip({ active, label, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--stroke-1)",
        borderRadius: "var(--r-m)",
        padding: "var(--sp-s) var(--sp-m)",
        boxShadow: "var(--shadow-8)",
        fontSize: "var(--fs-200)",
      }}
    >
      <p className="t-eyebrow" style={{ marginBottom: 4 }}>
        {label}
      </p>
      <p className="t-body" style={{ marginBottom: 4 }}>
        <strong>{total}</strong> total
      </p>
      {payload
        .filter((p) => (p.value ?? 0) > 0)
        .map((p) => (
          <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                background: p.color,
                borderRadius: 2,
              }}
            />
            <span style={{ flex: 1 }}>{labelFor(p.name)}</span>
            <span className="tnum">{p.value}</span>
          </div>
        ))}
    </div>
  );
}

function labelFor(key: string): string {
  if (key === "success") return "Success";
  if (key === "error") return "Error";
  if (key === "noData") return "No data";
  return key;
}

function RecentRunsBlock({
  items,
  expanded,
  onToggle,
}: {
  readonly items: readonly IngestRunHistoryItem[];
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const visible = items.slice(0, 20);
  return (
    <section>
      <div className="row row--between">
        <p className="t-eyebrow">Recent runs</p>
        <button
          type="button"
          className="btn btn--small btn--subtle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {expanded ? "Hide" : `Show last ${visible.length}`}
        </button>
      </div>
      {expanded && visible.length === 0 && (
        <p className="t-body t-body--mute" style={{ marginTop: "var(--sp-s)" }}>
          No runs in the lookback window.
        </p>
      )}
      {expanded && visible.length > 0 && (
        <table className="dt" style={{ fontSize: "var(--fs-200)", marginTop: "var(--sp-s)" }}>
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th className="num">Rows</th>
              <th className="num">Graph attempts</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={`${r.runId}-${i}`}>
                <td className="t-body--mute">
                  {new Date(r.startedAt).toLocaleString(undefined, {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </td>
                <td>
                  <span className={`badge badge--${runTone(r)}`}>
                    {r.errorKind ?? r.status ?? "—"}
                  </span>
                </td>
                <td className="num tnum">{r.rowsWritten ?? "—"}</td>
                <td className="num tnum">{r.graphAttempts ?? "—"}</td>
                <td className="t-body--mute">{r.snapshotDate ?? r.runId.slice(0, 8) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function runTone(r: IngestRunHistoryItem): string {
  if (r.errorKind || r.status === "error") return "danger";
  if (r.status === "success") return "success";
  if (r.status === "no_data") return "info";
  return "neutral";
}

function CardSkeleton() {
  return (
    <Skeleton>
      <SkeletonItem size={48} />
      <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
      <SkeletonItem size={48} style={{ marginTop: "var(--sp-s)" }} />
    </Skeleton>
  );
}

/** yyyy-mm-dd → "dd MMM" (UTC). Mirrors the IncidentsTrendsChart helper. */
function shortDay(d: string): string {
  const [, m, day] = d.split("-");
  if (!m || !day) return d;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const mi = Number.parseInt(m, 10);
  return `${day} ${months[mi - 1] ?? m}`;
}

/** Bucket runs into per-day success/error/no-data counts spanning the full
 *  lookback window so the chart shows continuous days even when the source
 *  produced no runs on a given day. */
export function bucketByDay(
  items: readonly IngestRunHistoryItem[],
  lookbackDays: number,
): readonly DayBucket[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const buckets = new Map<string, DayBucket>();
  for (let i = lookbackDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    buckets.set(day, { day, success: 0, error: 0, noData: 0 });
  }
  for (const r of items) {
    const day = r.day || r.startedAt.slice(0, 10);
    const b = buckets.get(day);
    if (!b) continue;
    if (r.errorKind || r.status === "error") {
      buckets.set(day, { ...b, error: b.error + 1 });
    } else if (r.status === "no_data") {
      buckets.set(day, { ...b, noData: b.noData + 1 });
    } else if (r.status === "success") {
      buckets.set(day, { ...b, success: b.success + 1 });
    }
  }
  return Array.from(buckets.values());
}
