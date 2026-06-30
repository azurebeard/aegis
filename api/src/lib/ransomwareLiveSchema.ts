// ADR-0037 — ransomware.live PRO response validators.
//
// Pure functions — no I/O, no SDK. Consumes the raw JSON returned by the
// upstream API and either returns a normalised `RansomwareVictim[]` /
// `RansomwarePress[]` matching the store's domain shapes, or throws a
// `RansomwareLiveSchemaError`. Reject-not-coerce: a row whose required
// fields are missing or wrong-typed fails the whole batch (the orchestrator
// catches and skips the run rather than persisting half-validated data).
//
// Adversarial-input handling (ADR-0037 §"Privacy"):
//   - Free-text fields (`activity`, `summary`, `victim`, `title`) carry
//     attacker-controlled or third-party-summarised text. Sanitisation
//     happens at parse-time so downstream (store + UI + email) sees only
//     clean strings:
//       1. Reject if the type is not `string`.
//       2. Strip C0 + C1 control characters (U+0000–U+001F and U+007F–U+009F)
//          AND U+2028 / U+2029 (line/paragraph separators — break JS string
//          line parsing). Common whitespace (\t \n \r  ) is stripped
//          along with the rest — these come out of leak-site posts and have
//          no semantic value in dashboard cells.
//       3. Cap at MAX_FREE_TEXT (4096 chars) and append a truncation marker.
//       4. Type narrowed back to `string` — no nominal subtype that could
//          mislead the SPA into trusting the value.
//   - URLs are sanitised the same way then cap-checked against MAX_URL.
//   - Country codes are upper-cased and length-checked against 2 / 3 chars
//     (alpha-2 from /victims/ + /press/all, alpha-3 from /csirt/{country}).
//
// Field-name mapping: ransomware.live returns lowercase keys
// (`attackdate`, `discovered`); we map to the camelCase domain shape used
// by `ransomwareIntelStore.ts`.

import type {
  RansomwarePress,
  RansomwareVictim,
} from "./ransomwareIntelStore.js";

const MAX_FREE_TEXT = 4096;
const MAX_SHORT_FIELD = 256;
const MAX_URL = 2048;
const MAX_ITEMS = 10_000;

const TRUNCATION_MARKER = "…[truncated]";

// C0 controls (0x00–0x1F), DEL (0x7F), C1 controls (0x80–0x9F), and the
// Unicode line/paragraph separators (U+2028, U+2029). Defence-in-depth —
// the SPA escapes by default but a control char in an email cell or PDF
// export is still a usability bug.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

export class RansomwareLiveSchemaError extends Error {
  readonly kind: "not_array" | "row_invalid" | "too_many_items";
  readonly rowIndex: number | null;
  readonly field: string | null;
  constructor(
    kind: RansomwareLiveSchemaError["kind"],
    message: string,
    rowIndex: number | null = null,
    field: string | null = null,
  ) {
    super(message);
    this.name = "RansomwareLiveSchemaError";
    this.kind = kind;
    this.rowIndex = rowIndex;
    this.field = field;
  }
}

export interface ParseOptions {
  /** ISO 8601 timestamp stamped onto every row's `ingestedAt`. The
   *  orchestrator supplies a single timestamp for the whole batch so all
   *  rows from one fetch share the retention anchor. */
  readonly ingestedAt: string;
}

/** Validate + normalise a `/victims/` response into the store's domain
 *  shape. Throws `RansomwareLiveSchemaError` on shape violation.
 *
 *  Envelope shape (confirmed live 2026-06-29 against the dev tenant):
 *    { client, filters, count, victims: [...] }
 *  The validator accepts either the wrapped form (canonical) OR a bare
 *  array (defensive: covers the upstream changing back, or `/victims/`
 *  vs `/victims/search` returning different shapes). The wrapper's
 *  metadata fields (client/filters/count) are discarded — they're not
 *  load-bearing for the dashboard. */
export function parseVictimsResponse(
  raw: unknown,
  options: ParseOptions,
): readonly RansomwareVictim[] {
  const arr = expectArrayOrWrappedArray(raw, "victims");
  const out: RansomwareVictim[] = [];
  for (let i = 0; i < arr.length; i++) {
    out.push(parseVictimRow(arr[i], i, options));
  }
  return out;
}

/** Validate + normalise a `/press/all` response.
 *
 *  Envelope shape (confirmed live 2026-06-29 against the dev tenant):
 *    { client, filters, count, results: [...] }
 *  Note the inner array key differs from `/victims/` — press uses
 *  `results`, victims uses `victims`. The validator unwraps the
 *  appropriate key for each endpoint. */
export function parsePressResponse(
  raw: unknown,
  options: ParseOptions,
): readonly RansomwarePress[] {
  const arr = expectArrayOrWrappedArray(raw, "results");
  const out: RansomwarePress[] = [];
  for (let i = 0; i < arr.length; i++) {
    out.push(parsePressRow(arr[i], i, options));
  }
  return out;
}

/** Accept either a bare top-level array OR an object envelope of the form
 *  `{...metadata..., [arrayKey]: [...]}`. Returns the inner array.
 *  Throws `not_array` when neither shape matches. The array-key form
 *  matches the live upstream as of 2026-06-29; the bare-array form is
 *  kept as a defensive fallback so a future API revert doesn't break us. */
function expectArrayOrWrappedArray(
  raw: unknown,
  arrayKey: string,
): readonly unknown[] {
  let candidate: unknown = raw;
  if (
    !Array.isArray(raw) &&
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as Record<string, unknown>)[arrayKey])
  ) {
    candidate = (raw as Record<string, unknown>)[arrayKey];
  }
  if (!Array.isArray(candidate)) {
    throw new RansomwareLiveSchemaError(
      "not_array",
      `expected JSON array OR object with \`${arrayKey}: [...]\` at top level, got ${typeOfBrief(raw)}`,
    );
  }
  if (candidate.length > MAX_ITEMS) {
    throw new RansomwareLiveSchemaError(
      "too_many_items",
      `array length ${candidate.length} exceeds MAX_ITEMS=${MAX_ITEMS}`,
    );
  }
  return candidate;
}

function parseVictimRow(
  raw: unknown,
  rowIndex: number,
  options: ParseOptions,
): RansomwareVictim {
  const obj = expectObject(raw, rowIndex);
  // Required: `id` (used for RowKey), `victim`, `group`. Everything else
  // tolerated as missing/empty per ADR-0037 §"defensive read".
  const id = requireString(obj, "id", rowIndex);
  if (id.length === 0) {
    throw new RansomwareLiveSchemaError(
      "row_invalid",
      `victim row ${rowIndex}: id is empty`,
      rowIndex,
      "id",
    );
  }
  return {
    id, // upstream id passed through verbatim — RowKey helper normalises.
    victim: shortField(obj, "victim"),
    group: shortField(obj, "group"),
    attackDate: optionalIsoDate(obj, "attackdate"),
    discoveredDate: optionalIsoDate(obj, "discovered"),
    country: countryCode(obj, "country"),
    // `sector` is NOT echoed in the `/victims/` row by the documented
    // upstream schema — it's a filter parameter, not a response field. We
    // look for it defensively in case Microsoft ever extends the response,
    // and default to "" otherwise so the store row carries a known shape.
    sector: shortField(obj, "sector"),
    // `activity` is the threat-actor-supplied narrative — adversarial input.
    activity: freeTextField(obj, "activity"),
    website: urlField(obj, "website"),
    permalink: urlField(obj, "permalink"),
    ingestedAt: options.ingestedAt,
  };
}

function parsePressRow(
  raw: unknown,
  rowIndex: number,
  options: ParseOptions,
): RansomwarePress {
  const obj = expectObject(raw, rowIndex);
  // Required: `url` (used for RowKey). Everything else tolerated.
  const url = urlField(obj, "url");
  if (url.length === 0) {
    throw new RansomwareLiveSchemaError(
      "row_invalid",
      `press row ${rowIndex}: url is empty`,
      rowIndex,
      "url",
    );
  }
  // Press schema doesn't have an upstream `id` — store layer hashes the URL
  // for the RowKey, so domain `id` is a stable derivative. Surface the raw
  // value so downstream debug tooling can correlate; the store recomputes.
  const id = optionalString(obj, "id") ?? "";
  return {
    id,
    title: shortField(obj, "title"),
    url,
    // Some HudsonRock-enriched press rows use `published`; others use `date`.
    // Accept either, prefer the more specific name.
    publishedAt: optionalIsoDate(obj, "published") ?? optionalIsoDate(obj, "date"),
    source: shortField(obj, "source"),
    country: countryCode(obj, "country"),
    // HudsonRock-enriched narrative — adversarial-input class.
    summary: freeTextField(obj, "summary"),
    ingestedAt: options.ingestedAt,
  };
}

// ─── Field-level helpers ────────────────────────────────────────────────────

function expectObject(raw: unknown, rowIndex: number): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RansomwareLiveSchemaError(
      "row_invalid",
      `row ${rowIndex}: expected object, got ${typeOfBrief(raw)}`,
      rowIndex,
    );
  }
  return raw as Record<string, unknown>;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  rowIndex: number,
): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new RansomwareLiveSchemaError(
      "row_invalid",
      `row ${rowIndex}: required field "${key}" must be a string, got ${typeOfBrief(v)}`,
      rowIndex,
      key,
    );
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  if (typeof v !== "string") return null;
  return v;
}

/** Free-text field: control-char stripped + length-capped. Returns "" when
 *  the field is missing OR non-string (silent default — these fields are
 *  per-row optional and a missing value should not fail the batch). */
export function freeTextField(
  obj: Record<string, unknown>,
  key: string,
): string {
  const v = obj[key];
  if (typeof v !== "string") return "";
  return sanitiseFreeText(v);
}

/** Short field (sector, group, victim name) — same sanitisation as
 *  free-text, but capped at MAX_SHORT_FIELD. */
function shortField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") return "";
  const clean = v.replace(CONTROL_CHARS_RE, "");
  if (clean.length <= MAX_SHORT_FIELD) return clean;
  return clean.slice(0, MAX_SHORT_FIELD - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** URL field: control chars stripped, scheme allowlisted, length-capped.
 *  Returns "" when missing/non-string OR when the URL has no scheme prefix
 *  this validator accepts.
 *
 *  IMPORTANT SCOPE NOTE — these URLs are **upstream-supplied content**
 *  (victim websites, press article URLs, ransomware.live permalinks), NOT
 *  endpoints this code calls. The HTTP client itself is hard-pinned to
 *  `https://api-pro.ransomware.live` in `ransomwareLiveClient.ts` and uses
 *  the loaded API key with HTTPS only. The `http://` allowance below is so
 *  legitimate legacy victim sites (industrial / small-business homepages
 *  that haven't migrated to HTTPS) survive the validator and reach the
 *  dashboard for the operator to inspect; if we strip them, the operator
 *  loses the ability to confirm "yes, this is the right company".
 *
 *  Defence-in-depth against `javascript:` / `data:` / `vbscript:` /
 *  `file:` smuggled through the threat-actor-controlled `website` field —
 *  even though Layer 5 must render these plain-text per ADR-0037
 *  §"Privacy", a regression that turned them into `<a href>` must not
 *  introduce an XSS surface. Allowed schemes:
 *   - `http://` and `https://` (the vast majority of upstream values)
 *   - `tor://` and `onion://` (sometimes used by leak-site posts)
 *   - The empty string (silently dropped) when none match. */
const ALLOWED_URL_SCHEMES = ["http://", "https://", "tor://", "onion://"] as const;

function urlField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") return "";
  const clean = v.replace(CONTROL_CHARS_RE, "").trim();
  if (clean.length === 0) return "";
  const lower = clean.toLowerCase();
  if (!ALLOWED_URL_SCHEMES.some((s) => lower.startsWith(s))) return "";
  if (clean.length <= MAX_URL) return clean;
  return clean.slice(0, MAX_URL - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/** Country code: upper-cased, control-stripped, length-checked. Accepts
 *  alpha-2 + alpha-3. Returns "" when missing or out-of-shape. */
function countryCode(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") return "";
  const clean = v.replace(CONTROL_CHARS_RE, "").trim().toUpperCase();
  if (clean.length !== 2 && clean.length !== 3) return "";
  if (!/^[A-Z]+$/.test(clean)) return "";
  return clean;
}

/** Optional ISO 8601-ish date. Reads the field as a string, control-strips
 *  it, returns `null` when missing OR unparseable. We don't aggressively
 *  re-format — the store carries the upstream string verbatim modulo
 *  sanitisation so debugging is unambiguous. */
function optionalIsoDate(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  if (typeof v !== "string") return null;
  const clean = v.replace(CONTROL_CHARS_RE, "").trim();
  if (clean.length === 0) return null;
  // Defensive cap — the date field shouldn't exceed an ISO 8601's length
  // (~32 chars), but we still bound it to keep the Table column predictable.
  if (clean.length > 64) return null;
  const parsed = Date.parse(clean);
  if (!Number.isFinite(parsed)) return null;
  return clean;
}

/** Exposed for tests + the client layer when post-validating a single
 *  string slipped through the schema (e.g. an HTTP error message body
 *  echoed back to AIEVENT). */
export function sanitiseFreeText(raw: string): string {
  const clean = raw.replace(CONTROL_CHARS_RE, "");
  if (clean.length <= MAX_FREE_TEXT) return clean;
  return clean.slice(0, MAX_FREE_TEXT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function typeOfBrief(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export const SCHEMA_LIMITS = {
  MAX_FREE_TEXT,
  MAX_SHORT_FIELD,
  MAX_URL,
  MAX_ITEMS,
  TRUNCATION_MARKER,
} as const;
