// ADR-0034 §3.3 — narrow Graph `/v1.0/identity/conditionalAccess/policies`
// payloads into the typed shape consumed by the orchestrator + store.
// Defensive on malformed rows (skip-not-throw); JCS-canonicalises the three
// nested object fields (conditions / grantControls / sessionControls) so
// downstream diff detection compares stable strings rather than wrestling
// with object key ordering.
//
// Size bounds per ADR-0034 §3.3: Conditions ≤ 16 KB, GrantControls ≤ 16 KB,
// SessionControls ≤ 4 KB. Operator-defined IP lists in the conditions
// object can be long — bounding at the parser keeps the Table row under
// Azure's per-property 64 KB cap with comfortable headroom.

import { canonicalize } from "json-canonicalize";

const POLICY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ALLOWED_STATES = new Set([
  "enabled",
  "disabled",
  "enabledForReportingButNotEnforced",
]);

const CONDITIONS_BYTE_LIMIT = 16 * 1024;
const GRANT_CONTROLS_BYTE_LIMIT = 16 * 1024;
const SESSION_CONTROLS_BYTE_LIMIT = 4 * 1024;

export interface ConditionalAccessPolicyDomain {
  readonly id: string;
  readonly displayName: string;
  /** `enabled` | `disabled` | `enabledForReportingButNotEnforced`. Free-tenant
   *  policies (rare) may emit additional values; the parser narrows to the
   *  three documented + skips any row with an out-of-set value. */
  readonly state: "enabled" | "disabled" | "enabledForReportingButNotEnforced";
  readonly createdDateTime: string | null;
  readonly modifiedDateTime: string | null;
  /** JCS-canonical JSON string of `policy.conditions`. Bounded; oversized
   *  input is replaced with the sentinel `{"_truncated":true}` so a runaway
   *  IP-list operator change can't blow up storage but the diff signal still
   *  fires (the truncation marker is itself a stable canonical string). */
  readonly conditions: string;
  readonly grantControls: string;
  /** Null when the policy has no session-controls block (typical for
   *  conditional-only policies). */
  readonly sessionControls: string | null;
  readonly ingestedAt: string;
  readonly ingestRunId: string;
}

export interface ParsedConditionalAccessBatch {
  readonly rows: readonly ConditionalAccessPolicyDomain[];
  readonly skippedMalformed: number;
  readonly truncatedFieldCount: number;
}

interface RawCaPolicy {
  readonly id?: unknown;
  readonly displayName?: unknown;
  readonly state?: unknown;
  readonly createdDateTime?: unknown;
  readonly modifiedDateTime?: unknown;
  readonly conditions?: unknown;
  readonly grantControls?: unknown;
  readonly sessionControls?: unknown;
}

interface ParseContext {
  readonly ingestedAt: string;
  readonly ingestRunId: string;
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

interface CanonResult {
  readonly value: string;
  readonly truncated: boolean;
}

function canonAndBound(input: unknown, byteLimit: number): CanonResult {
  if (input === null || input === undefined) {
    return { value: "null", truncated: false };
  }
  const canon = canonicalize(input);
  if (Buffer.byteLength(canon, "utf-8") <= byteLimit) {
    return { value: canon, truncated: false };
  }
  return { value: '{"_truncated":true}', truncated: true };
}

interface ParseOneResult {
  readonly row: ConditionalAccessPolicyDomain | null;
  readonly truncatedFields: number;
}

function parseOne(raw: RawCaPolicy, ctx: ParseContext): ParseOneResult {
  const id = asString(raw.id);
  if (id === null || !POLICY_ID_RE.test(id)) return { row: null, truncatedFields: 0 };
  const displayName = asString(raw.displayName);
  if (displayName === null) return { row: null, truncatedFields: 0 };
  const stateRaw = asString(raw.state);
  if (stateRaw === null || !ALLOWED_STATES.has(stateRaw)) {
    return { row: null, truncatedFields: 0 };
  }
  const state = stateRaw as ConditionalAccessPolicyDomain["state"];

  const conditions = canonAndBound(raw.conditions, CONDITIONS_BYTE_LIMIT);
  const grantControls = canonAndBound(raw.grantControls, GRANT_CONTROLS_BYTE_LIMIT);
  const sessionControlsRaw =
    raw.sessionControls === undefined || raw.sessionControls === null
      ? null
      : canonAndBound(raw.sessionControls, SESSION_CONTROLS_BYTE_LIMIT);

  const truncatedFields =
    (conditions.truncated ? 1 : 0) +
    (grantControls.truncated ? 1 : 0) +
    (sessionControlsRaw?.truncated ? 1 : 0);

  return {
    row: {
      id,
      displayName,
      state,
      createdDateTime: asIsoOrNull(raw.createdDateTime),
      modifiedDateTime: asIsoOrNull(raw.modifiedDateTime),
      conditions: conditions.value,
      grantControls: grantControls.value,
      sessionControls: sessionControlsRaw?.value ?? null,
      ingestedAt: ctx.ingestedAt,
      ingestRunId: ctx.ingestRunId,
    },
    truncatedFields,
  };
}

/** Parse one Graph page into the typed batch. */
export function parseConditionalAccessPage(
  rawPage: unknown,
  ctx: ParseContext,
): ParsedConditionalAccessBatch {
  if (typeof rawPage !== "object" || rawPage === null) {
    return { rows: [], skippedMalformed: 0, truncatedFieldCount: 0 };
  }
  const arr = (rawPage as { value?: unknown }).value;
  if (!Array.isArray(arr)) return { rows: [], skippedMalformed: 0, truncatedFieldCount: 0 };
  const rows: ConditionalAccessPolicyDomain[] = [];
  let skipped = 0;
  let truncated = 0;
  for (const r of arr) {
    if (typeof r !== "object" || r === null) {
      skipped += 1;
      continue;
    }
    const out = parseOne(r as RawCaPolicy, ctx);
    if (out.row === null) {
      skipped += 1;
      continue;
    }
    rows.push(out.row);
    truncated += out.truncatedFields;
  }
  return { rows, skippedMalformed: skipped, truncatedFieldCount: truncated };
}

/** Convenience aggregator for multi-page walks. */
export function parseConditionalAccessPages(
  pages: readonly unknown[],
  ctx: ParseContext,
): ParsedConditionalAccessBatch {
  let allRows: ConditionalAccessPolicyDomain[] = [];
  let skipped = 0;
  let truncated = 0;
  for (const p of pages) {
    const out = parseConditionalAccessPage(p, ctx);
    allRows = allRows.concat(out.rows);
    skipped += out.skippedMalformed;
    truncated += out.truncatedFieldCount;
  }
  return { rows: allRows, skippedMalformed: skipped, truncatedFieldCount: truncated };
}

// Re-exports for tests.
export const __test__ = {
  CONDITIONS_BYTE_LIMIT,
  GRANT_CONTROLS_BYTE_LIMIT,
  SESSION_CONTROLS_BYTE_LIMIT,
};
