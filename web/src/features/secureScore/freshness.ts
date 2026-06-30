// Freshness + health-badge derivation (ADR-0012 §3).
//
// Thresholds are client-side constants so the badge can be unit-tested
// without a server round-trip. The server-side `health.status` is the source
// of truth for `consecutiveFailures`; staleness is derived from `ingestedAt`.
// Precedence rule: server health flag wins over client-derived staleness

import type { IngestHealthStatus } from "./types.js";

export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;
export const VERY_STALE_AFTER_MS = 72 * 60 * 60 * 1000;

export type BadgeState =
  | "healthy"
  | "stale"
  | "very_stale"
  | "degrading"
  | "failing"
  | "awaiting_first_run"
  | "no_data";

export interface BadgeDecision {
  readonly state: BadgeState;
  readonly text: string;
  readonly tone: "success" | "warning" | "danger" | "informative";
}

export interface BadgeInputs {
  readonly healthStatus: IngestHealthStatus;
  readonly ingestedAt: string | null;
  readonly nowMs?: number; // for tests
}

export function deriveBadge(inputs: BadgeInputs): BadgeDecision | null {
  if (inputs.healthStatus === "awaiting_first_run") {
    return { state: "awaiting_first_run", text: "Awaiting first ingest", tone: "informative" };
  }
  if (inputs.healthStatus === "no_data") {
    return { state: "no_data", text: "No Microsoft Secure Score yet", tone: "informative" };
  }
  // Server health precedence.
  if (inputs.healthStatus === "failing") {
    return { state: "failing", text: "Ingest failing", tone: "danger" };
  }
  if (inputs.healthStatus === "degrading") {
    return { state: "degrading", text: "Ingest retrying", tone: "warning" };
  }
  // Healthy — consider staleness.
  if (!inputs.ingestedAt) return null;
  const now = inputs.nowMs ?? Date.now();
  const ingestedMs = Date.parse(inputs.ingestedAt);
  if (!Number.isFinite(ingestedMs)) return null;
  const age = now - ingestedMs;
  if (age > VERY_STALE_AFTER_MS) {
    return { state: "very_stale", text: "Very stale", tone: "warning" };
  }
  if (age > STALE_AFTER_MS) {
    return { state: "stale", text: "Stale", tone: "warning" };
  }
  return null; // Healthy and fresh — no badge.
}

export function formatRelative(iso: string | null, nowMs: number = Date.now()): string {
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
