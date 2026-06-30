// Freshness + health-badge derivation for the Risky Users tile.
//
// Ingest cadence is 4 hours (ADR-0023 §1) so the stale thresholds are
// looser than Incidents' 30m / 60m: "stale" after one missed run (≤ 5h),
// "very stale" after two missed runs (> 8h).

import type { EntraRiskHealthStatus } from "./types.js";

export const STALE_AFTER_MS = 5 * 60 * 60 * 1000;
export const VERY_STALE_AFTER_MS = 8 * 60 * 60 * 1000;

export type BadgeState =
  | "healthy"
  | "stale"
  | "very_stale"
  | "degrading"
  | "failing"
  | "licence_required"
  | "awaiting_first_run"
  | "no_data";

export interface BadgeDecision {
  readonly state: BadgeState;
  readonly text: string;
  readonly tone: "success" | "warning" | "danger" | "informative";
}

export interface BadgeInputs {
  readonly healthStatus: EntraRiskHealthStatus;
  readonly ingestedAt: string | null;
  readonly nowMs?: number;
}

export function deriveRiskyUsersBadge(inputs: BadgeInputs): BadgeDecision | null {
  if (inputs.healthStatus === "licence_required") {
    return {
      state: "licence_required",
      text: "P2 required",
      tone: "informative",
    };
  }
  if (inputs.healthStatus === "awaiting_first_run") {
    return { state: "awaiting_first_run", text: "Awaiting first ingest", tone: "informative" };
  }
  if (inputs.healthStatus === "no_data") {
    return { state: "no_data", text: "No risky users", tone: "informative" };
  }
  if (inputs.healthStatus === "failing") {
    return { state: "failing", text: "Ingest failing", tone: "danger" };
  }
  if (inputs.healthStatus === "degrading") {
    return { state: "degrading", text: "Ingest retrying", tone: "warning" };
  }
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
  return null;
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
