// Pure-function test for the per-day bucketing helper backing the
// diagnostics-page outcomes-per-day chart. The helper produces a
// continuous calendar window even when the source produced no runs on
// some days, which is what makes the bar chart honest.

import { describe, expect, it } from "vitest";
import { bucketByDay } from "@/pages/DiagnosticsPage";
import type { IngestRunHistoryItem } from "@/features/secureScore/ingestRunHistory";

function run(
  status: string | null,
  errorKind: string | null,
  startedAt: string,
  day?: string,
): IngestRunHistoryItem {
  return {
    runId: "r-" + startedAt,
    startedAt,
    endedAt: null,
    status,
    rowsWritten: status === "success" ? 1 : 0,
    retentionRowsDeleted: 0,
    graphAttempts: errorKind ? 3 : 1,
    snapshotDate: null,
    currentScore: null,
    maxScore: null,
    errorKind,
    day: day ?? startedAt.slice(0, 10),
  };
}

describe("DiagnosticsPage.bucketByDay", () => {
  it("returns one bucket per calendar day in the lookback window", () => {
    const out = bucketByDay([], 14);
    expect(out.length).toBe(14);
  });

  it("counts success / error / no_data correctly per day", () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayDay = today.toISOString().slice(0, 10);
    const items: IngestRunHistoryItem[] = [
      run("success", null, `${todayDay}T03:00:01Z`),
      run("success", null, `${todayDay}T03:01:00Z`),
      run("error", "timeout", `${todayDay}T03:03:32Z`),
      run("no_data", null, `${todayDay}T03:05:00Z`),
    ];
    const out = bucketByDay(items, 7);
    const todayBucket = out.find((b) => b.day === todayDay);
    expect(todayBucket).toBeDefined();
    expect(todayBucket?.success).toBe(2);
    expect(todayBucket?.error).toBe(1);
    expect(todayBucket?.noData).toBe(1);
  });

  it("classifies a row with errorKind set as 'error' regardless of status", () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayDay = today.toISOString().slice(0, 10);
    const items: IngestRunHistoryItem[] = [
      // Status says success but errorKind is set — classify as error
      // (defensive: server should never emit this combo, but the renderer
      // shouldn't trust mixed shapes).
      run("success", "internal", `${todayDay}T03:00:01Z`),
    ];
    const out = bucketByDay(items, 1);
    expect(out[0]?.error).toBe(1);
    expect(out[0]?.success).toBe(0);
  });

  it("ignores runs whose day falls outside the lookback window", () => {
    const items: IngestRunHistoryItem[] = [
      // 2 years ago — definitely outside any reasonable lookback window
      run("success", null, "2024-01-01T03:00:00Z"),
    ];
    const out = bucketByDay(items, 14);
    const total = out.reduce((s, b) => s + b.success + b.error + b.noData, 0);
    expect(total).toBe(0);
  });

  it("orders buckets oldest-to-newest (left-to-right on a chart)", () => {
    const out = bucketByDay([], 7);
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]?.day ?? "";
      const curr = out[i]?.day ?? "";
      expect(prev < curr).toBe(true);
    }
  });
});
