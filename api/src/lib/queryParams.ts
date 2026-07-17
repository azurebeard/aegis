// Small input-parsing utilities for HTTP handlers.
//
// SEC-BUG-INCIDENTS-LIST-MULTI: the SWA linked-backend proxy
// in front of the Function App collapses repeated query parameters into a
// single comma-joined value before the request reaches the Functions
// runtime. A browser request for `?severity=high&severity=medium` arrives
// at the handler as `severity=high,medium` (one entry, comma-joined). The
// strict-enum validator at `filterFingerprint.ts:normaliseEnumArray` then
// rejects the comma-joined token with `enum_invalid` (`value "high,medium"
// is not in the allowed enum`), and the request 400s.
//
// `getAllMulti(query, name)` is the defensive parser for handlers that
// accept array-valued query parameters: it accepts BOTH shapes (native
// repeats AND comma-joined values) and returns a flat string array with
// whitespace-trimmed tokens and empty tokens dropped. Both shapes
// canonicalise to the same array — the canonicaliser's strict per-token
// validation runs unchanged.
//
// Examples (all return `["high", "medium"]`):
//   ?severity=high&severity=medium     // native repeats
//   ?severity=high,medium              // comma-joined (proxy-collapsed)
//   ?severity=high%2Cmedium            // URL-encoded comma
//   ?severity=high&severity=medium,low // mixed (also tolerated)
//   ?severity=high, medium             // whitespace around tokens
//
// Edge cases:
//   ?severity=              → []  (single empty token dropped)
//   ?severity=high,         → ["high"]  (trailing-comma empty token dropped)
//   ?severity=,,            → []  (all empty tokens dropped)
//   (absent)                → []
//
// The function does NOT deduplicate — the canonicaliser already does that
// via the `seen` Set in `normaliseEnumArray`.

export interface QueryLike {
  getAll(name: string): string[];
}

export function getAllMulti(query: QueryLike, name: string): string[] {
  const raw = query.getAll(name);
  if (raw.length === 0) return [];
  const out: string[] = [];
  for (const v of raw) {
    for (const token of v.split(",")) {
      const trimmed = token.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}
