// Timer-triggered User dormancy ingest (ADR-0034 §1).
//
// Fires once daily at 01:30 UTC. Singleton via IngestHealth ETag (ADR-0011 §2).
// Lands before the SecureScore 03:00 fire so the diagnostics page shows a
// complete daily picture.

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { resolveUserDormancyIngestConfig } from "../lib/config.js";
import { runUserDormancyIngestOnce } from "../lib/runUserDormancyIngest.js";

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `userDormancy.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveUserDormancyIngestConfig();
  const outcome = await runUserDormancyIngestOnce(config, context, {
    trigger: "timer",
  });
  if (outcome.status === "error") {
    throw new Error(
      `userDormancy.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
    );
  }
}

app.timer("userDormancyTimer", {
  schedule: "%USER_DORMANCY_TIMER_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler,
});
