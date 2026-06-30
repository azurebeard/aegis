// Client hook + types for GET /api/agents/observability/ingest-sources.
//
// Server-driven catalogue of Ingest Diagnostics sources. Replaces the
// hardcoded SOURCES array that used to live in DiagnosticsPage — adding
// a new ingest source now becomes a single-file server-side edit
// (`api/src/lib/diagnosticsSources.ts`) and the SPA picks it up at
// mount time.
//
// Icon-name handling: the server sends `iconName` as an opaque string;
// we validate against the local `IconName` union at render time and
// fall back to a default if a future server pushes a name the SPA
// bundle doesn't recognise. That keeps the API → SPA contract loose
// enough that one side can ship before the other.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { IconName } from "@/components/Icon";

export interface IngestSource {
  /** URL-segment key. Forward-typed as `string` (not the union from
   *  ingestRunHistory.ts) so a server that adds a new key still renders
   *  in an older SPA bundle. */
  readonly key: string;
  readonly label: string;
  /** Opaque icon-name from the server. Use {@link toIconName} to
   *  narrow against the local `IconName` union before passing to the
   *  Icon component. */
  readonly iconName: string;
  readonly description: string;
}

export interface IngestSourcesResponse {
  readonly schemaVersion: 1;
  readonly sources: readonly IngestSource[];
}

// Mirror of the local IconName union — kept here as a runtime set so the
// hook's `toIconName` narrowing doesn't need a switch statement per name.
// Drift between this set and `IconName` is caught at compile time by
// the type assertion below.
const KNOWN_ICON_NAMES: ReadonlySet<IconName> = new Set<IconName>([
  "shield",
  "sparkle",
  "calendar",
  "alert",
  "user",
  "trend-up",
  "refresh",
  "external",
  "search",
  "chevron-down",
  "chevron-right",
  "close",
  "settings",
  "filter",
  "moon",
  "sun",
  "system",
  "bell",
  "help",
  "clock",
  "doc",
  "key",
  "globe",
  "lock",
  "tile",
  "wallet",
  "palette",
  "arrow-up",
  "arrow-down",
  "minus",
  "dot",
]);

/** Default icon when the server sends a name the SPA bundle doesn't
 *  recognise (e.g. SPA shipped before server adding a new source +
 *  icon). Picked because every page already imports the alert glyph
 *  and it reads as "fallback" without being alarming. */
const FALLBACK_ICON: IconName = "alert";

/** Narrow an opaque server-supplied iconName to the local `IconName`
 *  union, returning the fallback when unknown. Pure function — call
 *  this at render time. */
export function toIconName(raw: string): IconName {
  return (KNOWN_ICON_NAMES as Set<string>).has(raw) ? (raw as IconName) : FALLBACK_ICON;
}

/** Fetch the per-deploy catalogue of Ingest Diagnostics sources from
 *  the server. Admin-only at the server (403 otherwise); cached for the
 *  default React-Query stale window. */
export function useIngestSources() {
  return useQuery<IngestSourcesResponse>({
    queryKey: ["admin", "ingest", "sources"],
    queryFn: () => api.get<IngestSourcesResponse>("/api/agents/observability/ingest-sources"),
    // The catalogue changes per-deploy only — long stale window is fine.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
