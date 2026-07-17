// ADR-0030 Phase B — daily auto-capture Timer for report snapshots.
//
// Reads the operator-configured cadence from `TenantSettings.reportCadence`
// and fires `runReportCaptureOnce` with `skipIfPeriodHasVersions: true` so
// the daily fire is idempotent: only the first fire after a period
// rollover writes a snapshot. Manual operator captures (clicking the
// /admin button) inject v2/v3 versions WITHOUT preventing the next
// period's auto-capture from firing — versioning is per-period, the skip
// gate uses the resolved current period.
//
// Default cron `0 0 4 * * *` (04:00 UTC daily) — runs after the existing
// KEV ingest (02:00) + suppressions sweep (03:00) so the snapshot reads
// fresh KEV data on the period-rollover day. Override via the
// `REPORT_SNAPSHOT_AUTO_CAPTURE_CRON` app setting (Bicep-authoritative).

import { app, type InvocationContext, type Timer } from "@azure/functions";
import { emitAievent } from "../lib/aievent.js";
import {
  resolveIngestConfig,
  resolveReportSnapshotConfig,
} from "../lib/config.js";
import { runReportCaptureOnce } from "../lib/runReportCapture.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import {
  DEFAULT_REPORT_CADENCE,
  readReportCadence,
} from "../lib/tenantSettingsStore.js";

async function handler(timer: Timer, context: InvocationContext): Promise<void> {
  context.log(
    `report.auto_capture.fire isPastDue=${timer.isPastDue} ` +
      `scheduleStatus=${JSON.stringify(timer.scheduleStatus ?? {})}`,
  );

  const ingestConfig = resolveIngestConfig();
  const reportConfig = resolveReportSnapshotConfig();

  // Read the operator-configured cadence from TenantSettings. Default
  // when no row exists ("default" source) is `monthly` — same behaviour
  // as the SPA's /reports default view + the cadence section's hint.
  const settingsTable = getTableClient(
    {
      endpoint: ingestConfig.opsTableEndpoint,
      managedIdentityClientId: ingestConfig.ingestMiClientId,
    },
    OPS_TABLES.TenantSettings,
  );
  const cadenceRow = await readReportCadence(settingsTable, ingestConfig.tenantId);
  const cadence = cadenceRow.cadence ?? DEFAULT_REPORT_CADENCE;

  const result = await runReportCaptureOnce({
    cadence,
    capturedBy: "system.timer",
    skipIfPeriodHasVersions: true,
    ingestConfig,
    reportConfig,
    logger: context,
  });

  // Operator-visible signal — App Insights customEvents queryable via
  // `customEvents | where name == "AIEVENT.ReportSnapshotAutoCapture"`.
  emitAievent(context, "ReportSnapshotAutoCapture", {
    tenantId: ingestConfig.tenantId,
    cadence,
    periodKey: result.periodKey,
    status: result.status,
    version: result.version,
    envelopeBytes: result.envelopeBytes,
    runId: result.runId,
    ...(result.existingVersions !== undefined
      ? { existingVersions: result.existingVersions }
      : {}),
    ...(result.errorKind ? { errorKind: result.errorKind } : {}),
  });

  switch (result.status) {
    case "success":
      context.log(
        `report.auto_capture.ok cadence=${cadence} periodKey=${result.periodKey} version=${result.version} bytes=${result.envelopeBytes}`,
      );
      return;
    case "skipped_already_captured":
      context.log(
        `report.auto_capture.skipped cadence=${cadence} periodKey=${result.periodKey} existingVersions=${result.existingVersions ?? 0}`,
      );
      return;
    case "lease_contended":
      // Another HTTP-driven capture won the race — Timer abdicates;
      // the period is now covered. Not an error.
      context.log(
        `report.auto_capture.lease_contended cadence=${cadence} periodKey=${result.periodKey} — another capture committed first`,
      );
      return;
    case "size_exceeded":
      // Audit line is on chain; surface as a non-fatal log so the Timer
      // doesn't repeatedly retry-fail. Operators alert via the
      // AIEVENT customEvent.
      context.warn(
        `report.auto_capture.size_exceeded cadence=${cadence} periodKey=${result.periodKey} bytes=${result.envelopeBytes}`,
      );
      return;
    case "invalid_period":
      // Programmer-error guard — periodForCadence cannot return null for
      // any of the three documented cadences. Logged loudly and emitted
      // as AIEVENT above; no throw to avoid Timer-retry storms on a
      // condition the next fire can't fix.
      context.error(
        `report.auto_capture.invalid_period cadence=${cadence} message=${result.errorMessage ?? ""}`,
      );
      return;
    case "error":
      // Throw so the Functions host marks the invocation failed and the
      // App Insights AgentRun-style alert rule fires. The audit line is
      // already on the chain regardless.
      throw new Error(
        `report.auto_capture.fail cadence=${cadence} periodKey=${result.periodKey} message=${result.errorMessage ?? "unknown"}`,
      );
  }
}

app.timer("reportSnapshotAutoCaptureTimer", {
  schedule: "%REPORT_SNAPSHOT_AUTO_CAPTURE_CRON%",
  runOnStartup: false,
  useMonitor: true,
  handler,
});
