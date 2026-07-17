// ADR-0034 §3.2 — TanStack Query hooks for the Sign-ins SPA feature.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { SignInsListResponse, SignInsSummaryResponse } from "./types";

export function useSignInsSummary() {
  return useQuery<SignInsSummaryResponse>({
    queryKey: ["sign-ins", "summary"],
    queryFn: () => api.get<SignInsSummaryResponse>("/api/sign-ins/summary"),
    staleTime: 30_000,
  });
}

export interface SignInsListParams {
  readonly outOfAreaOnly?: boolean;
  readonly caFailuresOnly?: boolean;
  readonly limit?: number;
}

export function useSignInsList(params: SignInsListParams = {}) {
  const outOfAreaOnly = params.outOfAreaOnly ?? false;
  const caFailuresOnly = params.caFailuresOnly ?? false;
  const limit = params.limit ?? 50;
  return useQuery<SignInsListResponse>({
    queryKey: ["sign-ins", "list", outOfAreaOnly, caFailuresOnly, limit],
    queryFn: () =>
      api.get<SignInsListResponse>(
        `/api/sign-ins/list?outOfAreaOnly=${String(outOfAreaOnly)}&caFailuresOnly=${String(caFailuresOnly)}&limit=${String(limit)}`,
      ),
    staleTime: 30_000,
  });
}
