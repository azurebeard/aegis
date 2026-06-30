// Parse Microsoft Graph `secureScore` objects into the internal snapshot shape.
// Pure function — no SDK, no I/O, no logging. Unit-tested in isolation.
// See ADR-0012 §1.1 (server-authoritative percentage) and §5 (untrusted-field
// policy: prose is rendered plain-text only; no HTML stripping here since the
// web tile handles rendering).

import type { SecureScore } from "@microsoft/microsoft-graph-types";
import type { SecureScoreSnapshot } from "./types.js";

/**
 * Derive the snapshot date (yyyy-MM-dd) from Graph's `createdDateTime` in UTC.
 * Stable across locales — uses explicit UTC components rather than toISOString
 * slicing to tolerate inputs that are already date-only.
 */
export function deriveSnapshotDate(createdDateTime: string): string {
  const d = new Date(createdDateTime);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid createdDateTime: ${createdDateTime}`);
  }
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Deterministic percentage rounded to 1 d.p.
 *
 * `toFixed` uses banker's-ish rounding under IEEE 754, but for our fixed
 * two-operand shape (current/max * 100) the edge-case drift is below 0.05
 * points and tests assert the specific values. This is acceptable for a
 * display-only field; the wire carries both `currentScore` and `maxScore`
 * so clients can recompute if a different rounding is ever required.
 */
export function computePercentage(current: number, max: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return 0;
  const raw = (current / max) * 100;
  return Number(raw.toFixed(1));
}

export interface ParseSnapshotOptions {
  readonly ingestedAt: string; // ISO8601 UTC — set by caller (the handler clock)
  readonly ingestRunId: string; // GUID — correlates to audit/AI operation id
}

/**
 * Convert a Graph `secureScore` object into our internal snapshot shape.
 *
 * Validation is conservative: required numeric fields must be finite numbers;
 * any missing arrays default to empty; the `id` field is preserved verbatim.
 * A throw signals an unexpected shape that should surface as an ingest failure
 * (never a silent write).
 */
export function parseSecureScore(
  graphScore: SecureScore,
  options: ParseSnapshotOptions,
): SecureScoreSnapshot {
  if (!graphScore.createdDateTime) {
    throw new Error("graph secureScore missing createdDateTime");
  }
  if (typeof graphScore.currentScore !== "number" || !Number.isFinite(graphScore.currentScore)) {
    throw new Error("graph secureScore currentScore is not a finite number");
  }
  if (typeof graphScore.maxScore !== "number" || !Number.isFinite(graphScore.maxScore)) {
    throw new Error("graph secureScore maxScore is not a finite number");
  }

  const snapshotDate = deriveSnapshotDate(graphScore.createdDateTime);
  const currentScore = graphScore.currentScore;
  const maxScore = graphScore.maxScore;

  return {
    snapshotDate,
    createdDateTime: graphScore.createdDateTime,
    ingestedAt: options.ingestedAt,
    currentScore,
    maxScore,
    percentage: computePercentage(currentScore, maxScore),
    activeUserCount: toFiniteNumber(graphScore.activeUserCount),
    licensedUserCount: toFiniteNumber(graphScore.licensedUserCount),
    enabledServices: graphScore.enabledServices ?? [],
    averageComparativeScores: (graphScore.averageComparativeScores ?? []).map((a) => ({
      basis: a.basis ?? "",
      averageScore: toFiniteNumber(a.averageScore),
    })),
    controlScores: (graphScore.controlScores ?? []).map((c) => ({
      controlCategory: c.controlCategory ?? "",
      controlName: c.controlName ?? "",
      description: c.description ?? "",
      score: toFiniteNumber(c.score),
    })),
    graphId: graphScore.id ?? `${snapshotDate}-unknown`,
    ingestRunId: options.ingestRunId,
  };
}

function toFiniteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
