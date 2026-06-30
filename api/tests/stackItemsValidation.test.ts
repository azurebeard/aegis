// ADR-0031 §1 — body validation tests for create + patch.

import { describe, expect, it } from "vitest";
import {
  isValidStackItemId,
  validateCreateBody,
  validatePatchBody,
} from "../src/lib/stackItemsValidation.js";

const BASE_VALID = {
  vendor: "Microsoft",
  product: "Windows Server 2022",
  category: "os",
  environment: "production",
};

describe("validateCreateBody", () => {
  it("accepts a minimal valid body", () => {
    const r = validateCreateBody(BASE_VALID);
    expect(r).toMatchObject({
      value: { vendor: "Microsoft", product: "Windows Server 2022" },
    });
  });

  it("trims surrounding whitespace from string fields", () => {
    const r = validateCreateBody({
      ...BASE_VALID,
      vendor: "  Microsoft  ",
      product: "  Windows  ",
    });
    expect(r).toMatchObject({
      value: { vendor: "Microsoft", product: "Windows" },
    });
  });

  it("rejects body that isn't a JSON object", () => {
    for (const bad of [null, "string", 42, [], true]) {
      expect(validateCreateBody(bad)).toMatchObject({ error: expect.stringContaining("object") });
    }
  });

  it("rejects unknown top-level fields", () => {
    expect(
      validateCreateBody({ ...BASE_VALID, sneaky: "bad" }),
    ).toMatchObject({ error: expect.stringContaining("unknown") });
  });

  it("requires vendor + product + category + environment", () => {
    expect(validateCreateBody({ product: "X", category: "os", environment: "production" }))
      .toMatchObject({ error: expect.stringContaining("vendor is required") });
    expect(validateCreateBody({ vendor: "X", category: "os", environment: "production" }))
      .toMatchObject({ error: expect.stringContaining("product is required") });
    expect(validateCreateBody({ vendor: "X", product: "Y", environment: "production" }))
      .toMatchObject({ error: expect.stringContaining("category") });
    expect(validateCreateBody({ vendor: "X", product: "Y", category: "os" }))
      .toMatchObject({ error: expect.stringContaining("environment") });
  });

  it("rejects unknown category / environment values", () => {
    expect(
      validateCreateBody({ ...BASE_VALID, category: "DROP TABLE" }),
    ).toMatchObject({ error: expect.stringContaining("category") });
    expect(
      validateCreateBody({ ...BASE_VALID, environment: "../../etc" }),
    ).toMatchObject({ error: expect.stringContaining("environment") });
  });

  it("enforces vendor / product / version length caps", () => {
    expect(
      validateCreateBody({ ...BASE_VALID, vendor: "x".repeat(65) }),
    ).toMatchObject({ error: expect.stringContaining("vendor") });
    expect(
      validateCreateBody({ ...BASE_VALID, product: "y".repeat(65) }),
    ).toMatchObject({ error: expect.stringContaining("product") });
    expect(
      validateCreateBody({ ...BASE_VALID, version: "z".repeat(33) }),
    ).toMatchObject({ error: expect.stringContaining("version") });
  });

  it("rejects control chars in vendor / product / version", () => {
    expect(
      validateCreateBody({ ...BASE_VALID, vendor: "Microsoft\x00" }),
    ).toMatchObject({ error: expect.stringContaining("control") });
    expect(
      validateCreateBody({ ...BASE_VALID, product: "Win\x07dows" }),
    ).toMatchObject({ error: expect.stringContaining("control") });
  });

  it("admits tab / newline only in notes", () => {
    const r = validateCreateBody({
      ...BASE_VALID,
      notes: "line one\nline two\twith tab",
    });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.value.notes).toContain("line two");
    }
    // Other control chars in notes are still rejected.
    expect(
      validateCreateBody({ ...BASE_VALID, notes: "bad\x00null" }),
    ).toMatchObject({ error: expect.stringContaining("control") });
  });

  it("validates tags shape + caps", () => {
    expect(
      validateCreateBody({ ...BASE_VALID, tags: ["pci-zone-a", "internet-facing"] }),
    ).toMatchObject({ value: { tags: ["pci-zone-a", "internet-facing"] } });
    expect(
      validateCreateBody({ ...BASE_VALID, tags: "not-an-array" }),
    ).toMatchObject({ error: expect.stringContaining("array") });
    expect(
      validateCreateBody({ ...BASE_VALID, tags: ["a", "b", "c", "d", "e", "f"] }),
    ).toMatchObject({ error: expect.stringContaining("entries") });
    expect(
      validateCreateBody({ ...BASE_VALID, tags: ["x".repeat(25)] }),
    ).toMatchObject({ error: expect.stringContaining("characters") });
    expect(
      validateCreateBody({ ...BASE_VALID, tags: ["bad\x00tag"] }),
    ).toMatchObject({ error: expect.stringContaining("control") });
  });

  it("filters empty tags out without error", () => {
    const r = validateCreateBody({ ...BASE_VALID, tags: ["pci-zone-a", "", "  ", "internet"] });
    expect(r).toMatchObject({ value: { tags: ["pci-zone-a", "internet"] } });
  });
});

describe("validatePatchBody", () => {
  it("accepts a single-field patch", () => {
    expect(validatePatchBody({ version: "2.4.1" })).toMatchObject({
      value: { version: "2.4.1" },
    });
  });

  it("rejects empty patch (no fields to update)", () => {
    expect(validatePatchBody({})).toMatchObject({
      error: expect.stringContaining("at least one"),
    });
  });

  it("rejects patches with required-field-blanking", () => {
    // Patch can omit fields but cannot blank required ones.
    expect(validatePatchBody({ vendor: "" })).toMatchObject({
      error: expect.stringContaining("vendor is required"),
    });
  });

  it("accepts category + environment changes", () => {
    expect(
      validatePatchBody({ category: "library", environment: "staging" }),
    ).toMatchObject({ value: { category: "library", environment: "staging" } });
  });

  it("rejects unknown top-level keys", () => {
    expect(validatePatchBody({ malicious: 1 })).toMatchObject({
      error: expect.stringContaining("unknown"),
    });
  });
});

describe("isValidStackItemId", () => {
  it("accepts a v4-shaped UUID", () => {
    expect(isValidStackItemId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects malformed / hostile shapes", () => {
    for (const bad of [
      "",
      "not-a-uuid",
      "550e8400-e29b-41d4-a716-44665544000",
      "550e8400e29b41d4a716446655440000",
      "../../../etc/passwd",
      "550e8400-e29b-41d4-a716-446655440000; DROP TABLE",
    ]) {
      expect(isValidStackItemId(bad)).toBe(false);
    }
  });
});
