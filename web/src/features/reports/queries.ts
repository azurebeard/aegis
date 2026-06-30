// ADR-0030 Phase A — React Query hooks for /api/reports/*.
//
// `useReportCurrent` powers the default /reports view (live envelope).
// `useReportSnapshot` powers the historical view (?period=… permalink).
// `useReportSnapshotList` powers the "Recent reports" sidebar.
// `useCaptureReportSnapshot` is the admin-only mutation, invalidates the
// list query so the sidebar refreshes after a successful capture.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  CaptureResponse,
  ReportCadence,
  ReportEnvelope,
  ReportSnapshotListResponse,
} from "./types";

export const REPORT_QUERY_KEYS = {
  current: (cadence: ReportCadence) => ["reports", "current", cadence] as const,
  snapshot: (periodKey: string, version: number | null) =>
    ["reports", "snapshot", periodKey, version] as const,
  list: (cadence: ReportCadence) => ["reports", "list", cadence] as const,
};

export function useReportCurrent(cadence: ReportCadence | null) {
  return useQuery<ReportEnvelope>({
    queryKey: cadence ? REPORT_QUERY_KEYS.current(cadence) : ["reports", "current", "disabled"],
    enabled: cadence !== null,
    queryFn: () => api.get<ReportEnvelope>(`/api/reports/current?cadence=${cadence as string}`),
    // Live envelope — same staleTime as the underlying tile queries (30s).
    staleTime: 30_000,
  });
}

export function useReportSnapshot(periodKey: string | null, version: number | null) {
  return useQuery<ReportEnvelope>({
    queryKey: periodKey
      ? REPORT_QUERY_KEYS.snapshot(periodKey, version)
      : ["reports", "snapshot", "disabled"],
    enabled: periodKey !== null,
    queryFn: () => {
      const url =
        version !== null
          ? `/api/reports/snapshots/${encodeURIComponent(periodKey as string)}?version=${version}`
          : `/api/reports/snapshots/${encodeURIComponent(periodKey as string)}`;
      return api.get<ReportEnvelope>(url);
    },
    // Historical = stable. 5-minute staleTime matches the server cache header.
    staleTime: 5 * 60_000,
  });
}

export function useReportSnapshotList(cadence: ReportCadence) {
  return useQuery<ReportSnapshotListResponse>({
    queryKey: REPORT_QUERY_KEYS.list(cadence),
    queryFn: () =>
      api.get<ReportSnapshotListResponse>(`/api/reports/snapshots?cadence=${cadence}&limit=12`),
    staleTime: 30_000,
  });
}

export interface CaptureInput {
  readonly cadence: ReportCadence;
  readonly periodKey?: string;
  /** ADR-0030 — operator-supplied free-text note. Length-capped at the
   *  API (1000 chars). Surfaces under the executive summary in the
   *  rendered HTML report. */
  readonly notes?: string;
}

export function useCaptureReportSnapshot() {
  const qc = useQueryClient();
  return useMutation<CaptureResponse, Error, CaptureInput>({
    mutationFn: (input) => api.post<CaptureResponse>("/api/reports/snapshots", input),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: REPORT_QUERY_KEYS.list(input.cadence) });
    },
  });
}
