// ADR-0031 §1 — body validation for POST + PATCH stack items.
//
// Pure functions — no I/O, no logging. Returns either { value: T } or
// { error: string }. Endpoints surface the error string verbatim with
// http.status=400.

import {
  isValidStackCategory,
  isValidStackEnvironment,
  STACK_BOUNDS,
  type StackCategory,
  type StackEnvironment,
} from "./stackItemsStore.js";

export interface CreateStackItemBody {
  readonly vendor: string;
  readonly product: string;
  readonly version: string;
  readonly category: StackCategory;
  readonly environment: StackEnvironment;
  readonly notes: string;
  readonly tags: readonly string[];
}

export interface PatchStackItemBody {
  readonly vendor?: string;
  readonly product?: string;
  readonly version?: string;
  readonly category?: StackCategory;
  readonly environment?: StackEnvironment;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

const KNOWN_KEYS = new Set([
  "vendor",
  "product",
  "version",
  "category",
  "environment",
  "notes",
  "tags",
]);

// Control-char detection. Regex literals can't carry raw line-terminator
// bytes (LF/CR), so we build patterns from explicit hex escapes via
// `new RegExp(...)` — equivalent to /[\x00-\x1f\x7f]/ at runtime.
const ANY_CONTROL = new RegExp("[\\x00-\\x1f\\x7f]");
// All control chars EXCEPT \t (\x09), \n (\x0a), \r (\x0d). Used for the
// `notes` field so operators can paste multi-line context.
const NON_PRINTABLE_EXCEPT_WHITESPACE = new RegExp(
  "[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]",
);

function asObj(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function rejectUnknownKeys(obj: Record<string, unknown>): string | null {
  for (const k of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(k)) return `unknown field: ${k}`;
  }
  return null;
}

function validateString(
  raw: unknown,
  field: string,
  maxChars: number,
  required: boolean,
): { value: string } | { error: string } {
  if (raw === undefined || raw === null || raw === "") {
    if (required) return { error: `${field} is required` };
    return { value: "" };
  }
  if (typeof raw !== "string") return { error: `${field} must be a string` };
  const trimmed = raw.trim();
  if (required && trimmed === "") return { error: `${field} is required` };
  if (trimmed.length > maxChars) {
    return { error: `${field} must be ${maxChars} characters or fewer` };
  }
  // Reject control chars (NUL, ESC, DEL etc.) — these aren't user-typed
  // and almost always indicate a bug or hostile input. `notes` admits
  // tab / newline / CR.
  if (field === "notes") {
    if (NON_PRINTABLE_EXCEPT_WHITESPACE.test(trimmed)) {
      return { error: `${field} contains control characters` };
    }
  } else {
    if (ANY_CONTROL.test(trimmed)) {
      return { error: `${field} contains control characters` };
    }
  }
  return { value: trimmed };
}

function validateTags(
  raw: unknown,
): { value: readonly string[] } | { error: string } {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: "tags must be an array of strings" };
  if (raw.length > STACK_BOUNDS.tags.maxCount) {
    return { error: `tags must have ${STACK_BOUNDS.tags.maxCount} or fewer entries` };
  }
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") return { error: "tags entries must be strings" };
    const trimmed = t.trim();
    if (trimmed === "") continue;
    if (trimmed.length > STACK_BOUNDS.tags.maxCharsEach) {
      return {
        error: `tag '${trimmed.slice(0, 12)}…' exceeds ${STACK_BOUNDS.tags.maxCharsEach} characters`,
      };
    }
    if (ANY_CONTROL.test(trimmed)) {
      return { error: "tag contains control characters" };
    }
    out.push(trimmed);
  }
  return { value: out };
}

export function validateCreateBody(
  body: unknown,
): { value: CreateStackItemBody } | { error: string } {
  const obj = asObj(body);
  if (!obj) return { error: "body must be a JSON object" };
  const unknown = rejectUnknownKeys(obj);
  if (unknown) return { error: unknown };

  const vendor = validateString(obj.vendor, "vendor", STACK_BOUNDS.vendor.maxChars, true);
  if ("error" in vendor) return vendor;
  const product = validateString(obj.product, "product", STACK_BOUNDS.product.maxChars, true);
  if ("error" in product) return product;
  const version = validateString(obj.version, "version", STACK_BOUNDS.version.maxChars, false);
  if ("error" in version) return version;
  const notes = validateString(obj.notes, "notes", STACK_BOUNDS.notes.maxChars, false);
  if ("error" in notes) return notes;
  if (!isValidStackCategory(obj.category)) {
    return { error: "category must be one of: os, application, network-device, library, service, other" };
  }
  if (!isValidStackEnvironment(obj.environment)) {
    return { error: "environment must be one of: production, staging, development, unknown" };
  }
  const tags = validateTags(obj.tags);
  if ("error" in tags) return tags;

  return {
    value: {
      vendor: vendor.value,
      product: product.value,
      version: version.value,
      category: obj.category,
      environment: obj.environment,
      notes: notes.value,
      tags: tags.value,
    },
  };
}

export function validatePatchBody(
  body: unknown,
): { value: PatchStackItemBody } | { error: string } {
  const obj = asObj(body);
  if (!obj) return { error: "body must be a JSON object" };
  const unknown = rejectUnknownKeys(obj);
  if (unknown) return { error: unknown };

  const out: {
    vendor?: string;
    product?: string;
    version?: string;
    category?: StackCategory;
    environment?: StackEnvironment;
    notes?: string;
    tags?: readonly string[];
  } = {};

  if (obj.vendor !== undefined) {
    const r = validateString(obj.vendor, "vendor", STACK_BOUNDS.vendor.maxChars, true);
    if ("error" in r) return r;
    out.vendor = r.value;
  }
  if (obj.product !== undefined) {
    const r = validateString(obj.product, "product", STACK_BOUNDS.product.maxChars, true);
    if ("error" in r) return r;
    out.product = r.value;
  }
  if (obj.version !== undefined) {
    const r = validateString(obj.version, "version", STACK_BOUNDS.version.maxChars, false);
    if ("error" in r) return r;
    out.version = r.value;
  }
  if (obj.notes !== undefined) {
    const r = validateString(obj.notes, "notes", STACK_BOUNDS.notes.maxChars, false);
    if ("error" in r) return r;
    out.notes = r.value;
  }
  if (obj.category !== undefined) {
    if (!isValidStackCategory(obj.category)) {
      return { error: "category must be one of: os, application, network-device, library, service, other" };
    }
    out.category = obj.category;
  }
  if (obj.environment !== undefined) {
    if (!isValidStackEnvironment(obj.environment)) {
      return { error: "environment must be one of: production, staging, development, unknown" };
    }
    out.environment = obj.environment;
  }
  if (obj.tags !== undefined) {
    const r = validateTags(obj.tags);
    if ("error" in r) return r;
    out.tags = r.value;
  }

  if (Object.keys(out).length === 0) {
    return { error: "body must include at least one field to update" };
  }
  return { value: out };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a path-supplied stack-item id is a v4 UUID (loose: accepts any
 *  RFC-4122 hex shape, since RowKey only needs to match what we wrote). */
export function isValidStackItemId(id: string): boolean {
  return UUID_RE.test(id);
}
