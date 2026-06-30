// ADR-0034 Phase 8E — narrow `/v1.0/servicePrincipals` payloads into the
// typed shape returned by the on-demand `/api/identities/service-principals`
// endpoint. Defensive on malformed rows (skip-not-throw); no inferred PII
// enrichment (UPN-equivalents are not present on SPs).
//
// "Agent" classification: ADR-0034 §7 settles that the page tags rows by
// the future Microsoft-published `agentSubtype` field on `/servicePrincipals`
// (schema TBC; not GA at the time of writing). Until then `kind="agent"`
// resolves to the empty set and the SPA's Agents tab renders the
// degraded-state "agent identities not yet surfaced on this tenant" copy.

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Three render-time classifications, derived from the raw `servicePrincipalType`
 *  field (or from the not-yet-shipped `agentSubtype`). The SPA tabs filter on
 *  this discriminator. */
export type ServicePrincipalKind = "application" | "managedIdentity" | "agent" | "other";

export interface ServicePrincipalRow {
  readonly id: string;
  readonly appId: string;
  readonly displayName: string;
  readonly servicePrincipalType: string; // raw Graph value
  readonly kind: ServicePrincipalKind;
  readonly signInAudience: string | null;
  readonly accountEnabled: boolean;
  /** Owner tenant GUID — when not the current tenant, indicates a
   *  multi-tenant or first-party Microsoft SP consented into this tenant. */
  readonly appOwnerOrganizationId: string | null;
  readonly createdDateTime: string | null;
  readonly tags: readonly string[];
  readonly credentialSummary: CredentialSummary;
}

/** Roll-up of `keyCredentials` + `passwordCredentials` so the SPA can render
 *  expiry-hygiene flags without unfolding the full credential arrays. */
export interface CredentialSummary {
  readonly secrets: number;
  readonly certs: number;
  /** Earliest end-of-life among ALL credentials, or null when none. */
  readonly earliestExpiryAt: string | null;
  /** Count of credentials whose `endDateTime` is in the past. */
  readonly expiredCount: number;
}

export interface ParsedServicePrincipalsBatch {
  readonly rows: readonly ServicePrincipalRow[];
  readonly skippedMalformed: number;
}

interface RawCredential {
  readonly endDateTime?: unknown;
}

interface RawSp {
  readonly id?: unknown;
  readonly appId?: unknown;
  readonly displayName?: unknown;
  readonly servicePrincipalType?: unknown;
  readonly signInAudience?: unknown;
  readonly accountEnabled?: unknown;
  readonly appOwnerOrganizationId?: unknown;
  readonly createdDateTime?: unknown;
  readonly tags?: unknown;
  readonly keyCredentials?: unknown;
  readonly passwordCredentials?: unknown;
  // Microsoft schema TBC — when shipped, will mark the SP as a Copilot
  // Studio agent. We read it defensively so the parser is forward-compatible
  // with the GA payload without an ADR amendment (per ADR-0034 §Decision §7).
  readonly agentSubtype?: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asIsoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  return v;
}

function classifyKind(
  servicePrincipalType: string,
  agentSubtype: string | null,
): ServicePrincipalKind {
  // Future-compat: any non-empty agentSubtype value (Microsoft schema TBC)
  // promotes the row to the Agents tab regardless of the parent type.
  if (agentSubtype !== null) return "agent";
  if (servicePrincipalType === "ManagedIdentity") return "managedIdentity";
  if (servicePrincipalType === "Application") return "application";
  return "other";
}

function summariseCredentials(
  keyCreds: readonly RawCredential[],
  passwordCreds: readonly RawCredential[],
  nowIso: string,
): CredentialSummary {
  const nowMs = Date.parse(nowIso);
  let earliestMs = Number.POSITIVE_INFINITY;
  let expiredCount = 0;
  const visit = (arr: readonly RawCredential[]): void => {
    for (const c of arr) {
      const iso = asIsoOrNull(c.endDateTime);
      if (iso === null) continue;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) continue;
      if (ms < earliestMs) earliestMs = ms;
      if (ms < nowMs) expiredCount += 1;
    }
  };
  visit(keyCreds);
  visit(passwordCreds);
  return {
    secrets: passwordCreds.length,
    certs: keyCreds.length,
    earliestExpiryAt: Number.isFinite(earliestMs) ? new Date(earliestMs).toISOString() : null,
    expiredCount,
  };
}

function parseOne(raw: RawSp, nowIso: string): ServicePrincipalRow | null {
  const id = asString(raw.id);
  if (id === null || !GUID_RE.test(id)) return null;
  const appId = asString(raw.appId);
  if (appId === null || !GUID_RE.test(appId)) return null;
  const displayName = asString(raw.displayName);
  if (displayName === null) return null;
  const spType = asString(raw.servicePrincipalType) ?? "Unknown";
  const agentSubtype = asString(raw.agentSubtype);
  const kind = classifyKind(spType, agentSubtype);
  const tags: string[] = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string")
    : [];
  const keyCreds: readonly RawCredential[] = Array.isArray(raw.keyCredentials)
    ? raw.keyCredentials.filter((c): c is RawCredential => typeof c === "object" && c !== null)
    : [];
  const pwdCreds: readonly RawCredential[] = Array.isArray(raw.passwordCredentials)
    ? raw.passwordCredentials.filter(
        (c): c is RawCredential => typeof c === "object" && c !== null,
      )
    : [];
  return {
    id,
    appId,
    displayName,
    servicePrincipalType: spType,
    kind,
    signInAudience: asString(raw.signInAudience),
    accountEnabled: typeof raw.accountEnabled === "boolean" ? raw.accountEnabled : true,
    appOwnerOrganizationId: asString(raw.appOwnerOrganizationId),
    createdDateTime: asIsoOrNull(raw.createdDateTime),
    tags,
    credentialSummary: summariseCredentials(keyCreds, pwdCreds, nowIso),
  };
}

/** Parse one Graph page (`{ value: [...], "@odata.nextLink"?: string }`) into
 *  the domain shape. Skips malformed rows; counts them so the handler can
 *  surface a debug header. */
export function parseServicePrincipalsPage(
  rawPage: unknown,
  nowIso: string,
): ParsedServicePrincipalsBatch {
  if (typeof rawPage !== "object" || rawPage === null) {
    return { rows: [], skippedMalformed: 0 };
  }
  const arr = (rawPage as { value?: unknown }).value;
  if (!Array.isArray(arr)) return { rows: [], skippedMalformed: 0 };
  const rows: ServicePrincipalRow[] = [];
  let skipped = 0;
  for (const r of arr) {
    if (typeof r !== "object" || r === null) {
      skipped += 1;
      continue;
    }
    const parsed = parseOne(r as RawSp, nowIso);
    if (parsed === null) {
      skipped += 1;
      continue;
    }
    rows.push(parsed);
  }
  return { rows, skippedMalformed: skipped };
}
