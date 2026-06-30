// Unit tests for brandingLogo lib — ADR-0029 Phase B §Decision.5 magic-byte
// gate. Verifies the canonical-signature acceptances and the mismatch
// rejections. Critically asserts the PNG full-8-byte signature per WS10
// F1 resolution (4-byte prefix is insufficient — CR/LF-mutated PNG passes
// prefix but is a broken file downstream).

import { describe, expect, it } from "vitest";
import {
  isAllowedLogoContentType,
  isWithinLogoSizeCap,
  validateLogoMagicBytes,
} from "../src/lib/brandingLogo.js";
import { LOGO_MAX_BYTES } from "../src/lib/tenantSettingsStore.js";

// Canonical signature fixtures.
const PNG_FULL = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  // A few trailing bytes so the signature isn't the whole body.
  0x00, 0x00, 0x00, 0x0d,
]);

const PNG_FOUR_BYTE_PREFIX_ONLY = Buffer.from([
  // Four bytes `89 50 4E 47` match (legacy weaker check), then a CR/LF-
  // transport-mutation: `20 20 1A 20` instead of `0D 0A 1A 0A`. Real-world
  // FTP-ASCII-mode corruption pattern.
  0x89, 0x50, 0x4e, 0x47, 0x20, 0x20, 0x1a, 0x20, 0x00, 0x00, 0x00, 0x0d,
]);

const JPEG_JFIF = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

const WEBP_VALID = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x20]), // dummy size bytes
  Buffer.from("WEBP", "ascii"),
  Buffer.alloc(8), // filler
]);

const WEBP_WITHOUT_FOURCC = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from("OGG ", "ascii"), // not WEBP
  Buffer.alloc(8),
]);

describe("isAllowedLogoContentType", () => {
  it("accepts the three canonical MIME types", () => {
    expect(isAllowedLogoContentType("image/png")).toBe(true);
    expect(isAllowedLogoContentType("image/jpeg")).toBe(true);
    expect(isAllowedLogoContentType("image/webp")).toBe(true);
  });

  it("rejects SVG (deliberately excluded — §Decision.5)", () => {
    expect(isAllowedLogoContentType("image/svg+xml")).toBe(false);
  });

  it("rejects gif (plausible but not in the allowlist)", () => {
    expect(isAllowedLogoContentType("image/gif")).toBe(false);
  });

  it("rejects prompt-injection masquerades", () => {
    expect(isAllowedLogoContentType("")).toBe(false);
    expect(isAllowedLogoContentType("text/html")).toBe(false);
    expect(isAllowedLogoContentType("application/pdf")).toBe(false);
  });
});

describe("validateLogoMagicBytes — PNG", () => {
  it("accepts the full 8-byte PNG signature", () => {
    expect(validateLogoMagicBytes(PNG_FULL, "image/png")).toBe(true);
  });

  it("REJECTS a body with only the 4-byte prefix (WS10 F1 — CR/LF mutation)", () => {
    expect(validateLogoMagicBytes(PNG_FOUR_BYTE_PREFIX_ONLY, "image/png")).toBe(
      false,
    );
  });

  it("rejects JPEG body claimed as PNG (content-type lie)", () => {
    expect(validateLogoMagicBytes(JPEG_JFIF, "image/png")).toBe(false);
  });

  it("rejects a body too short to hold the full signature", () => {
    expect(validateLogoMagicBytes(Buffer.from([0x89, 0x50]), "image/png")).toBe(false);
  });
});

describe("validateLogoMagicBytes — JPEG", () => {
  it("accepts the JFIF 3-byte SOI sequence", () => {
    expect(validateLogoMagicBytes(JPEG_JFIF, "image/jpeg")).toBe(true);
  });

  it("rejects PNG body claimed as JPEG", () => {
    expect(validateLogoMagicBytes(PNG_FULL, "image/jpeg")).toBe(false);
  });

  it("rejects a body too short to hold the 3-byte signature", () => {
    expect(validateLogoMagicBytes(Buffer.from([0xff]), "image/jpeg")).toBe(false);
  });
});

describe("validateLogoMagicBytes — WebP", () => {
  it("accepts a body with RIFF at 0 + WEBP at 8", () => {
    expect(validateLogoMagicBytes(WEBP_VALID, "image/webp")).toBe(true);
  });

  it("rejects a RIFF body with a different fourCC (e.g. OGG)", () => {
    expect(validateLogoMagicBytes(WEBP_WITHOUT_FOURCC, "image/webp")).toBe(false);
  });

  it("rejects a body too short to hold the RIFF + fourCC discriminator", () => {
    const shortBuf = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4)]);
    expect(validateLogoMagicBytes(shortBuf, "image/webp")).toBe(false);
  });

  it("rejects PNG body claimed as WebP", () => {
    expect(validateLogoMagicBytes(PNG_FULL, "image/webp")).toBe(false);
  });
});

describe("validateLogoMagicBytes — cross-type denial", () => {
  it("denies an SVG-with-script payload even if somehow declared as PNG", () => {
    const svgWithScript = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "utf-8",
    );
    expect(validateLogoMagicBytes(svgWithScript, "image/png")).toBe(false);
    expect(validateLogoMagicBytes(svgWithScript, "image/jpeg")).toBe(false);
    expect(validateLogoMagicBytes(svgWithScript, "image/webp")).toBe(false);
  });

  it("denies an arbitrary binary blob declared as any allowed type", () => {
    const garbage = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22]);
    expect(validateLogoMagicBytes(garbage, "image/png")).toBe(false);
    expect(validateLogoMagicBytes(garbage, "image/jpeg")).toBe(false);
    expect(validateLogoMagicBytes(garbage, "image/webp")).toBe(false);
  });
});

describe("isWithinLogoSizeCap", () => {
  it("rejects zero-length", () => {
    expect(isWithinLogoSizeCap(0)).toBe(false);
  });

  it("accepts a positive-length body up to the cap", () => {
    expect(isWithinLogoSizeCap(1)).toBe(true);
    expect(isWithinLogoSizeCap(LOGO_MAX_BYTES)).toBe(true);
  });

  it("rejects one byte over the cap", () => {
    expect(isWithinLogoSizeCap(LOGO_MAX_BYTES + 1)).toBe(false);
  });
});
