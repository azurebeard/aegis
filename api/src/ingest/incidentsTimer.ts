// Timer-triggered Incidents ingest (ADR-0014 §1).
//
// The schedule MUST be bound via the `%INCIDENTS_TIMER_CRON%` app-setting
// binding expression — WS10 SEC-M-STEP4-INFRA-02 resolution. Bicep is the
// authoritative source of truth for the CRON; hard-coding here would make
// the Bicep parameter cosmetic. Dev environments can override via
// `azd env set AZURE_INCIDENTS_TIMER_CRON='0 */1 * * * *'` for fast smoke tests.

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { resolveIncidentsIngestConfig } from "../lib/config.js";
import { runIncidentsIngestOnce } from "../lib/runIncidentsIngest.js";

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `incidents.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveIncidentsIngestConfig();
  const outcome = await runIncidentsIngestOnce(config, context);
  if (outcome.status === "error") {
    // Surface as a handler-level failure so App Insights records a failed
    // invocation — health row and audit line are already written, so the
    // degraded-state badge will appear on the dashboard on the next read.
    throw new Error(
      `incidents.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
    );
  }
}

app.timer("incidentsTimer", {
  schedule: "%INCIDENTS_TIMER_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler,
});
