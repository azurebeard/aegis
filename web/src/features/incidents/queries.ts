// TanStack Query hooks for the Incidents endpoints (ADR-0016 §3).
//
// Client-side staleTime matches or exceeds the server-side Cache-Control so
// the browser cache and React Query cache don't fight each other — the 15-min
// ingest cadence means a 60-second tile refresh is plenty fresh.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  IncidentDetailResponse,
  IncidentsListFilters,
  IncidentsListResponse,
  IncidentsSummaryResponse,
  IncidentsTrendsResponse,
} from "./types.js";

export function useIncidentsSummary() {
  return useQuery<IncidentsSummaryResponse>({
    queryKey: ["incidents", "summary"],
    queryFn: () => api.get<IncidentsSummaryResponse>("/api/incidents/summary"),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useIncidentsList(filters: IncidentsListFilters) {
  const search = buildQueryString(filters);
  return useQuery<IncidentsListResponse>({
    queryKey: ["incidents", "list", search],
    queryFn: () => api.get<IncidentsListResponse>(`/api/incidents${search}`),
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useIncidentsTrends(days = 30) {
  return useQuery<IncidentsTrendsResponse>({
    queryKey: ["incidents", "trends", days],
    queryFn: () => api.get<IncidentsTrendsResponse>(`/api/incidents/trends?days=${days}`),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useIncidentDetail(id: string | null) {
  return useQuery<IncidentDetailResponse>({
    queryKey: ["incidents", "detail", id],
    enabled: id !== null && id.length > 0,
    queryFn: () =>
      api.get<IncidentDetailResponse>(`/api/incidents/${encodeURIComponent(id as string)}`),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function buildQueryString(filters: IncidentsListFilters): string {
  const params = new URLSearchParams();
  for (const s of filters.severity ?? []) params.append("severity", s);
  for (const s of filters.status ?? []) params.append("status", s);
  for (const s of filters.classification ?? []) params.append("classification", s);
  if (filters.since) params.set("since", filters.since);
  if (filters.includeRedirected === true) params.set("includeRedirected", "true");
  if (typeof filters.limit === "number") params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);
  const s = params.toString();
  return s ? `?${s}` : "";
}
