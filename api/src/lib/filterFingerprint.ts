// Incidents-list filter-fingerprint canonicaliser (ADR-0016 §2a).
//
// The `f` field on the opaque pagination cursor is a stable fingerprint of
// the filter set. Canonicalisation MUST be identical for two equivalent
// request shapes (parameter order, duplicate values, default-value inclusion).
// An under-specified canonicalisation is a false-positive source for
// `cursor_filter_mismatch` errors that look identical to replay-attack
// detection (ADR-0016 §2a).
//
// All exports here are pure — no clock reads, no I/O.

import { canonicalise, hashCanonical } from "./auditChain.js";
import type {
  IncidentClassification,
  IncidentSeverity,
  IncidentStatus,
} from "./types.js";

export const ALLOWED_SEVERITIES: readonly IncidentSeverity[] = [
  "unknown",
  "informational",
  "low",
  "medium",
  "high",
];

export const ALLOWED_STATUSES: readonly IncidentStatus[] = [
  "active",
  "resolved",
  "inProgress",
  "redirected",
  "awaitingAction",
];

export const ALLOWED_CLASSIFICATIONS: readonly IncidentClassification[] = [
  "unknown",
  "truePositive",
  "falsePositive",
  "informationalExpectedActivity",
];

export const DEFAULT_LIMIT = 25;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 50;

// Strict ISO 8601 UTC — always-three-digit fractional seconds, always Z.
const STRICT_ISO8601_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface IncidentsListFilterInput {
  readonly severity?: readonly string[];
  readonly status?: readonly string[];
  readonly classification?: readonly string[];
  readonly since?: string | null;
  readonly includeRedirected?: boolean;
  readonly limit?: number;
}

export interface CanonicalFilterSet {
  readonly severity: readonly IncidentSeverity[];
  readonly status: readonly IncidentStatus[];
  readonly classification: readonly IncidentClassification[];
  readonly since: string | null;
  readonly includeRedirected: boolean;
  readonly limit: number;
}

export class FilterValidationError extends Error {
  readonly kind:
    | "enum_invalid"
    | "enum_casing"
    | "since_format"
    | "limit_range"
    | "limit_integer";
  readonly field: string;
  readonly detail: string;
  constructor(
    kind: FilterValidationError["kind"],
    field: string,
    detail: string,
  ) {
    super(`${field}: ${detail}`);
    this.name = "FilterValidationError";
    this.kind = kind;
    this.field = field;
    this.detail = detail;
  }
}

/**
 * Validate and normalise raw filter input into a canonical set. Enforces:
 *  - lowercase enum casing only — mixed case is 400, not case-insensitive accept
 *  - duplicates removed, sorted by UTF-16 code-unit order
 *  - `since` matches strict `YYYY-MM-DDTHH:mm:ss.sssZ` — any other form rejected
 *  - `limit` is an integer in [MIN_LIMIT, MAX_LIMIT], default DEFAULT_LIMIT
 *
 * Throws FilterValidationError on any violation.
 */
export function canonicaliseFilterSet(
  input: IncidentsListFilterInput,
): CanonicalFilterSet {
  const severity = normaliseEnumArray(
    "severity",
    input.severity,
    ALLOWED_SEVERITIES as readonly string[],
  ) as readonly IncidentSeverity[];
  const status = normaliseEnumArray(
    "status",
    input.status,
    ALLOWED_STATUSES as readonly string[],
  ) as readonly IncidentStatus[];
  const classification = normaliseEnumArray(
    "classification",
    input.classification,
    ALLOWED_CLASSIFICATIONS as readonly string[],
  ) as readonly IncidentClassification[];

  let since: string | null = null;
  if (input.since !== undefined && input.since !== null && input.since !== "") {
    if (!STRICT_ISO8601_Z.test(input.since)) {
      throw new FilterValidationError(
        "since_format",
        "since",
        "must match strict ISO8601 UTC: YYYY-MM-DDTHH:mm:ss.sssZ",
      );
    }
    // Additionally reject semantically-invalid dates (e.g. 2026-02-30T...).
    // ECMAScript `Date` silently coerces invalid calendar dates (Feb 30 → Mar 2);
    // round-trip comparison against the canonical UTC re-serialisation is the
    // standard way to detect the coercion.
    const parsed = Date.parse(input.since);
    if (!Number.isFinite(parsed)) {
      throw new FilterValidationError(
        "since_format",
        "since",
        "is syntactically well-formed but not a real calendar date/time",
      );
    }
    const reserialised = new Date(parsed).toISOString();
    if (reserialised !== input.since) {
      throw new FilterValidationError(
        "since_format",
        "since",
        "is syntactically well-formed but not a real calendar date/time (ECMAScript Date silently coerced)",
      );
    }
    since = input.since;
  }

  const includeRedirected = input.includeRedirected === true;

  let limit: number = DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit)) {
      throw new FilterValidationError(
        "limit_integer",
        "limit",
        "must be an integer",
      );
    }
    if (input.limit < MIN_LIMIT || input.limit > MAX_LIMIT) {
      throw new FilterValidationError(
        "limit_range",
        "limit",
        `must be in [${MIN_LIMIT}, ${MAX_LIMIT}]`,
      );
    }
    limit = input.limit;
  }

  return { severity, status, classification, since, includeRedirected, limit };
}

/**
 * Build the canonical-form JSON object for hashing. Follows ADR-0016 §2a
 * steps 1–5 exactly:
 *   - enum arrays omitted entirely when empty
 *   - `since` omitted when absent
 *   - `includeRedirected` omitted when false (default)
 *   - `limit` always included (default 25 is load-bearing for pagination)
 */
export function buildCanonicalFilterObject(
  set: CanonicalFilterSet,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (set.severity.length > 0) out.severity = [...set.severity];
  if (set.status.length > 0) out.status = [...set.status];
  if (set.classification.length > 0) out.classification = [...set.classification];
  if (set.since !== null) out.since = set.since;
  if (set.includeRedirected === true) out.includeRedirected = true;
  out.limit = set.limit;
  return out;
}

/**
 * Compute `f` — the filter fingerprint — via JCS canonicalisation (reusing the
 * ADR-0015 library) + SHA-256 lowercase-hex.
 */
export function computeFilterFingerprint(
  input: IncidentsListFilterInput,
): string {
  const canonical = canonicaliseFilterSet(input);
  const obj = buildCanonicalFilterObject(canonical);
  return hashCanonical(canonicalise(obj));
}

// --- EntraRisk filter-fingerprint (ADR-0024 §2a) ----------------------------

export const ALLOWED_RISK_LEVELS = [
  "high",
  "medium",
  "low",
  "hidden",
  "none",
  "unknown",
] as const;

export const ALLOWED_RISK_STATES = [
  "atRisk",
  "confirmedCompromised",
  "remediated",
  "confirmedSafe",
  "dismissed",
  "none",
  "unknown",
] as const;

export const RISKY_USERS_DEFAULT_LIMIT = 25;
export const RISKY_USERS_MIN_LIMIT = 1;
export const RISKY_USERS_MAX_LIMIT = 100;

export interface RiskyUsersListFilterInput {
  readonly riskLevel?: readonly string[];
  readonly riskState?: readonly string[];
  readonly since?: string | null;
  readonly includeDeleted?: boolean;
  readonly includeRemediated?: boolean;
  readonly limit?: number;
}

export interface RiskyUsersCanonicalFilterSet {
  readonly riskLevel: readonly string[];
  readonly riskState: readonly string[];
  readonly since: string | null;
  readonly includeDeleted: boolean;
  readonly includeRemediated: boolean;
  readonly limit: number;
}

export function canonicaliseRiskyUsersFilterSet(
  input: RiskyUsersListFilterInput,
): RiskyUsersCanonicalFilterSet {
  const riskLevel = normaliseEnumArray(
    "riskLevel",
    input.riskLevel,
    ALLOWED_RISK_LEVELS as readonly string[],
  );
  const riskState = normaliseEnumArray(
    "riskState",
    input.riskState,
    ALLOWED_RISK_STATES as readonly string[],
  );

  let since: string | null = null;
  if (input.since !== undefined && input.since !== null && input.since !== "") {
    if (!STRICT_ISO8601_Z.test(input.since)) {
      throw new FilterValidationError(
        "since_format",
        "since",
        "must match strict ISO8601 UTC: YYYY-MM-DDTHH:mm:ss.sssZ",
      );
    }
    const parsed = Date.parse(input.since);
    if (!Number.isFinite(parsed)) {
      throw new FilterValidationError(
        "since_format",
        "since",
        "is syntactically well-formed but not a real calendar date/time",
      );
    }
    const reserialised = new Date(parsed).toISOString();
    if (reserialised !== input.since) {
      throw new FilterValidationError(
        "since_format",
        "since",
        "is syntactically well-formed but not a real calendar date/time (ECMAScript Date silently coerced)",
      );
    }
    since = input.since;
  }

  const includeDeleted = input.includeDeleted === true;
  const includeRemediated = input.includeRemediated === true;

  let limit = RISKY_USERS_DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit)) {
      throw new FilterValidationError(
        "limit_integer",
        "limit",
        "must be an integer",
      );
    }
    if (input.limit < RISKY_USERS_MIN_LIMIT || input.limit > RISKY_USERS_MAX_LIMIT) {
      throw new FilterValidationError(
        "limit_range",
        "limit",
        `must be in [${RISKY_USERS_MIN_LIMIT}, ${RISKY_USERS_MAX_LIMIT}]`,
      );
    }
    limit = input.limit;
  }

  return { riskLevel, riskState, since, includeDeleted, includeRemediated, limit };
}

export function buildRiskyUsersCanonicalFilterObject(
  set: RiskyUsersCanonicalFilterSet,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (set.riskLevel.length > 0) out.riskLevel = [...set.riskLevel];
  if (set.riskState.length > 0) out.riskState = [...set.riskState];
  if (set.since !== null) out.since = set.since;
  if (set.includeDeleted === true) out.includeDeleted = true;
  if (set.includeRemediated === true) out.includeRemediated = true;
  out.limit = set.limit;
  return out;
}

export function computeRiskyUsersFilterFingerprint(
  input: RiskyUsersListFilterInput,
): string {
  const canonical = canonicaliseRiskyUsersFilterSet(input);
  const obj = buildRiskyUsersCanonicalFilterObject(canonical);
  return hashCanonical(canonicalise(obj));
}

const STRICT_ISO8601_Z_RE = STRICT_ISO8601_Z;
void STRICT_ISO8601_Z_RE;

function normaliseEnumArray(
  field: string,
  raw: readonly string[] | undefined,
  allowed: readonly string[],
): readonly string[] {
  if (!raw || raw.length === 0) return [];
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  for (const v of raw) {
    // Case sensitivity rule (§2a): the allowed-set is the source of truth for
    // casing. Incidents enums are lowercase (`high`, `medium`, ...);
    // EntraRisk `riskState` is camelCase per Graph's schema (`atRisk`,
    // `confirmedCompromised`, ...). Exact membership in `allowed` catches
    // mis-cased input and holds for both.
    //
    // earlier we
    // additionally rejected any value where `v !== v.toLowerCase()`, which
    // made every camelCase `riskState` 400 `enum_casing` — a functional DoS
    // on the filter UX. Using exact allowed-set membership preserves strict
    // validation (mis-cased input still fails) while honouring the
    // documented wire format (OWASP ASVS v4.0.3 §5.1.1).
    if (!allowedSet.has(v)) {
      // Distinguish a casing mismatch from a wholly-unknown value for
      // operator observability; either way, the request is rejected.
      const lowered = v.toLowerCase();
      const isCasingOnly = lowered !== v && allowedSet.has(lowered);
      if (isCasingOnly) {
        throw new FilterValidationError(
          "enum_casing",
          field,
          `value "${v}" does not match the allowed casing`,
        );
      }
      throw new FilterValidationError(
        "enum_invalid",
        field,
        `value "${v}" is not in the allowed enum`,
      );
    }
    seen.add(v);
  }
  // Sort by UTF-16 code-unit order — the same ordering rule JCS uses for
  // object keys (ADR-0015 §2). String#localeCompare would be locale-sensitive
  // and wrong here.
  const sorted = [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted;
}
