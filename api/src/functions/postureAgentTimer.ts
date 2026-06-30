// Posture-agent Timer trigger — fires per `POSTURE_TIMER_CRON` app setting
// (ADR-0027 §Decision.4).
//
// Default `0 0 6 * * 1` = Mondays 06:00 UTC. `useMonitor: true` so a missed
// Monday fire (function-host downtime) is caught up on next start; the
// adapter still cache-checks so a catch-up replay doesn't re-spend tokens.

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { ConfigError } from "../lib/config.js";
import { runPostureAgent } from "../lib/runPostureAgent.js";

export async function postureAgentTimerHandler(
  myTimer: Timer,
  context: InvocationContext,
): Promise<void> {
  void myTimer;
  try {
    const result = await runPostureAgent({ trigger: "timer", context });
    context.log(
      `postureAgentTimer status=${result.status} runId=${result.runId ?? "n/a"} isoWeek=${result.isoWeek} reason=${result.reason ?? "n/a"} degraded=${result.degraded ? "true" : "false"}`,
    );
  } catch (err) {
    if (err instanceof ConfigError) {
      context.error(
        JSON.stringify({
          event: "posture.config_error",
          kind: "config",
          message: err.message,
          correlationId: context.invocationId,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }
    throw err;
  }
}

app.timer("postureAgentTimer", {
  schedule: "%POSTURE_TIMER_CRON%",
  useMonitor: true,
  handler: postureAgentTimerHandler,
});
