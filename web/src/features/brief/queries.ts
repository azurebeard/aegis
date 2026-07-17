// React Query hooks for /api/brief/*.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { BriefByDateResponse, BriefHistoryResponse, BriefLatestResponse } from "./types.js";

export function useBriefLatest() {
  return useQuery<BriefLatestResponse>({
    queryKey: ["brief", "latest"],
    queryFn: () => api.get<BriefLatestResponse>("/api/brief/latest"),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useBriefByDate(date: string | null) {
  return useQuery<BriefByDateResponse>({
    queryKey: ["brief", "byDate", date],
    enabled: date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date),
    queryFn: () => api.get<BriefByDateResponse>(`/api/brief/${date as string}`),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useBriefHistory(limit = 14) {
  return useQuery<BriefHistoryResponse>({
    queryKey: ["brief", "history", limit],
    queryFn: () => api.get<BriefHistoryResponse>(`/api/brief/history?limit=${limit}`),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
