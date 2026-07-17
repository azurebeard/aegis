// ADR-0036 — narrow Microsoft.Security/secureScores ARM responses into the
// typed domain shape. Defensive on every field; skip-not-throw on malformed.
//
// The endpoint returns `value: SecureScore[]` where each entry has a
// `properties.score` object. v1 reads only the first entry (the
// per-subscription `ascScore` aggregate); future multi-policy support
// would iterate.

import type { SecureScoreApiResponse } from "./armClient.js";

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AzureSecureScoreDomain {
  readonly subscriptionId: string;
  readonly subscriptionName: string;
  readonly snapshotDate: string; // yyyy-mm-dd UTC
  readonly currentScore: number;
  readonly maxScore: number;
  readonly percentage: number;
  readonly weight: number;
  readonly ingestedAt: string;
  readonly ingestRunId: string;
}

export interface ParsedAzureSecureScore {
  readonly row: AzureSecureScoreDomain | null;
  readonly skippedReason?: string;
}

export interface ParseContext {
  readonly subscriptionId: string;
  readonly subscriptionName: string;
  readonly snapshotDate: string;
  readonly ingestedAt: string;
  readonly ingestRunId: string;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseAzureSecureScore(
  raw: SecureScoreApiResponse,
  ctx: ParseContext,
): ParsedAzureSecureScore {
  if (!GUID_RE.test(ctx.subscriptionId)) {
    return { row: null, skippedReason: "subscriptionId is not a GUID" };
  }
  if (!Array.isArray(raw.value) || raw.value.length === 0) {
    return { row: null, skippedReason: "secureScores response had no value entries" };
  }
  // Pick the first entry. ARM typically returns a single `ascScore`
  // per subscription.
  const first = raw.value[0]!;
  const props = first.properties;
  if (!props || typeof props !== "object") {
    return { row: null, skippedReason: "first secureScore entry has no properties" };
  }
  const score = props.score;
  if (!score || typeof score !== "object") {
    return { row: null, skippedReason: "first secureScore entry has no score block" };
  }
  const current = asNumber(score.current);
  const max = asNumber(score.max);
  if (current === null || max === null || max <= 0) {
    return { row: null, skippedReason: "score.current/max missing or non-finite" };
  }
  // ADR-0036 v1.1 observation — trust ARM-supplied `percentage` when
  // present (ships in 0..1 range per Microsoft.Security/secureScores
  // schema), scaled to our 0..100 convention. Falls back to the
  // current/max re-derivation when the field is absent or malformed,
  // so a future API-shape change can't silently zero the trend.
  // Defensive band-check: if the supplied value is implausible
  // (negative, NaN, > 1 by more than rounding tolerance), we ignore
  // it and re-derive.
  const armPct = asNumber(score.percentage);
  const percentage =
    armPct !== null && armPct >= 0 && armPct <= 1.0001
      ? armPct * 100
      : (current / max) * 100;
  const weight = asNumber(props.weight) ?? 1;

  return {
    row: {
      subscriptionId: ctx.subscriptionId.toLowerCase(),
      subscriptionName: ctx.subscriptionName,
      snapshotDate: ctx.snapshotDate,
      currentScore: current,
      maxScore: max,
      percentage,
      weight,
      ingestedAt: ctx.ingestedAt,
      ingestRunId: ctx.ingestRunId,
    },
  };
}
