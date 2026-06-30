// Timer-triggered Secure Score control-profile catalogue refresh.
//
// Fires once daily at 02:30 UTC — slightly before the snapshot timer
// (03:00) so when the daily snapshot lands the profile catalogue is
// already up to date. Microsoft updates the catalogue ~monthly, so
// technically once-a-week would suffice; daily keeps the operational
// story simple (everything refreshes every day).
//
// No singleton lease — the upserts are idempotent (Replace semantics on
// stable RowKeys), and `runSecureScoreControlProfilesIngestOnce` does
// not write to the audit chain. If two instances race, both win;
// observable via duplicate AIEVENT entries.
//
// Historical note: an earlier `0 30-34 2 * * *` cron was
// added in the belief NCRONTAB's minute-range syntax expresses jitter.
// It fires on every minute in the range — 5 invocations per day —
// burning Graph quota that the snapshot timer at 03:00 then competes
// against. Same bug as secureScoreTimer (commit 692ed1f).

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { resolveIngestConfig } from "../lib/config.js";
import { runSecureScoreControlProfilesIngestOnce } from "../lib/runSecureScoreControlProfilesIngest.js";

const SCHEDULE = "0 30 2 * * *"; // sec min hour day month dow — 02:30 UTC daily

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `secureScoreControlProfiles.timer.fire isPastDue=${timer.isPastDue} scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );
  const config = resolveIngestConfig();
  const outcome = await runSecureScoreControlProfilesIngestOnce(config, context);
  if (outcome.status === "error") {
    throw new Error(
      `secureScoreControlProfiles.timer.fail kind=${outcome.error?.kind ?? "unknown"} message=${outcome.error?.message ?? ""}`,
    );
  }
}

app.timer("secureScoreControlProfilesTimer", {
  schedule: SCHEDULE,
  runOnStartup: false,
  useMonitor: true,
  handler,
});
