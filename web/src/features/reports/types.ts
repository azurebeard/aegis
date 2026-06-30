// ADR-0030 Phase A — wire types for /api/reports/*.

import type { ReportCadence } from "@/features/settings/types";
export type { ReportCadence };

/** The full envelope shape returned by GET /api/reports/current and the
 *  per-snapshot get. Matches `ReportSnapshotEnvelope` on the API side. */
export interface ReportEnvelope {
  readonly schemaVersion: 1;
  readonly contentType: "application/json";
  readonly tenantId: string;
  readonly periodKey: string;
  readonly periodCadence: ReportCadence;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly capturedAt: string;
  readonly capturedBy: string;
  readonly version: number;
  readonly sections: {
    readonly secureScore: unknown;
    readonly incidents: unknown;
    readonly entraRisk: unknown;
    readonly brief: unknown;
    readonly posture: unknown;
    readonly ingestHealth: unknown;
  };
  readonly derived: Readonly<Record<string, string>>;
}

export interface ReportSnapshotListItem {
  readonly periodKey: string;
  readonly cadence: ReportCadence;
  readonly version: number;
  readonly capturedAt: string;
  readonly capturedBy: string;
  readonly contentType: string;
  readonly envelopeBytes: number;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface ReportSnapshotListResponse {
  readonly schemaVersion: 1;
  readonly cadence: ReportCadence;
  readonly items: readonly ReportSnapshotListItem[];
  readonly range: {
    readonly requestedLimit: number;
    readonly returnedCount: number;
  };
}

export interface CaptureResponse {
  readonly schemaVersion: 1;
  readonly periodKey: string;
  readonly cadence: ReportCadence;
  readonly version: number;
  readonly capturedAt: string;
  readonly retentionRowsDeleted: number;
  readonly snapshotUrl: string;
}
