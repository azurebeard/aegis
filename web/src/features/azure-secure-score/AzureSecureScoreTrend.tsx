// 90-day trend line for Defender for Cloud Secure Score. Mirrors the
// Microsoft Secure Score trend chart visually, but with the simpler
// AzureSecureScoreTrendPoint shape (no currentScore / maxScore on the
// trend points — daily aggregate snapshots only).
//
// Kept separate from secureScore/SecureScoreTrend on the "feature folder
// owns its display" pattern. Sharing would require generalising the
// tooltip + entry type and the marginal complexity isn't worth the win.

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
import type { AzureSecureScoreTrendPoint } from "./types";

export interface AzureSecureScoreTrendProps {
  readonly data: readonly AzureSecureScoreTrendPoint[];
  readonly height?: number;
  readonly ariaLabel?: string;
}

export function AzureSecureScoreTrend({
  data,
  height = 120,
  ariaLabel,
}: AzureSecureScoreTrendProps) {
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
          data={data as AzureSecureScoreTrendPoint[]}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid stroke={gridColour} vertical={false} />
          <XAxis
            dataKey="snapshotDate"
            tick={{ fontSize: 10, fill: tickColour }}
            tickFormatter={shortDay}
            minTickGap={28}
            stroke={gridColour}
          />
          <YAxis
            tick={{ fontSize: 10, fill: tickColour }}
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={36}
            stroke={gridColour}
          />
          <Tooltip content={<TrendTooltip />} cursor={{ stroke: gridColour }} />
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
  readonly payload: AzureSecureScoreTrendPoint;
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
      </p>
    </div>
  );
}
