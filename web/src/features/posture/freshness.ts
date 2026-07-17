// Freshness + severity label mapping for the posture tile.

import type { PostureFreshness, PostureSeverity } from "./types.js";

export interface FreshnessDecision {
  readonly text: string;
  readonly tone: "success" | "warning" | "danger" | "informative";
}

export function freshnessLabel(f: PostureFreshness | undefined): FreshnessDecision | null {
  if (!f) return null;
  switch (f) {
    case "fresh":
      return null;
    case "stale_serviceable":
      return { text: "Posture is from last week (>7d)", tone: "warning" };
    case "stale_unservable":
      return { text: "Posture is very stale (>14d)", tone: "danger" };
  }
}

export function severityLabel(s: PostureSeverity | undefined): FreshnessDecision | null {
  if (!s || s === "unknown") return null;
  switch (s) {
    case "informational":
      return { text: "Informational", tone: "informative" };
    case "notable":
      return { text: "Notable", tone: "warning" };
    case "urgent":
      return { text: "Urgent", tone: "danger" };
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
