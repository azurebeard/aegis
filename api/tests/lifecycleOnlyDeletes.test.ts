// Lifecycle-only-deletes invariant test (ADR-0014 §3.3 — extended for ADR-0022).
//
// The agent MI does NOT have delete capability on cache containers; deletes
// are governed exclusively by the storage lifecycle policy. Mirror the
// incidentsStore precedent test by grepping for `.delete(` / `.deleteIfExists(`
// against blob clients in the brief-agent code paths.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PATHS = [
  "src/lib/briefCache.ts",
  "src/lib/runBriefAgent.ts",
];

const FORBIDDEN = /\.(delete|deleteIfExists)\(/g;

describe("lifecycle-only-deletes invariant (ADR-0022, mirrors ADR-0014 §3.3)", () => {
  for (const p of PATHS) {
    it(`does not call .delete() / .deleteIfExists() in ${p}`, () => {
      const text = readFileSync(resolve(process.cwd(), p), "utf-8");
      // Strip comments and string literals first so a JSDoc reference doesn't
      // false-positive. A simple line-based filter is enough — the agent code
      // base never legitimately uses these tokens outside docstrings.
      const stripped = text
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      const matches = stripped.match(FORBIDDEN);
      // Accept matches that are clearly typed-method references inside
      // explicit comments or never on a blob/container client. Defensive: if
      // any match remains, the test fails — re-evaluate the call site.
      expect(matches).toBeNull();
    });
  }
});
