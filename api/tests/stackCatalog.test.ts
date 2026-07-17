// ADR-0031 §2 — catalog flatten + canonical-pair detection.

import { describe, expect, it } from "vitest";
import {
  flattenCatalog,
  isCanonicalPair,
  STACK_CATALOG,
} from "../src/lib/stackCatalog.js";

describe("stackCatalog", () => {
  it("has at least 100 vendor+product pairs", () => {
    const flat = flattenCatalog();
    expect(flat.length).toBeGreaterThanOrEqual(100);
  });

  it("every entry has at least one product", () => {
    for (const e of STACK_CATALOG) {
      expect(e.products.length).toBeGreaterThan(0);
      expect(e.vendor.length).toBeGreaterThan(0);
    }
  });

  it("every product appears under a known category", () => {
    const validCategories = new Set([
      "os",
      "application",
      "network-device",
      "library",
      "service",
      "other",
    ]);
    for (const e of STACK_CATALOG) {
      expect(validCategories.has(e.defaultCategory)).toBe(true);
    }
  });

  it("isCanonicalPair finds known products case-insensitively", () => {
    expect(isCanonicalPair("Microsoft", "Windows Server 2022")).toBe(true);
    expect(isCanonicalPair("microsoft", "windows server 2022")).toBe(true);
    expect(isCanonicalPair("MICROSOFT", "WINDOWS SERVER 2022")).toBe(true);
    expect(isCanonicalPair("  Microsoft  ", "  Windows Server 2022  ")).toBe(true);
  });

  it("isCanonicalPair returns false for unknown vendors / products", () => {
    expect(isCanonicalPair("AcmeWare", "FrobnicatorPro")).toBe(false);
    // Known vendor, unknown product.
    expect(isCanonicalPair("Microsoft", "DefinitelyNotAProduct")).toBe(false);
  });

  it("includes the high-frequency vendors", () => {
    const vendors = new Set(STACK_CATALOG.map((e) => e.vendor));
    for (const v of [
      "Microsoft",
      "Apple",
      "Google",
      "Apache",
      "nginx",
      "Cisco",
      "Fortinet",
      "Palo Alto Networks",
      "Red Hat",
      "Canonical",
      "Docker",
      "Kubernetes",
    ]) {
      expect(vendors.has(v), `expected vendor ${v}`).toBe(true);
    }
  });
});
