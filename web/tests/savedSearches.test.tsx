// Tests for the saved-incident-searches feature — hook CRUD against
// localStorage and the isSameSearch comparator.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  isSameSearch,
  useSavedIncidentSearches,
  type SavedIncidentSearch,
} from "@/features/incidents/savedSearches";
import type { IncidentSeverity, IncidentStatus } from "@/features/incidents/types";

const STORAGE_KEY = "aegis.incidents.savedSearches";

const sevAllOff: Record<IncidentSeverity, boolean> = {
  high: false,
  medium: false,
  low: false,
  informational: false,
  unknown: false,
};
const statusAllOff: Record<IncidentStatus, boolean> = {
  active: false,
  inProgress: false,
  resolved: false,
  redirected: false,
  awaitingAction: false,
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("isSameSearch", () => {
  const baseline = {
    sevFilters: { ...sevAllOff, high: true, medium: true },
    statusFilters: { ...statusAllOff, active: true },
    query: "",
  };

  it("returns true for byte-identical state", () => {
    expect(isSameSearch(baseline, baseline)).toBe(true);
  });

  it("returns false when query differs", () => {
    expect(isSameSearch(baseline, { ...baseline, query: "alice" })).toBe(false);
  });

  it("returns false when any sev flag differs", () => {
    expect(
      isSameSearch(baseline, {
        ...baseline,
        sevFilters: { ...baseline.sevFilters, low: true },
      }),
    ).toBe(false);
  });

  it("returns false when any status flag differs", () => {
    expect(
      isSameSearch(baseline, {
        ...baseline,
        statusFilters: { ...baseline.statusFilters, resolved: true },
      }),
    ).toBe(false);
  });
});

describe("useSavedIncidentSearches", () => {
  it("starts empty when localStorage has no entry", () => {
    const { result } = renderHook(() => useSavedIncidentSearches());
    expect(result.current.searches).toEqual([]);
  });

  it("adds a search and persists it", () => {
    const { result } = renderHook(() => useSavedIncidentSearches());
    act(() => {
      result.current.add({
        name: "High + Medium · Active",
        sevFilters: { ...sevAllOff, high: true, medium: true },
        statusFilters: { ...statusAllOff, active: true },
        query: "",
      });
    });
    expect(result.current.searches).toHaveLength(1);
    expect(result.current.searches[0]?.name).toBe("High + Medium · Active");
    expect(result.current.searches[0]?.id).toBeTruthy();

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.searches).toHaveLength(1);
  });

  it("removes a search by id", () => {
    const { result } = renderHook(() => useSavedIncidentSearches());
    let created: SavedIncidentSearch | undefined;
    act(() => {
      created = result.current.add({
        name: "Test",
        sevFilters: sevAllOff,
        statusFilters: statusAllOff,
        query: "",
      });
    });
    expect(result.current.searches).toHaveLength(1);
    act(() => {
      result.current.remove(created!.id);
    });
    expect(result.current.searches).toHaveLength(0);
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(persisted.searches).toHaveLength(0);
  });

  it("loads pre-existing entries on mount", () => {
    const seed: SavedIncidentSearch = {
      id: "seed-1",
      name: "Pre-existing",
      sevFilters: sevAllOff,
      statusFilters: statusAllOff,
      query: "",
    };
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, searches: [seed] }),
    );
    const { result } = renderHook(() => useSavedIncidentSearches());
    expect(result.current.searches).toEqual([seed]);
  });

  it("returns empty list when localStorage value is corrupt", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not-json");
    const { result } = renderHook(() => useSavedIncidentSearches());
    expect(result.current.searches).toEqual([]);
  });

  it("returns empty list when schemaVersion mismatches", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schemaVersion: 99, searches: [{ id: "x" }] }),
    );
    const { result } = renderHook(() => useSavedIncidentSearches());
    expect(result.current.searches).toEqual([]);
  });
});
