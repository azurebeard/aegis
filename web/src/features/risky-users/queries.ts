// TanStack Query hooks for /api/risky-users/* (ADR-0024 §3).
//
// 4h ingest cadence → longer client-side staleTimes than incidents.
// `licence_required` status → 1h staleTime override (ADR-0024 §3).

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  RiskyUsersListFilters,
  RiskyUsersListResponse,
  RiskyUsersSummaryResponse,
} from "./types.js";

const ONE_HOUR_MS = 60 * 60_000;
const FIVE_MIN_MS = 5 * 60_000;

export function useRiskyUsersSummary() {
  return useQuery<RiskyUsersSummaryResponse>({
    queryKey: ["risky-users", "summary"],
    queryFn: async () => {
      const data = await api.get<RiskyUsersSummaryResponse>("/api/risky-users/summary");
      return data;
    },
    // Dynamic staleTime: a tile in `licence_required` shouldn't be polled
    // every 5 minutes. ADR-0024 §3 calls for 1h on that status.
    staleTime: FIVE_MIN_MS,
    refetchInterval: (query) => {
      const data = query.state.data as RiskyUsersSummaryResponse | undefined;
      if (data?.health.status === "licence_required") return ONE_HOUR_MS;
      return FIVE_MIN_MS;
    },
    refetchOnWindowFocus: true,
  });
}

export function useRiskyUsersList(filters: RiskyUsersListFilters) {
  const search = buildQueryString(filters);
  return useQuery<RiskyUsersListResponse>({
    queryKey: ["risky-users", "list", search],
    queryFn: () => api.get<RiskyUsersListResponse>(`/api/risky-users/list${search}`),
    staleTime: FIVE_MIN_MS,
    refetchOnWindowFocus: false,
  });
}

export function buildQueryString(filters: RiskyUsersListFilters): string {
  const params = new URLSearchParams();
  for (const l of filters.riskLevel ?? []) params.append("riskLevel", l);
  for (const s of filters.riskState ?? []) params.append("riskState", s);
  if (filters.since) params.set("since", filters.since);
  if (filters.includeDeleted === true) params.set("includeDeleted", "true");
  if (filters.includeRemediated === true) params.set("includeRemediated", "true");
  if (typeof filters.limit === "number") params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);
  const s = params.toString();
  return s ? `?${s}` : "";
}
