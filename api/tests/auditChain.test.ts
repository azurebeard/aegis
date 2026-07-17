import { describe, it, expect } from "vitest";
import {
  BUFFER_ZERO_SHA256_HEX,
  buildChainBoundaryLine,
  buildChainRepairLine,
  canonicalise,
  CHAIN_SCHEMA_VERSION,
  ChainError,
  computeLineSha256,
  genesisSentinel,
  hashCanonical,
  resolvePrevLineSha256,
} from "../src/lib/auditChain.js";

describe("genesisSentinel", () => {
  it("is a 64-char lowercase-hex string", () => {
    const g = genesisSentinel("graph.security.incidents", "tenant-123");
    expect(g).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for identical inputs", () => {
    const a = genesisSentinel("graph.security.incidents", "t-1");
    const b = genesisSentinel("graph.security.incidents", "t-1");
    expect(a).toBe(b);
  });

  it("differs between sources", () => {
    expect(genesisSentinel("graph.security.incidents", "t-1")).not.toBe(
      genesisSentinel("graph.security.secureScores", "t-1"),
    );
  });

  it("differs between tenants", () => {
    expect(genesisSentinel("graph.security.incidents", "t-1")).not.toBe(
      genesisSentinel("graph.security.incidents", "t-2"),
    );
  });

  it("does not collide with buffer-zero (ADR-0015 §3 — distinguishable sentinel)", () => {
    const g = genesisSentinel("graph.security.incidents", "tenant");
    expect(g).not.toBe(BUFFER_ZERO_SHA256_HEX);
  });

  it("throws on empty source or tenantId", () => {
    expect(() => genesisSentinel("", "t")).toThrow(ChainError);
    expect(() => genesisSentinel("s", "")).toThrow(ChainError);
  });
});

describe("canonicalise + hashCanonical (RFC 8785 delegation)", () => {
  it("sorts keys by UTF-16 code-unit order", () => {
    const a = canonicalise({ b: 1, a: 2 });
    const b = canonicalise({ a: 2, b: 1 });
    expect(a.toString("utf-8")).toBe(b.toString("utf-8"));
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it("produces stable lineSha256 regardless of key order", () => {
    const aHash = computeLineSha256({ b: 1, a: 2 });
    const bHash = computeLineSha256({ a: 2, b: 1 });
    expect(aHash).toBe(bHash);
  });

  it("computeLineSha256 drops lineSha256 from input (idempotence)", () => {
    const base = { a: 1, b: 2 };
    const hash = computeLineSha256(base);
    const withHash = computeLineSha256({ ...base, lineSha256: "whatever" });
    expect(hash).toBe(withHash);
  });

  it("different payloads produce different hashes", () => {
    expect(computeLineSha256({ a: 1 })).not.toBe(computeLineSha256({ a: 2 }));
  });
});

describe("resolvePrevLineSha256", () => {
  it("returns genesis sentinel for empty stored value", () => {
    const expected = genesisSentinel("graph.security.incidents", "t-1");
    expect(resolvePrevLineSha256("", "graph.security.incidents", "t-1")).toBe(expected);
    expect(resolvePrevLineSha256(null, "graph.security.incidents", "t-1")).toBe(expected);
    expect(resolvePrevLineSha256(undefined, "graph.security.incidents", "t-1")).toBe(expected);
    expect(resolvePrevLineSha256("   ", "graph.security.incidents", "t-1")).toBe(expected);
  });

  it("returns stored value when it is a valid 64-char hex", () => {
    const fake = "a".repeat(64);
    expect(resolvePrevLineSha256(fake, "s", "t")).toBe(fake);
  });

  it("throws ChainError(buffer_zero) for sixty-four zeros", () => {
    expect(() => resolvePrevLineSha256(BUFFER_ZERO_SHA256_HEX, "s", "t")).toThrow(ChainError);
    try {
      resolvePrevLineSha256(BUFFER_ZERO_SHA256_HEX, "s", "t");
    } catch (err) {
      expect((err as ChainError).kind).toBe("buffer_zero");
    }
  });

  it("throws ChainError(malformed_hash) for non-hex / wrong-length inputs", () => {
    expect(() => resolvePrevLineSha256("not-hex", "s", "t")).toThrow(ChainError);
    expect(() => resolvePrevLineSha256("abc", "s", "t")).toThrow(ChainError);
    // Uppercase is rejected per the lowercase-hex convention.
    expect(() => resolvePrevLineSha256("A".repeat(64), "s", "t")).toThrow(ChainError);
  });
});

describe("buildChainBoundaryLine (ADR-0015 §3a)", () => {
  it("emits schemaVersion:2 and eventType audit.chain.start", () => {
    const line = buildChainBoundaryLine({
      source: "graph.security.secureScores",
      tenantId: "t-1",
      seq: 42,
      startedAt: "2026-04-19T00:00:00.000Z",
      priorLineCount: 41,
      callerPrincipalMiClientId: "mi-1",
    });
    expect(line.schemaVersion).toBe(CHAIN_SCHEMA_VERSION);
    expect(line.eventType).toBe("audit.chain.start");
    expect(line.prevLineSha256).toBe(genesisSentinel("graph.security.secureScores", "t-1"));
  });

  it("defaults reason to chain-introduced", () => {
    const line = buildChainBoundaryLine({
      source: "s",
      tenantId: "t",
      seq: 1,
      startedAt: "2026-04-19T00:00:00.000Z",
      priorLineCount: 0,
      callerPrincipalMiClientId: "mi",
    });
    expect(line.reason).toBe("chain-introduced");
  });
});

describe("buildChainRepairLine (ADR-0015 §Negative)", () => {
  it("chains off priorOnDiskLineSha256 (not genesis)", () => {
    const prior = "b".repeat(64);
    const line = buildChainRepairLine({
      source: "s",
      tenantId: "t",
      seq: 5,
      startedAt: "2026-04-19T00:00:00.000Z",
      priorOnDiskLineSha256: prior,
      expectedLineSha256: "c".repeat(64),
      callerPrincipalMiClientId: "mi",
    });
    expect(line.prevLineSha256).toBe(prior);
    expect(line.eventType).toBe("ingest.audit.repair");
  });

  it("rejects sixty-four-zero priorOnDiskLineSha256 (ADR-0015 §3 buffer-zero rule)", () => {
    expect(() =>
      buildChainRepairLine({
        source: "s",
        tenantId: "t",
        seq: 5,
        startedAt: "2026-04-19T00:00:00.000Z",
        priorOnDiskLineSha256: BUFFER_ZERO_SHA256_HEX,
        expectedLineSha256: "c".repeat(64),
        callerPrincipalMiClientId: "mi",
      }),
    ).toThrow(ChainError);
  });
});

describe("end-to-end chain forward-integrity", () => {
  it("line N+1's prevLineSha256 == line N's lineSha256", () => {
    const lineN = {
      schemaVersion: 2,
      eventType: "ingest.run",
      source: "graph.security.incidents",
      seq: 7,
      tenantId: "t-1",
      startedAt: "2026-04-19T00:00:00.000Z",
      prevLineSha256: genesisSentinel("graph.security.incidents", "t-1"),
      callerPrincipalMiClientId: "mi-1",
    };
    const hashN = computeLineSha256(lineN);
    const lineNPlus1 = {
      schemaVersion: 2,
      eventType: "ingest.run",
      source: "graph.security.incidents",
      seq: 8,
      tenantId: "t-1",
      startedAt: "2026-04-19T00:15:00.000Z",
      prevLineSha256: hashN,
      callerPrincipalMiClientId: "mi-1",
    };
    const hashNPlus1 = computeLineSha256(lineNPlus1);
    // Mutating line N should break the chain — every verifier that recomputes
    // hash N sees a mismatch.
    const mutated = { ...lineN, startedAt: "2026-04-19T00:00:00.001Z" };
    expect(computeLineSha256(mutated)).not.toBe(hashN);
    // Sanity: the N+1 line's own hash is deterministic and depends on the
    // bound prev hash.
    expect(hashNPlus1).toMatch(/^[0-9a-f]{64}$/);
  });
});
