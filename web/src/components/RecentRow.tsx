// RecentRow — single dense row replacing the pre-redesign "most recent"
// tile-within-a-tile pattern. Used inside IncidentsTile + RiskyUsersTile.
//
// Layout: title (truncated) + meta line on the left, badge stack on the
// right. Optional onClick + role="button" makes the whole row a single
// click target — operators land on the detail drawer / list with one
// gesture from the dashboard.

import type { ReactNode } from "react";

interface RecentRowProps {
  readonly label: string;
  readonly title: string;
  readonly time: string;
  readonly badges?: readonly { label: string; tone: string }[];
  readonly onClick?: () => void;
}

export function RecentRow({
  label,
  title,
  time,
  badges,
  onClick,
}: RecentRowProps): React.ReactElement {
  const interactive = onClick !== undefined;
  return (
    <div
      className="recent-row"
      style={interactive ? { cursor: "pointer" } : undefined}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onClick?.();
            }
          : undefined
      }
    >
      <div className="recent-row__main">
        <p className="recent-row__title truncate">{title}</p>
        <span className="recent-row__meta">
          <span>{label}</span>
          <span aria-hidden="true">·</span>
          <span>{time}</span>
        </span>
      </div>
      {badges && badges.length > 0 && (
        <div style={{ display: "flex", gap: 4 }}>
          {badges.map((b, i) => (
            <span
              key={`${b.label}-${i}` as ReactNode as string}
              className={`badge badge--${b.tone}`}
            >
              {b.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
