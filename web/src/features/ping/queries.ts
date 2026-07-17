import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export interface PingResponse {
  readonly ok: boolean;
  readonly identityProvider: string;
  readonly userId: string;
  readonly userDetails: string;
  readonly roles: readonly string[];
  readonly ts: string;
}

export function usePing() {
  return useQuery({
    queryKey: ["ping"],
    queryFn: () => api.get<PingResponse>("/api/ping"),
  });
}
