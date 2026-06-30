// ADR-0033 §7 — body + path validators for KEV suppression PATCH/DELETE.

import {
  isKevSuppressionStatus,
  KEV_SUPPRESSION_BOUNDS,
  type KevSuppressionStatus,
} from "./kevSuppressionsStore.js";
import { isValidStackItemId } from "./stackItemsValidation.js";

const CVE_ID_RE = /^CVE-\d{4}-\d{4,7}$/;

export function isValidCveID(id: string): boolean {
  return CVE_ID_RE.test(id);
}

export function validateSuppressionPath(
  stackItemId: string,
  cveID: string,
): { ok: true } | { error: string } {
  if (!isValidStackItemId(stackItemId)) return { error: "stackItemId must be a UUID" };
  if (!isValidCveID(cveID)) return { error: "cveID must match CVE-YYYY-NNNN[NNN]" };
  return { ok: true };
}

export interface ValidatedSuppressionPatch {
  readonly status: KevSuppressionStatus;
  readonly notes: string;
  readonly expiresAt: string; // "" for no expiry
}

const ANY_CONTROL = new RegExp("[\\x00-\\x1f\\x7f]");
const NON_PRINTABLE_EXCEPT_WHITESPACE = new RegExp(
  "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]",
);
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function validateSuppressionPatchBody(
  body: unknown,
): { value: ValidatedSuppressionPatch } | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;

  // Allowlist top-level keys.
  for (const k of Object.keys(obj)) {
    if (k !== "status" && k !== "notes" && k !== "expiresAt") {
      return { error: `unknown field: ${k}` };
    }
  }

  if (!isKevSuppressionStatus(obj.status)) {
    return {
      error: "status must be one of: open, acknowledged, risk_accepted, remediated, not_applicable",
    };
  }

  let notes = "";
  if (obj.notes !== undefined && obj.notes !== null) {
    if (typeof obj.notes !== "string") return { error: "notes must be a string" };
    notes = obj.notes.trim();
    if (notes.length > KEV_SUPPRESSION_BOUNDS.notes.maxChars) {
      return {
        error: `notes must be ${KEV_SUPPRESSION_BOUNDS.notes.maxChars} characters or fewer`,
      };
    }
    if (NON_PRINTABLE_EXCEPT_WHITESPACE.test(notes)) {
      return { error: "notes contains control characters" };
    }
  }

  let expiresAt = "";
  if (obj.expiresAt !== undefined && obj.expiresAt !== null && obj.expiresAt !== "") {
    if (typeof obj.expiresAt !== "string") {
      return { error: "expiresAt must be an ISO-8601 string" };
    }
    const trimmed = obj.expiresAt.trim();
    if (!ISO_8601_RE.test(trimmed)) {
      return { error: "expiresAt must match ISO-8601 (YYYY-MM-DD or full datetime)" };
    }
    if (ANY_CONTROL.test(trimmed)) {
      return { error: "expiresAt contains control characters" };
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) {
      return { error: "expiresAt is not a parseable date" };
    }
    expiresAt = trimmed;
  }

  return { value: { status: obj.status, notes, expiresAt } };
}
