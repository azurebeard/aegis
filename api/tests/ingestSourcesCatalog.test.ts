// ADR-0036 v1.3 follow-track (§10.71 F1) — `IngestSource` catalog invariants.
//
// The freshness-row routing in `ingestHealth.ts` / `tables.ts` is prefix-
// based: `azure.*` → `ArmIngestHealth`, everything else → `IngestHealth`.
// This test pins the contract:
//
//   1. Every `ArmIngestSource` literal starts with `azure.`.
//   2. NO `GraphIngestSource` / `AgentIngestSource` / `OtherIngestSource`
//      literal starts with `azure.` (would silently mis-route to
//      `ArmIngestHealth` and be writable by the `armIngest` MI).
//   3. Graph-prefix sources start with `graph.`; agent-prefix with
//      `agent.aegis.`; the "other" bucket covers the remaining narrow
//      tail (`cisa.*`, `operator.*`, `report.*`).
//   4. The four category arrays are pairwise disjoint.
//   5. `ingestHealthTableNameForSource` agrees with the prefix rule on
//      every catalogued literal.
//
// A new ingest source landing in the wrong bucket fails this test at
// PR time.

import { describe, expect, it } from "vitest";
import {
  AGENT_INGEST_SOURCES,
  ALL_INGEST_SOURCES,
  ARM_INGEST_SOURCES,
  GRAPH_INGEST_SOURCES,
  OTHER_INGEST_SOURCES,
  isKnownIngestSource,
} from "../src/lib/ingestSources.js";
import { ingestHealthTableNameForSource, OPS_TABLES } from "../src/lib/tables.js";

describe("ingestSources catalog (§10.71 F1)", () => {
  it("every ARM source starts with `azure.`", () => {
    for (const s of ARM_INGEST_SOURCES) {
      expect(
        s.startsWith("azure."),
        `${s} is in ARM_INGEST_SOURCES but does not start with 'azure.'`,
      ).toBe(true);
    }
  });

  it("no Graph source starts with `azure.`", () => {
    for (const s of GRAPH_INGEST_SOURCES) {
      expect(
        s.startsWith("azure."),
        `${s} is in GRAPH_INGEST_SOURCES but starts with 'azure.' — would mis-route to ArmIngestHealth`,
      ).toBe(false);
      expect(
        s.startsWith("graph."),
        `${s} is in GRAPH_INGEST_SOURCES but does not start with 'graph.'`,
      ).toBe(true);
    }
  });

  it("no Agent source starts with `azure.`", () => {
    for (const s of AGENT_INGEST_SOURCES) {
      expect(s.startsWith("azure.")).toBe(false);
      expect(
        s.startsWith("agent.aegis."),
        `${s} is in AGENT_INGEST_SOURCES but does not start with 'agent.aegis.'`,
      ).toBe(true);
    }
  });

  it("no Other source starts with `azure.`", () => {
    for (const s of OTHER_INGEST_SOURCES) {
      expect(
        s.startsWith("azure."),
        `${s} is in OTHER_INGEST_SOURCES but starts with 'azure.' — re-categorise to ARM_INGEST_SOURCES OR rename`,
      ).toBe(false);
    }
  });

  it("the four category arrays are pairwise disjoint", () => {
    const seen = new Set<string>();
    for (const s of ALL_INGEST_SOURCES) {
      expect(seen.has(s), `duplicate source literal: ${s}`).toBe(false);
      seen.add(s);
    }
  });

  it("ingestHealthTableNameForSource routes every catalogued literal correctly", () => {
    for (const s of ARM_INGEST_SOURCES) {
      expect(ingestHealthTableNameForSource(s)).toBe(OPS_TABLES.ArmIngestHealth);
    }
    const nonArm = [
      ...GRAPH_INGEST_SOURCES,
      ...AGENT_INGEST_SOURCES,
      ...OTHER_INGEST_SOURCES,
    ];
    for (const s of nonArm) {
      expect(ingestHealthTableNameForSource(s)).toBe(OPS_TABLES.IngestHealth);
    }
  });

  it("isKnownIngestSource accepts every catalogued literal + rejects unknowns", () => {
    for (const s of ALL_INGEST_SOURCES) {
      expect(isKnownIngestSource(s)).toBe(true);
    }
    expect(isKnownIngestSource("nope.not.a.source")).toBe(false);
    expect(isKnownIngestSource("azure.something.unknown")).toBe(false);
    expect(isKnownIngestSource("")).toBe(false);
  });
});
