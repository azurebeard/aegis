// Stacked bar chart showing incidents-by-day for the last N days,
// stacked by severity (high → medium → low → informational → unknown).
//
// Powers the trend block above the Incidents list page.
// Pulls from `useIncidentsTrends` which hits the new `/api/incidents/trends`
// endpoint. Renders an aria-label summarising the window so screen readers
// get a useful description without us building a dedicated table view.

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useIncidentsTrends } from "./queries";
import type { IncidentTrendBucket } from "./types";

interface Row {
  readonly day: string;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly informational: number;
  readonly unknown: number;
  readonly total: number;
}

const SEVERITY_LAYERS = [
  // Order = render order = visual stack from bottom to top.
  // Bottom-stack heaviest severity so high/medium read most prominent.
  { key: "high", label: "High", colour: "var(--red-strong, #b71c1c)" },
  { key: "medium", label: "Medium", colour: "var(--orange-fg, #b35900)" },
  { key: "low", label: "Low", colour: "var(--brand-fg, #0078d4)" },
  { key: "informational", label: "Info", colour: "var(--gray-border, #b1b1b1)" },
  { key: "unknown", label: "Unknown", colour: "var(--fg-4, #757575)" },
] as const;

export function IncidentsTrendsChart({ days = 30 }: { readonly days?: number }) {
  const trends = useIncidentsTrends(days);

  if (trends.isPending) {
    return (
      <div style={{ padding: "var(--sp-l)" }}>
        <Skeleton>
          <SkeletonItem size={48} />
          <SkeletonItem size={120} style={{ marginTop: "var(--sp-s)" }} />
        </Skeleton>
      </div>
    );
  }
  if (trends.isError) {
    return (
      <p className="t-body" style={{ padding: "var(--sp-l)", color: "var(--red-fg)" }}>
        Could not load incident trend.{" "}
        {trends.error instanceof ApiError
          ? `(${trends.error.status}) ${trends.error.message}`
          : (trends.error as Error).message}
      </p>
    );
  }

  const items = trends.data.items;
  const rows: Row[] = items.map(toRow);
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  const peakDay = rows.reduce<Row | null>(
    (best, r) => (best === null || r.total > best.total ? r : best),
    null,
  );
  const ariaLabel =
    peakDay && peakDay.total > 0
      ? `Last ${days} days · ${total.toLocaleString()} incidents · peak ${peakDay.total} on ${peakDay.day}`
      : `Last ${days} days · no incidents`;

  return (
    <section aria-label={ariaLabel}>
      <div className="row row--between" style={{ marginBottom: "var(--sp-s)" }}>
        <p className="t-eyebrow">Trend · last {days} days</p>
        <p className="t-caption">
          {total.toLocaleString()} incidents
          {peakDay && peakDay.total > 0 ? ` · peak ${peakDay.total} on ${peakDay.day}` : ""}
        </p>
      </div>
      <div style={{ width: "100%", height: 200 }} role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
            barCategoryGap={2}
          >
            <CartesianGrid stroke="var(--stroke-3, #e5e5e5)" vertical={false} />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 10, fill: "var(--fg-3)" }}
              tickFormatter={shortDay}
              minTickGap={28}
            />
            <YAxis tick={{ fontSize: 10, fill: "var(--fg-3)" }} allowDecimals={false} width={28} />
            <Tooltip content={<TooltipBody />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
            {SEVERITY_LAYERS.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="severity"
                fill={s.colour}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {/* Legend rendered as a row of dots so we don't depend on Recharts'
       *  built-in <Legend> (which would force its own font + sizing). */}
      <div className="row" style={{ gap: "var(--sp-l)", marginTop: "var(--sp-s)" }}>
        {SEVERITY_LAYERS.map((s) => (
          <span
            key={s.key}
            className="t-caption"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                background: s.colour,
                borderRadius: 2,
              }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function toRow(b: IncidentTrendBucket): Row {
  return {
    day: b.day,
    high: b.bySeverity.high ?? 0,
    medium: b.bySeverity.medium ?? 0,
    low: b.bySeverity.low ?? 0,
    informational: b.bySeverity.informational ?? 0,
    unknown: b.bySeverity.unknown ?? 0,
    total: b.total,
  };
}

function shortDay(d: string): string {
  // yyyy-mm-dd → dd MMM (UTC). Locale-independent format keeps the tick
  // axis stable across browsers. Sample: "27 Apr".
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

function TooltipBody({ active, label, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((sum, p) => sum + (p.value ?? 0), 0);
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
  const m = SEVERITY_LAYERS.find((s) => s.key === key);
  return m ? m.label : key;
}
