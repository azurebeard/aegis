// Daily-brief Timer trigger — fires per `BRIEF_TIMER_CRON` app setting
// (ADR-0019 §Decision.3, ADR-0020 §trigger).
//
// Cron expression is passed via `%BRIEF_TIMER_CRON%` so an operator can adjust
// the daily fire time without a code change. Default `0 0 5 * * *` = 05:00 UTC
// daily. `useMonitor: true` so missed fires (function-host downtime) are
// catched up on next start, but the agent still cache-checks before any
// Foundry call so a catch-up replay doesn't double-charge tokens.

import {
  app,
  type InvocationContext,
  type Timer,
} from "@azure/functions";
import { ConfigError } from "../lib/config.js";
import { runBriefAgent } from "../lib/runBriefAgent.js";

export async function dailyBriefTimerHandler(
  myTimer: Timer,
  context: InvocationContext,
): Promise<void> {
  void myTimer; // unused — Timer body has no payload for daily fire.
  try {
    const result = await runBriefAgent({ trigger: "timer", context });
    context.log(
      `dailyBriefTimer status=${result.status} runId=${result.runId ?? "n/a"} briefDate=${result.briefDate} reason=${result.reason ?? "n/a"}`,
    );
  } catch (err) {
    // a ConfigError
    // at boot (missing env var, region-parity violation per ADR-0017 §2)
    // must NOT re-throw — throwing from a Timer handler on Flex Consumption
    // triggers retry storms. Log a structured App Insights trace instead;
    // an operator-authored scheduled-query alert rule (TODO(step-5.3))
    // catches `event:"brief.config_error"` at severity-1.
    if (err instanceof ConfigError) {
      context.error(
        JSON.stringify({
          event: "brief.config_error",
          kind: "config",
          message: err.message,
          correlationId: context.invocationId,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }
    // All other errors propagate so the host records a function failure and
    // the AgentRun alert can fire.
    throw err;
  }
}

app.timer("dailyBriefTimer", {
  schedule: "%BRIEF_TIMER_CRON%",
  useMonitor: true,
  handler: dailyBriefTimerHandler,
});
