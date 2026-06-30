// Icon — façade over `@fluentui/react-icons` matching the Aegis design
// system's icon-name API (shield, sparkle, calendar, etc. — see the
// design source at `docs/ui-pack/aegis-ui-snapshot.html`).
//
// Single source of truth for every icon used in the app shell, tiles,
// drawer, and admin surfaces. Sized via the `size` prop (default 16).
// Falls back to `null` for unknown names so an icon-less consumer
// renders no chrome rather than crashing.
//
// We import individual icon components by canonical Fluent name; tree-
// shaking keeps the bundle slim. When a design icon doesn't have a
// 1:1 Fluent equivalent we pick the nearest visual cognate and
// document the substitution inline.

import {
  Alert20Regular,
  AppsList20Regular,
  ArrowDown16Regular,
  ArrowSync20Regular,
  ArrowTrending20Regular,
  ArrowUp16Regular,
  Calendar20Regular,
  ChevronDown12Regular,
  ChevronRight12Regular,
  Circle12Filled,
  Clock20Regular,
  Color20Regular,
  Desktop20Regular,
  Dismiss20Regular,
  Document20Regular,
  Filter20Regular,
  type FluentIcon,
  Globe20Regular,
  Key20Regular,
  LineHorizontal116Regular,
  LockClosed20Regular,
  Open20Regular,
  Person20Regular,
  QuestionCircle20Regular,
  Search20Regular,
  ServiceBell20Regular,
  Settings20Regular,
  Shield20Regular,
  Sparkle20Regular,
  Wallet20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular,
} from "@fluentui/react-icons";
import type { CSSProperties } from "react";

export type IconName =
  | "shield"
  | "sparkle"
  | "calendar"
  | "alert"
  | "user"
  | "trend-up"
  | "refresh"
  | "external"
  | "search"
  | "chevron-down"
  | "chevron-right"
  | "close"
  | "settings"
  | "filter"
  | "moon"
  | "sun"
  | "system"
  | "bell"
  | "help"
  | "clock"
  | "doc"
  | "key"
  | "globe"
  | "lock"
  | "tile"
  | "wallet"
  | "palette"
  | "arrow-up"
  | "arrow-down"
  | "minus"
  | "dot";

interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const ICON_MAP: Record<IconName, FluentIcon> = {
  shield: Shield20Regular,
  sparkle: Sparkle20Regular,
  calendar: Calendar20Regular,
  // Alert20Regular is the canonical Fluent "alert" — the design's
  // triangle-with-bang glyph; close visual match.
  alert: Alert20Regular,
  user: Person20Regular,
  "trend-up": ArrowTrending20Regular,
  // ArrowSync is the canonical Fluent "refresh" / "sync" glyph.
  refresh: ArrowSync20Regular,
  external: Open20Regular,
  search: Search20Regular,
  "chevron-down": ChevronDown12Regular,
  "chevron-right": ChevronRight12Regular,
  close: Dismiss20Regular,
  settings: Settings20Regular,
  filter: Filter20Regular,
  moon: WeatherMoon20Regular,
  sun: WeatherSunny20Regular,
  system: Desktop20Regular,
  // Fluent's "ServiceBell" is the closest semantic match for the
  // notifications-bell glyph (the simple Bell name is reserved for
  // various other size/shape variants without a 20Regular).
  bell: ServiceBell20Regular,
  help: QuestionCircle20Regular,
  clock: Clock20Regular,
  doc: Document20Regular,
  key: Key20Regular,
  globe: Globe20Regular,
  // Fluent uses LockClosed to disambiguate from LockOpen; semantically
  // equivalent to the design's `lock` icon.
  lock: LockClosed20Regular,
  // Tile glyph approximates the 4-square design icon via Fluent's
  // AppsList equivalent.
  tile: AppsList20Regular,
  wallet: Wallet20Regular,
  palette: Color20Regular,
  "arrow-up": ArrowUp16Regular,
  "arrow-down": ArrowDown16Regular,
  minus: LineHorizontal116Regular,
  dot: Circle12Filled,
};

export function Icon({ name, size = 16, className, style }: IconProps): React.ReactElement | null {
  const Component = ICON_MAP[name];
  if (!Component) return null;
  // Fluent icons render as <svg> with intrinsic size from the variant
  // (12 / 16 / 20 / 24 / 28 / 32 / 48). Override via inline style for
  // pixel-precise sizing — matches the design's `size` prop semantics.
  const merged: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    ...style,
  };
  // Spread `className` only when defined to satisfy
  // exactOptionalPropertyTypes — Fluent's icon component types
  // explicitly require a string (no undefined).
  return <Component {...(className !== undefined ? { className } : {})} style={merged} />;
}
