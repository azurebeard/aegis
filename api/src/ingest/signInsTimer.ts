// Timer-triggered Sign-ins ingest (ADR-0034 §1).
//
// Fires every 15 minutes — sign-in events are operationally time-sensitive
// (matches the Incidents cadence). Singleton via IngestHealth ETag
// (ADR-0011 §2). Sticky `licence_required` per ADR-0034 §6 means tenants
// without Entra ID P1 cost one Graph call per first-run-after-deploy and
// then short-circuit indefinitely until an admin re-probes.

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { resolveSignInsIngestConfig } from "../lib/config.js";
import { runSignInsIngestOnce } from "../lib/runSignInsIngest.js";

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `signIns.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveSignInsIngestConfig();
  const outcome = await runSignInsIngestOnce(config, context, { trigger: "timer" });
  if (outcome.status === "error") {
    throw new Error(
      `signIns.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
    );
  }
}

app.timer("signInsTimer", {
  schedule: "%SIGN_INS_TIMER_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler,
});
