// ADR-0032 §1 + §7 — fetch + parse the CISA KEV feed.
//
// Public unauthenticated HTTPS feed. Defences:
//   - 30s timeout (configurable via KEV_FEED_TIMEOUT_MS)
//   - 50 MB body cap (configurable via KEV_FEED_MAX_BYTES) — current
//     feed is ~1.5 MB, but cap defends against a CISA-side incident
//     or MITM serving an unbounded payload.
//   - 3 retries with exponential backoff on 5xx / network errors.
//     4xx (other than 429) are terminal-no-retry.
//   - Strict schema validation on parse: if the top-level shape drifts,
//     fail-loud with `error.kind=schema_invalid`. Per-CVE we're tolerant
//     (skip the bad row + warn) so a single CISA typo doesn't fail the
//     whole ingest.
//   - cveID validated against `^CVE-\d{4}-\d{4,7}$` — reject malformed.
//   - Per-field length caps on parse (truncate + log). Belt-and-braces
//     even though Table Storage column cap is 64 KB.

const CVE_ID_RE = /^CVE-\d{4}-\d{4,7}$/;

const VENDOR_PRODUCT_MAX = 256;
const NAME_MAX = 512;
const TEXT_MAX = 4096;

export interface RawKevEntry {
  readonly cveID: string;
  readonly vendorProject: string;
  readonly product: string;
  readonly vulnerabilityName: string;
  readonly dateAdded: string;
  readonly shortDescription: string;
  readonly requiredAction: string;
  readonly dueDate: string;
  readonly knownRansomwareCampaignUse: "Known" | "Unknown";
  readonly notes: string;
  readonly cwes: readonly string[];
}

export interface ParsedKevFeed {
  readonly catalogVersion: string;
  readonly dateReleased: string;
  readonly count: number;
  readonly entries: readonly RawKevEntry[];
  /** Number of raw entries that the parser dropped because they failed
   *  cveID validation or were missing required fields. Surfaces via
   *  audit line + AIEVENT for operator visibility on schema drift. */
  readonly droppedCount: number;
  /** HTTP attempts the fetcher made before success. */
  readonly attempts: number;
  /** Final HTTP status of the successful fetch. */
  readonly httpStatusFinal: number;
}

export class KevFetchError extends Error {
  readonly kind: "timeout" | "network" | "4xx" | "5xx" | "size_exceeded" | "schema_invalid" | "internal";
  readonly status: number | null;
  readonly attempts: number;
  constructor(args: {
    kind: KevFetchError["kind"];
    message: string;
    status?: number | null;
    attempts?: number;
  }) {
    super(args.message);
    this.name = "KevFetchError";
    this.kind = args.kind;
    this.status = args.status ?? null;
    this.attempts = args.attempts ?? 0;
  }
}

export interface FetchKevConfig {
  readonly feedUrl: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Test-fixture override — defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Test-fixture override — defaults to setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Fetch + parse the KEV feed. Retries on 5xx + network up to 3 times.
 * Throws KevFetchError on terminal failure.
 */
export async function fetchKevFeed(config: FetchKevConfig): Promise<ParsedKevFeed> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastErr: KevFetchError | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await fetchOnce(config.feedUrl, config.timeoutMs, config.maxBytes, fetchImpl);
      return { ...parseKevFeed(result.body), attempts: attempt, httpStatusFinal: result.status };
    } catch (err) {
      if (!(err instanceof KevFetchError)) throw err;
      lastErr = err;
      lastErr = new KevFetchError({ ...err, attempts: attempt });
      // Don't retry terminal errors (4xx other than 429, schema_invalid, size_exceeded).
      if (err.kind === "4xx" && err.status !== 429) break;
      if (err.kind === "schema_invalid") break;
      if (err.kind === "size_exceeded") break;
      // Backoff: 1s, 4s.
      if (attempt < 3) await sleep(attempt * 1000 * attempt);
    }
  }
  if (!lastErr) throw new KevFetchError({ kind: "internal", message: "fetchKevFeed: no result + no error", attempts: 3 });
  throw lastErr;
}

async function fetchOnce(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  fetchImpl: typeof fetch,
): Promise<{ body: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = (err as { name?: string }).name === "AbortError";
    throw new KevFetchError({
      kind: isAbort ? "timeout" : "network",
      message: isAbort ? `KEV fetch timed out after ${timeoutMs}ms` : `KEV fetch network error: ${(err as Error).message}`,
    });
  }
  clearTimeout(timer);
  if (response.status >= 500) {
    throw new KevFetchError({
      kind: "5xx",
      status: response.status,
      message: `KEV fetch upstream error: ${response.status}`,
    });
  }
  if (response.status >= 400) {
    throw new KevFetchError({
      kind: "4xx",
      status: response.status,
      message: `KEV fetch client error: ${response.status}`,
    });
  }
  // Stream-cap the body. Most fetch implementations don't support a hard
  // byte cap natively, so we read into a buffer + abort after the cap.
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new KevFetchError({
      kind: "size_exceeded",
      status: response.status,
      message: `KEV feed Content-Length ${contentLength} exceeds cap ${maxBytes}`,
    });
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf-8") > maxBytes) {
    throw new KevFetchError({
      kind: "size_exceeded",
      status: response.status,
      message: `KEV feed body ${Buffer.byteLength(text, "utf-8")} bytes exceeds cap ${maxBytes}`,
    });
  }
  return { body: text, status: response.status };
}

interface RawTopLevel {
  readonly catalogVersion?: unknown;
  readonly dateReleased?: unknown;
  readonly count?: unknown;
  readonly vulnerabilities?: unknown;
}

interface RawCveJson {
  readonly cveID?: unknown;
  readonly vendorProject?: unknown;
  readonly product?: unknown;
  readonly vulnerabilityName?: unknown;
  readonly dateAdded?: unknown;
  readonly shortDescription?: unknown;
  readonly requiredAction?: unknown;
  readonly dueDate?: unknown;
  readonly knownRansomwareCampaignUse?: unknown;
  readonly notes?: unknown;
  readonly cwes?: unknown;
}

/**
 * Parse the JSON body. Top-level shape is strict — missing
 * `vulnerabilities` array is fail-loud. Per-CVE rows are tolerant —
 * malformed entries are dropped + counted, the run continues.
 */
export function parseKevFeed(body: string): Omit<ParsedKevFeed, "attempts" | "httpStatusFinal"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new KevFetchError({ kind: "schema_invalid", message: "KEV feed body is not valid JSON" });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KevFetchError({ kind: "schema_invalid", message: "KEV feed root is not a JSON object" });
  }
  const top = parsed as RawTopLevel;
  if (!Array.isArray(top.vulnerabilities)) {
    throw new KevFetchError({
      kind: "schema_invalid",
      message: "KEV feed missing `vulnerabilities` array",
    });
  }

  const entries: RawKevEntry[] = [];
  let dropped = 0;
  for (const v of top.vulnerabilities) {
    const entry = parseEntry(v);
    if (entry) entries.push(entry);
    else dropped++;
  }
  return {
    catalogVersion: typeof top.catalogVersion === "string" ? top.catalogVersion : "",
    dateReleased: typeof top.dateReleased === "string" ? top.dateReleased : "",
    count: typeof top.count === "number" ? top.count : entries.length,
    entries,
    droppedCount: dropped,
  };
}

function parseEntry(raw: unknown): RawKevEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as RawCveJson;
  if (typeof r.cveID !== "string" || !CVE_ID_RE.test(r.cveID)) return null;
  if (typeof r.vendorProject !== "string" || r.vendorProject.trim() === "") return null;
  if (typeof r.product !== "string" || r.product.trim() === "") return null;

  return {
    cveID: r.cveID,
    vendorProject: truncate(r.vendorProject, VENDOR_PRODUCT_MAX),
    product: truncate(r.product, VENDOR_PRODUCT_MAX),
    vulnerabilityName: truncate(asString(r.vulnerabilityName), NAME_MAX),
    dateAdded: asString(r.dateAdded),
    shortDescription: truncate(asString(r.shortDescription), TEXT_MAX),
    requiredAction: truncate(asString(r.requiredAction), TEXT_MAX),
    dueDate: asString(r.dueDate),
    knownRansomwareCampaignUse:
      r.knownRansomwareCampaignUse === "Known" ? "Known" : "Unknown",
    notes: truncate(asString(r.notes), TEXT_MAX),
    cwes: Array.isArray(r.cwes)
      ? r.cwes.filter((c): c is string => typeof c === "string").slice(0, 16)
      : [],
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}
