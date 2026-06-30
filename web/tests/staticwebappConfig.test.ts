// ADR-0035 Phase D2 / WS10 SEC-M-02 — CSP regression test.
//
// MSAL.js requires connect-src + frame-src to permit
// https://login.microsoftonline.com (silent token renewal iframe + the
// /token endpoint POST). The CSP delta must NOT relax script-src,
// style-src, or default-src — those are the load-bearing XSS controls
// that keep R2 (token-theft via XSS) from re-opening.
//
// Future hygiene: any change to the CSP must update this test deliberately.
// Anyone who silently relaxes CSP and breaks this test sees the failure
// at PR-time, not at production-incident time.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, "..", "swa-config.template.json");

interface SwaConfig {
  readonly auth?: unknown;
  readonly routes: ReadonlyArray<{ readonly route: string; readonly allowedRoles?: readonly string[] }>;
  readonly globalHeaders: Record<string, string>;
}

async function loadTemplate(): Promise<SwaConfig> {
  const raw = await readFile(templatePath, "utf-8");
  return JSON.parse(raw) as SwaConfig;
}

describe("swa-config.template.json — CSP (SEC-M-02 regression guard)", () => {
  it("connect-src allows login.microsoftonline.com (silent token endpoint)", async () => {
    const cfg = await loadTemplate();
    const csp = cfg.globalHeaders["Content-Security-Policy"];
    expect(csp).toMatch(/connect-src[^;]*\bhttps:\/\/login\.microsoftonline\.com\b/);
  });

  it("frame-src allows login.microsoftonline.com (silent renewal iframe)", async () => {
    const cfg = await loadTemplate();
    const csp = cfg.globalHeaders["Content-Security-Policy"];
    expect(csp).toMatch(/frame-src[^;]*\bhttps:\/\/login\.microsoftonline\.com\b/);
  });

  it("script-src is NOT relaxed (no 'unsafe-inline', no 'unsafe-eval', no wildcards)", async () => {
    const cfg = await loadTemplate();
    const csp = cfg.globalHeaders["Content-Security-Policy"];
    const scriptSrc = csp.match(/script-src([^;]*)/)?.[1] ?? "";
    expect(scriptSrc).not.toMatch(/'unsafe-inline'/);
    expect(scriptSrc).not.toMatch(/'unsafe-eval'/);
    expect(scriptSrc).not.toMatch(/\*/);
  });

  it("default-src is 'self' — no wildcard fallback", async () => {
    const cfg = await loadTemplate();
    const csp = cfg.globalHeaders["Content-Security-Policy"];
    const defaultSrc = csp.match(/default-src([^;]*)/)?.[1] ?? "";
    expect(defaultSrc.trim()).toBe("'self'");
  });

  it("frame-ancestors is 'none' (clickjacking defence)", async () => {
    const cfg = await loadTemplate();
    const csp = cfg.globalHeaders["Content-Security-Policy"];
    expect(csp).toMatch(/frame-ancestors[^;]*'none'/);
  });
});

describe("swa-config.template.json — ADR-0035 Phase D2 invariants", () => {
  it("does NOT contain an `auth` block (SWA built-in OIDC retired)", async () => {
    const cfg = await loadTemplate();
    expect(cfg.auth).toBeUndefined();
  });

  it("does NOT reference rolesSource as a live config key (handler retired in Phase E)", async () => {
    // Strip `_comment` annotations before checking — historical context lives
    // in those, but no live SWA config key may reference rolesSource.
    const cfg = await loadTemplate();
    const live = JSON.parse(
      JSON.stringify(cfg, (k, v) => (k === "_comment" ? undefined : v)),
    ) as unknown;
    expect(JSON.stringify(live)).not.toMatch(/rolesSource/);
  });

  it("/api/* route uses `anonymous` (FA enforces auth, not SWA)", async () => {
    const cfg = await loadTemplate();
    const apiRoute = cfg.routes.find((r) => r.route === "/api/*");
    expect(apiRoute).toBeDefined();
    expect(apiRoute!.allowedRoles).toEqual(["anonymous"]);
  });

  it("no route uses `admin` or `reader` allowedRoles (handler-level enforcement)", async () => {
    const cfg = await loadTemplate();
    for (const r of cfg.routes) {
      const roles = r.allowedRoles ?? [];
      expect(roles).not.toContain("admin");
      expect(roles).not.toContain("reader");
      expect(roles).not.toContain("authenticated");
    }
  });
});
