// Canonical source-key registry for the agent plane (ADR-0020 amendment
// 2026-04-20 + ADR-0027 §Decision.8 + ADR-0028 §Decision.8).
//
// Every specialist agent's prompt builder consumes inputs labelled by a
// source key. The subset-check (ADR-0020 §Decision.2) asserts that a
// model's claimed `sourcesUsed` is a subset of the builder-presented set;
// a model claiming a key that the builder never provided fails validation
// as `source_fabrication`. To make that check defensible, there needs to
// be exactly one authoritative enumeration of which keys are canonical —
// this module is that enumeration.
//
// Convention (dotted-namespace, lowercase): `<domain>.<facet>`. Examples:
//   secureScore.latest, incidents.summary, ingestHealth.all
//
// Dynamic (per-entity) keys live under the same convention with a trailing
// entity-ID suffix — currently only `incidents.summary.<id>` and
// `incidents.detail.<id>` per ADR-0028 §Decision.8. The incident-ID suffix
// MUST match the authoritative adapter-parameter incident ID (never
// model-provided); `isCanonicalSourceKey` enforces that.

/**
 * Static canonical source keys — must match the enumeration shipped in
 * `briefPromptBuilder.ts` as of ADR-0020 amendment 2026-04-20.
 *
 * Additions land here first; a new key not in this tuple is rejected by
 * `isCanonicalSourceKey` by default. When a new specialist is added, the
 * ADR describing it amends this tuple in the same commit.
 */
export const CANONICAL_SOURCE_KEYS = [
  "secureScore.latest",
  "secureScore.trend14d",
  "incidents.summary",
  "incidents.highSeverity.active",
  "ingestHealth.all",
  "ingestHealth.secureScore",
  "riskyUsers.summary",
  "riskyUsers.recent",
] as const;

/**
 * Type derived from the canonical set. Every builder-side key declaration
 * should narrow to this type; the type system then guarantees that every
 * producer of a source key references an entry in `CANONICAL_SOURCE_KEYS`.
 */
export type CanonicalSourceKey = (typeof CANONICAL_SOURCE_KEYS)[number];

/**
 * Superset allow-type — static canonical keys + the dynamic (suffixed)
 * forms. Runtime validation is via `isCanonicalSourceKey`; this type
 * exists so adapters that emit dynamic keys can narrow without a union
 * widening to `string`.
 */
export type AllowedSourceKey = CanonicalSourceKey | DynamicSourceKey;

/** Templated dynamic-source-key shape. Only `incidents.*` at v1. */
export type DynamicSourceKey =
  | `incidents.summary.${string}`
  | `incidents.detail.${string}`;

/**
 * Dynamic-key regex — mirrors ADR-0028 §Decision.8. Character class
 * `[A-Za-z0-9_-]+` matches Defender's incident-ID shape (ADR-0014 §3.2);
 * widen here when Graph starts emitting additional characters.
 */
const DYNAMIC_INCIDENT_KEY_REGEX = /^incidents\.(summary|detail)\.([A-Za-z0-9_-]+)$/;

export interface SourceKeyContext {
  /**
   * The incident ID from the run context — authoritative adapter
   * parameter, never model-provided. Required when checking dynamic
   * incident-suffixed keys.
   */
  readonly incidentId?: string;
}

/**
 * Error thrown when a dynamic key is tested without the required run
 * context. Separate from a rejection: a caller that forgets context is
 * a coding bug (adapter boundary violation), not a model-fabrication
 * attempt. Fails loud at test time rather than silently accepting.
 */
export class MissingSourceKeyContextError extends Error {
  constructor(key: string) {
    super(
      `isCanonicalSourceKey: dynamic key "${key}" requires context.incidentId; none supplied`,
    );
    this.name = "MissingSourceKeyContextError";
  }
}

/**
 * Decide whether `key` is canonical under this registry.
 *
 * Accepts:
 * - An exact member of `CANONICAL_SOURCE_KEYS`.
 * - A dynamic `incidents.(summary|detail).<id>` where the `<id>` suffix
 *   matches `context.incidentId` exactly.
 *
 * Rejects:
 * - Any other string.
 * - A dynamic-matching key whose suffix ≠ `context.incidentId` (model
 *   fabrication attempt — ADR-0028 §Decision.8).
 *
 * Throws `MissingSourceKeyContextError` when the key matches the dynamic
 * regex but `context.incidentId` is absent. This catches the "forgotten
 * context" bug at test time; the adapter boundary always has the ID.
 */
export function isCanonicalSourceKey(
  key: string,
  context?: SourceKeyContext,
): boolean {
  if ((CANONICAL_SOURCE_KEYS as readonly string[]).includes(key)) return true;
  const match = DYNAMIC_INCIDENT_KEY_REGEX.exec(key);
  if (!match) return false;
  const suffix = match[2];
  if (!context || !context.incidentId) {
    throw new MissingSourceKeyContextError(key);
  }
  return suffix === context.incidentId;
}
