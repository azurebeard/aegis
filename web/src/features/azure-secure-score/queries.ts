// ADR-0036 — TanStack Query hook for /api/azure-secure-score/summary.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { AzureSecureScoreSummaryResponse } from "./types";

export function useAzureSecureScoreSummary() {
  return useQuery<AzureSecureScoreSummaryResponse>({
    queryKey: ["azure-secure-score", "summary"],
    queryFn: () => api.get<AzureSecureScoreSummaryResponse>("/api/azure-secure-score/summary"),
    staleTime: 300_000,
  });
}
