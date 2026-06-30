// Saved-search persistence for the Incidents list (HANDOVER §6.3 menu
// item — "saved searches on Incidents"). v1 stores the operator's
// bookmarked filter sets in localStorage; cross-device sync would need
// a TenantSettings sub-row, deferred until an operator asks.
//
// The saved-search captures every dimension of the live filter state
// (severity chips + status chips + free-text query) so an operator
// can return to the exact same view in one click.

import { useCallback, useEffect, useState } from "react";
import type { IncidentSeverity, IncidentStatus } from "./types";

export interface SavedIncidentSearch {
  readonly id: string;
  readonly name: string;
  readonly sevFilters: Record<IncidentSeverity, boolean>;
  readonly statusFilters: Record<IncidentStatus, boolean>;
  readonly query: string;
}

const STORAGE_KEY = "aegis.incidents.savedSearches";
const SCHEMA_VERSION = 1;

interface PersistedShape {
  readonly schemaVersion: 1;
  readonly searches: readonly SavedIncidentSearch[];
}

/**
 * Read the persisted list from localStorage. Returns an empty array on
 * any parse error / missing storage so a corrupted entry doesn't break
 * the page — the operator can re-bookmark.
 */
function readStorage(): readonly SavedIncidentSearch[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return [];
    if (!Array.isArray(parsed.searches)) return [];
    return parsed.searches.filter(isValidSearch);
  } catch {
    return [];
  }
}

function writeStorage(searches: readonly SavedIncidentSearch[]): void {
  try {
    const body: PersistedShape = { schemaVersion: SCHEMA_VERSION, searches };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(body));
  } catch {
    // localStorage may be full / blocked — silently drop. The
    // in-memory copy stays consistent for this session.
  }
}

function isValidSearch(s: unknown): s is SavedIncidentSearch {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.query === "string" &&
    typeof o.sevFilters === "object" &&
    o.sevFilters !== null &&
    typeof o.statusFilters === "object" &&
    o.statusFilters !== null
  );
}

/**
 * Compare two filter states for exact-match selection highlighting.
 * Two saved searches are equivalent iff every chip flag matches AND the
 * query strings match. Used by the UI to show which saved-search chip
 * (if any) reflects the current filter state.
 */
export function isSameSearch(
  a: Pick<SavedIncidentSearch, "sevFilters" | "statusFilters" | "query">,
  b: Pick<SavedIncidentSearch, "sevFilters" | "statusFilters" | "query">,
): boolean {
  if (a.query !== b.query) return false;
  // Records are over closed string-literal unions so iterating either side's
  // keys covers the full set; iterate both as a defensive check against
  // partial-shape persistence (older entries that may be missing keys).
  const sevKeys = new Set<IncidentSeverity>([
    ...(Object.keys(a.sevFilters) as IncidentSeverity[]),
    ...(Object.keys(b.sevFilters) as IncidentSeverity[]),
  ]);
  for (const k of sevKeys) {
    if (a.sevFilters[k] !== b.sevFilters[k]) return false;
  }
  const statusKeys = new Set<IncidentStatus>([
    ...(Object.keys(a.statusFilters) as IncidentStatus[]),
    ...(Object.keys(b.statusFilters) as IncidentStatus[]),
  ]);
  for (const k of statusKeys) {
    if (a.statusFilters[k] !== b.statusFilters[k]) return false;
  }
  return true;
}

/** Generate a UUID for a new saved search. Uses crypto.randomUUID when
 *  available (every modern browser), falls back to a Math.random shim
 *  in older / vitest environments. */
function newId(): string {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `s-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Hook returning the saved-search list + add/remove operations.
 * Cross-tab sync via the `storage` event so a save in one tab updates
 * the chip row in others.
 */
export function useSavedIncidentSearches(): {
  searches: readonly SavedIncidentSearch[];
  add: (s: Omit<SavedIncidentSearch, "id">) => SavedIncidentSearch;
  remove: (id: string) => void;
} {
  const [searches, setSearches] = useState<readonly SavedIncidentSearch[]>(() => readStorage());

  useEffect(() => {
    const handler = (e: StorageEvent): void => {
      if (e.key === STORAGE_KEY) {
        setSearches(readStorage());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const add = useCallback((draft: Omit<SavedIncidentSearch, "id">): SavedIncidentSearch => {
    const created: SavedIncidentSearch = { ...draft, id: newId() };
    setSearches((cur) => {
      const next = [...cur, created];
      writeStorage(next);
      return next;
    });
    return created;
  }, []);

  const remove = useCallback((id: string): void => {
    setSearches((cur) => {
      const next = cur.filter((s) => s.id !== id);
      writeStorage(next);
      return next;
    });
  }, []);

  return { searches, add, remove };
}
