// ADR-0036 v1.3 — source → table helper unit test.
//
// `ingestHealthTableNameForSource(source)` routes each ingest source to
// either `IngestHealth` (Graph-plane) or `ArmIngestHealth` (ARM-plane).
// The invariant: any source starting with `azure.` MUST land on
// `ArmIngestHealth`, and everything else MUST land on `IngestHealth`.
// Misrouting opens the very cross-plane forge-row surface the M-Q2
// follow-track closed.

import { describe, expect, it } from "vitest";
import { ingestHealthTableNameForSource, OPS_TABLES } from "../src/lib/tables.js";

describe("ingestHealthTableNameForSource (ADR-0036 v1.3)", () => {
  it("routes azure.security.defenderForCloud.secureScores to ArmIngestHealth", () => {
    expect(
      ingestHealthTableNameForSource("azure.security.defenderForCloud.secureScores"),
    ).toBe(OPS_TABLES.ArmIngestHealth);
  });

  it("routes a future hypothetical azure.* source to ArmIngestHealth", () => {
    expect(ingestHealthTableNameForSource("azure.resources.policyCompliance")).toBe(
      OPS_TABLES.ArmIngestHealth,
    );
  });

  it.each([
    "graph.security.secureScores",
    "graph.security.incidents",
    "graph.security.riskyUsers",
    "graph.users.dormancy",
    "graph.auditLogs.signIns",
    "graph.identity.conditionalAccess.policies",
    "agent.aegis.brief",
    "agent.aegis.posture",
    "cisa.kev",
    "operator.stack",
  ])("routes %s to IngestHealth", (source) => {
    expect(ingestHealthTableNameForSource(source)).toBe(OPS_TABLES.IngestHealth);
  });

  it("does NOT match a source containing 'azure.' as a substring (must be a prefix)", () => {
    // Defensive: prefix match, not contains-match. A made-up source like
    // `graph.azure.foo` is Graph-plane regardless of the substring.
    expect(ingestHealthTableNameForSource("graph.azure.foo")).toBe(OPS_TABLES.IngestHealth);
  });
});
