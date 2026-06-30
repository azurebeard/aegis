// ADR-0032 §1 — Timer-triggered KEV ingest. Daily 02:00 UTC default,
// override via KEV_TIMER_CRON app setting (Bicep-authoritative).
// Singleton via IngestHealth[<tenantId>][cisa.kev] ETag lease.

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { resolveKevIngestConfig } from "../lib/config.js";
import { runKevIngestOnce } from "../lib/runKevIngest.js";

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `kev.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveKevIngestConfig();
  const outcome = await runKevIngestOnce(config, context);
  if (outcome.status === "error") {
    throw new Error(
      `kev.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
    );
  }
}

app.timer("kevTimer", {
  schedule: "%KEV_TIMER_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler,
});
