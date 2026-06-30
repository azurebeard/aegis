// `react/no-danger` is enabled as an error for this feature folder via
// `web/eslint.config.mjs` (ADR-0012 §5). No `dangerouslySetInnerHTML`.

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { tokens } from "@fluentui/react-components";
import type { SecureScoreTrendEntry } from "./types.js";

export interface SecureScoreTrendProps {
  readonly data: readonly SecureScoreTrendEntry[];
  readonly height?: number;
  readonly ariaLabel?: string;
  /** Show axes / gridlines / tooltip. Defaults to true; pass `false` for a
   *  bare sparkline (no axis labels) on extremely compact surfaces. The
   *  trend tile uses true (axes help operators read the date range and
   *  percentage scale at a glance, which was a directly-requested gap). */
  readonly showAxes?: boolean;
}

/**
 * Secure Score percentage trend line.
 *
 * Default form ships axes + gridlines + a date+percentage tooltip — operators
 * need to see the percentage scale (Y axis 0-100) and the date range (X axis)
 * to read the chart, especially after a discontinuity (e.g. when Microsoft
 * re-baselines maxScore mid-month).
 *
 * Mirrors the IncidentsTrendsChart pattern (recharts + design-token styling)
 * for visual consistency across the dashboard.
 */
export function SecureScoreTrend({
  data,
  height = 120,
  ariaLabel,
  showAxes = true,
}: SecureScoreTrendProps) {
  if (data.length === 0) {
    return (
      <div
        style={{ height, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 }}
        role="img"
        aria-label={ariaLabel ?? "No trend data available"}
      >
        —
      </div>
    );
  }
  const first = data[0];
  const last = data[data.length - 1];
  const derivedLabel =
    first && last
      ? `Trend: ${first.percentage.toFixed(1)}% on ${first.snapshotDate} to ${last.percentage.toFixed(1)}% on ${last.snapshotDate}`
      : "Trend";
  const stroke = tokens.colorBrandForeground1;
  const gridColour = "var(--stroke-3, #e5e5e5)";
  const tickColour = "var(--fg-3, #757575)";
  return (
    <div role="img" aria-label={ariaLabel ?? derivedLabel} style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data as SecureScoreTrendEntry[]}
          margin={
            showAxes
              ? { top: 8, right: 8, bottom: 0, left: 0 }
              : { top: 4, right: 0, bottom: 4, left: 0 }
          }
        >
          {showAxes ? <CartesianGrid stroke={gridColour} vertical={false} /> : null}
          {showAxes ? (
            <XAxis
              dataKey="snapshotDate"
              tick={{ fontSize: 10, fill: tickColour }}
              tickFormatter={shortDay}
              minTickGap={28}
              stroke={gridColour}
            />
          ) : null}
          {showAxes ? (
            <YAxis
              tick={{ fontSize: 10, fill: tickColour }}
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v: number) => `${v}%`}
              width={36}
              stroke={gridColour}
            />
          ) : null}
          {showAxes ? <Tooltip content={<TrendTooltip />} cursor={{ stroke: gridColour }} /> : null}
          <Line
            type="monotone"
            dataKey="percentage"
            stroke={stroke}
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** yyyy-mm-dd → "dd MMM" (UTC). Locale-independent so axis ticks remain
 *  stable across browsers. Mirrors the IncidentsTrendsChart helper. */
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

interface TooltipPayload {
  readonly value: number;
  readonly payload: SecureScoreTrendEntry;
}

interface TooltipProps {
  readonly active?: boolean;
  readonly label?: string;
  readonly payload?: readonly TooltipPayload[];
}

function TrendTooltip({ active, label, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0];
  if (!p) return null;
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
      <p className="t-body">
        <strong>{p.value.toFixed(1)}%</strong>
        <span className="t-body--mute" style={{ marginLeft: 4 }}>
          {p.payload.currentScore} / {p.payload.maxScore}
        </span>
      </p>
    </div>
  );
}
