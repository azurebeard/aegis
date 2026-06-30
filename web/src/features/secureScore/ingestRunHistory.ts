// Wire shape + query hook for /api/agents/observability/ingest-runs.
// Mirrors useAgentRunHistory but projects ingest-shaped fields (rowsWritten,
// graphAttempts, snapshotDate) instead of agent-shaped ones. Backs the
// "Recent runs" expand on the Secure Score failing/empty tile.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export type IngestSourceKey =
  | "secure-score"
  | "incidents"
  | "entra-risk"
  | "kev"
  | "user-dormancy"
  | "sign-ins"
  | "conditional-access"
  | "azure-secure-score"
  | "ransomware-intel"; // ADR-0037

export interface IngestRunHistoryItem {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: string | null;
  readonly rowsWritten: number | null;
  readonly retentionRowsDeleted: number | null;
  readonly graphAttempts: number | null;
  readonly snapshotDate: string | null;
  readonly currentScore: number | null;
  readonly maxScore: number | null;
  readonly errorKind: string | null;
  readonly day: string;
}

export interface IngestRunHistoryResponse {
  readonly schemaVersion: 1;
  readonly source: IngestSourceKey;
  readonly items: readonly IngestRunHistoryItem[];
  readonly range: {
    readonly lookbackDays: number;
    readonly requestedLimit: number;
    readonly returnedCount: number;
  };
}

export function useIngestRunHistory(source: IngestSourceKey | null, limit = 20) {
  return useQuery<IngestRunHistoryResponse>({
    queryKey: ["admin", "ingest", "runs", source, limit],
    enabled: source !== null,
    queryFn: () =>
      api.get<IngestRunHistoryResponse>(
        `/api/agents/observability/ingest-runs?source=${source as string}&limit=${limit}`,
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
