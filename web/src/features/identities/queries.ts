// ADR-0034 Phase 8E — React Query hooks for /api/identities/*.
//
// `useServicePrincipals` is on-demand: each tab triggers its own hook with
// the appropriate `kind` filter. The 5-minute server cache header lets us
// keep `staleTime` short on the SPA side without re-hitting Graph each
// render. `nextLink`-paginated "Load more" is a separate hook to keep the
// initial-load shape simple.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { ServicePrincipalKindFilter, ServicePrincipalsResponse } from "./types";

export interface ServicePrincipalsParams {
  readonly kind: ServicePrincipalKindFilter;
  readonly search?: string;
  readonly top?: number;
  readonly enabled?: boolean;
}

function buildUrl(params: ServicePrincipalsParams, nextLink?: string): string {
  if (nextLink !== undefined && nextLink.length > 0) {
    return `/api/identities/service-principals?nextLink=${encodeURIComponent(nextLink)}`;
  }
  const qs = new URLSearchParams();
  qs.set("kind", params.kind);
  if (params.search !== undefined && params.search.length > 0) qs.set("search", params.search);
  if (params.top !== undefined) qs.set("top", String(params.top));
  return `/api/identities/service-principals?${qs.toString()}`;
}

export function useServicePrincipals(params: ServicePrincipalsParams) {
  const url = buildUrl(params);
  return useQuery<ServicePrincipalsResponse>({
    queryKey: [
      "identities",
      "service-principals",
      params.kind,
      params.search ?? "",
      params.top ?? 100,
    ],
    queryFn: () => api.get<ServicePrincipalsResponse>(url),
    enabled: params.enabled ?? true,
    // The server caches 5 minutes via cache-control: private, max-age=300.
    // SPA-side staleTime aligned so a re-render within the 5-min window
    // doesn't trigger a refetch the cache would short-circuit anyway.
    staleTime: 300_000,
  });
}
