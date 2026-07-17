// FreshnessMeta — Fluent Caption1-style inline timing strip used in tile
// heads to replace the redesign's predecessor "compound badge" stack.
// Pattern source: `docs/ui-pack/aegis-ui-snapshot.html` + the redesign
// chat where badge proliferation (4+ badges per tile) was item #2 on the
// design-asks list. The replacement is a single inline meta line with
// optional accent tone + small icon per segment.
//
// Each segment is `{ icon?, label, tone?: "accent" | "mute" }`. The accent
// tone keys off the design's `--green-fg` for "Generated 4h ago" style
// liveness; mute is the default fg-3 colour.

import { Icon, type IconName } from "@/components/Icon";

export interface FreshnessSegment {
  readonly icon?: IconName;
  readonly label: string;
  readonly tone?: "accent" | "mute";
}

interface FreshnessMetaProps {
  readonly segments: readonly FreshnessSegment[];
}

export function FreshnessMeta({ segments }: FreshnessMetaProps): React.ReactElement {
  return (
    <span className="freshness-meta">
      {segments.map((s, i) => (
        <span key={`${s.label}-${i}`} style={{ display: "contents" }}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <span className={s.tone === "accent" ? "freshness-meta__accent" : ""}>
            {s.icon && <Icon name={s.icon} size={11} />}
            {s.label}
          </span>
        </span>
      ))}
    </span>
  );
}
