// Branding-logo upload hygiene (ADR-0029 Phase B §Decision.5).
//
// Three-check contract at the upload handler. Checks 1 and 2 are declarations
// the polite client makes and we short-circuit on; check 3 is the
// authoritative gate — it re-validates the declared content-type against the
// first bytes of the uploaded body so a client claiming `image/png` but
// shipping JPEG (or an SVG with `<script>`, or an arbitrary binary) is
// rejected before the blob is written:
//
//   1. `Content-Length` ≤ 1 MB → 413 otherwise.
//   2. `Content-Type` ∈ {image/png, image/webp, image/jpeg} → 415 otherwise.
//   3. Magic bytes match the declared type → 415 otherwise.
//
// PNG uses the full 8-byte signature per W3C PNG 2nd Ed §5.2 (WS10
// SEC-F1-ADR29 resolution: 4 bytes is insufficient — a CR/LF-transport-
// mutated PNG passes the 4-byte prefix but is a broken file downstream).
// JPEG uses the 3-byte JFIF convention (matches libmagic). WebP uses the
// RIFF/WEBP discriminator at offsets 0 and 8 per the WebP Container Spec.
//
// SVG is deliberately excluded — safe inclusion requires server-side
// DOMPurify-style sanitisation + CSP-`script-src: none` on the served
// content, a non-trivial expansion deferred to a future Phase (ADR-0029
// §Decision.5).

import {
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  type LogoContentType,
} from "./tenantSettingsStore.js";

const LOGO_CONTENT_TYPE_SET = new Set<string>(LOGO_CONTENT_TYPES);

/** PNG 8-byte signature per W3C PNG §5.2. */
const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** JPEG 3-byte SOI + JFIF convention. */
const JPEG_SIGNATURE = new Uint8Array([0xff, 0xd8, 0xff]);

/** WebP — RIFF at offset 0 (4 bytes) + WEBP at offset 8 (4 bytes).
 *  Bytes 4..7 are the file-size little-endian header — not discriminating. */
const WEBP_RIFF = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
const WEBP_FOURCC = new Uint8Array([0x57, 0x45, 0x42, 0x50]); // "WEBP"

/**
 * Check that the declared content-type is one of the three allowed logo
 * MIME types. Exported so the caller can emit a deterministic 415 error
 * message before attempting magic-byte validation.
 */
export function isAllowedLogoContentType(ct: string): ct is LogoContentType {
  return LOGO_CONTENT_TYPE_SET.has(ct);
}

/**
 * Validate the uploaded body's first bytes against the declared
 * content-type. Returns `true` when the signature matches; `false` when
 * it doesn't or the body is too short to even hold the signature.
 *
 * Does NOT trust the declared content-type itself — caller must have
 * already verified it via `isAllowedLogoContentType`. This function
 * answers only "do the bytes match what the client claimed".
 */
export function validateLogoMagicBytes(
  body: Buffer | Uint8Array,
  declaredContentType: LogoContentType,
): boolean {
  const bytes = body instanceof Buffer ? body : Buffer.from(body);
  switch (declaredContentType) {
    case "image/png":
      return startsWith(bytes, PNG_SIGNATURE);
    case "image/jpeg":
      return startsWith(bytes, JPEG_SIGNATURE);
    case "image/webp":
      // RIFF at offset 0 + WEBP at offset 8. Size header (offsets 4–7) is
      // intentionally not checked — it's a dynamic file-size value, not
      // part of the container discriminator.
      return (
        bytes.length >= 12 &&
        startsWith(bytes, WEBP_RIFF) &&
        startsWithAt(bytes, WEBP_FOURCC, 8)
      );
  }
}

/**
 * Size-cap gate. Call AFTER reading the body (since Content-Length may be
 * absent under chunked encoding) AND as an early reject from the header
 * value (so polite clients bail before uploading 1GB of junk).
 */
export function isWithinLogoSizeCap(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= LOGO_MAX_BYTES;
}

function startsWith(haystack: Buffer, needle: Uint8Array): boolean {
  if (haystack.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[i] !== needle[i]) return false;
  }
  return true;
}

function startsWithAt(haystack: Buffer, needle: Uint8Array, offset: number): boolean {
  if (haystack.length < offset + needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}
