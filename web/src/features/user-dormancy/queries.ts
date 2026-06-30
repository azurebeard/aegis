// ADR-0034 §3.1 — TanStack Query hooks for the User dormancy SPA feature.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { UserDormancyListResponse, UserDormancySummaryResponse } from "./types";

export function useUserDormancySummary() {
  return useQuery<UserDormancySummaryResponse>({
    queryKey: ["user-dormancy", "summary"],
    queryFn: () => api.get<UserDormancySummaryResponse>("/api/user-dormancy/summary"),
    staleTime: 30_000,
  });
}

export interface UserDormancyListParams {
  readonly dormantOnly?: boolean;
  readonly sort?: "lastSignIn" | "upn" | "displayName";
  readonly limit?: number;
}

export function useUserDormancyList(params: UserDormancyListParams = {}) {
  const dormantOnly = params.dormantOnly ?? false;
  const sort = params.sort ?? "lastSignIn";
  const limit = params.limit ?? 50;
  return useQuery<UserDormancyListResponse>({
    queryKey: ["user-dormancy", "list", dormantOnly, sort, limit],
    queryFn: () =>
      api.get<UserDormancyListResponse>(
        `/api/user-dormancy/list?dormantOnly=${String(dormantOnly)}&sort=${sort}&limit=${String(limit)}`,
      ),
    staleTime: 30_000,
  });
}
