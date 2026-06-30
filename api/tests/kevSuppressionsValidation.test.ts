// ADR-0033 — body + path validators for KEV suppression PATCH/DELETE.

import { describe, expect, it } from "vitest";
import {
  isValidCveID,
  validateSuppressionPatchBody,
  validateSuppressionPath,
} from "../src/lib/kevSuppressionsValidation.js";

describe("isValidCveID", () => {
  it("accepts well-formed CVE IDs (4–7 sequence digits)", () => {
    expect(isValidCveID("CVE-2024-12345")).toBe(true);
    expect(isValidCveID("CVE-2024-1234")).toBe(true);
    expect(isValidCveID("CVE-2024-1234567")).toBe(true);
  });

  it("rejects malformed / hostile shapes", () => {
    for (const bad of [
      "",
      "CVE-2024-123",         // too short sequence
      "CVE-2024-12345678",    // too long sequence
      "CVE-24-12345",         // year too short
      "cve-2024-12345",       // lowercase
      "CVE-2024-ABCDE",       // non-digit
      "../../../etc",
      "CVE-2024-12345; DROP",
    ]) {
      expect(isValidCveID(bad)).toBe(false);
    }
  });
});

describe("validateSuppressionPath", () => {
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
  const VALID_CVE = "CVE-2024-12345";

  it("accepts valid (UUID, CVE) pair", () => {
    expect(validateSuppressionPath(VALID_UUID, VALID_CVE)).toEqual({ ok: true });
  });

  it("rejects bad UUID", () => {
    expect(validateSuppressionPath("not-a-uuid", VALID_CVE)).toMatchObject({
      error: expect.stringContaining("UUID"),
    });
  });

  it("rejects bad CVE-ID", () => {
    expect(validateSuppressionPath(VALID_UUID, "CVE-bad")).toMatchObject({
      error: expect.stringContaining("CVE-YYYY"),
    });
  });
});

describe("validateSuppressionPatchBody", () => {
  it("accepts a minimal status-only body", () => {
    expect(validateSuppressionPatchBody({ status: "acknowledged" })).toMatchObject({
      value: { status: "acknowledged", notes: "", expiresAt: "" },
    });
  });

  it("accepts notes + ISO datetime expiresAt", () => {
    expect(
      validateSuppressionPatchBody({
        status: "acknowledged",
        notes: "Patching tomorrow",
        expiresAt: "2026-05-15T00:00:00Z",
      }),
    ).toMatchObject({
      value: {
        status: "acknowledged",
        notes: "Patching tomorrow",
        expiresAt: "2026-05-15T00:00:00Z",
      },
    });
  });

  it("accepts ISO date-only expiresAt", () => {
    expect(
      validateSuppressionPatchBody({ status: "risk_accepted", expiresAt: "2026-12-31" }),
    ).toMatchObject({ value: { expiresAt: "2026-12-31" } });
  });

  it("rejects body that isn't a JSON object", () => {
    for (const bad of [null, "string", 42, [], true]) {
      expect(validateSuppressionPatchBody(bad)).toMatchObject({
        error: expect.stringContaining("object"),
      });
    }
  });

  it("rejects unknown top-level fields", () => {
    expect(
      validateSuppressionPatchBody({ status: "open", sneaky: "bad" }),
    ).toMatchObject({ error: expect.stringContaining("unknown") });
  });

  it("rejects unknown status values", () => {
    expect(validateSuppressionPatchBody({ status: "DROP TABLE" })).toMatchObject({
      error: expect.stringContaining("status"),
    });
    expect(validateSuppressionPatchBody({ status: "" })).toMatchObject({
      error: expect.stringContaining("status"),
    });
  });

  it("enforces notes length cap", () => {
    expect(
      validateSuppressionPatchBody({ status: "open", notes: "x".repeat(257) }),
    ).toMatchObject({ error: expect.stringContaining("characters or fewer") });
  });

  it("rejects control chars in notes", () => {
    expect(
      validateSuppressionPatchBody({ status: "open", notes: "bad\x00null" }),
    ).toMatchObject({ error: expect.stringContaining("control") });
  });

  it("admits tab/newline in notes (multi-line operator context)", () => {
    expect(
      validateSuppressionPatchBody({
        status: "acknowledged",
        notes: "line one\nline two\twith tab",
      }),
    ).toMatchObject({ value: { notes: "line one\nline two\twith tab" } });
  });

  it("rejects malformed expiresAt at the regex layer", () => {
    // Regex-malformed: doesn't match ISO-8601 shape at all → "ISO-8601" error.
    for (const bad of ["yesterday", "2026/05/15", "not-a-date"]) {
      expect(
        validateSuppressionPatchBody({ status: "open", expiresAt: bad }),
      ).toMatchObject({ error: expect.stringContaining("ISO-8601") });
    }
  });

  it("rejects unparseable date even when ISO-shaped (e.g. month 13)", () => {
    // Regex passes (\\d{2}) but Date.parse rejects → second-layer reject
    // with the "not a parseable date" message.
    expect(
      validateSuppressionPatchBody({ status: "open", expiresAt: "2026-13-01" }),
    ).toMatchObject({ error: expect.stringContaining("parseable") });
  });
});
