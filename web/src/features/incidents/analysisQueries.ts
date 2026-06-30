// React Query hooks for /api/incidents/{id}/analysis + the admin
// analyse / clear-lock endpoints (ADR-0028).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  AnalyseIncidentResponse,
  ClearRedactionLockResponse,
  IncidentAnalysisResponse,
} from "./analysisTypes.js";

export function useIncidentAnalysis(id: string | null) {
  return useQuery<IncidentAnalysisResponse>({
    queryKey: ["incidents", "analysis", id],
    enabled: id !== null && id.length > 0,
    queryFn: () =>
      api.get<IncidentAnalysisResponse>(
        `/api/incidents/${encodeURIComponent(id as string)}/analysis`,
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

// Invalidate-after-POST must happen inside `mutationFn`, NOT in the
// `onSuccess` option, because the latter only fires when the component is
// still mounted. The panel mounts conditionally on the AI tab (see
// IncidentDetailDrawer.tsx tab gate) so any tab switch, drawer close, or
// route change during the 5-30s agent run silently strands the response:
// the row IS committed to the cache table, but the stale GET stays cached
// and the panel reverts to "No analysis yet" + button on the next mount.
//
// `mutationFn` runs at the MutationCache level — invalidation here is
// durable across unmount. We swallow invalidate errors so a transient
// QueryClient hiccup never masks a successful agent run (the next mount
// will refetch via staleTime expiry as a backstop).
export function useAnalyseIncident() {
  const qc = useQueryClient();
  return useMutation<AnalyseIncidentResponse, Error, { incidentId: string }>({
    mutationFn: async ({ incidentId }) => {
      const result = await api.post<AnalyseIncidentResponse>(
        `/api/ingest/incidents/${encodeURIComponent(incidentId)}/analyse`,
      );
      try {
        // The per-incident analysis envelope query — drives the AI panel.
        await qc.invalidateQueries({ queryKey: ["incidents", "analysis", incidentId] });
        // The list query — drives the "AI" column. Prefix match invalidates
        // every list variant regardless of filter/cursor state. The list
        // handler computes `hasAnalysis` server-side per request, so any
        // cached pre-analyse list response is now stale for this incident.
        await qc.invalidateQueries({ queryKey: ["incidents", "list"] });
      } catch {
        /* best-effort — staleTime expiry is the backstop */
      }
      return result;
    },
  });
}

export function useClearRedactionLock() {
  const qc = useQueryClient();
  return useMutation<ClearRedactionLockResponse, Error, { incidentId: string }>({
    mutationFn: async ({ incidentId }) => {
      const result = await api.delete<ClearRedactionLockResponse>(
        `/api/ingest/incidents/${encodeURIComponent(incidentId)}/redaction-lock`,
      );
      try {
        await qc.invalidateQueries({ queryKey: ["incidents", "analysis", incidentId] });
      } catch {
        /* best-effort — staleTime expiry is the backstop */
      }
      return result;
    },
  });
}
