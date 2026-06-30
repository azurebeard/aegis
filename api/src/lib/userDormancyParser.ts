// ADR-0034 §3.1 — narrow Graph `/users?$select=...,signInActivity` payloads
// into the typed shape consumed by the orchestrator + store. Defensive on
// malformed rows (skip-not-throw); no `unknownFutureValue` enums to handle
// (signInActivity is timestamp + bool fields only — no evolvable enums).

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface UserDormancyDomain {
  readonly id: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
  readonly accountEnabled: boolean;
  /** ISO-8601 UTC, or null when absent on the row (P1 missing, OR the user
   *  has never had an interactive sign-in). The IngestHealth `licence_required`
   *  sticky-state is derived at orchestrator level from "all rows null". */
  readonly lastInteractiveSignIn: string | null;
  readonly lastNonInteractiveSignIn: string | null;
  readonly lastSuccessfulSignIn: string | null;
  /** ISO-8601 UTC. Captured on Phase 8D follow-up to drive the new-user
   *  highlight on /identities Humans tab. Null when Graph omits the field
   *  (very old tenants pre-dating Microsoft's createdDateTime tracking; in
   *  practice, post-2014 users always carry a value). */
  readonly createdDateTime: string | null;
  readonly ingestedAt: string;
  readonly ingestRunId: string;
}

export interface ParsedUserDormancyBatch {
  readonly rows: readonly UserDormancyDomain[];
  readonly skippedMalformed: number;
}

interface ParseContext {
  readonly ingestedAt: string;
  readonly ingestRunId: string;
}

interface RawSignInActivity {
  readonly lastSignInDateTime?: unknown;
  readonly lastNonInteractiveSignInDateTime?: unknown;
  readonly lastSuccessfulSignInDateTime?: unknown;
}

interface RawUser {
  readonly id?: unknown;
  readonly displayName?: unknown;
  readonly userPrincipalName?: unknown;
  readonly accountEnabled?: unknown;
  readonly signInActivity?: unknown;
  readonly createdDateTime?: unknown;
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

/** Parse one Graph user row into the domain shape. Returns null when the row
 *  fails the basic identity-shape check (no id, malformed id, no UPN). */
function parseOne(raw: RawUser, ctx: ParseContext): UserDormancyDomain | null {
  const id = asString(raw.id);
  if (!id || !ID_RE.test(id)) return null;
  const upn = asString(raw.userPrincipalName) ?? "";
  if (upn === "") return null;
  const displayName = asString(raw.displayName) ?? "";
  const accountEnabled = raw.accountEnabled === true;
  const sa = (raw.signInActivity ?? null) as RawSignInActivity | null;
  return {
    id,
    userPrincipalName: upn,
    displayName,
    accountEnabled,
    lastInteractiveSignIn: sa ? asIsoOrNull(sa.lastSignInDateTime) : null,
    lastNonInteractiveSignIn: sa
      ? asIsoOrNull(sa.lastNonInteractiveSignInDateTime)
      : null,
    lastSuccessfulSignIn: sa
      ? asIsoOrNull(sa.lastSuccessfulSignInDateTime)
      : null,
    createdDateTime: asIsoOrNull(raw.createdDateTime),
    ingestedAt: ctx.ingestedAt,
    ingestRunId: ctx.ingestRunId,
  };
}

/** Parse a Graph `/users` page envelope (object with `value: User[]`) and
 *  return the narrowed rows + skip count. Defensive on every input — the
 *  caller's `rawPages` array elements are typed `unknown` and can have any
 *  shape from a misbehaving Graph response. */
export function parseUsersPage(
  rawPage: unknown,
  ctx: ParseContext,
): ParsedUserDormancyBatch {
  if (!rawPage || typeof rawPage !== "object") {
    return { rows: [], skippedMalformed: 0 };
  }
  const env = rawPage as { value?: unknown };
  const value = Array.isArray(env.value) ? env.value : [];
  const rows: UserDormancyDomain[] = [];
  let skippedMalformed = 0;
  for (const r of value) {
    if (!r || typeof r !== "object") {
      skippedMalformed++;
      continue;
    }
    const parsed = parseOne(r as RawUser, ctx);
    if (parsed === null) {
      skippedMalformed++;
      continue;
    }
    rows.push(parsed);
  }
  return { rows, skippedMalformed };
}

/** Aggregate parse over all pages from `fetchUsersPaged`. */
export function parseUsersPages(
  rawPages: readonly unknown[],
  ctx: ParseContext,
): ParsedUserDormancyBatch {
  const allRows: UserDormancyDomain[] = [];
  let skippedMalformed = 0;
  for (const page of rawPages) {
    const batch = parseUsersPage(page, ctx);
    for (const r of batch.rows) allRows.push(r);
    skippedMalformed += batch.skippedMalformed;
  }
  return { rows: allRows, skippedMalformed };
}

/** Predicate: every row in the batch has all three signInActivity fields
 *  null. Used by the orchestrator to detect tenants without Entra ID P1
 *  (the `signInActivity` property is null for every row when P1 is absent). */
export function isLicenceRequiredBatch(
  rows: readonly UserDormancyDomain[],
): boolean {
  if (rows.length === 0) return false;
  for (const r of rows) {
    if (
      r.lastInteractiveSignIn !== null ||
      r.lastNonInteractiveSignIn !== null ||
      r.lastSuccessfulSignIn !== null
    ) {
      return false;
    }
  }
  return true;
}
