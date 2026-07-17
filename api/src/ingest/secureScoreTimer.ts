// Timer-triggered Secure Score ingest (ADR-0011 §1).
//
// Fires once daily at 03:00 UTC. Singleton behaviour is enforced by the
// IngestHealth row's ETag (the actual lease) — see ADR-0011 §2 + WS10
// SEC-L-STEP3-INFRA-02 recommendation.
//
// Historical note: an earlier `0 0-4 3 * * *` cron was added
// in the belief NCRONTAB's minute-range syntax expresses jitter. It does
// not — it fires on every minute in the range, producing 5 invocations
// per day. Failed later-batch runs (Graph throttle after the early ones
// succeed) overwrote IngestHealth with `status=error`, surfacing as a
// false "failing" badge on the dashboard despite the data being intact.

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { resolveIngestConfig } from "../lib/config.js";
import { runSecureScoreIngestOnce } from "../lib/runSecureScoreIngest.js";

const SCHEDULE = "0 0 3 * * *"; // sec min hour day month dow — 03:00 UTC daily

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `secureScore.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveIngestConfig();
  const outcome = await runSecureScoreIngestOnce(config, context);
  if (outcome.status === "error") {
    // Surface as a handler-level failure so App Insights records a failed
    // invocation — but the health row and audit line are already written, so
    // the degraded-state badge will appear on the dashboard on the next read.
    throw new Error(
      `secureScore.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
    );
  }
}

app.timer("secureScoreTimer", {
  schedule: SCHEDULE,
  runOnStartup: false,
  useMonitor: true,
  handler,
});
