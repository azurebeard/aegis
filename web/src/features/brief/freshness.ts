// Freshness label mapping for the brief tile.

import type { BriefFreshness } from "./types.js";

export interface FreshnessDecision {
  readonly text: string;
  readonly tone: "success" | "warning" | "danger" | "informative";
}

export function freshnessLabel(f: BriefFreshness | undefined): FreshnessDecision | null {
  if (!f) return null;
  switch (f) {
    case "fresh":
      return null; // no badge — quiet success
    case "stale_serviceable":
      return { text: "Brief is stale (>26h)", tone: "warning" };
    case "stale_unservable":
      return { text: "Brief is very stale (>72h)", tone: "danger" };
  }
}

export function formatRelative(iso: string | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const delta = Math.max(0, nowMs - ms);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
