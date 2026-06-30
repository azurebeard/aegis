import { describe, it, expect } from "vitest";
import { auditBlobPath, auditFilenameForSource } from "../src/lib/audit.js";

describe("auditBlobPath", () => {
  it("builds the day-partitioned path", () => {
    expect(auditBlobPath("graph.security.secureScores", "2026-04-18T03:02:18.902Z")).toBe(
      "graph.security.secureScores/2026/04/18/ingest.ndjson",
    );
  });

  it("zero-pads single-digit month and day", () => {
    expect(auditBlobPath("src", "2026-01-09T00:00:00Z")).toBe("src/2026/01/09/ingest.ndjson");
  });

  it("routes agent.* sources to agent-run.ndjson when filename is dispatched", () => {
    // The optional `filename` arg in `auditBlobPath` is normally supplied
    // via `auditFilenameForSource(source)` — callers in `audit.ts` use
    // exactly that pattern. Verify the composition produces the correct
    // agent-chain path.
    expect(
      auditBlobPath(
        "agent.aegis.brief",
        "2026-04-18T03:02:18.902Z",
        auditFilenameForSource("agent.aegis.brief"),
      ),
    ).toBe("agent.aegis.brief/2026/04/18/agent-run.ndjson");
  });

  it("sanitises source to prevent path traversal", () => {
    expect(auditBlobPath("../etc/passwd", "2026-01-01T00:00:00Z")).toBe(
      ".._etc_passwd/2026/01/01/ingest.ndjson",
    );
    expect(auditBlobPath("foo/../bar", "2026-01-01T00:00:00Z")).toBe(
      "foo_.._bar/2026/01/01/ingest.ndjson",
    );
  });
});

describe("auditFilenameForSource — SEC-OBS-AUDIT-CHAIN-01 contract", () => {
  // This function is the authoritative filename dispatcher for the audit
  // writer AND the one that `scripts/verify-audit-chain.mjs` mirrors
  // line-for-line in pure JS (cannot import from TS at runtime).
  // Drift here silently breaks chain verification for any source using the
  // non-mirrored branch — so these assertions are the canary.

  it("routes graph.* sources to ingest.ndjson", () => {
    expect(auditFilenameForSource("graph.security.secureScores")).toBe("ingest.ndjson");
    expect(auditFilenameForSource("graph.security.incidents")).toBe("ingest.ndjson");
    expect(auditFilenameForSource("graph.security.riskyUsers")).toBe("ingest.ndjson");
  });

  it("routes agent.* sources to agent-run.ndjson", () => {
    expect(auditFilenameForSource("agent.aegis.brief")).toBe("agent-run.ndjson");
    expect(auditFilenameForSource("agent.aegis.posture")).toBe("agent-run.ndjson");
    expect(auditFilenameForSource("agent.aegis.incidents")).toBe("agent-run.ndjson");
  });

  it("defaults an unknown-prefix source to ingest.ndjson", () => {
    // Belt-and-braces: fail-closed to the legacy filename so an unrecognised
    // source doesn't accidentally land at the agent filename without review.
    expect(auditFilenameForSource("future.vertical")).toBe("ingest.ndjson");
    expect(auditFilenameForSource("")).toBe("ingest.ndjson");
  });

  it("does NOT match strings containing `agent.` after the prefix", () => {
    // Guards against a source like `graph.agent.foo` inadvertently matching
    // via `.includes()` or substring checks on future refactors. The current
    // impl uses `startsWith("agent.")` which is correct.
    expect(auditFilenameForSource("graph.agent.foo")).toBe("ingest.ndjson");
    expect(auditFilenameForSource("x-agent.brief")).toBe("ingest.ndjson");
  });
});
