// Prompt-injection screening (ADR-0020 §four-layer defence).
//
// Four layers, applied in order:
//   1. length cap        — reject if context > MAX_CONTEXT_CHARS.
//   2. control-char strip — remove zero-width, bidi, and C0/C1 controls.
//   3. denylist match    — reject on any of the patterns below.
//   4. fenced delimiter  — wrap accepted context in <context>...</context>
//      so the system prompt instructs the model to treat the inner content
//      as untrusted data.
//
// Quarterly review (ADR-0020 §denylist review): the snapshot is dated and
// audited via `denylistVersion` on every brief-agent audit line.

export const DENYLIST_VERSION = "2026-04-19";
export const MAX_CONTEXT_CHARS = 32_000;

/**
 * 2026-04-19 snapshot. Patterns target the most common prompt-injection
 * shapes seen in the wild — the goal is fail-closed defence-in-depth, not a
 * complete classifier (the model itself remains the last line of defence).
 */
export const DENYLIST: readonly RegExp[] = [
  /(ignore|disregard)\s+(all|previous|above)\s+instructions/i,
  /system\s*prompt/i,
  /<\/?(script|iframe)/i,
  /javascript:/i,
  /data:text\/html/i,
  /<!\s*ENTITY/i,
  /role\s*:\s*system/i,
  /\{\{[^}]*\}\}/, // template-injection braces
  /tool_code/i,
  /tool_result/i,
  /you\s+are\s+now/i,
  /i\s+am\s+the\s+administrator/i,
  /-----BEGIN/, // PEM block markers (cred-shaped)
];

export interface ScreenResult {
  readonly accepted: boolean;
  /**
   * Post-layer-2 form of the input — stripped of C0/C1 controls, bidi
   * overrides, BOMs. Populated on `accepted:true` so callers can fence the
   * CLEANED string rather than the raw input (ADR-0020 §four-layer defence:
   * the fence must wrap the output of layers 1–3, not the raw). Also
   * populated on `accepted:false` with `reason:"denylist_hit"` — the caller
   * may want the cleaned form for forensic logging.
   */
  readonly cleaned?: string;
  readonly reason?: "length_cap" | "denylist_hit";
  readonly matchedPattern?: string;
}

/**
 * Screen one untrusted context string. Applies length cap → control-char
 * strip → denylist match. Returns `{accepted:false, reason}` on first hit.
 *
 * On `accepted:true`, the `cleaned` form (post-strip, pre-fence) is included
 * so callers pass it through `fencePromptContext` to close the 4-layer
 * defence. (SEC-M-STEP5-CODE-03 resolution — WS10 verdict 2026-04-19
 * step5-code.)
 */
export function screenPromptContext(context: string): ScreenResult {
  if (context.length > MAX_CONTEXT_CHARS) {
    return { accepted: false, reason: "length_cap" };
  }
  const cleaned = stripControlChars(context);
  for (const re of DENYLIST) {
    if (re.test(cleaned)) {
      return {
        accepted: false,
        cleaned,
        reason: "denylist_hit",
        matchedPattern: re.source,
      };
    }
  }
  return { accepted: true, cleaned };
}

/**
 * Strip:
 *   U+0000..U+0008, U+000B, U+000C, U+000E..U+001F, U+007F  — C0 controls
 *   U+FEFF, U+FFEF                                          — BOM / sentinel
 *   U+200E, U+200F, U+202A..U+202E, U+2066..U+2069          — bidi controls
 * Tabs (\t U+0009), LF (\n U+000A), CR (\r U+000D) are preserved — they're
 * present in legitimate JSON and markdown contexts.
 */
export function stripControlChars(input: string): string {
  // Two regex passes — the first removes the C0/C1 ranges except whitespace,
  // the second targets the named bidi + BOM points.
  const c0 = input.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  );
  const bidi = c0.replace(
    /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\uFFEF]/g,
    "",
  );
  return bidi;
}

/**
 * Wrap accepted context in literal `<context>` delimiters. The system prompt
 * instructs the model to treat anything inside as untrusted data — never to
 * follow instructions, never to emit raw URLs, never to fabricate numbers.
 */
export function fencePromptContext(cleaned: string): string {
  return `<context>\n${cleaned}\n</context>`;
}
