// Timer-triggered EntraRisk ingest (ADR-0023 §1).
//
// Schedule bound via the `%ENTRA_RISK_TIMER_CRON%` app-setting binding
// expression — Bicep is the authoritative source of truth for the CRON.
// Default `0 0 */4 * * *` (every 4 hours). `useMonitor: true` records
// execution state; the IngestHealth ETag lease remains the singleton
// guarantee (ADR-0011 §2).

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { ConfigError, resolveEntraRiskIngestConfig } from "../lib/config.js";
import { runEntraRiskIngestOnce } from "../lib/runEntraRiskIngest.js";

export async function entraRiskTimerHandler(
  timer: Timer,
  context: InvocationContext,
): Promise<void> {
  try {
    context.log(
      `entraRisk.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
    );
    const config = resolveEntraRiskIngestConfig();
    const outcome = await runEntraRiskIngestOnce(config, context, { trigger: "timer" });
    if (outcome.status === "error") {
      throw new Error(
        `entraRisk.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
      );
    }
  } catch (err) {
    // a ConfigError
    // at boot (missing env var, region-parity violation per ADR-0017 §2) must
    // NOT re-throw — throwing from a Timer handler on Flex Consumption
    // triggers retry storms. Log a structured App Insights
    // trace instead; an operator-authored scheduled-query alert rule catches
    // `event:"entraRisk.config_error"` at severity-1. Mirrors the
    // `dailyBriefTimer.ts` ConfigError path.
    if (err instanceof ConfigError) {
      context.error(
        JSON.stringify({
          event: "entraRisk.config_error",
          kind: "config",
          message: err.message,
          correlationId: context.invocationId,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }
    // All other errors propagate so the host records a function failure and
    // the AgentRun / ingest alert can fire (ADR-0015 chain-repair detection
    // preserved).
    throw err;
  }
}

app.timer("entraRiskTimer", {
  schedule: "%ENTRA_RISK_TIMER_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler: entraRiskTimerHandler,
});
