// React Query hooks for /api/posture/*.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  PostureByWeekResponse,
  PostureHistoryResponse,
  PostureLatestResponse,
} from "./types.js";

export function usePostureLatest() {
  return useQuery<PostureLatestResponse>({
    queryKey: ["posture", "latest"],
    // Weekly cadence — five-minute staleTime aligns with the server
    // Cache-Control: private, max-age=300 (ADR-0027 §Decision.5).
    queryFn: () => api.get<PostureLatestResponse>("/api/posture/latest"),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function usePostureByWeek(isoWeek: string | null) {
  return useQuery<PostureByWeekResponse>({
    queryKey: ["posture", "byWeek", isoWeek],
    enabled: isoWeek !== null && /^\d{4}-W\d{2}$/.test(isoWeek),
    queryFn: () => api.get<PostureByWeekResponse>(`/api/posture/${isoWeek as string}`),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function usePostureHistory(limit = 12) {
  return useQuery<PostureHistoryResponse>({
    queryKey: ["posture", "history", limit],
    queryFn: () => api.get<PostureHistoryResponse>(`/api/posture/history?limit=${limit}`),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
