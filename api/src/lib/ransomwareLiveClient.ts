// ADR-0037 — ransomware.live PRO HTTP client.
//
// Two read endpoints:
//   - `GET /victims/?country=&year=&month=`  → schema-validated victim rows
//   - `GET /press/all?country=&year=&month=` → schema-validated press rows
//
// Auth: `X-API-KEY` header on every request, key loaded lazily from KV via
// the injected `loadApiKey` thunk (default: `loadRansomwareLiveApiKey`).
// Decoupling the loader from the client keeps tests free of KV mocks.
//
// Retry policy (mirrors `graphClient.graphGetJsonWithRetry`):
//   - 3 attempts max.
//   - Retry on 408/429/500/502/503/504 with full-jitter exponential backoff
//     (2s base → 30s cap).
//   - Retry on AbortError/network/timeout — bounded by max attempts.
//   - 400/401/403/404 are terminal (re-trying a 401 only burns the rate-
//     limit budget; re-trying a 404 confuses the upstream rate counter).
//   - `Retry-After` honoured when present + parseable, clamped to a 30s
//     hard cap so a misconfigured upstream can't pin us mid-Timer.
//
// Adversarial input: all parsed rows go through
// `ransomwareLiveSchema` which strips control chars + caps lengths. The
// client itself only does the shape-level "is this an array?" check by
// way of delegating to the parser.

import type { InvocationContext } from "@azure/functions";
import { emitAievent } from "./aievent.js";
import {
  loadRansomwareLiveApiKey as defaultLoadApiKey,
  type ApiKeyFallbackReason,
  type LoadApiKeyResult,
} from "./ransomwareLiveApiKey.js";
import type { RansomwarePress, RansomwareVictim } from "./ransomwareIntelStore.js";
import {
  parsePressResponse,
  parseVictimsResponse,
  RansomwareLiveSchemaError,
} from "./ransomwareLiveSchema.js";

const DEFAULT_BASE_URL = "https://api-pro.ransomware.live";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const RETRY_AFTER_HARD_CAP_MS = 30_000;
const USER_AGENT = "aegis-xdr-hub/1.0 (+ransomware-intel ingest)";

export type RansomwareLiveFetchErrorKind =
  | "auth_unavailable"
  | "timeout"
  | "throttle"
  | "4xx"
  | "5xx"
  | "network"
  | "schema_invalid"
  | "internal";

export class RansomwareLiveFetchError extends Error {
  readonly kind: RansomwareLiveFetchErrorKind;
  readonly status: number | null;
  readonly attempts: number;
  /** Populated when kind === "auth_unavailable" — maps to the KV loader
   *  fallback reason so the orchestrator can sticky-set IngestHealth. */
  readonly fallbackReason: ApiKeyFallbackReason | null;
  constructor(
    kind: RansomwareLiveFetchErrorKind,
    message: string,
    status: number | null,
    attempts: number,
    fallbackReason: ApiKeyFallbackReason | null = null,
  ) {
    super(message);
    this.name = "RansomwareLiveFetchError";
    this.kind = kind;
    this.status = status;
    this.attempts = attempts;
    this.fallbackReason = fallbackReason;
  }
}

export interface RetryEvent {
  readonly attempt: number;
  readonly statusCode: number;
  readonly retryAfterHeader: string | null;
  readonly retryAfterClamped: boolean;
  readonly retryAfterAppliedMs: number;
  readonly backoffMs: number;
}

export interface FetchResult<T> {
  readonly data: T;
  readonly attempts: number;
  readonly finalHttpStatus: number;
  readonly retryEvents: readonly RetryEvent[];
}

export interface RansomwareLiveClientOptions {
  /** Override the base URL — for tests + future on-prem mirror support. */
  readonly baseUrl?: string;
  /** Override the timeout (ms). Defaults to 30s. */
  readonly timeoutMs?: number;
  /** Override the KV loader. Defaults to `loadRansomwareLiveApiKey`. */
  readonly loadApiKey?: () => Promise<LoadApiKeyResult>;
  /** Override `fetch` — for unit tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Override the wall-clock that stamps every parsed row's `ingestedAt`.
   *  Defaults to `new Date().toISOString()` at the moment of parse. The
   *  orchestrator passes a fixed timestamp so all rows from one Timer
   *  fire share the same retention anchor. */
  readonly ingestedAtIso?: string;
}

export interface MonthFilter {
  /** ISO 3166-1 alpha-2 country code (e.g. `GB`). Echoed verbatim into
   *  the URL query string — caller responsible for ensuring it matches
   *  the upstream contract. */
  readonly country: string;
  readonly year: number;
  /** 1–12. Zero-padded internally — the upstream prefers `06` to `6`. */
  readonly month: number;
}

interface ClientContext {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly loadApiKey: () => Promise<LoadApiKeyResult>;
  readonly fetchImpl: typeof fetch;
  readonly ingestedAtIso: string;
}

function buildContext(options: RansomwareLiveClientOptions = {}): ClientContext {
  return {
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    loadApiKey: options.loadApiKey ?? defaultLoadApiKey,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    ingestedAtIso: options.ingestedAtIso ?? new Date().toISOString(),
  };
}

export async function fetchRansomwareLiveVictims(
  filter: MonthFilter,
  context: InvocationContext,
  options: RansomwareLiveClientOptions = {},
): Promise<FetchResult<readonly RansomwareVictim[]>> {
  const ctx = buildContext(options);
  const url = buildUrl(ctx.baseUrl, "/victims/", filter);
  const raw = await getJsonWithRetry(url, ctx, context);
  let parsed: readonly RansomwareVictim[];
  try {
    parsed = parseVictimsResponse(raw.data, { ingestedAt: ctx.ingestedAtIso });
  } catch (err) {
    if (err instanceof RansomwareLiveSchemaError) {
      throw new RansomwareLiveFetchError(
        "schema_invalid",
        `victims response failed schema: ${err.message}`,
        raw.finalHttpStatus,
        raw.attempts,
      );
    }
    throw err;
  }
  return { ...raw, data: parsed };
}

export async function fetchRansomwareLivePress(
  filter: MonthFilter,
  context: InvocationContext,
  options: RansomwareLiveClientOptions = {},
): Promise<FetchResult<readonly RansomwarePress[]>> {
  const ctx = buildContext(options);
  const url = buildUrl(ctx.baseUrl, "/press/all", filter);
  const raw = await getJsonWithRetry(url, ctx, context);
  let parsed: readonly RansomwarePress[];
  try {
    parsed = parsePressResponse(raw.data, { ingestedAt: ctx.ingestedAtIso });
  } catch (err) {
    if (err instanceof RansomwareLiveSchemaError) {
      throw new RansomwareLiveFetchError(
        "schema_invalid",
        `press response failed schema: ${err.message}`,
        raw.finalHttpStatus,
        raw.attempts,
      );
    }
    throw err;
  }
  return { ...raw, data: parsed };
}

function buildUrl(baseUrl: string, path: string, filter: MonthFilter): string {
  const params = new URLSearchParams();
  params.set("country", filter.country);
  params.set("year", String(filter.year));
  params.set("month", String(filter.month).padStart(2, "0"));
  return `${baseUrl}${path}?${params.toString()}`;
}

async function getJsonWithRetry(
  url: string,
  ctx: ClientContext,
  context: InvocationContext,
): Promise<FetchResult<unknown>> {
  const apiKeyResult = await ctx.loadApiKey();
  if (apiKeyResult.key === null) {
    throw new RansomwareLiveFetchError(
      "auth_unavailable",
      `ransomware.live API key unavailable: ${apiKeyResult.fallbackReason ?? "env_unset"}`,
      null,
      0,
      apiKeyResult.fallbackReason ?? "env_unset",
    );
  }
  const key = apiKeyResult.key;

  const retryEvents: RetryEvent[] = [];
  let lastStatus = 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), ctx.timeoutMs);

    let res: Response;
    try {
      res = await ctx.fetchImpl(url, {
        method: "GET",
        headers: {
          "X-API-KEY": key,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });
    } catch (err) {
      lastError = err;
      const isAbort = (err as Error)?.name === "AbortError";
      const kind: RansomwareLiveFetchErrorKind = isAbort ? "timeout" : "network";
      context.warn(
        `ransomware.live fetch ${isAbort ? "timeout" : "network error"}: attempt=${attempt} err=${String((err as Error).message ?? err).slice(0, 200)}`,
      );
      if (attempt === MAX_ATTEMPTS) {
        throw new RansomwareLiveFetchError(
          kind,
          `ransomware.live fetch ${kind} after ${MAX_ATTEMPTS} attempts`,
          null,
          attempt,
        );
      }
      const backoff = computeBackoffMs(attempt);
      retryEvents.push({
        attempt,
        statusCode: 0,
        retryAfterHeader: null,
        retryAfterClamped: false,
        retryAfterAppliedMs: 0,
        backoffMs: backoff,
      });
      await sleep(backoff);
      continue;
    } finally {
      clearTimeout(timeoutHandle);
    }

    lastStatus = res.status;

    if (res.status >= 200 && res.status < 300) {
      let body: unknown;
      try {
        body = await res.json();
      } catch (parseErr) {
        throw new RansomwareLiveFetchError(
          "internal",
          `ransomware.live ${res.status} body not valid JSON: ${String((parseErr as Error).message ?? parseErr).slice(0, 200)}`,
          res.status,
          attempt,
        );
      }
      return {
        data: body,
        attempts: attempt,
        finalHttpStatus: res.status,
        retryEvents,
      };
    }

    // Terminal non-retry. NB the upstream returns 401 when the API key is
    // wrong or revoked — we want a loud failure, not silent retry burning
    // through the monthly quota.
    if ([400, 401, 403, 404].includes(res.status)) {
      const body = await res.text().catch(() => "");
      emitAievent(context, "RansomwareLiveAuthRejected", {
        statusCode: res.status,
        attempt,
        // Echo a 64-char excerpt so an operator can correlate against
        // the upstream response without leaking a potentially-huge body
        // into telemetry.
        bodyExcerpt: body.slice(0, 64),
      });
      throw new RansomwareLiveFetchError(
        "4xx",
        `ransomware.live ${res.status} terminal: ${body.slice(0, 200)}`,
        res.status,
        attempt,
      );
    }

    const isRetryable = [408, 429, 500, 502, 503, 504].includes(res.status);
    if (!isRetryable) {
      const body = await res.text().catch(() => "");
      throw new RansomwareLiveFetchError(
        classifyStatus(res.status),
        `ransomware.live ${res.status} non-retryable: ${body.slice(0, 200)}`,
        res.status,
        attempt,
      );
    }

    if (attempt === MAX_ATTEMPTS) {
      throw new RansomwareLiveFetchError(
        classifyStatus(res.status),
        `ransomware.live ${res.status} after ${MAX_ATTEMPTS} attempts`,
        res.status,
        attempt,
      );
    }

    const retryAfterHeader = res.headers.get("retry-after");
    const applied = applyRetryAfterClamp(retryAfterHeader, attempt);
    retryEvents.push({
      attempt,
      statusCode: res.status,
      retryAfterHeader,
      retryAfterClamped: applied.clamped,
      retryAfterAppliedMs: applied.appliedMs,
      backoffMs: applied.backoffMs,
    });
    await sleep(applied.appliedMs > 0 ? applied.appliedMs : applied.backoffMs);
  }

  // Loop exit without explicit return — defence; the attempt-cap branches
  // above all throw. Surface a clear internal error if we ever get here.
  /* c8 ignore next */
  throw new RansomwareLiveFetchError(
    "internal",
    `ransomware.live loop ended without return; lastStatus=${lastStatus} lastError=${String((lastError as Error)?.message ?? lastError ?? "")}`,
    lastStatus || null,
    MAX_ATTEMPTS,
  );
}

export function applyRetryAfterClamp(
  header: string | null,
  attempt: number,
): { appliedMs: number; clamped: boolean; backoffMs: number } {
  const backoffMs = computeBackoffMs(attempt);
  if (!header) {
    return { appliedMs: 0, clamped: false, backoffMs };
  }
  const requestedSeconds = Number.parseInt(header, 10);
  if (!Number.isFinite(requestedSeconds) || requestedSeconds < 0) {
    return { appliedMs: 0, clamped: false, backoffMs };
  }
  const requestedMs = requestedSeconds * 1000;
  const appliedMs = Math.min(requestedMs, RETRY_AFTER_HARD_CAP_MS);
  return { appliedMs, clamped: appliedMs < requestedMs, backoffMs };
}

function classifyStatus(status: number): RansomwareLiveFetchErrorKind {
  if (status === 408) return "timeout";
  if (status === 429) return "throttle";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  return "internal";
}

export function computeBackoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), BACKOFF_MAX_MS);
  return Math.floor(exp * Math.random());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const internals = {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  RETRY_AFTER_HARD_CAP_MS,
  USER_AGENT,
} as const;
