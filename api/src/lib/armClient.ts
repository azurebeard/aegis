// ADR-0036 — Azure Resource Manager (ARM) data-plane client.
//
// Defender for Cloud Secure Score lives at `https://management.azure.com/`
// not `https://graph.microsoft.com/`. The two consumers (graphClient.ts +
// this file) share the same retry shape but acquire tokens against
// different audiences. This client is intentionally tighter than
// graphClient — single endpoint family, no IdP-specific Prefer headers,
// no cross-tenant guest enumeration concerns.
//
// Auth: ManagedIdentityCredential with explicit scope `https://management.
// azure.com/.default`. The ingest MI must have an Azure RBAC `Reader`
// role assignment at subscription scope (per ADR-0036 §5).

import { DefaultAzureCredential } from "@azure/identity";
import type { InvocationContext } from "@azure/functions";

const ARM_SCOPE = "https://management.azure.com/.default";
const ARM_BASE_URL = "https://management.azure.com";

// SSRF defence (CWE-918): every outbound URL constructed by this module must
// be under ARM_BASE_URL. Callers pass tenant-derived subscription IDs that
// are internal state — but the assertion is defence in depth against any
// future refactor that accepts caller-supplied URL components.
function assertArmUrl(url: string): void {
  if (!url.startsWith(`${ARM_BASE_URL}/`)) {
    throw new Error(
      `armClient: refusing to fetch URL outside ARM_BASE_URL (got prefix ${url.slice(0, 32)})`,
    );
  }
}

const MAX_ATTEMPTS = 3;
const DEFAULT_READ_TIMEOUT_MS = 30_000;

export interface ArmFetchOptions {
  readonly managedIdentityClientId: string;
  /** Per-request timeout. ARM's secureScores endpoint typically responds
   *  in <1s so 30s is generous. */
  readonly timeoutMs?: number;
}

export class ArmFetchError extends Error {
  constructor(
    public readonly kind:
      | "4xx"
      | "5xx"
      | "throttle"
      | "timeout"
      | "network"
      | "internal",
    message: string,
    public readonly status: number | null,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = "ArmFetchError";
  }
}

export interface RetryEvent {
  readonly attempt: number;
  readonly statusCode: number;
  readonly retryAfterHeader: string | null;
  readonly backoffMs: number;
}

export interface ArmFetchResult<T> {
  readonly data: T;
  readonly attempts: number;
  readonly finalHttpStatus: number;
  readonly retryEvents: readonly RetryEvent[];
}

async function acquireArmToken(managedIdentityClientId: string): Promise<string> {
  const credential = new DefaultAzureCredential({ managedIdentityClientId });
  const token = await credential.getToken(ARM_SCOPE);
  if (!token) {
    throw new ArmFetchError(
      "internal",
      `no ARM token returned for MI ${managedIdentityClientId}`,
      null,
      0,
    );
  }
  return token.token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(attempt: number): number {
  // 500ms, 1500ms, 4500ms — modest jitter avoided for predictable
  // single-tenant cadence.
  return 500 * 3 ** (attempt - 1);
}

/** Single GET against ARM with retry on 429/5xx. Returns parsed JSON +
 *  retry telemetry. Throws ArmFetchError on terminal failure. */
export async function armGetJson<T>(
  url: string,
  options: ArmFetchOptions,
  context: InvocationContext,
): Promise<ArmFetchResult<T>> {
  const retries: RetryEvent[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let token: string;
    try {
      token = await acquireArmToken(options.managedIdentityClientId);
    } catch (err) {
      throw new ArmFetchError(
        "internal",
        `ARM token acquisition failed: ${String((err as Error).message ?? err)}`,
        null,
        attempt - 1,
      );
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    );

    assertArmUrl(url);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "aegis-xdr-hub/1.0 (+azure-secure-score)",
        },
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = (err as Error)?.name === "AbortError";
      const kind: ArmFetchError["kind"] = isAbort ? "timeout" : "network";
      context.warn(
        `arm fetch ${isAbort ? "timeout" : "network error"}: attempt=${attempt} err=${String((err as Error).message ?? err)}`,
      );
      if (attempt === MAX_ATTEMPTS) {
        throw new ArmFetchError(kind, `ARM fetch ${kind}`, null, attempt);
      }
      const backoff = computeBackoffMs(attempt);
      retries.push({
        attempt,
        statusCode: 0,
        retryAfterHeader: null,
        backoffMs: backoff,
      });
      await sleep(backoff);
      continue;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (res.status >= 200 && res.status < 300) {
      const body = (await res.json()) as T;
      return {
        data: body,
        attempts: attempt,
        finalHttpStatus: res.status,
        retryEvents: retries,
      };
    }

    // Terminal 4xx — no point retrying auth/auth/notfound failures.
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      const body = await res.text().catch(() => "");
      throw new ArmFetchError(
        "4xx",
        `arm ${res.status} terminal: ${body.slice(0, 512)}`,
        res.status,
        attempt,
      );
    }

    // Retry on 429 + 5xx.
    if (attempt === MAX_ATTEMPTS) {
      const body = await res.text().catch(() => "");
      throw new ArmFetchError(
        res.status === 429 ? "throttle" : "5xx",
        `arm ${res.status} after ${attempt} attempts: ${body.slice(0, 256)}`,
        res.status,
        attempt,
      );
    }

    const retryAfterHeader = res.headers.get("retry-after");
    const parsedMs = parseRetryAfterMs(retryAfterHeader, Date.now());
    const retryAfterMs = parsedMs !== null ? Math.min(60_000, parsedMs) : computeBackoffMs(attempt);
    const backoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : computeBackoffMs(attempt);
    retries.push({
      attempt,
      statusCode: res.status,
      retryAfterHeader,
      backoffMs: backoff,
    });
    await sleep(backoff);
  }

  // Unreachable — every path either returns or throws. TypeScript needs
  // the explicit fallback.
  throw new ArmFetchError("internal", "arm fetch loop exhausted", null, MAX_ATTEMPTS);
}

/**
 * Parse the `Retry-After` header per RFC 9110 §10.2.3. Two valid forms:
 *
 *   - **Delta-seconds:** a non-negative integer count of seconds to wait
 *     (e.g. `Retry-After: 120`). Returned as `value * 1000`.
 *   - **HTTP-date (IMF-fixdate, obsolete RFC 850, asctime):** an absolute
 *     timestamp at which the resource is expected to be available
 *     (e.g. `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`). Returned as
 *     `parsedDate - now` clamped to a non-negative value (an HTTP-date
 *     already past simply means "retry immediately").
 *
 * ADR-0036 L-Q4 follow-up (§10.67): pre-this-change the parser only
 * handled delta-seconds, falling back to exponential backoff on
 * HTTP-date headers. ARM does occasionally emit the HTTP-date form
 * (observed under sustained per-subscription throttling); honouring it
 * keeps total wait closer to the service's hint without cresting the
 * 60s safety cap applied at the call site.
 *
 * Returns `null` if the header is absent or unparseable — the caller
 * falls back to `computeBackoffMs(attempt)`.
 */
export function parseRetryAfterMs(
  header: string | null,
  nowMs: number,
): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  // Delta-seconds: bare non-negative integer. `Number.parseInt` would
  // accept `"120abc"` which is not the contract — use a strict regex.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return seconds * 1000;
  }
  // HTTP-date: defer parsing to `Date.parse` which accepts every form
  // RFC 9110 references (IMF-fixdate is the canonical preference; the
  // obsolete RFC 850 + asctime forms come along for free).
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const delta = parsed - nowMs;
  return delta > 0 ? delta : 0;
}

/** Defender for Cloud Secure Score per-subscription. Fetches the
 *  `ascScore` aggregate (the headline percentage Microsoft renders in
 *  the Defender for Cloud portal). */
export interface SecureScoreApiResponse {
  readonly value?: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
    readonly properties?: {
      readonly displayName?: string;
      readonly score?: {
        readonly current?: number;
        readonly max?: number;
        readonly percentage?: number;
      };
      readonly weight?: number;
    };
  }>;
}

export async function fetchAzureSecureScore(
  options: ArmFetchOptions,
  subscriptionId: string,
  context: InvocationContext,
): Promise<ArmFetchResult<SecureScoreApiResponse>> {
  // The endpoint returns an array — typically with a single `ascScore`
  // entry covering the whole subscription. Multi-entry responses occur
  // when management groups are involved; v1 only renders the first.
  const url = `${ARM_BASE_URL}/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Security/secureScores?api-version=2020-01-01`;
  return armGetJson<SecureScoreApiResponse>(url, options, context);
}

/** Resolve the human-readable subscription name. Reader role on the
 *  subscription covers this read; failures degrade to the GUID. */
export async function fetchSubscriptionDisplayName(
  options: ArmFetchOptions,
  subscriptionId: string,
  context: InvocationContext,
): Promise<string | null> {
  try {
    const url = `${ARM_BASE_URL}/subscriptions/${encodeURIComponent(subscriptionId)}?api-version=2022-12-01`;
    const res = await armGetJson<{ displayName?: string }>(url, options, context);
    return typeof res.data.displayName === "string" && res.data.displayName.length > 0
      ? res.data.displayName
      : null;
  } catch (err) {
    context.warn(
      `arm subscription displayName resolve failed: ${String((err as Error).message ?? err)}`,
    );
    return null;
  }
}
