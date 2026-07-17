// Unit tests for BrandingProvider internals (ADR-0029 Phase A).
//
// The pure helpers are exposed via `internals` so we can test the
// theme-resolution precedence chain + colour-ramp generation without
// spinning up a React tree.

import { describe, it, expect } from "vitest";
import { internals } from "@/features/branding/BrandingProvider";

const { resolveEffectiveTheme, buildBrandRamp, safePrimaryHex, hexToRgb, rgbToHsl, hslToHex } =
  internals;

describe("resolveEffectiveTheme (ADR-0029 §Decision.4 precedence chain)", () => {
  it("localStorage user preference wins over tenant default (dark user + light tenant)", () => {
    expect(resolveEffectiveTheme("dark", "light", false)).toBe("dark");
  });

  it("localStorage user preference wins over tenant default (light user + dark tenant)", () => {
    expect(resolveEffectiveTheme("light", "dark", true)).toBe("light");
  });

  it("tenant default wins over system preference when no user override", () => {
    expect(resolveEffectiveTheme(null, "dark", false)).toBe("dark");
    expect(resolveEffectiveTheme(null, "light", true)).toBe("light");
  });

  it("user 'system' preference defers to media query", () => {
    expect(resolveEffectiveTheme("system", "dark", true)).toBe("dark");
    expect(resolveEffectiveTheme("system", "light", false)).toBe("light");
  });

  it("tenant 'system' default defers to media query when no user override", () => {
    expect(resolveEffectiveTheme(null, "system", true)).toBe("dark");
    expect(resolveEffectiveTheme(null, "system", false)).toBe("light");
  });
});

describe("safePrimaryHex — defence-in-depth against corrupted values", () => {
  it("accepts valid #RRGGBB", () => {
    expect(safePrimaryHex("#FF0044")).toBe("#FF0044");
    expect(safePrimaryHex("#abcdef")).toBe("#abcdef");
  });

  it("falls back to default on invalid inputs", () => {
    expect(safePrimaryHex("red")).toBe("#0078D4");
    expect(safePrimaryHex("#FFF")).toBe("#0078D4"); // 3-digit form unsupported at this layer
    expect(safePrimaryHex("#FFFFFFF")).toBe("#0078D4");
    expect(safePrimaryHex("FF0044")).toBe("#0078D4");
    expect(safePrimaryHex(undefined)).toBe("#0078D4");
    expect(safePrimaryHex("")).toBe("#0078D4");
  });
});

describe("buildBrandRamp — deterministic 16-shade generation", () => {
  it("produces 16 shade keys from a valid hex", () => {
    const ramp = buildBrandRamp("#0078D4") as unknown as Record<number, string>;
    const keys = Object.keys(ramp)
      .map(Number)
      .sort((a, b) => a - b);
    expect(keys).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
    for (const v of Object.values(ramp)) {
      expect(v).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("produces identical ramps for identical inputs (determinism)", () => {
    const a = buildBrandRamp("#FF0044") as unknown as Record<number, string>;
    const b = buildBrandRamp("#FF0044") as unknown as Record<number, string>;
    expect(a).toEqual(b);
  });

  it("produces different ramps for different inputs", () => {
    const a = buildBrandRamp("#FF0044") as unknown as Record<number, string>;
    const b = buildBrandRamp("#44FF00") as unknown as Record<number, string>;
    expect(a).not.toEqual(b);
  });

  it("generates a monotonically darkening ramp (shade 10 lighter than 160)", () => {
    const ramp = buildBrandRamp("#FF0044") as unknown as Record<number, string>;
    // Compare luminance as a proxy: RGB sum of shade 10 > shade 160.
    const sum = (hex: string): number => {
      const { r, g, b } = hexToRgb(hex);
      return r + g + b;
    };
    const light = ramp[10]!;
    const dark = ramp[160]!;
    expect(sum(light)).toBeGreaterThan(sum(dark));
  });
});

describe("hex ↔ HSL colour helpers", () => {
  it("round-trips black (no hue/saturation loss)", () => {
    const { r, g, b } = hexToRgb("#000000");
    const { h, s, l } = rgbToHsl(r, g, b);
    expect(hslToHex(h, s, l)).toBe("#000000");
  });

  it("round-trips white", () => {
    const { r, g, b } = hexToRgb("#FFFFFF");
    const { h, s, l } = rgbToHsl(r, g, b);
    expect(hslToHex(h, s, l)).toBe("#FFFFFF");
  });

  it("round-trips Fluent blue 10 within 1-bit quantisation", () => {
    const input = "#0078D4";
    const { r, g, b } = hexToRgb(input);
    const { h, s, l } = rgbToHsl(r, g, b);
    const out = hslToHex(h, s, l);
    // Round-trip tolerance — ±1 on each channel acceptable for 8-bit quant.
    const outRgb = hexToRgb(out);
    expect(Math.abs(outRgb.r - r)).toBeLessThanOrEqual(1);
    expect(Math.abs(outRgb.g - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(outRgb.b - b)).toBeLessThanOrEqual(1);
  });
});
