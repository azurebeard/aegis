// ADR-0033 §5 Phase 2.5 — daily KevSuppressions expiry sweep.
//
// The read-time resolver (`resolveEffective` in kevSuppressionsStore.ts)
// already returns "open" for rows whose ExpiresAt is in the past — so
// effective state is correct without this Timer. This sweeper exists for
// HYGIENE only: physically delete the dead rows so the partition doesn't
// accumulate stale entries indefinitely.
//
// Defaults to 03:00 UTC daily — one hour after the KEV ingest at
// 02:00 UTC. Override via the KEV_SUPPRESSIONS_SWEEP_CRON app setting
// (Bicep-authoritative).

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { emitAievent } from "../lib/aievent.js";
import { resolveIngestConfig } from "../lib/config.js";
import { sweepExpiredSuppressions } from "../lib/kevSuppressionsStore.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `kev.suppressions.sweep.fire isPastDue=${timer.isPastDue} ` +
      `scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveIngestConfig();
  const table = getTableClient(
    {
      endpoint: config.opsTableEndpoint,
      managedIdentityClientId: config.ingestMiClientId,
    },
    OPS_TABLES.KevSuppressions,
  );
  try {
    const result = await sweepExpiredSuppressions(table, config.tenantId, new Date());
    context.log(
      `kev.suppressions.sweep.ok scanned=${result.scanned} deleted=${result.deleted}`,
    );
    emitAievent(context, "KevSuppressionsSweep", {
      tenantId: config.tenantId,
      scanned: result.scanned,
      deleted: result.deleted,
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    context.error(`kev.suppressions.sweep.fail message=${message}`);
    emitAievent(context, "KevSuppressionsSweepFailure", {
      tenantId: config.tenantId,
      errorType: (err as Error)?.constructor?.name ?? "Error",
      errorMessage: message,
    });
    throw err;
  }
}

app.timer("kevSuppressionsSweepTimer", {
  schedule: "%KEV_SUPPRESSIONS_SWEEP_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler,
});
