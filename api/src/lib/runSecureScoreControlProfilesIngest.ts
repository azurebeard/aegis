// Daily refresh of the Secure Score control-profile catalogue
//
// Fetches `/security/secureScoreControlProfiles` and upserts each entry
// into the existing `SecureScore` ops-table under PartitionKey="profile"
// (per `secureScoreControlProfileStore.ts`). The catalogue is tenant-
// stable metadata — Microsoft updates it ~monthly and per-row writes
// are idempotent, so no audit chain / IngestHealth lease is needed
// (those primitives protect security-critical signals where gaps are
// observable; profile drift is reference-data drift). We surface
// ingest outcomes via the AIEVENT App Insights wrapper instead.

import type { InvocationContext } from "@azure/functions";
import { emitAievent } from "./aievent.js";
import type { IngestConfig } from "./config.js";
import {
  fetchSecureScoreControlProfiles,
  GraphFetchError,
} from "./graphClient.js";
import {
  profileToEntity,
  upsertControlProfile,
} from "./secureScoreControlProfileStore.js";
import { getTableClient, OPS_TABLES } from "./tables.js";

/** Source label for AIEVENT routing — distinguishes the profile ingest
 *  from the snapshot ingest (which uses graph.security.secureScores). */
const INGEST_SOURCE = "graph.security.secureScoreControlProfiles";

/** Bespoke outcome shape — the elaborate `IngestOutcome` carries fields
 *  (auditSeq, snapshotDate, runId) that don't apply to a metadata refresh. */
export interface ControlProfilesIngestOutcome {
  readonly status: "success" | "error";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly profilesFetched: number;
  readonly profilesWritten: number;
  readonly profilesSkipped: number;
  readonly graphAttempts: number;
  readonly error?: { readonly kind: string; readonly message: string };
}

export async function runSecureScoreControlProfilesIngestOnce(
  config: IngestConfig,
  context: InvocationContext,
): Promise<ControlProfilesIngestOutcome> {
  const startedAt = new Date().toISOString();
  let attempts = 0;

  try {
    const fetched = await fetchSecureScoreControlProfiles(
      {
        graphBaseUrl: config.graphBaseUrl,
        managedIdentityClientId: config.ingestMiClientId,
        leaseWindowMs: config.leaseWindowMs,
        timeoutMs: config.graphApiTimeoutMs,
      },
      context,
    );
    attempts = fetched.attempts;
    const profiles = fetched.data;

    const opsCtx = {
      endpoint: config.opsTableEndpoint,
      managedIdentityClientId: config.ingestMiClientId,
    };
    const table = getTableClient(opsCtx, OPS_TABLES.SecureScore);

    let written = 0;
    let skipped = 0;
    for (const raw of profiles) {
      // Microsoft sometimes returns entries without an `id`. Skip any
      // we can't key safely — the catalogue is best-effort metadata,
      // not a chain.
      if (typeof raw.id !== "string" || raw.id.trim() === "") {
        skipped++;
        continue;
      }
      const entity = profileToEntity(raw, startedAt);
      await upsertControlProfile(table, entity);
      written++;
    }

    emitAievent(context, "SecureScoreControlProfilesIngest", {
      tenantId: config.tenantId,
      source: INGEST_SOURCE,
      status: "success",
      profilesFetched: profiles.length,
      profilesWritten: written,
      profilesSkipped: skipped,
      graphAttempts: attempts,
      startedAt,
      endedAt: new Date().toISOString(),
    });

    return {
      status: "success",
      startedAt,
      endedAt: new Date().toISOString(),
      profilesFetched: profiles.length,
      profilesWritten: written,
      profilesSkipped: skipped,
      graphAttempts: attempts,
    };
  } catch (err) {
    const kind =
      err instanceof GraphFetchError
        ? `graph_${err.kind}_${err.status ?? "unknown"}`
        : (err as Error)?.constructor?.name ?? "Error";
    const message = (err as Error)?.message ?? String(err);
    emitAievent(context, "SecureScoreControlProfilesIngest", {
      tenantId: config.tenantId,
      source: INGEST_SOURCE,
      status: "error",
      errorKind: kind,
      errorMessage: message,
      graphAttempts: attempts,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    return {
      status: "error",
      startedAt,
      endedAt: new Date().toISOString(),
      profilesFetched: 0,
      profilesWritten: 0,
      profilesSkipped: 0,
      graphAttempts: attempts,
      error: { kind, message },
    };
  }
}
