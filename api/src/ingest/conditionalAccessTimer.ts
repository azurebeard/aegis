// Timer-triggered Conditional Access policy state ingest (ADR-0034 §3.3,
// Phase 8D).
//
// Fires hourly at minute 0 UTC (`0 0 * * * *`). Singleton via IngestHealth
// ETag (ADR-0011 §2). Phase 8D does NOT use the licence_required pattern —
// empty `value: []` is a legitimate "no policies configured" state on Free
// tenants and on tenants that haven't enabled CA. Diff detection runs
// after upsert + reconciliation; one `ca.policy.changed` audit line per
// policy delta gets appended after the ingest.run line.

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { resolveConditionalAccessIngestConfig } from "../lib/config.js";
import { runConditionalAccessIngestOnce } from "../lib/runConditionalAccessIngest.js";

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `conditionalAccess.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveConditionalAccessIngestConfig();
  const outcome = await runConditionalAccessIngestOnce(config, context, {
    trigger: "timer",
  });
  if (outcome.status === "error") {
    throw new Error(
      `conditionalAccess.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
    );
  }
}

app.timer("conditionalAccessTimer", {
  schedule: "%CONDITIONAL_ACCESS_TIMER_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler,
});
