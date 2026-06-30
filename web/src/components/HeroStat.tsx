// HeroStat — large tabular-num display for top-of-tile metrics
// (Secure Score "537 / 680", Incidents "8 total", Risky Users "14").
// Optional inline delta with up/down/flat icon and tone.

import { Icon } from "@/components/Icon";

interface HeroStatProps {
  readonly value: string | number;
  readonly denominator?: string | number;
  readonly delta?: string;
  readonly deltaTone?: "up" | "down" | "flat";
  readonly caption?: string;
  readonly small?: boolean;
}

export function HeroStat({
  value,
  denominator,
  delta,
  deltaTone = "flat",
  caption,
  small = false,
}: HeroStatProps): React.ReactElement {
  return (
    <div>
      <div className="hero-stat">
        <span className={`hero-stat__num${small ? " hero-stat__num--small" : ""}`}>{value}</span>
        {denominator !== undefined && <span className="hero-stat__den">/ {denominator}</span>}
        {delta && (
          <span className={`hero-stat__delta hero-stat__delta--${deltaTone}`}>
            <Icon
              name={deltaTone === "up" ? "arrow-up" : deltaTone === "down" ? "arrow-down" : "minus"}
              size={12}
            />
            {delta}
          </span>
        )}
      </div>
      {caption && (
        <p className="t-caption" style={{ marginTop: 4 }}>
          {caption}
        </p>
      )}
    </div>
  );
}
