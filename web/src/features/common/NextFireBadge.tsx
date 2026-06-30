// Compact "next fire in Nh / Nd" badge for the agent tiles.
// Bicep is the authoritative source for the cron strings; the server
// computes `nextFireAt` (ISO 8601 UTC) and ships it in the settings
// response. This component formats it as a relative future time —
// the user-visible string is plain prose, never a raw timestamp, so
// the tile keeps its conversational tone.
//
// `nextFireAt` may be null (e.g. an unrecognised cron shape, or the
// `incidents` agent which has no Timer); the component renders nothing
// in that case.

import { Badge, tokens } from "@fluentui/react-components";

interface Props {
  readonly nextFireAt: string | null | undefined;
  readonly nowMs?: number;
}

export function NextFireBadge({ nextFireAt, nowMs = Date.now() }: Props) {
  if (!nextFireAt) return null;
  const ms = Date.parse(nextFireAt);
  if (!Number.isFinite(ms) || ms <= nowMs) return null;
  return (
    <Badge appearance="outline" color="informative" style={{ fontWeight: 400 }}>
      <span style={{ color: tokens.colorNeutralForeground3 }}>
        Next run: {formatRelativeFuture(ms - nowMs)}
      </span>
    </Badge>
  );
}

/**
 * Render a positive millisecond delta with sub-unit precision so a 1h45m
 * next-fire reads "1h 45m" rather than "1h".
 * Breakpoints:
 *   - <1 min           → "<1 min"
 *   - <60 min          → "N min"
 *   - <24h             → "Nh Nm" (minutes suffix elided when zero)
 *   - <7d              → "Nd Nh" (hours suffix elided when zero)
 *   - ≥7d              → "Nd"
 * Ceiling is minute-granularity — sub-minute precision buys nothing for
 * a cron-scheduled fire whose actual tick jitters on seconds anyway.
 */
export function formatRelativeFuture(deltaMs: number): string {
  const totalMinutes = Math.floor(deltaMs / 60_000);
  if (totalMinutes < 1) return "<1 min";
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes - totalHours * 60;
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`;
  }

  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 7) {
    const hours = totalHours - totalDays * 24;
    return hours === 0 ? `${totalDays}d` : `${totalDays}d ${hours}h`;
  }
  // 7+ days: day-granularity is enough — operator is weeks away, the
  // hours remainder is cosmetic noise.
  return `${totalDays}d`;
}
