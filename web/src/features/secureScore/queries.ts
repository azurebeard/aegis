import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  SecureScoreControlProfilesResponse,
  SecureScoreLatestResponse,
  SecureScoreTrendResponse,
} from "./types.js";

export function useSecureScoreLatest() {
  return useQuery<SecureScoreLatestResponse>({
    queryKey: ["secure-score", "latest"],
    queryFn: () => api.get<SecureScoreLatestResponse>("/api/secure-score/latest"),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function useSecureScoreControlProfiles() {
  return useQuery<SecureScoreControlProfilesResponse>({
    queryKey: ["secure-score", "controlProfiles"],
    queryFn: () =>
      api.get<SecureScoreControlProfilesResponse>("/api/secure-score/control-profiles"),
    // Catalogue refreshes once a day at 02:30 UTC; 30 minutes is enough
    // browser-side staleTime to amortise the page's fan-out.
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

export function useSecureScoreTrend(days: number = 90) {
  return useQuery<SecureScoreTrendResponse>({
    queryKey: ["secure-score", "trend", days],
    queryFn: () => api.get<SecureScoreTrendResponse>(`/api/secure-score/trend?days=${days}`),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
