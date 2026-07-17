// Minimal cron-next-fire calculator for the agent Timer schedules
// (B4 — Timer ETA badges). Bicep is authoritative for both schedules,
// so this implementation only needs to handle the shapes those Bicep
// params actually emit:
//
//   `0 0 5 * * *`     → 05:00 UTC daily         (brief-agent)
//   `0 0 6 * * 1`     → 06:00 UTC Mondays       (posture-agent)
//
// Generic cron parsing is deliberately out of scope. If a future
// schedule needs more expressivity we adopt `cron-parser` / `croner` as
// a dep — that's a one-line change at the parse step. For now the cost
// of a 600-line library to compute "next Monday 06:00" is not paid.
//
// The function exits with `null` on any unrecognised shape; the SPA
// renders a generic "next fire unknown" placeholder rather than a
// possibly-wrong ETA. Fail-safe.
//
// Format reference: Azure Functions NCRONTAB
// https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer
// — six-field form `{seconds} {minutes} {hours} {day} {month} {day-of-week}`.

export interface CronNextFireResult {
  readonly nextFireAt: string; // ISO8601 UTC
  readonly cron: string;
  readonly cadence: "daily" | "weekly";
}

/**
 * Compute the next fire time for the supplied NCRONTAB string. Returns
 * `null` for any cron shape outside the supported set.
 *
 * Supported:
 *   - `<sec> <min> <hour> * * *`        — daily at the given UTC time.
 *   - `<sec> <min> <hour> * * <0-6>`    — weekly on the given day-of-week.
 *
 * `now` defaults to the current time but is parameterisable for tests.
 */
export function nextFireOf(
  cron: string,
  now: Date = new Date(),
): CronNextFireResult | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 6) return null;
  const [secStr, minStr, hourStr, dayStr, monthStr, dowStr] = fields;
  // Day, month must be unrestricted wildcards.
  if (dayStr !== "*" || monthStr !== "*") return null;
  const sec = parseTimeField(secStr ?? "");
  const min = parseTimeField(minStr ?? "");
  const hour = parseTimeField(hourStr ?? "");
  if (sec === null || min === null || hour === null) return null;

  if (dowStr === "*") {
    return { nextFireAt: nextDailyFire(now, hour, min, sec), cron, cadence: "daily" };
  }
  const dow = parseTimeField(dowStr ?? "");
  if (dow === null || dow < 0 || dow > 6) return null;
  return {
    nextFireAt: nextWeeklyFire(now, hour, min, sec, dow),
    cron,
    cadence: "weekly",
  };
}

/** Parse a single integer field; reject ranges / lists / step values. */
function parseTimeField(field: string): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number.parseInt(field, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function nextDailyFire(now: Date, hour: number, min: number, sec: number): string {
  const candidate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      min,
      sec,
      0,
    ),
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate.toISOString();
}

/**
 * Compute the next weekly fire for a `<sec> <min> <hour> * * <dow>` cron.
 *
 * Month roll-over is implicit via `Date.prototype.setUTCDate` (SEC-L-B4-02
 * resolution). When `candidate.getUTCDate() + daysAhead` overflows the
 * current month (e.g. today is 29 April, daysAhead=3 → setUTCDate(32)),
 * JavaScript's Date normalisation rolls the excess into the next month:
 * `setUTCDate(32)` on an April Date becomes 2 May. The same rule handles
 * year boundaries (`setUTCDate(366)` on a January 1 Date → March 7 of
 * the next year). This is the documented behaviour per ECMA-262 §21.4.4
 * (MakeDay) and is tested in `cronNextFire.test.ts` — the "crosses a
 * month boundary correctly" and "rolls into the next year" cases pin
 * the invariant so a future refactor that hand-rolls day arithmetic
 * cannot regress silently.
 *
 * NCRONTAB day-of-week: Sunday=0..Saturday=6. JS `getUTCDay` matches.
 */
function nextWeeklyFire(
  now: Date,
  hour: number,
  min: number,
  sec: number,
  dow: number,
): string {
  const candidate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      min,
      sec,
      0,
    ),
  );
  let daysAhead = (dow - candidate.getUTCDay() + 7) % 7;
  if (daysAhead === 0 && candidate.getTime() <= now.getTime()) {
    daysAhead = 7;
  }
  // `setUTCDate` handles month + year roll-over via JS's Date normalisation;
  // see the function doc-comment above for the ECMA-262 contract.
  candidate.setUTCDate(candidate.getUTCDate() + daysAhead);
  return candidate.toISOString();
}
