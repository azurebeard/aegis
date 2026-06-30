// ADR-0034 §3.2 — narrow Graph `/auditLogs/signIns` payloads into the typed
// shape consumed by the orchestrator + store. Defensive on malformed rows
// (skip-not-throw); evolvable enums on `conditionalAccessStatus` per
// Microsoft's evolvable-enum pattern. The `OutOfArea` flag is computed
// against the operator's geo-fence policy AT INGEST TIME so the dashboard
// tile is a fast partition-scan aggregate rather than a per-row policy
// lookup.

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
// ISO 3166-1 alpha-2 — two letter codes only. Lowercase comparison.
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

export interface SignInDomain {
  readonly id: string;
  readonly createdDateTime: string;
  readonly userId: string;
  readonly userPrincipalName: string;
  readonly userDisplayName: string;
  readonly appDisplayName: string;
  readonly ipAddress: string;
  readonly country: string; // ISO alpha-2 or empty
  readonly city: string;
  readonly state: string;
  /** JSON-stringified status object (errorCode + failureReason); bounded
   *  at 2 KB per ADR-0034 §3.2. */
  readonly status: string;
  readonly conditionalAccessStatus: string;
  /** `true` when `country` is non-empty AND not in the operator's
   *  allowedCountries allowlist. Computed at ingest time. */
  readonly outOfArea: boolean;
  readonly ingestedAt: string;
  readonly ingestRunId: string;
}

export interface ParsedSignInsBatch {
  readonly rows: readonly SignInDomain[];
  readonly skippedMalformed: number;
  readonly outOfAreaCount: number;
}

export interface GeoFencePolicy {
  readonly enabled: boolean;
  readonly allowedCountries: readonly string[]; // lowercased
  readonly unknownLocationPolicy: "alert" | "ignore";
}

interface ParseContext {
  readonly ingestedAt: string;
  readonly ingestRunId: string;
  readonly policy: GeoFencePolicy;
}

interface RawLocation {
  readonly countryOrRegion?: unknown;
  readonly city?: unknown;
  readonly state?: unknown;
}

interface RawSignIn {
  readonly id?: unknown;
  readonly createdDateTime?: unknown;
  readonly userId?: unknown;
  readonly userPrincipalName?: unknown;
  readonly userDisplayName?: unknown;
  readonly appDisplayName?: unknown;
  readonly ipAddress?: unknown;
  readonly location?: unknown;
  readonly status?: unknown;
  readonly conditionalAccessStatus?: unknown;
}

const STATUS_MAX_BYTES = 2 * 1024;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asIso(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) return "";
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return "";
  return v;
}

function normaliseCountry(v: unknown): string {
  if (typeof v !== "string" || !COUNTRY_CODE_RE.test(v)) return "";
  return v.toLowerCase();
}

function jsonStringifyBounded(v: unknown, maxBytes: number): string {
  if (v === null || v === undefined) return "";
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    return "";
  }
  if (Buffer.byteLength(s, "utf-8") > maxBytes) {
    // Trim defensively — the SPA renderer treats this as plain-text
    // anyway; truncation cannot break shape.
    return s.slice(0, Math.floor(maxBytes / 2)) + '..."truncated":true}';
  }
  return s;
}

/** Compute `OutOfArea` per the policy. Disabled policy → always false.
 *  Empty country → unknownLocationPolicy decides. Non-empty country →
 *  allowedCountries.includes(country.toLowerCase()) is the gate. */
export function computeOutOfArea(country: string, policy: GeoFencePolicy): boolean {
  if (!policy.enabled) return false;
  if (country === "") {
    return policy.unknownLocationPolicy === "alert";
  }
  return !policy.allowedCountries.includes(country);
}

function parseOne(raw: RawSignIn, ctx: ParseContext): SignInDomain | null {
  const id = asString(raw.id);
  if (!id || !ID_RE.test(id)) return null;
  const createdDateTime = asIso(raw.createdDateTime);
  if (!createdDateTime) return null;
  const userId = asString(raw.userId);
  if (!userId) return null;
  const loc = (raw.location ?? null) as RawLocation | null;
  const country = loc ? normaliseCountry(loc.countryOrRegion) : "";
  return {
    id,
    createdDateTime,
    userId,
    userPrincipalName: asString(raw.userPrincipalName),
    userDisplayName: asString(raw.userDisplayName),
    appDisplayName: asString(raw.appDisplayName),
    ipAddress: asString(raw.ipAddress),
    country,
    city: loc ? asString(loc.city) : "",
    state: loc ? asString(loc.state) : "",
    status: jsonStringifyBounded(raw.status, STATUS_MAX_BYTES),
    conditionalAccessStatus: asString(raw.conditionalAccessStatus),
    outOfArea: computeOutOfArea(country, ctx.policy),
    ingestedAt: ctx.ingestedAt,
    ingestRunId: ctx.ingestRunId,
  };
}

/** Parse one Graph `/auditLogs/signIns` page envelope. */
export function parseSignInsPage(
  rawPage: unknown,
  ctx: ParseContext,
): ParsedSignInsBatch {
  if (!rawPage || typeof rawPage !== "object") {
    return { rows: [], skippedMalformed: 0, outOfAreaCount: 0 };
  }
  const env = rawPage as { value?: unknown };
  const value = Array.isArray(env.value) ? env.value : [];
  const rows: SignInDomain[] = [];
  let skippedMalformed = 0;
  let outOfAreaCount = 0;
  for (const r of value) {
    if (!r || typeof r !== "object") {
      skippedMalformed++;
      continue;
    }
    const parsed = parseOne(r as RawSignIn, ctx);
    if (parsed === null) {
      skippedMalformed++;
      continue;
    }
    rows.push(parsed);
    if (parsed.outOfArea) outOfAreaCount++;
  }
  return { rows, skippedMalformed, outOfAreaCount };
}

/** Aggregate parse over all pages. */
export function parseSignInsPages(
  rawPages: readonly unknown[],
  ctx: ParseContext,
): ParsedSignInsBatch {
  const allRows: SignInDomain[] = [];
  let skippedMalformed = 0;
  let outOfAreaCount = 0;
  for (const page of rawPages) {
    const batch = parseSignInsPage(page, ctx);
    for (const r of batch.rows) allRows.push(r);
    skippedMalformed += batch.skippedMalformed;
    outOfAreaCount += batch.outOfAreaCount;
  }
  return { rows: allRows, skippedMalformed, outOfAreaCount };
}
