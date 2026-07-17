// Period-key derivation + validation for ADR-0030 report snapshots.
//
// Three accepted forms, matched against operator-set TenantSettings.reportCadence:
//   weekly:     YYYY-Www  (ISO 8601 week numbering)
//   monthly:    YYYY-MM
//   quarterly:  YYYY-Qn   (calendar Q1 = Jan-Mar)
//
// Period derivation is UTC-only — same convention as posture-agent's
// isoWeek keying. Operators in non-UTC time zones get a UTC period
// bracket; the SPA renders local-time `periodStart` / `periodEnd`
// labels for human readability without changing the canonical key.

export type ReportCadence = "weekly" | "monthly" | "quarterly";

const WEEKLY_RE = /^(\d{4})-W(\d{2})$/;
const MONTHLY_RE = /^(\d{4})-(\d{2})$/;
const QUARTERLY_RE = /^(\d{4})-Q([1-4])$/;

export interface PeriodBounds {
  readonly cadence: ReportCadence;
  readonly periodKey: string;
  readonly periodStart: string; // ISO-8601 UTC, inclusive
  readonly periodEnd: string;   // ISO-8601 UTC, inclusive end-of-period (… .999Z)
}

/**
 * Validate a periodKey against the cadence — both shape AND range. Hostile
 * inputs like `"2026-13"` (regex-shaped but month out of range) are rejected.
 * Delegates to `periodFromKey` so range-checking stays a single source of truth.
 */
export function isValidPeriodKey(cadence: ReportCadence, key: string): boolean {
  return periodFromKey(cadence, key) !== null;
}

/** Validate a cadence value coming off the wire. */
export function isReportCadence(value: unknown): value is ReportCadence {
  return value === "weekly" || value === "monthly" || value === "quarterly";
}

/**
 * Derive the period bounds for the period containing `now`. Used by the
 * capture handler when an admin clicks "Capture this period" without
 * specifying an explicit periodKey.
 */
export function periodForCadence(
  cadence: ReportCadence,
  now: Date = new Date(),
): PeriodBounds {
  switch (cadence) {
    case "weekly":    return weeklyPeriod(now);
    case "monthly":   return monthlyPeriod(now);
    case "quarterly": return quarterlyPeriod(now);
  }
}

/**
 * Resolve an explicit periodKey to its bounds. Returns null if the key is
 * malformed or names a period whose values are out-of-range (e.g. month 13,
 * week 54 in a non-leap-week year).
 */
export function periodFromKey(
  cadence: ReportCadence,
  key: string,
): PeriodBounds | null {
  switch (cadence) {
    case "weekly":    return weeklyFromKey(key);
    case "monthly":   return monthlyFromKey(key);
    case "quarterly": return quarterlyFromKey(key);
  }
}

// --- Weekly (ISO 8601) ----------------------------------------------------

function weeklyPeriod(now: Date): PeriodBounds {
  const { year, week } = isoWeekOf(now);
  return weeklyBounds(year, week);
}

function weeklyFromKey(key: string): PeriodBounds | null {
  const m = WEEKLY_RE.exec(key);
  if (!m) return null;
  const year = Number.parseInt(m[1] as string, 10);
  const week = Number.parseInt(m[2] as string, 10);
  // Allow weeks 1-53; week 54 is invalid in ISO 8601.
  if (week < 1 || week > 53) return null;
  // Verify the week is reachable in this ISO year — week 53 only exists in
  // certain years (e.g. 2020, 2026). Cross-check by reconstructing.
  const bounds = weeklyBounds(year, week);
  const round = isoWeekOf(new Date(bounds.periodStart));
  if (round.year !== year || round.week !== week) return null;
  return bounds;
}

function weeklyBounds(isoYear: number, isoWeek: number): PeriodBounds {
  // ISO week starts on Monday. Week 1 contains the year's first Thursday.
  // Find Jan 4 of isoYear (always in week 1), back-step to its Monday,
  // add (isoWeek - 1) weeks.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const dow = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - (dow - 1));
  const start = new Date(week1Monday.getTime());
  start.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7);
  const end = new Date(start.getTime());
  end.setUTCDate(start.getUTCDate() + 7);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return {
    cadence: "weekly",
    periodKey: `${isoYear}-W${String(isoWeek).padStart(2, "0")}`,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

function isoWeekOf(d: Date): { year: number; week: number } {
  // Algorithm per ISO 8601 §3.2.2.
  const probe = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Set probe to Thursday of the same week (ISO weeks are Thursday-anchored).
  const dow = probe.getUTCDay() || 7;
  probe.setUTCDate(probe.getUTCDate() + 4 - dow);
  const isoYear = probe.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((probe.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: isoYear, week };
}

// --- Monthly --------------------------------------------------------------

function monthlyPeriod(now: Date): PeriodBounds {
  return monthlyBounds(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

function monthlyFromKey(key: string): PeriodBounds | null {
  const m = MONTHLY_RE.exec(key);
  if (!m) return null;
  const year = Number.parseInt(m[1] as string, 10);
  const month = Number.parseInt(m[2] as string, 10);
  if (month < 1 || month > 12) return null;
  return monthlyBounds(year, month);
}

function monthlyBounds(year: number, monthOneBased: number): PeriodBounds {
  const start = new Date(Date.UTC(year, monthOneBased - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthOneBased, 1, 0, 0, 0, 0));
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return {
    cadence: "monthly",
    periodKey: `${year}-${String(monthOneBased).padStart(2, "0")}`,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

// --- Quarterly ------------------------------------------------------------

function quarterlyPeriod(now: Date): PeriodBounds {
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  return quarterlyBounds(now.getUTCFullYear(), q as 1 | 2 | 3 | 4);
}

function quarterlyFromKey(key: string): PeriodBounds | null {
  const m = QUARTERLY_RE.exec(key);
  if (!m) return null;
  const year = Number.parseInt(m[1] as string, 10);
  const quarter = Number.parseInt(m[2] as string, 10) as 1 | 2 | 3 | 4;
  return quarterlyBounds(year, quarter);
}

function quarterlyBounds(year: number, q: 1 | 2 | 3 | 4): PeriodBounds {
  const startMonth = (q - 1) * 3; // 0-indexed
  const endMonth = q * 3;         // 0-indexed first month of next quarter
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, endMonth, 1, 0, 0, 0, 0));
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return {
    cadence: "quarterly",
    periodKey: `${year}-Q${q}`,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}
