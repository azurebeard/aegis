// ADR-0030 §6 — auditFilenameForSource dispatch for the new
// report.snapshot chain. Pins the contract that report capture lines
// route to `report.ndjson`, distinct from `ingest.ndjson` and
// `agent-run.ndjson`.

import { describe, expect, it } from "vitest";
import { auditFilenameForSource } from "../src/lib/audit.js";

describe("auditFilenameForSource", () => {
  it("routes report.snapshot to report.ndjson", () => {
    expect(auditFilenameForSource("report.snapshot")).toBe("report.ndjson");
  });

  it("still routes agent.* to agent-run.ndjson", () => {
    expect(auditFilenameForSource("agent.aegis.brief")).toBe("agent-run.ndjson");
    expect(auditFilenameForSource("agent.aegis.posture")).toBe("agent-run.ndjson");
  });

  it("still routes ingest sources to ingest.ndjson", () => {
    expect(auditFilenameForSource("graph.security.secureScores")).toBe("ingest.ndjson");
    expect(auditFilenameForSource("graph.security.incidents")).toBe("ingest.ndjson");
    expect(auditFilenameForSource("graph.security.riskyUsers")).toBe("ingest.ndjson");
  });

  it("routes Phase C report-email sources to their dedicated files (ADR-0030 §C.7)", () => {
    expect(auditFilenameForSource("report.email.intent")).toBe(
      "report-email-intent.ndjson",
    );
    // sent + failed share the outcome blob — only `report.email.sent` is the
    // configured source string; `eventType` on the line distinguishes them.
    expect(auditFilenameForSource("report.email.sent")).toBe(
      "report-email-sent.ndjson",
    );
  });
});
