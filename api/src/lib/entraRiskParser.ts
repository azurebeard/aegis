// Parse Microsoft Graph `/v1.0/identityProtection/riskyUsers` responses into
// the internal RiskyUserDomain shape (ADR-0023 §3).
//
// Pure function — no SDK, no I/O, no logging. Unit-tested in isolation.
//
// Defensive against ADR-0023 §9 evolvable enums: `riskLevel`, `riskState`,
// and especially `riskDetail` can gain new values on any Graph release. The
// parser preserves the raw string and surfaces unknowns via the returned
// `unknownEnumSamples` array so the orchestrator can emit App Insights
// `EntraRiskUnknownEnum` events (ADR-0023 §9).
//
// Rows with a malformed `id` (not GUID-shaped per ADR-0023 §3 regex) or with
// a missing mandatory field are SKIPPED, not thrown — mirrors the
// `incidentsParser.ts` reject-not-truncate posture but scoped per-row so a
// single bad upstream record does not fail the whole run.

export const RISKY_USER_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

export const RISK_LEVELS = [
  "low",
  "medium",
  "high",
  "hidden",
  "none",
  "unknownFutureValue",
] as const;

export const RISK_STATES = [
  "none",
  "confirmedSafe",
  "remediated",
  "dismissed",
  "atRisk",
  "confirmedCompromised",
  "unknownFutureValue",
] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number] | "unknown";
export type RiskState = (typeof RISK_STATES)[number] | "unknown";

/**
 * ADR-0023 §3 — domain shape produced by the parser. PascalCase-columns are
 * on the Table entity (see `entraRiskStore.ts`); this shape is camelCase for
 * TS idiomatic use.
 */
export interface RiskyUserDomain {
  readonly id: string;
  readonly userPrincipalName: string;
  readonly userDisplayName: string;
  readonly riskLevel: RiskLevel;
  readonly riskLevelRaw: string;
  readonly riskState: RiskState;
  readonly riskStateRaw: string;
  readonly riskDetail: string;
  readonly riskLastUpdatedDateTime: string;
  readonly isDeleted: boolean;
  readonly isProcessing: boolean;
  readonly ingestedAt: string;
  readonly ingestRunId: string;
}

export interface RiskyUserGraphResponse {
  readonly value?: readonly unknown[];
  readonly "@odata.nextLink"?: string;
  readonly "@odata.context"?: string;
}

export interface UnknownEnumSample {
  readonly field: "riskLevel" | "riskState" | "riskDetail";
  readonly value: string;
  readonly userId: string;
}

export interface ParseRiskyUsersResult {
  readonly entries: readonly RiskyUserDomain[];
  readonly nextLink: string | null;
  readonly unknownEnumSamples: readonly UnknownEnumSample[];
  readonly skipped: readonly { readonly idFirst32: string; readonly reason: string }[];
}

export interface ParseRiskyUsersOptions {
  readonly ingestedAt: string;
  readonly ingestRunId: string;
}

/**
 * Parse one Graph page. Accepts `unknown` at the boundary (the caller deals
 * with raw JSON from `graphClient`), narrows defensively, skips malformed
 * rows with an entry in `skipped` for the handler to count into
 * `riskyUsersSkipped` (ADR-0023 §10).
 */
export function parseRiskyUsersPage(
  json: unknown,
  options: ParseRiskyUsersOptions,
): ParseRiskyUsersResult {
  if (!isObject(json)) {
    return { entries: [], nextLink: null, unknownEnumSamples: [], skipped: [] };
  }
  const env = json as RiskyUserGraphResponse;
  const rawArr = Array.isArray(env.value) ? env.value : [];
  const nextLink =
    typeof env["@odata.nextLink"] === "string" && env["@odata.nextLink"].length > 0
      ? env["@odata.nextLink"]
      : null;

  const entries: RiskyUserDomain[] = [];
  const unknownEnumSamples: UnknownEnumSample[] = [];
  const skipped: { idFirst32: string; reason: string }[] = [];

  for (const raw of rawArr) {
    const parsed = parseOneRow(raw, options, unknownEnumSamples);
    if ("error" in parsed) {
      skipped.push({ idFirst32: parsed.idFirst32, reason: parsed.error });
      continue;
    }
    entries.push(parsed.domain);
  }

  return { entries, nextLink, unknownEnumSamples, skipped };
}

type ParseOneResult =
  | { readonly domain: RiskyUserDomain }
  | { readonly error: string; readonly idFirst32: string };

function parseOneRow(
  raw: unknown,
  options: ParseRiskyUsersOptions,
  unknownEnumSamples: UnknownEnumSample[],
): ParseOneResult {
  if (!isObject(raw)) {
    return { error: "row_not_object", idFirst32: "" };
  }
  const row = raw as Record<string, unknown>;
  const rawId = typeof row.id === "string" ? row.id : "";
  if (!RISKY_USER_ID_REGEX.test(rawId)) {
    return { error: "id_malformed", idFirst32: rawId.slice(0, 32) };
  }
  const riskLastUpdatedDateTime =
    typeof row.riskLastUpdatedDateTime === "string" ? row.riskLastUpdatedDateTime : "";
  if (riskLastUpdatedDateTime === "" || !Number.isFinite(Date.parse(riskLastUpdatedDateTime))) {
    return { error: "riskLastUpdatedDateTime_invalid", idFirst32: rawId.slice(0, 32) };
  }

  const userPrincipalName =
    typeof row.userPrincipalName === "string" ? row.userPrincipalName : "";
  const userDisplayName =
    typeof row.userDisplayName === "string" ? row.userDisplayName : "";

  const riskLevelRaw = typeof row.riskLevel === "string" ? row.riskLevel : "";
  const riskStateRaw = typeof row.riskState === "string" ? row.riskState : "";
  const riskDetail = typeof row.riskDetail === "string" ? row.riskDetail : "";

  const riskLevel = narrowRiskLevel(riskLevelRaw);
  if (riskLevel === "unknown" && riskLevelRaw !== "") {
    unknownEnumSamples.push({ field: "riskLevel", value: riskLevelRaw, userId: rawId });
  }
  const riskState = narrowRiskState(riskStateRaw);
  if (riskState === "unknown" && riskStateRaw !== "") {
    unknownEnumSamples.push({ field: "riskState", value: riskStateRaw, userId: rawId });
  }
  // riskDetail is explicitly loosely-typed per ADR-0023 §9 — the parser does
  // not narrow it. The observability signal fires from the orchestrator's
  // whitelist check against `riskDetailEnum.ts`. Tests that assert "unknown
  // riskDetail is preserved" use the raw string here.

  const isDeleted = row.isDeleted === true;
  const isProcessing = row.isProcessing === true;

  const domain: RiskyUserDomain = {
    id: rawId,
    userPrincipalName,
    userDisplayName,
    riskLevel,
    riskLevelRaw,
    riskState,
    riskStateRaw,
    riskDetail,
    riskLastUpdatedDateTime,
    isDeleted,
    isProcessing,
    ingestedAt: options.ingestedAt,
    ingestRunId: options.ingestRunId,
  };
  return { domain };
}

function narrowRiskLevel(raw: string): RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(raw) ? (raw as RiskLevel) : "unknown";
}

function narrowRiskState(raw: string): RiskState {
  return (RISK_STATES as readonly string[]).includes(raw) ? (raw as RiskState) : "unknown";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
