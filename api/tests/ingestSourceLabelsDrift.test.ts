// §10.58 INFO-1 — drift-prevention test asserting every key in
// `INGEST_SOURCE_LABELS` (the notifications-panel display-name map in
// `getNotifications.ts`) corresponds to a catalogued ingest source.
//
// The label map is consumed by the notifications panel to render a
// human-friendly title for each degrading/failing ingest source. If a
// new vertical's source string lands in `ingestSources.ts` but the
// label map isn't updated, the bell falls back to the raw source string
// (ugly but functional) — minor. If a stale key remains in the label
// map after a source is renamed/removed, the dead-code analysis carries
// it forward — also minor.
//
// The stricter direction — "every key in the label map must be a known
// source" — is the invariant worth pinning. Catches typos + stale
// entries at PR review time. The reverse direction ("every source has
// a label") is deliberately NOT asserted: some sources (agent.aegis.*,
// report.snapshot, operator.stack) surface through different UX paths
// and intentionally have no bell label.

import { describe, expect, it } from "vitest";
import { INGEST_SOURCE_LABELS } from "../src/functions/getNotifications.js";
import { isKnownIngestSource } from "../src/lib/ingestSources.js";

describe("INGEST_SOURCE_LABELS drift test (§10.58 INFO-1)", () => {
  const labelKeys = Object.keys(INGEST_SOURCE_LABELS);

  it("declares at least one label (sanity)", () => {
    expect(labelKeys.length).toBeGreaterThan(0);
  });

  for (const key of labelKeys) {
    it(`'${key}' is a known ingest source (declared in ingestSources.ts)`, () => {
      expect(
        isKnownIngestSource(key),
        `INGEST_SOURCE_LABELS has key '${key}' but no matching entry in ` +
          `ARM_INGEST_SOURCES + GRAPH_INGEST_SOURCES + AGENT_INGEST_SOURCES + ` +
          `OTHER_INGEST_SOURCES. Either register the source in ` +
          `api/src/lib/ingestSources.ts OR remove the stale label.`,
      ).toBe(true);
    });
  }

  it("every label is a non-empty human-friendly string", () => {
    for (const [key, label] of Object.entries(INGEST_SOURCE_LABELS)) {
      expect(typeof label).toBe("string");
      expect(label.length, `label for ${key} is empty`).toBeGreaterThan(0);
    }
  });
});
