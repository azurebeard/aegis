// Audit-log hash-chain primitives (ADR-0015).
//
// Every audit line carries two SHA-256 hex fields from schemaVersion 2 onwards:
//   prevLineSha256 — lineSha256 of the immediately previous line in the same
//                    (source, tenantId) chain, or the salted genesis sentinel
//                    for the chain head.
//   lineSha256     — SHA-256 of this line's JCS-canonical form (RFC 8785),
//                    with lineSha256 itself excluded from the hash input.
//
// The canonicalisation library is `json-canonicalize` (ADR-0015 §2).
// Hand-rolling RFC 8785 is explicitly rejected; a replacement requires a
// WS10-reviewed ADR pass (ADR-0015 §2 exception process).
//
// All exports here are pure — no I/O, no logging, no clock reads.

import { canonicalize } from "json-canonicalize";
import { createHash } from "node:crypto";

export const CHAIN_SCHEMA_VERSION = 2 as const;
export const CHAIN_SALT_VERSION = "v2" as const;

/** Lowercase hex SHA-256 of a zero-filled 32-byte buffer — a writer that emits
 * this value has forgotten to populate prevLineSha256 (see ADR-0015 §3). */
export const BUFFER_ZERO_SHA256_HEX = "0".repeat(64);

/**
 * Compute the project-salted genesis sentinel for a given (source, tenantId).
 * This is the only legal chain-head value for `prevLineSha256` per ADR-0015 §3.
 */
export function genesisSentinel(source: string, tenantId: string): string {
  if (!source || !tenantId) {
    throw new ChainError(
      "genesis",
      `genesisSentinel requires non-empty source and tenantId`,
    );
  }
  const salt = `aegis:audit-chain:${CHAIN_SALT_VERSION}:${source}:${tenantId}:genesis`;
  return sha256Hex(Buffer.from(salt, "utf-8"));
}

/**
 * Canonicalise an arbitrary JSON object per RFC 8785 / JCS.
 *
 * Delegates to `json-canonicalize`. Returns UTF-8 bytes suitable for hashing.
 */
export function canonicalise(obj: Record<string, unknown>): Buffer {
  const str = canonicalize(obj);
  if (typeof str !== "string") {
    // json-canonicalize is documented to return a string — guard against a
    // surprising dependency upgrade.
    throw new ChainError(
      "canonicalisation",
      `canonicalise: expected string, got ${typeof str}`,
    );
  }
  return Buffer.from(str, "utf-8");
}

/** SHA-256 of arbitrary bytes, rendered as lowercase hex. */
export function hashCanonical(bytes: Buffer): string {
  return sha256Hex(bytes);
}

/**
 * Compute `lineSha256` for an audit line. `lineWithoutHash` is the full line
 * object **except** the `lineSha256` field; `prevLineSha256` MUST already be
 * populated on the object — it is part of the chain binding (ADR-0015 §2 step 3).
 *
 * If the caller accidentally includes `lineSha256` on the input, it is
 * stripped before canonicalisation to keep the function idempotent.
 */
export function computeLineSha256(
  lineWithoutHash: Record<string, unknown>,
): string {
  const clean: Record<string, unknown> = { ...lineWithoutHash };
  delete clean.lineSha256;
  return hashCanonical(canonicalise(clean));
}

/**
 * Resolve the correct `prevLineSha256` to write on the NEXT line, given the
 * stored `LastLineSha256` from the IngestHealth row.
 *
 *   empty / absent    → genesis sentinel (chain initialisation)
 *   sixty-four zeros  → throw: malformed stored state, a prior writer bug
 *   otherwise         → stored value (chain forward)
 *
 * ADR-0015 §3 "Buffer-zero rejection" — emitting sixty-four zeros breaks
 * the verifier's ability to distinguish intent from uninitialised buffer.
 */
export function resolvePrevLineSha256(
  storedLastLineSha256: string | null | undefined,
  source: string,
  tenantId: string,
): string {
  const stored = (storedLastLineSha256 ?? "").trim();
  if (stored === "") {
    return genesisSentinel(source, tenantId);
  }
  if (stored === BUFFER_ZERO_SHA256_HEX) {
    throw new ChainError(
      "buffer_zero",
      `stored LastLineSha256 is sixty-four zeros — malformed writer state for source=${source} tenantId=${tenantId}. ADR-0015 §3 rejects this as a valid chain-link value.`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(stored)) {
    throw new ChainError(
      "malformed_hash",
      `stored LastLineSha256 is not lowercase 64-char hex: len=${stored.length}`,
    );
  }
  return stored;
}

/**
 * Build an `audit.chain.start` boundary-marker line body (ADR-0015 §3a).
 * Caller stamps the `lineSha256` using `computeLineSha256` and writes to the
 * audit blob. Used by `scripts/write-audit-chain-boundary.mjs` on forward-only
 * migration for sources that already carry pre-chain schemaVersion:1 lines.
 */
export interface ChainBoundaryInput {
  readonly source: string;
  readonly tenantId: string;
  readonly seq: number;
  readonly startedAt: string; // ISO8601 UTC
  readonly priorLineCount: number;
  readonly callerPrincipalMiClientId: string;
  readonly reason?: string; // default: "chain-introduced"
}

export function buildChainBoundaryLine(
  input: ChainBoundaryInput,
): Record<string, unknown> {
  return {
    schemaVersion: CHAIN_SCHEMA_VERSION,
    eventType: "audit.chain.start",
    source: input.source,
    tenantId: input.tenantId,
    seq: input.seq,
    startedAt: input.startedAt,
    reason: input.reason ?? "chain-introduced",
    priorLineCount: input.priorLineCount,
    callerPrincipalMiClientId: input.callerPrincipalMiClientId,
    prevLineSha256: genesisSentinel(input.source, input.tenantId),
  };
}

/**
 * Build an `ingest.audit.repair` line body (ADR-0015 §Negative / "Audit-write
 * failure asymmetry"). Emitted when the ingest handler detects that
 * `IngestHealth.LastLineSha256` is ahead of the last on-disk line for this
 * chain — a gap from a prior failed audit append. The chain resumes from the
 * repair line; automatic re-genesis is forbidden.
 */
export interface ChainRepairInput {
  readonly source: string;
  readonly tenantId: string;
  readonly seq: number;
  readonly startedAt: string;
  readonly priorOnDiskLineSha256: string;
  readonly expectedLineSha256: string;
  readonly callerPrincipalMiClientId: string;
  readonly reason?: string; // default: "audit-write-gap"
}

export function buildChainRepairLine(
  input: ChainRepairInput,
): Record<string, unknown> {
  if (input.priorOnDiskLineSha256 === BUFFER_ZERO_SHA256_HEX) {
    throw new ChainError(
      "buffer_zero",
      `priorOnDiskLineSha256 is sixty-four zeros — cannot emit a repair chaining off malformed state`,
    );
  }
  return {
    schemaVersion: CHAIN_SCHEMA_VERSION,
    eventType: "ingest.audit.repair",
    source: input.source,
    tenantId: input.tenantId,
    seq: input.seq,
    startedAt: input.startedAt,
    reason: input.reason ?? "audit-write-gap",
    priorOnDiskLineSha256: input.priorOnDiskLineSha256,
    expectedLineSha256: input.expectedLineSha256,
    callerPrincipalMiClientId: input.callerPrincipalMiClientId,
    prevLineSha256: input.priorOnDiskLineSha256,
  };
}

export class ChainError extends Error {
  readonly kind:
    | "genesis"
    | "canonicalisation"
    | "buffer_zero"
    | "malformed_hash"
    | "internal";
  constructor(kind: ChainError["kind"], message: string) {
    super(message);
    this.name = "ChainError";
    this.kind = kind;
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
