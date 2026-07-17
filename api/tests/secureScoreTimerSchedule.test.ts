// Pin the cron expressions to single-fire form. Defends against the
// 2026-05-01 regression where `0 0-4 3 * * *` was mistaken for jitter
// syntax — NCRONTAB's range expression fires on EVERY minute in the
// range, producing 5 invocations per day.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSchedule(file: string): string {
  const src = readFileSync(join(__dirname, "..", "src", "ingest", file), "utf8");
  const m = src.match(/const\s+SCHEDULE\s*=\s*"([^"]+)";/);
  if (!m) throw new Error(`SCHEDULE constant not found in ${file}`);
  return m[1] ?? "";
}

describe("ingest timer cron expressions", () => {
  it("secureScoreTimer fires once daily at 03:00 UTC (no minute-range jitter)", () => {
    const cron = readSchedule("secureScoreTimer.ts");
    expect(cron).toBe("0 0 3 * * *");
    // Defensive — must not contain a range in the minute field.
    expect(cron).not.toMatch(/^\d+\s+\d+-\d+\s+/);
  });

  it("secureScoreControlProfilesTimer fires once daily at 02:30 UTC", () => {
    const cron = readSchedule("secureScoreControlProfilesTimer.ts");
    expect(cron).toBe("0 30 2 * * *");
    expect(cron).not.toMatch(/^\d+\s+\d+-\d+\s+/);
  });
});
