// WS10 SEC-I-ADR29-04 test-enforced invariant: no file that references a
// branding context, hook, or field may also use React's
// `dangerouslySetInnerHTML`. Convention alone is insufficient; this test
// makes the XSS boundary load-bearing.
//
// The operator-controlled branding strings (productName, footerText) must
// ONLY render via React's default text-escape path. Any future refactor
// that wires `dangerouslySetInnerHTML` into a branding consumer fails this
// test before the diff lands.

import { describe, it, expect } from "vitest";

// Vite's import.meta.glob with `eager: true, query: "?raw", import: "default"`
// materialises every matching file's contents as a string at test-load
// time. Avoids pulling in @types/node just for this single test. Pattern
// covers the full web src surface below where this file lives.
const ALL_SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const BRANDING_TOKENS = [
  "useBranding",
  "useProductName",
  "BrandingProvider",
  "BrandingSection",
  "BrandingRecord",
  "BrandingPatch",
  "useUpdateBranding",
  // Phase B additions — the logo-path adds `logoUrl` as a context field.
  // The URL itself is same-origin and computed server-side, but we enforce
  // the same "never via dangerouslySetInnerHTML" rule so a future refactor
  // cannot accidentally paste it into an `<img>` via innerHTML.
  "useUploadBrandingLogo",
  "useDeleteBrandingLogo",
  "LogoUploadInput",
  "branding.productName",
  "branding.footerText",
  "branding.primaryHex",
  "branding.logoUrl",
  "branding.logoSha256",
  "branding.logoContentType",
  ".productName",
  ".footerText",
  ".logoUrl",
];

function sourceEntries(): Array<[string, string]> {
  return Object.entries(ALL_SOURCES).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

describe("branding XSS invariant (WS10 SEC-I-ADR29-04)", () => {
  it("no file references branding AND uses dangerouslySetInnerHTML", () => {
    const violations: string[] = [];
    for (const [path, content] of sourceEntries()) {
      if (!content.includes("dangerouslySetInnerHTML")) continue;
      if (BRANDING_TOKENS.some((t) => content.includes(t))) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });

  it("sanity-check: at least one source file references branding (prevents the test silently passing on a false-negative glob)", () => {
    const branded = sourceEntries().filter(([, c]) => BRANDING_TOKENS.some((t) => c.includes(t)));
    expect(branded.length).toBeGreaterThan(0);
  });
});
