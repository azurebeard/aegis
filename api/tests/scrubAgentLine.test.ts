// Tests for audit.ts §scrubAgentLine (ADR-0021 §Decision.4 redaction)
// + §sanitiseExtraAuditFields (SEC-OBS-B4-02 shape gate).

import { describe, it, expect } from "vitest";
import { sanitiseExtraAuditFields, scrubAgentLine } from "../src/lib/audit.js";
import { computeLineSha256 } from "../src/lib/auditChain.js";

describe("scrubAgentLine — allowlist", () => {
  it("strips unknown keys", () => {
    const input = {
      schemaVersion: 2,
      eventType: "agent.run",
      source: "agent.aegis.brief",
      seq: 1,
      tenantId: "t1",
      callerPrincipalMiClientId: "mi-1",
      prevLineSha256: "abc",
      lineSha256: "def",
      // Unknown — must be stripped:
      attackPayload: "secret",
      randomMetadata: { x: 1 },
    };
    const out = scrubAgentLine(input);
    expect(Object.keys(out).sort()).not.toContain("attackPayload");
    expect(Object.keys(out).sort()).not.toContain("randomMetadata");
    expect(out.eventType).toBe("agent.run");
  });

  it("does not allow __proto__ pollution", () => {
    const malicious = JSON.parse(
      '{"__proto__":{"polluted":true},"schemaVersion":2,"eventType":"agent.run","source":"x","seq":1,"tenantId":"t","callerPrincipalMiClientId":"mi","prevLineSha256":"a","lineSha256":"b"}',
    ) as Record<string, unknown>;
    const out = scrubAgentLine(malicious);
    // Output is null-prototype; "polluted" should NOT appear via prototype
    // chain, AND the __proto__ key was filtered (not in allowlist).
    expect((out as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(null);
  });
});

describe("scrubAgentLine — credential pattern redaction", () => {
  it("redacts JWT-shaped strings", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "t",
      callerPrincipalMiClientId: "eyJabc1234567890.payload",
      prevLineSha256: "a",
      lineSha256: "b",
    });
    expect(out.callerPrincipalMiClientId).toBe("[REDACTED]");
  });

  it("redacts Bearer-prefixed strings", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "t",
      callerPrincipalMiClientId: "Bearer abc.def.ghi",
      prevLineSha256: "a",
      lineSha256: "b",
    });
    expect(out.callerPrincipalMiClientId).toBe("[REDACTED]");
  });

  it("redacts PEM block markers", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "-----BEGIN RSA PRIVATE KEY-----",
      callerPrincipalMiClientId: "mi",
      prevLineSha256: "a",
      lineSha256: "b",
    });
    expect(out.tenantId).toBe("[REDACTED]");
  });

  it("redacts long hex (32+) strings", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "deadbeefdeadbeefdeadbeefdeadbeef",
      callerPrincipalMiClientId: "mi",
      prevLineSha256: "a",
      lineSha256: "b",
    });
    expect(out.tenantId).toBe("[REDACTED]");
  });

  it("preserves benign strings", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "agent.aegis.brief",
      seq: 1,
      tenantId: "tenant-uuid-123",
      callerPrincipalMiClientId: "mi-abc-456",
      prevLineSha256: "a",
      lineSha256: "b",
    });
    expect(out.tenantId).toBe("tenant-uuid-123");
    expect(out.callerPrincipalMiClientId).toBe("mi-abc-456");
  });
});

describe("scrubAgentLine — recursion through nested objects + arrays", () => {
  it("recurses into nested error.message", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "t",
      callerPrincipalMiClientId: "mi",
      prevLineSha256: "a",
      lineSha256: "b",
      error: {
        kind: "internal",
        message: "Bearer abc.def.ghi exposed",
      },
    });
    const e = out.error as Record<string, unknown>;
    expect(e.message).toBe("[REDACTED]");
    expect(e.kind).toBe("internal");
  });

  it("recurses into arrays", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "t",
      callerPrincipalMiClientId: "mi",
      prevLineSha256: "a",
      lineSha256: "b",
      sourcesUsed: ["secureScore.latest", "deadbeefdeadbeefdeadbeefdeadbeef", "incidents.summary"],
    });
    const arr = out.sourcesUsed as string[];
    expect(arr[0]).toBe("secureScore.latest");
    expect(arr[1]).toBe("[REDACTED]");
    expect(arr[2]).toBe("incidents.summary");
  });
});

describe("scrubAgentLine — chain-integrity field allowlist (SEC-FD-AUDIT-CHAIN-01)", () => {
  // SHA-256 digests always print as 64 hex chars — they MUST survive the
  // long-hex credential regex, or the verifier's cross-line chain walk
  // fails against every agent audit line on disk.
  const SHA64 = "a".repeat(64);
  const SHA64_B = "f".repeat(64);
  const SHA64_C = "0123456789abcdef".repeat(4);

  it("preserves prevLineSha256 (64-hex value survives credential regex)", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "t",
      callerPrincipalMiClientId: "mi",
      prevLineSha256: SHA64,
      lineSha256: "b",
    });
    expect(out.prevLineSha256).toBe(SHA64);
  });

  it("preserves lineSha256 (64-hex value survives credential regex)", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "t",
      callerPrincipalMiClientId: "mi",
      prevLineSha256: "a",
      lineSha256: SHA64_B,
    });
    expect(out.lineSha256).toBe(SHA64_B);
  });

  it("preserves outputSha256 (64-hex value survives credential regex)", () => {
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "t",
      callerPrincipalMiClientId: "mi",
      outputSha256: SHA64_C,
      prevLineSha256: "a",
      lineSha256: "b",
    });
    expect(out.outputSha256).toBe(SHA64_C);
  });

  it("still redacts 32+-hex values on non-chain keys (tenantId, callerPrincipalMiClientId)", () => {
    // Regression belt-and-braces: allowlist is key-scoped, not global —
    // long-hex anywhere else still triggers redaction.
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "x",
      seq: 1,
      tenantId: "deadbeefdeadbeefdeadbeefdeadbeef",
      callerPrincipalMiClientId: SHA64,
      prevLineSha256: SHA64,
      lineSha256: SHA64,
    });
    expect(out.tenantId).toBe("[REDACTED]");
    expect(out.callerPrincipalMiClientId).toBe("[REDACTED]");
    expect(out.prevLineSha256).toBe(SHA64);
    expect(out.lineSha256).toBe(SHA64);
  });

  it("boundary case: pre-fix predecessor with real-hex lineSha256 still yields a clean post-fix successor (SEC-L-AUDIT-CHAIN-01)", () => {
    // Pre-fix writers always RE-APPENDED `lineSha256` as real hex after
    // scrubbing (`finalLine = { ...scrubbed, lineSha256 }` in
    // runAgent.ts + runBriefAgent.ts + runPostureAgent.ts). So a
    // pre-fix-era audit line on disk has:
    //   prevLineSha256: "[REDACTED]"  ← over-redacted (pre-fix bug)
    //   lineSha256:     "<real hex>"  ← re-appended post-scrub
    //
    // First post-fix line after deploy consumes the prior on-disk
    // lineSha256 as its new prevLineSha256. That hex MUST survive the
    // scrubber verbatim or the chain restart is immediately broken. This
    // is the production first-run-after-deploy scenario, so the test
    // case asserts it explicitly.
    const preFixLineSha = "a".repeat(64);
    const successor = scrubAgentLine({
      schemaVersion: 2,
      eventType: "agent.run",
      source: "agent.aegis.brief",
      seq: 42,
      tenantId: "t",
      callerPrincipalMiClientId: "mi",
      prevLineSha256: preFixLineSha,
      lineSha256: "b",
    });
    expect(successor.prevLineSha256).toBe(preFixLineSha);
  });

  it("three-line chain-walk invariant: line-N prevLineSha256 equals line-(N-1) lineSha256 on disk", () => {
    // End-to-end reconstruction of the chain-walk that
    // `scripts/verify-audit-chain.mjs` performs.
    //
    // Pre-fix behaviour: scrubAgentLine redacted both hash fields on
    // disk. The per-line hash re-compute still verified (hash was taken
    // AFTER the scrub), but the cross-line comparison
    //   current.prevLineSha256 === previous.lineSha256
    // always failed because `current.prevLineSha256` was `"[REDACTED]"`
    // while `previous.lineSha256` was the real hex value (re-appended
    // to the line AFTER scrub by the audit writer).
    //
    // Post-fix: both fields survive the scrub; the chain walks cleanly.
    type Line = Record<string, unknown> & {
      lineSha256: string;
      prevLineSha256: string;
      seq: number;
    };
    const base = {
      schemaVersion: 2 as const,
      eventType: "agent.run" as const,
      source: "agent.aegis.posture",
      tenantId: "tenant-guid",
      callerPrincipalMiClientId: "mi-agent",
      startedAt: "2026-04-20T00:00:00.000Z",
      status: "success" as const,
    };
    const writeLine = (seq: number, prev: string): Line => {
      const lineRaw: Record<string, unknown> = {
        ...base,
        seq,
        prevLineSha256: prev,
      };
      const scrubbed = scrubAgentLine(lineRaw);
      const lineSha256 = computeLineSha256(scrubbed);
      return { ...scrubbed, lineSha256 } as Line;
    };
    // Use a synthetic genesis — verifier treats the first line's
    // prevLineSha256 specially (genesis sentinel acceptance), so the
    // invariant we care about is between lines 2↔1 and 3↔2.
    const genesis = SHA64;
    const line1 = writeLine(1, genesis);
    const line2 = writeLine(2, line1.lineSha256);
    const line3 = writeLine(3, line2.lineSha256);

    expect(line1.prevLineSha256).toBe(genesis); // survives scrub
    expect(line2.prevLineSha256).toBe(line1.lineSha256);
    expect(line3.prevLineSha256).toBe(line2.lineSha256);

    // None of the chain hashes got redacted:
    for (const line of [line1, line2, line3]) {
      expect(line.prevLineSha256).not.toBe("[REDACTED]");
      expect(line.lineSha256).not.toBe("[REDACTED]");
      expect(line.lineSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe("sanitiseExtraAuditFields — SEC-OBS-B4-02 shape gate", () => {
  it("returns an empty object when input is undefined", () => {
    expect(sanitiseExtraAuditFields(undefined)).toEqual({});
  });

  it("returns an empty object when input is empty", () => {
    expect(sanitiseExtraAuditFields({})).toEqual({});
  });

  it("passes through a well-formed redactedFields string array", () => {
    expect(
      sanitiseExtraAuditFields({ redactedFields: ["alertTitle", "description"] }),
    ).toEqual({ redactedFields: ["alertTitle", "description"] });
  });

  it("drops redactedFields when the value is not an array", () => {
    expect(
      sanitiseExtraAuditFields({ redactedFields: "alertTitle,description" }),
    ).toEqual({});
  });

  it("drops redactedFields when any element is not a string", () => {
    expect(
      sanitiseExtraAuditFields({ redactedFields: ["alertTitle", 42] }),
    ).toEqual({});
  });

  it("drops redactedFields when an element is an empty string", () => {
    // Defence-in-depth: empty field names can't represent a real redaction
    // and would corrupt observability queries that filter on non-empty.
    expect(sanitiseExtraAuditFields({ redactedFields: ["valid", ""] })).toEqual({});
  });

  it("drops keys not in AGENT_LINE_ALLOWED_KEYS", () => {
    // The shape gate fails closed on unknown keys — same discipline as
    // scrubAgentLine on the line level.
    expect(
      sanitiseExtraAuditFields({ attackerKey: "payload", arbitrary: 123 }),
    ).toEqual({});
  });

  it("drops allowlisted keys that lack a shape rule (default branch)", () => {
    // `status` is in AGENT_LINE_ALLOWED_KEYS but is canonical-fields
    // territory — adapters should never supply it via extraAuditFields.
    // The default branch drops such keys so a rogue adapter can't
    // clobber the canonical `status` via the extra-fields slot.
    expect(sanitiseExtraAuditFields({ status: "success" })).toEqual({});
  });

  it("preserves an empty redactedFields array (valid — means 'no fields redacted')", () => {
    expect(sanitiseExtraAuditFields({ redactedFields: [] })).toEqual({
      redactedFields: [],
    });
  });
});

describe("scrubAgentLine — SEC-OBS-AUDIT-CHAIN-02 repair-line allowlist", () => {
  // Preventive: repair lines (eventType: "ingest.audit.repair", ADR-0015
  // §Negative "audit-write-gap") carry two SHA-256 fields
  // (priorOnDiskLineSha256 + expectedLineSha256) plus a priorLineCount
  // integer. Repair lines are NOT routed through scrubAgentLine today,
  // but the allowlist is extended so a future refactor that DOES route
  // them through cannot re-introduce the SEC-FD-AUDIT-CHAIN-01 over-
  // redaction bug for the repair chain.

  const REPAIR_PRIOR_SHA = "a".repeat(64);
  const REPAIR_EXPECTED_SHA = "b".repeat(64);

  it("preserves repair-line fields (priorLineCount, priorOnDiskLineSha256, expectedLineSha256)", () => {
    const repairLine = {
      schemaVersion: 2,
      eventType: "ingest.audit.repair",
      source: "graph.security.secureScores",
      seq: 42,
      tenantId: "t1",
      startedAt: "2026-04-21T12:00:00.000Z",
      callerPrincipalMiClientId: "audit-mi",
      reason: "audit-write-gap detected",
      priorLineCount: 41,
      priorOnDiskLineSha256: REPAIR_PRIOR_SHA,
      expectedLineSha256: REPAIR_EXPECTED_SHA,
      prevLineSha256: "c".repeat(64),
      lineSha256: "d".repeat(64),
    };
    const out = scrubAgentLine(repairLine);
    // All three repair-line fields survive the AGENT_LINE_ALLOWED_KEYS filter.
    expect(out.priorLineCount).toBe(41);
    expect(out.priorOnDiskLineSha256).toBe(REPAIR_PRIOR_SHA);
    expect(out.expectedLineSha256).toBe(REPAIR_EXPECTED_SHA);
    // Sanity — credential regex would match these 64-hex strings if they
    // weren't in CHAIN_INTEGRITY_KEYS. Confirm they passed through.
    expect(out.priorOnDiskLineSha256).not.toBe("[REDACTED]");
    expect(out.expectedLineSha256).not.toBe("[REDACTED]");
  });

  it("repair-line reason still has credential-regex protection", () => {
    // `reason` is NOT in CHAIN_INTEGRITY_KEYS — a credential-shaped
    // value there (hypothetically, if a hostile upstream message landed
    // in reason) must still be redacted. Confirms the allowlist for
    // integrity fields didn't accidentally exempt the entire repair line.
    const out = scrubAgentLine({
      schemaVersion: 2,
      eventType: "ingest.audit.repair",
      source: "x",
      seq: 1,
      tenantId: "t",
      callerPrincipalMiClientId: "mi",
      reason: "Bearer abcdef0123456789",
      prevLineSha256: "a",
      lineSha256: "b",
    });
    expect(out.reason).toBe("[REDACTED]");
  });

  it("canonical hash still verifies across a repair-line write", () => {
    // Belt-and-braces: the post-scrub line must hash deterministically,
    // which is the whole point of the chain-integrity allowlist. Confirm
    // computeLineSha256 produces real hex on a scrubbed repair line.
    const scrubbed = scrubAgentLine({
      schemaVersion: 2,
      eventType: "ingest.audit.repair",
      source: "graph.security.secureScores",
      seq: 99,
      tenantId: "t1",
      startedAt: "2026-04-21T12:00:00.000Z",
      callerPrincipalMiClientId: "audit-mi",
      reason: "repair",
      priorLineCount: 98,
      priorOnDiskLineSha256: REPAIR_PRIOR_SHA,
      expectedLineSha256: REPAIR_EXPECTED_SHA,
      prevLineSha256: "c".repeat(64),
    });
    const { lineSha256: _omit, ...hashInput } = scrubbed as Record<string, unknown>;
    const hash = computeLineSha256(hashInput);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
