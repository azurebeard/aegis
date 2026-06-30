// ADR-0030 §3 + §4 — encode/decode + version trim invariants.
// Pure tests over the encoder + the trim algorithm. Table I/O is
// covered separately by the capture-handler integration test.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeEnvelope,
  encodeEnvelope,
  EnvelopeTooLargeError,
  MAX_COMPRESSED_ENVELOPE_BYTES,
  MIN_VERSIONS_PER_PERIOD,
  rowKeyFor,
  type ReportSnapshotEnvelope,
} from "../src/lib/reportSnapshotStore.js";

const SAMPLE: ReportSnapshotEnvelope = {
  schemaVersion: 1,
  contentType: "application/json",
  tenantId: "tenant-1",
  periodKey: "2026-W17",
  periodCadence: "weekly",
  periodStart: "2026-04-20T00:00:00.000Z",
  periodEnd: "2026-04-26T23:59:59.999Z",
  capturedAt: "2026-04-28T12:00:00.000Z",
  capturedBy: "admin-oid",
  version: 1,
  sections: {
    secureScore: { snapshot: null, trend: [] },
    incidents: { counts: { total: 0 }, trend: [], preview: [] },
    entraRisk: { counts: { total: 0 } },
    brief: { briefDate: null, body: null, modelDeployment: null },
    posture: { isoWeek: null, body: null, modelDeployment: null },
    ingestHealth: [],
  },
  derived: {},
};

describe("encodeEnvelope / decodeEnvelope", () => {
  it("round-trips an envelope with no fidelity loss", () => {
    const encoded = encodeEnvelope(SAMPLE);
    expect(encoded.compressedBytes).toBeGreaterThan(0);
    expect(encoded.compressedBytes).toBeLessThanOrEqual(
      MAX_COMPRESSED_ENVELOPE_BYTES,
    );
    expect(encoded.preCompressionBytes).toBeGreaterThan(encoded.compressedBytes);
    const decoded = decodeEnvelope(encoded.column);
    expect(decoded).toEqual(SAMPLE);
  });

  it("throws EnvelopeTooLargeError when compressed bytes exceed cap", () => {
    // Use cryptographically random bytes → base64 — gzip cannot meaningfully
    // compress this, so post-compression size ~= pre-compression size. Need
    // ~80 KB of base64 to sail past the 60 KB compressed cap with margin.
    const stuffing = randomBytes(80 * 1024).toString("base64");
    const huge: ReportSnapshotEnvelope = {
      ...SAMPLE,
      sections: {
        ...SAMPLE.sections,
        incidents: {
          counts: { total: 0 },
          trend: [],
          preview: [],
          _stuffing: stuffing,
        },
      },
    };
    expect(() => encodeEnvelope(huge)).toThrow(EnvelopeTooLargeError);
  });
});

describe("rowKeyFor", () => {
  it("produces a chronologically-sortable RowKey", () => {
    const a = rowKeyFor("2026-W17", "2026-04-28T11:00:00.000Z");
    const b = rowKeyFor("2026-W17", "2026-04-28T12:00:00.000Z");
    expect(a < b).toBe(true);
  });

  it("isolates by period prefix", () => {
    const w17 = rowKeyFor("2026-W17", "2026-04-28T11:00:00.000Z");
    const w18 = rowKeyFor("2026-W18", "2026-04-28T11:00:00.000Z");
    expect(w17.startsWith("2026-W17_")).toBe(true);
    expect(w18.startsWith("2026-W18_")).toBe(true);
  });
});

describe("MIN_VERSIONS_PER_PERIOD floor", () => {
  it("is set to 3 (the operator-stated minimum)", () => {
    expect(MIN_VERSIONS_PER_PERIOD).toBe(3);
  });
});
