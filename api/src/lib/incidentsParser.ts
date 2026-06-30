// Parse Microsoft Graph `security.incident` objects into the internal
// IncidentSummary shape, and enforce the ADR-0014 §3.2 incident-ID contract.
//
// Pure function — no SDK, no I/O, no logging. Unit-tested in isolation.

import type { RawGraphIncident } from "./graphClient.js";
import type {
  IncidentClassification,
  IncidentSeverity,
  IncidentStatus,
  IncidentSummary,
} from "./types.js";

/**
 * ADR-0014 §3.2 / ADR-0016 §1.3 — shared incident-ID contract.
 * `^[A-Za-z0-9._-]{1,128}$`. 128-char cap derived from observed Graph envelope
 * (≤64) with a 2× tolerance margin. Reject-not-truncate.
 */
export const INCIDENT_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

/** Characters banned by the regex above but called out explicitly for the
 * test suite (ADR-0014 §3.2). Any ID containing one of these is rejected. */
export const INCIDENT_ID_FORBIDDEN_SUBSTRINGS = [
  "..",
  "/",
  "\\",
  "\u0000",
  "\uFEFF",
  "[",
  "]",
] as const;

export class IncidentIdRejectedError extends Error {
  readonly id: string;
  readonly length: number;
  readonly reason: "regex" | "length" | "forbidden_substring" | "empty";
  constructor(id: string, reason: IncidentIdRejectedError["reason"]) {
    const truncated = id.slice(0, 32);
    super(
      `incident id rejected (${reason}): length=${id.length} first32=${JSON.stringify(truncated)}`,
    );
    this.name = "IncidentIdRejectedError";
    this.id = id;
    this.length = id.length;
    this.reason = reason;
  }
}

/**
 * Validate an incident ID against ADR-0014 §3.2. Returns the ID unchanged on
 * success; throws `IncidentIdRejectedError` on any violation.
 * The handler catches this error, counts the incident toward `incidentsSkipped`,
 * and emits `IncidentsIdRejected` App Insights event.
 */
export function validateIncidentId(id: string | undefined | null): string {
  if (id === undefined || id === null || id === "") {
    throw new IncidentIdRejectedError(String(id ?? ""), "empty");
  }
  if (id.length > 128) {
    throw new IncidentIdRejectedError(id, "length");
  }
  for (const bad of INCIDENT_ID_FORBIDDEN_SUBSTRINGS) {
    if (id.includes(bad)) {
      throw new IncidentIdRejectedError(id, "forbidden_substring");
    }
  }
  // U+0000–U+001F control chars are not in the positive regex; the explicit
  // substring check above covers the specific cases called out by the ADR.
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code >= 0x00 && code <= 0x1f) {
      throw new IncidentIdRejectedError(id, "forbidden_substring");
    }
  }
  if (!INCIDENT_ID_REGEX.test(id)) {
    throw new IncidentIdRejectedError(id, "regex");
  }
  return id;
}

const DISPLAY_NAME_MAX = 256;
const DISPLAY_NAME_TRUNCATION_MARKER = "…";
const TAGS_JSON_MAX_BYTES = 4_096;

export interface ParseIncidentOptions {
  readonly ingestedAt: string;
  readonly ingestRunId: string;
}

/**
 * Normalise a Graph `security.incident` into the IncidentSummary shape written
 * to the `Incidents` Table row. Throws `IncidentIdRejectedError` when the ID
 * fails the ADR-0014 §3.2 contract. Missing / malformed fields are coerced to
 * safe defaults — Graph should always populate them, but a defensive read
 * keeps a single bad upstream record from failing the whole run.
 */
export function parseIncident(
  inc: RawGraphIncident,
  options: ParseIncidentOptions,
): IncidentSummary {
  const id = validateIncidentId(inc.id);

  const createdDateTime = normaliseIso8601(inc.createdDateTime, options.ingestedAt);
  const lastUpdateDateTime = normaliseIso8601(inc.lastUpdateDateTime, options.ingestedAt);

  const priorityScore =
    typeof inc.priorityScore === "number" && Number.isFinite(inc.priorityScore)
      ? inc.priorityScore
      : null;

  const alertCount = Array.isArray(inc.alerts) ? inc.alerts.length : 0;

  const redirectIncidentId =
    typeof inc.redirectIncidentId === "string" && inc.redirectIncidentId.length > 0
      ? inc.redirectIncidentId
      : null;
  const hasRedirect = redirectIncidentId !== null;

  return {
    id,
    displayName: truncateDisplayName(inc.displayName ?? ""),
    severity: normaliseSeverity(inc.severity),
    status: normaliseStatus(inc.status),
    classification: normaliseClassification(inc.classification),
    determination: typeof inc.determination === "string" ? inc.determination : "unknown",
    priorityScore,
    assignedTo:
      typeof inc.assignedTo === "string" && inc.assignedTo.length > 0
        ? inc.assignedTo
        : null,
    createdDateTime,
    lastUpdateDateTime,
    alertCount,
    customTags: capTags(Array.isArray(inc.customTags) ? inc.customTags : []),
    systemTags: capTags(Array.isArray(inc.systemTags) ? inc.systemTags : []),
    incidentWebUrl: typeof inc.incidentWebUrl === "string" ? inc.incidentWebUrl : "",
    hasRedirect,
    redirectIncidentId,
    ingestedAt: options.ingestedAt,
    ingestRunId: options.ingestRunId,
  };
}

/**
 * Build the blob path per ADR-0014 §3.2:
 *   `<container>/<yyyy>/<mm>/<dd>/<incidentId>.json`
 * The container name is the caller's; the date component comes from the UTC
 * date of `ingestedAt` (not `lastUpdateDateTime` — the "latest version wins
 * per day" rule keys on when we wrote it, not when Graph saw it).
 */
export function buildDetailBlobPath(
  incidentId: string,
  ingestedAt: string,
): string {
  // Defence-in-depth: the ingestedAt is handler-supplied but re-validate. If
  // something upstream ever passes a malformed value we want a loud failure
  // rather than a path string like `NaN/NaN/NaN`.
  const d = new Date(ingestedAt);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`buildDetailBlobPath: invalid ingestedAt: ${ingestedAt}`);
  }
  validateIncidentId(incidentId);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}/${m}/${day}/${incidentId}.json`;
}

export function normaliseSeverity(raw: unknown): IncidentSeverity {
  if (raw === "high") return "high";
  if (raw === "medium") return "medium";
  if (raw === "low") return "low";
  if (raw === "informational") return "informational";
  return "unknown";
}

export function normaliseStatus(raw: unknown): IncidentStatus {
  if (raw === "active") return "active";
  if (raw === "resolved") return "resolved";
  if (raw === "inProgress") return "inProgress";
  if (raw === "redirected") return "redirected";
  if (raw === "awaitingAction") return "awaitingAction";
  // Graph occasionally emits status values we don't know yet — default to
  // "active" so unknown-status incidents still surface on the tile rather than
  // being silently excluded. A future Graph enum expansion lands as an ADR.
  return "active";
}

export function normaliseClassification(raw: unknown): IncidentClassification {
  if (raw === "truePositive") return "truePositive";
  if (raw === "falsePositive") return "falsePositive";
  if (raw === "informationalExpectedActivity") return "informationalExpectedActivity";
  return "unknown";
}

function normaliseIso8601(raw: string | undefined | null, fallback: string): string {
  if (typeof raw !== "string" || raw === "") return fallback;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return raw;
}

function truncateDisplayName(raw: string): string {
  if (raw.length <= DISPLAY_NAME_MAX) return raw;
  return raw.slice(0, DISPLAY_NAME_MAX - DISPLAY_NAME_TRUNCATION_MARKER.length) +
    DISPLAY_NAME_TRUNCATION_MARKER;
}

function capTags(raw: readonly unknown[]): readonly string[] {
  const strings = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t);
  // Serialise repeatedly, trimming from the tail until under cap.
  let out = strings;
  while (Buffer.byteLength(JSON.stringify(out), "utf-8") > TAGS_JSON_MAX_BYTES && out.length > 0) {
    out = out.slice(0, -1);
  }
  return out;
}
