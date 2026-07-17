// Wire shapes for /api/incidents/{id}/analysis — aligned with the server
// envelope in incidentsPromptBuilder.ts + getIncidentAnalysis.ts. schemaVersion
// bumps when these diverge.

export type IncidentAnalysisSeverity = "informational" | "notable" | "urgent" | "unknown";

export interface IncidentAnalysisSections {
  readonly attackNarrative: string;
  readonly impactAssessment: string;
  readonly suggestedNextSteps: string;
}

export interface IncidentAnalysisRedactionLockState {
  readonly active: boolean;
  readonly until: string | null;
}

export interface IncidentAnalysisResponse {
  readonly schemaVersion: 1;
  readonly analysis?: null;
  readonly incidentId?: string;
  readonly headline?: string;
  readonly severity?: IncidentAnalysisSeverity;
  readonly sections?: IncidentAnalysisSections;
  readonly runId?: string;
  readonly generatedAt?: string;
  readonly outputSha256?: string;
  readonly modelDeployment?: string;
  readonly analysedIncidentLastUpdateDateTime?: string;
  readonly redactionLock?: IncidentAnalysisRedactionLockState;
  readonly health?: { readonly status: "awaiting_first_run" };
}

export interface AnalyseIncidentResponse {
  readonly status: "committed" | "cache_hit" | "redaction_locked" | "superseded";
  readonly incidentId: string;
  readonly runId?: string;
  readonly outputSha256?: string;
  readonly supersedingRunId?: string;
  readonly degraded?: boolean;
  readonly redactedFields?: readonly string[];
  readonly redactionLockUntil?: string | null;
}

export interface ClearRedactionLockResponse {
  readonly incidentId: string;
  readonly wasLocked: boolean;
  readonly redactionLock: IncidentAnalysisRedactionLockState;
}
