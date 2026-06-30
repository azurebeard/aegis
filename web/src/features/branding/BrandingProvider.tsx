// Branding provider (ADR-0029 Phase A).
//
// Wraps FluentProvider at the app root. Derives the effective theme from:
//   1. localStorage `aegis.theme` (per-user override set by the header toggle)
//   2. `branding.defaultTheme` (tenant-scoped default)
//   3. `prefers-color-scheme` media query (system preference)
//
// Exposes productName + footerText + theme-toggle via a React context so
// any downstream component can consume without re-doing the resolution
// dance. Falls back to hardcoded defaults when the server returns no
// branding row (fresh tenant or RBAC drift).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  FluentProvider,
  createLightTheme,
  createDarkTheme,
  webLightTheme,
  webDarkTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";
import { useTenantSettings } from "@/features/settings/queries";
import { useCurrentUser } from "@/auth/useCurrentUser";
import {
  BRANDING_DEFAULTS,
  type BrandingRecord,
  type DefaultTheme,
} from "@/features/settings/types";

const THEME_STORAGE_KEY = "aegis.theme";
const THEME_CHOICES: readonly DefaultTheme[] = ["system", "light", "dark"];

/** Resolved theme for actual rendering — only two effective values. */
export type ResolvedTheme = "light" | "dark";

export interface BrandingContextValue {
  readonly productName: string;
  readonly footerText: string;
  readonly primaryHex: string;
  /** The operator-set tenant default (`system` | `light` | `dark`). */
  readonly tenantDefaultTheme: DefaultTheme;
  /** The per-user override from localStorage (`null` if not set). */
  readonly userPreference: DefaultTheme | null;
  /** Actual theme being rendered (resolved). */
  readonly resolvedTheme: ResolvedTheme;
  /** Cycle system → light → dark → system and persist to localStorage. */
  readonly cycleTheme: () => void;
  /** ADR-0029 Phase B — same-origin logo URL with sha-based cache-buster.
   *  `null` when no logo is configured; consumers render text-only branding
   *  in that case. The URL is static origin → Function proxy → stream from
   *  blob storage; no `<img src="data:...">` path, no cross-origin fetch,
   *  CSP `img-src 'self'` preserved (§Decision.6). */
  readonly logoUrl: string | null;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

/** Hook for consumers. Throws if the provider is missing (coding bug). */
export function useBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (!ctx) {
    throw new Error("useBranding() must be called inside <BrandingProvider>. Wrap the app root.");
  }
  return ctx;
}

/** Convenience hook for the common case — just the product name. */
export function useProductName(): string {
  return useBranding().productName;
}

function readStoredPreference(): DefaultTheme | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && THEME_CHOICES.includes(raw as DefaultTheme)) {
      return raw as DefaultTheme;
    }
  } catch {
    // localStorage access can throw in some privacy modes — treat as unset.
  }
  return null;
}

function writeStoredPreference(value: DefaultTheme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // Best-effort persist.
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveEffectiveTheme(
  userPref: DefaultTheme | null,
  tenantDefault: DefaultTheme,
  systemDark: boolean,
): ResolvedTheme {
  const chosen = userPref ?? tenantDefault;
  if (chosen === "light") return "light";
  if (chosen === "dark") return "dark";
  return systemDark ? "dark" : "light";
}

/**
 * Clamp + normalise a hex colour. Returns the default when invalid —
 * defence-in-depth against a server row that somehow got corrupted.
 */
function safePrimaryHex(candidate: string | undefined): string {
  if (typeof candidate === "string" && /^#[0-9a-fA-F]{6}$/.test(candidate)) {
    return candidate;
  }
  return BRANDING_DEFAULTS.primaryHex;
}

/** Parse `#RRGGBB` → {r, g, b} in 0..255. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

/** RGB (0..255) → HSL (h in 0..360, s + l in 0..1). */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

/** HSL (h in 0..360, s + l in 0..1) → `#RRGGBB`. */
function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(value * 255);
  };
  const r = f(0);
  const g = f(8);
  const b = f(4);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
}

/**
 * Generate a Fluent `BrandVariants` (16 shades from 10 to 160) from a
 * single primary hex by varying HSL lightness along a canonical progression.
 * Not a perfect match to Fluent's Theme Designer output, but predictable,
 * deterministic, dep-free, and good enough for operator brand expression.
 */
function buildBrandRamp(primaryHex: string): BrandVariants {
  const { r, g, b } = hexToRgb(primaryHex);
  const { h, s } = rgbToHsl(r, g, b);
  // Lightness stops roughly matching Fluent's default blue ramp contour.
  // Index 0 (=10) is lightest; index 15 (=160) is darkest.
  const lightnessStops = [
    0.97, 0.93, 0.88, 0.81, 0.72, 0.63, 0.54, 0.47, 0.4, 0.33, 0.28, 0.22, 0.18, 0.14, 0.1, 0.07,
  ];
  const shadeKeys = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
  const ramp: Record<number, string> = {};
  for (let i = 0; i < 16; i++) {
    ramp[shadeKeys[i] as number] = hslToHex(h, s, lightnessStops[i] as number);
  }
  return ramp as unknown as BrandVariants;
}

/** Cache theme objects per (resolvedTheme, primaryHex) pair. */
function buildFluentTheme(resolved: ResolvedTheme, primaryHex: string): Theme {
  // Fast path — default brand + default hex → skip ramp generation.
  if (primaryHex === BRANDING_DEFAULTS.primaryHex) {
    return resolved === "dark" ? webDarkTheme : webLightTheme;
  }
  const brand = buildBrandRamp(primaryHex);
  return resolved === "dark" ? createDarkTheme(brand) : createLightTheme(brand);
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  // ADR-0035 Phase D2 — gate the tenant-settings query on sign-in so an
  // anonymous visitor doesn't 401-spam /api/settings before MSAL has an
  // active account. The provider falls back to BRANDING_DEFAULTS when
  // `query.data` is undefined, which is the desired pre-sign-in posture.
  const user = useCurrentUser();
  const query = useTenantSettings({ enabled: user.isAuthenticated });
  const branding: BrandingRecord = useMemo(() => {
    const b = query.data?.branding;
    if (b) return b;
    return {
      ...BRANDING_DEFAULTS,
      logoUrl: null,
      updatedAt: null,
      updatedBy: null,
      source: "default" as const,
    };
  }, [query.data?.branding]);

  const [userPreference, setUserPreference] = useState<DefaultTheme | null>(() =>
    readStoredPreference(),
  );
  const [systemDark, setSystemDark] = useState<boolean>(() => systemPrefersDark());

  // Keep systemDark in sync with the media-query changes.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const resolvedTheme = useMemo(
    () => resolveEffectiveTheme(userPreference, branding.defaultTheme, systemDark),
    [userPreference, branding.defaultTheme, systemDark],
  );

  const primaryHex = safePrimaryHex(branding.primaryHex);

  const fluentTheme = useMemo(
    () => buildFluentTheme(resolvedTheme, primaryHex),
    [resolvedTheme, primaryHex],
  );

  const cycleTheme = useCallback(() => {
    setUserPreference((prev) => {
      const current = prev ?? branding.defaultTheme;
      const nextIdx = (THEME_CHOICES.indexOf(current) + 1) % THEME_CHOICES.length;
      const next = THEME_CHOICES[nextIdx] as DefaultTheme;
      writeStoredPreference(next);
      return next;
    });
  }, [branding.defaultTheme]);

  const ctx = useMemo<BrandingContextValue>(
    () => ({
      productName: branding.productName,
      footerText: branding.footerText,
      primaryHex,
      tenantDefaultTheme: branding.defaultTheme,
      userPreference,
      resolvedTheme,
      cycleTheme,
      logoUrl: branding.logoUrl,
    }),
    [
      branding.productName,
      branding.footerText,
      primaryHex,
      branding.defaultTheme,
      userPreference,
      resolvedTheme,
      cycleTheme,
      branding.logoUrl,
    ],
  );

  // Apply resolved theme to <html> so the browser chrome (scrollbars,
  // form controls, etc.) picks up the right mode. Also toggle the
  // `.theme-light` / `.theme-dark` class on <html> + <body> — the
  // `web/src/styles/aegis.css` design system keys its CSS custom
  // property sets off these classes (so brand-ramp + token swap takes
  // effect at the document root, not just inside FluentProvider).
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.colorScheme = resolvedTheme;
    const root = document.documentElement;
    const body = document.body;
    root.classList.toggle("theme-dark", resolvedTheme === "dark");
    root.classList.toggle("theme-light", resolvedTheme === "light");
    body.classList.toggle("theme-dark", resolvedTheme === "dark");
    body.classList.toggle("theme-light", resolvedTheme === "light");
  }, [resolvedTheme]);

  // Apply operator's `primaryHex` to the design-system brand-ramp variables.
  // The Fluent v9 React theme is already derived from the same hex via
  // `createLightTheme` / `createDarkTheme`; this writes the same value
  // into `--brand-fg` / `--brand-80` so plain-CSS components in the
  // design system pick it up too.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty("--brand-fg", primaryHex);
    document.documentElement.style.setProperty("--brand-80", primaryHex);
  }, [primaryHex]);

  // Update the document title when the operator renames the product.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = branding.productName;
  }, [branding.productName]);

  return (
    <BrandingContext.Provider value={ctx}>
      <FluentProvider theme={fluentTheme}>{children}</FluentProvider>
    </BrandingContext.Provider>
  );
}

// Internal helpers exported for unit tests only.
export const internals = {
  resolveEffectiveTheme,
  buildBrandRamp,
  safePrimaryHex,
  hexToRgb,
  rgbToHsl,
  hslToHex,
  THEME_STORAGE_KEY,
};
