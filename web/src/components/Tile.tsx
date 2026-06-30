// Tile — base shell for every dashboard surface card.
//
// Visual contract (matches the redesign's `.tile` / `.tile__head` /
// `.tile__body` / `.tile__foot` markup): bordered article, eyebrow-style
// uppercase title in head, content body with `tile__body` padding, optional
// foot with metadata + action. AI-flavoured tiles add `tile--ai` for the
// brand-tinted bg variant per the chat transcript ("AI mark + tinted bg —
// distinct without shouting").
//
// Replaces the per-tile use of Fluent v9 `Card` / `CardHeader` directly.
// We keep Fluent React components for everything *inside* the tile (badges,
// buttons, skeletons, message bars); the tile shell itself is plain HTML
// for fine-grained layout control that Fluent's Card composition doesn't
// expose.

import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";

interface TileProps {
  /** All-caps eyebrow title in the head. */
  readonly title: string;
  /** Optional Fluent-style icon glyph rendered to the left of the title. */
  readonly icon?: IconName;
  /** Right-aligned meta row in the head — typically a FreshnessMeta or
   *  badge row. */
  readonly headMeta?: ReactNode;
  /** AI-narrative variant — adds the brand-tinted `tile--ai` class +
   *  re-enables the foot's transparent background per the design. */
  readonly ai?: boolean;
  /** Optional foot metadata text (left side). */
  readonly footMeta?: ReactNode;
  /** Optional foot action (right side) — typically a Refresh button. */
  readonly footAction?: ReactNode;
  /** Body content (the tile's primary content area). */
  readonly children: ReactNode;
  /** Forwarded for callers that need width / grid-cell overrides. */
  readonly style?: CSSProperties;
}

export function Tile({
  title,
  icon,
  headMeta,
  ai = false,
  footMeta,
  footAction,
  children,
  style,
}: TileProps): React.ReactElement {
  const showFoot = footMeta !== undefined || footAction !== undefined;
  return (
    <article className={`tile${ai ? " tile--ai" : ""}`} style={style}>
      <div className="tile__head">
        <h2 className="tile__title">
          {icon && <Icon name={icon} size={14} className="tile__title-icon" />}
          {title}
        </h2>
        {headMeta && <div className="tile__head-meta">{headMeta}</div>}
      </div>
      <div className="tile__body">{children}</div>
      {showFoot && (
        <div className="tile__foot">
          <span>{footMeta}</span>
          {footAction}
        </div>
      )}
    </article>
  );
}
