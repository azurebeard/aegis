// ADR-0037 Layer 5 — React Query hooks for /api/ransomware-intel/*.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { RansomwareIntelList, RansomwareIntelRowKind, RansomwareIntelSummary } from "./types";

export const RANSOMWARE_INTEL_SUMMARY_KEY = ["ransomwareIntel", "summary"] as const;
export const RANSOMWARE_INTEL_LIST_KEY = ["ransomwareIntel", "list"] as const;

export function useRansomwareIntelSummary() {
  return useQuery<RansomwareIntelSummary>({
    queryKey: RANSOMWARE_INTEL_SUMMARY_KEY,
    queryFn: () => api.get<RansomwareIntelSummary>("/api/ransomware-intel/summary"),
    // Matches the server's `private, max-age=30` Cache-Control on the
    // summary endpoint — refetch-on-focus past 30s, otherwise serve
    // cached.
    staleTime: 30_000,
  });
}

export interface UseRansomwareIntelListParams {
  /** When set, narrows the response to one row family. Omit / "all" to
   *  get the blended chronological list. */
  readonly kind?: RansomwareIntelRowKind | "all";
  /** 1–200; defaults to 100 (matches the server-side default). */
  readonly limit?: number;
}

export function useRansomwareIntelList(params: UseRansomwareIntelListParams = {}) {
  const kind = params.kind ?? "all";
  const limit = params.limit ?? 100;
  return useQuery<RansomwareIntelList>({
    queryKey: [...RANSOMWARE_INTEL_LIST_KEY, kind, limit],
    queryFn: () => {
      const q = new URLSearchParams();
      q.set("limit", String(limit));
      if (kind !== "all") q.set("kind", kind);
      return api.get<RansomwareIntelList>(`/api/ransomware-intel/list?${q.toString()}`);
    },
    // Matches the server's `private, max-age=60` on the list endpoint.
    staleTime: 60_000,
  });
}
