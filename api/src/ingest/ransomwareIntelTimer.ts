// ADR-0037 Layer 3c — Timer-triggered ransomware.live PRO ingest.
//
// Schedule MUST be bound via the `%THREAT_INTEL_TIMER_CRON%` app-setting
// expression — Bicep is the authoritative source for the cron (default
// `0 0 * * * *`, top of every hour, UTC; see infra/main.bicep). Hard-coding
// here would make the Bicep parameter cosmetic. Dev tenants can override:
//   azd env set AZURE_THREAT_INTEL_TIMER_CRON '0 */15 * * * *'
// for faster smoke tests.

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { resolveRansomwareIntelIngestConfig } from "../lib/config.js";
import { runRansomwareIntelIngestOnce } from "../lib/runRansomwareIntelIngest.js";

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `ransomwareIntel.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveRansomwareIntelIngestConfig();
  const outcome = await runRansomwareIntelIngestOnce(config, context, {
    trigger: "timer",
  });
  if (outcome.status === "error") {
    // Surface as a handler-level failure so AppInsights records a failed
    // invocation. Health row + audit line are already written, so the
    // dashboard degraded-state badge surfaces on the next read.
    throw new Error(
      `ransomwareIntel.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
    );
  }
}

app.timer("ransomwareIntelTimer", {
  schedule: "%THREAT_INTEL_TIMER_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler,
});
