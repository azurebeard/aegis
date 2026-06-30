// Timer-triggered Defender for Cloud Secure Score ingest (ADR-0036).
//
// Fires daily at 02:30 UTC (`30 30 2 * * *`). Singleton via IngestHealth
// ETag (ADR-0011 §2). Lands between the 02:00 KEV ingest and the 03:00
// Microsoft Secure Score ingest.

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { resolveAzureSecureScoreIngestConfig } from "../lib/config.js";
import { runAzureSecureScoreIngestOnce } from "../lib/runAzureSecureScoreIngest.js";

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `azureSecureScore.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveAzureSecureScoreIngestConfig();
  const outcome = await runAzureSecureScoreIngestOnce(config, context, {
    trigger: "timer",
  });
  if (outcome.status === "error") {
    throw new Error(
      `azureSecureScore.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
    );
  }
}

app.timer("azureSecureScoreTimer", {
  schedule: "%AZURE_SECURE_SCORE_TIMER_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler,
});
