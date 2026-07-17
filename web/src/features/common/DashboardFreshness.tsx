// Global "last refreshed" header for the dashboard. Reads the cached summary
// responses for every tile and reports the OLDEST ingest timestamp — so the
// header represents "every tile is at least this fresh". Tiles with no data
// yet (awaiting_first_run / licence_required / no_data) are excluded from
// the computation; when all four are in a no-data state the header is
// hidden rather than showing a misleading "just now".
//
// Consumes the React Query cache via the same hooks each tile uses; no
// extra HTTP requests — if a tile's data is already in cache (which it is
// on the dashboard page) the header just reads it.

import { Body1, tokens } from "@fluentui/react-components";
import { useAzureSecureScoreSummary } from "@/features/azure-secure-score/queries";
import { useBriefLatest } from "@/features/brief/queries";
import { useConditionalAccessSummary } from "@/features/conditional-access/queries";
import { useIncidentsSummary } from "@/features/incidents/queries";
import { useKevSummary } from "@/features/kev/queries";
import { useRansomwareIntelSummary } from "@/features/ransomware/queries";
import { useRiskyUsersSummary } from "@/features/risky-users/queries";
import { useSecureScoreLatest } from "@/features/secureScore/queries";
import { useSignInsSummary } from "@/features/sign-ins/queries";
import { useUserDormancySummary } from "@/features/user-dormancy/queries";
import { TILE_KEYS, type TileKey } from "@/features/settings/types";

/**
 * §10.58 INFO-2 — freshness-rollup registry.
 *
 * Every TileKey MUST appear in `FRESHNESS_REGISTRY`. The entry is either
 * `{ kind: "included", path }` — the dashboard rollup pulls a freshness
 * ISO from that path in the tile's cached query response — or
 * `{ kind: "excluded", reason }` — the surface has no meaningful ingest
 * cadence and is intentionally absent from the "every tile is at least
 * this fresh" calculation.
 *
 * Pre-registry, `useFreshnessCandidates` hand-listed 9 hook + path pairs
 * and tiles shipped after the original four (KEV, userDormancy, signIns,
 * conditionalAccess, azureSecureScore) were silently missed for weeks
 * until §10.58 caught the drift. The companion test
 * `dashboardFreshness.registry.test.ts` asserts every TileKey has an
 * entry so the next vertical can't fall out of the rollup again.
 */
export type FreshnessRegistryEntry =
  | { readonly kind: "included"; readonly path: string }
  | { readonly kind: "excluded"; readonly reason: string };

export const FRESHNESS_REGISTRY: Readonly<Record<TileKey, FreshnessRegistryEntry>> = {
  secureScore: { kind: "included", path: "data.snapshot.ingestedAt" },
  incidents: { kind: "included", path: "data.ingestedAt" },
  brief: { kind: "included", path: "data.generatedAt" },
  riskyUsers: { kind: "included", path: "data.ingestedAt" },
  posture: {
    kind: "excluded",
    reason:
      "ADR-0027 weekly AI narrative — out-of-cycle freshness isn't meaningful for the daily-rollup headline.",
  },
  stack: {
    kind: "excluded",
    reason:
      "ADR-0031 operator-curated inventory — no ingest cadence; tile's age is the operator's last edit time, surfaced inline.",
  },
  kev: { kind: "included", path: "data.health.lastSuccessAt" },
  userDormancy: { kind: "included", path: "data.ingestedAt" },
  signIns: { kind: "included", path: "data.ingestedAt" },
  conditionalAccess: { kind: "included", path: "data.health.lastSuccessAt" },
  azureSecureScore: { kind: "included", path: "data.health.lastSuccessAt" },
  ransomwareIntel: { kind: "included", path: "data.health.lastSuccessAt" },
};

/** Return the oldest ISO-8601 timestamp among the non-null candidates, or null. */
function oldest(candidates: readonly (string | null | undefined)[]): string | null {
  const real = candidates.filter((c): c is string => typeof c === "string" && c.length > 0);
  if (real.length === 0) return null;
  return real.sort()[0] ?? null;
}

/** Human-friendly "Xm ago" / "Xh ago" / "Xd ago" without external i18n deps. */
function formatAge(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const deltaMs = now.getTime() - t;
  if (deltaMs < 0) return "just now";
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Exposed for unit tests. */
export const _internal = { oldest, formatAge };

/**
 * Data-only variant — returns the freshness string (or null) without
 * rendering anything. Lets the new PageSubheader compose the freshness
 * pulse directly into its right-rail without nesting a component that
 * carries its own JSX. Same query inputs as `DashboardFreshness` so the
 * React Query cache is consulted once per mount.
 */
/**
 * Read the cached freshness ISO from each TileKey's query. Order MUST
 * match `TILE_KEYS` so the returned record is exhaustive — the companion
 * test asserts every TileKey is keyed here.
 *
 * Hooks are called unconditionally and in stable order (React's rules of
 * hooks). Excluded tiles still call their hook would call — they just
 * return `null` so the rollup ignores them. Currently `posture` + `stack`
 * are excluded and have no hooks to call.
 */
function useFreshnessByTile(): Readonly<Record<TileKey, string | null>> {
  // INCLUDED — each pull one timestamp out of the React Query cache.
  const secureScore = useSecureScoreLatest().data?.snapshot?.ingestedAt ?? null;
  const incidents = useIncidentsSummary().data?.ingestedAt ?? null;
  const brief = useBriefLatest().data?.generatedAt ?? null;
  const riskyUsers = useRiskyUsersSummary().data?.ingestedAt ?? null;
  const kev = useKevSummary().data?.health?.lastSuccessAt ?? null;
  const userDormancy = useUserDormancySummary().data?.ingestedAt ?? null;
  const signIns = useSignInsSummary().data?.ingestedAt ?? null;
  const conditionalAccess = useConditionalAccessSummary().data?.health?.lastSuccessAt ?? null;
  const azureSecureScore = useAzureSecureScoreSummary().data?.health?.lastSuccessAt ?? null;
  const ransomwareIntel = useRansomwareIntelSummary().data?.health?.lastSuccessAt ?? null;

  return {
    secureScore,
    incidents,
    brief,
    riskyUsers,
    posture: null, // excluded — see FRESHNESS_REGISTRY
    stack: null, // excluded — see FRESHNESS_REGISTRY
    kev,
    userDormancy,
    signIns,
    conditionalAccess,
    azureSecureScore,
    ransomwareIntel,
  };
}

function useFreshnessCandidates(): readonly (string | null)[] {
  const byTile = useFreshnessByTile();
  return TILE_KEYS.map((k) => byTile[k]);
}

export function useDashboardFreshness(): string | null {
  return formatAge(oldest(useFreshnessCandidates()));
}

export function DashboardFreshness() {
  const age = formatAge(oldest(useFreshnessCandidates()));
  if (!age) return null;

  return (
    <div
      aria-live="polite"
      style={{
        width: "100%",
        maxWidth: 720,
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
      }}
    >
      <Body1 block>
        Dashboard fully refreshed: <strong>{age}</strong>
      </Body1>
    </div>
  );
}
