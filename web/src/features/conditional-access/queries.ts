// ADR-0034 §3.3 — TanStack Query hooks for the /api/conditional-access/* surface.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { ConditionalAccessPoliciesResponse, ConditionalAccessSummaryResponse } from "./types";

export function useConditionalAccessSummary(opts: { readonly enabled?: boolean } = {}) {
  return useQuery<ConditionalAccessSummaryResponse>({
    queryKey: ["conditional-access", "summary"],
    queryFn: () => api.get<ConditionalAccessSummaryResponse>("/api/conditional-access/summary"),
    staleTime: 300_000,
    enabled: opts.enabled ?? true,
  });
}

export function useConditionalAccessPolicies(opts: { readonly enabled?: boolean } = {}) {
  return useQuery<ConditionalAccessPoliciesResponse>({
    queryKey: ["conditional-access", "policies"],
    queryFn: () => api.get<ConditionalAccessPoliciesResponse>("/api/conditional-access/policies"),
    staleTime: 300_000,
    enabled: opts.enabled ?? true,
  });
}
