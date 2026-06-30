// Wire shapes + query hook for /api/admin/agents (HANDOVER §6.3 agent
// observability page). Single endpoint returns per-agent state for the
// three AI specialists; the SPA renders one card per agent.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export type AgentName = "brief" | "posture" | "incidents-analysis";
export type AgentCadence = "daily" | "weekly" | "on-demand";
export type AgentHealthState = "closed" | "open" | "half_open";

export interface AgentHealthView {
  readonly state: AgentHealthState;
  readonly consecutiveFailures: number;
  readonly nextProbeAt: string | null;
  readonly lastFailureKind: string | null;
  readonly lastFailureAt: string | null;
  readonly updatedAt: string | null;
}

export interface AgentLatestRunView {
  readonly runId: string;
  readonly generatedAt: string;
  readonly modelDeployment: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly outputSha256: string;
  readonly keyKind: "briefDate" | "isoWeek" | "incidentId";
  readonly key: string;
}

export interface AgentBudgetView {
  readonly bucketKey: string;
  readonly bucketCadence: "daily" | "weekly";
  readonly tokensActualTotal: number;
  readonly runsSucceeded: number;
  readonly runsFailed: number;
  readonly manualRunsToday: number;
  readonly empty: boolean;
  readonly ceilings: { readonly manualRun: number; readonly tokens: number };
}

export interface AgentScheduleView {
  readonly cron: string | null;
  readonly nextFireAt: string | null;
  readonly cadence: AgentCadence;
}

export interface AgentObservability {
  readonly agentName: AgentName;
  readonly cadence: AgentCadence;
  readonly health: AgentHealthView;
  readonly latestRun: AgentLatestRunView | null;
  readonly budget: AgentBudgetView;
  readonly schedule: AgentScheduleView;
}

export interface AgentObservabilityResponse {
  readonly schemaVersion: 1;
  readonly agents: readonly AgentObservability[];
}

export function useAdminAgents() {
  return useQuery<AgentObservabilityResponse>({
    queryKey: ["admin", "agents"],
    // Endpoint moved from /api/admin/agents → /api/agents/observability —
    // see api/src/functions/getAdminAgents.ts for the routing rationale.
    // SWA gate: /api/* (reader OR admin); function-level admin re-check
    // via x-ms-client-principal header.
    queryFn: () => api.get<AgentObservabilityResponse>("/api/agents/observability"),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

// --- Run history (audit-blob walk) ----------------------------------------

export interface AgentRunHistoryItem {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: string | null;
  readonly modelDeployment: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly latencyMs: number | null;
  readonly trigger: string | null;
  readonly errorKind: string | null;
  readonly day: string;
}

export interface AgentRunHistoryResponse {
  readonly schemaVersion: 1;
  readonly agent: AgentName;
  readonly items: readonly AgentRunHistoryItem[];
  readonly range: {
    readonly lookbackDays: number;
    readonly requestedLimit: number;
    readonly returnedCount: number;
  };
}

export function useAgentRunHistory(agent: AgentName | null, limit = 20) {
  return useQuery<AgentRunHistoryResponse>({
    queryKey: ["admin", "agents", "runs", agent, limit],
    enabled: agent !== null,
    queryFn: () =>
      api.get<AgentRunHistoryResponse>(
        `/api/agents/observability/runs?agent=${agent as string}&limit=${limit}`,
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
