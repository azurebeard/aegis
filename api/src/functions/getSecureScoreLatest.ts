// GET /api/secure-score/latest (ADR-0012 §1.1).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveApiConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { readHealthRow } from "../lib/ingestHealth.js";
import {
  getLatestSnapshot,
  getTableClient,
  OPS_TABLES,
} from "../lib/tables.js";
import type { SecureScoreLatestResponse } from "../lib/types.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E follow-up — Bearer required (Easy Auth retired).
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const config = resolveApiConfig();
  const ctx = { endpoint: config.opsTableEndpoint, managedIdentityClientId: config.apiReaderMiClientId };
  const snapshotTable = getTableClient(ctx, OPS_TABLES.SecureScore);
  const healthTable = getTableClient(ctx, OPS_TABLES.IngestHealth);

  try {
    const [snapshot, health] = await Promise.all([
      getLatestSnapshot(snapshotTable),
      readHealthRow(healthTable, config.tenantId, config.source),
    ]);

    // Map IngestHealth row + snapshot presence onto the API wire status.
    //   no health row                                → awaiting_first_run
    //   health present, snapshot present             → pass through health.status
    //   health present, no snapshot, status=healthy  → no_data (Graph returned 0)
    //   health present, no snapshot, status=failing  → failing (ingest retrying/failing)
    //   health present, no snapshot, status=degrading → degrading
    const wireStatus: SecureScoreLatestResponse["health"]["status"] = !health
      ? "awaiting_first_run"
      : snapshot
        ? health.status
        : health.status === "healthy"
          ? "no_data"
          : health.status;

    const body: SecureScoreLatestResponse = {
      schemaVersion: 1,
      snapshot,
      health: {
        status: wireStatus,
        lastSuccessAt: health?.lastSuccessAt ?? null,
        consecutiveFailures: health?.consecutiveFailureCount ?? 0,
      },
    };

    return {
      status: 200,
      jsonBody: body,
      headers: {
        // 30 s — short enough that a fresh ingest appears without user action;
        // client-side React Query staleTime still bounds refetch cadence.
        // The longer 30 min cap stays on /trend which doesn't change rapidly.
        "cache-control": "private, max-age=30",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`secureScore.latest.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "secure score store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("getSecureScoreLatest", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "secure-score/latest",
  handler,
});
