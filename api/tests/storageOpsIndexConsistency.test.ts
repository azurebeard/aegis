// storage-ops.bicep index-variable consistency invariant (§10.70 follow-up).
//
// `infra/modules/storage-ops.bicep` declares a `tableNames` array and a set
// of `ingestWritableIdx*` + `agentWritableIdx*` variables that each grant
// resource uses to scope itself to a specific table via `tables[idx]`.
// On 2026-05-10 (§10.70) those variables silently drifted out of sync with
// the array — `ConditionalAccessPolicies` was inserted at position 3 and
// `AzureSecureScores` at position 4 without bumping the existing indices,
// and the new `AzureSecureScores` variable was set to 22 (append-at-end)
// while the table actually landed at position 4. Every grant resource
// scoped via `tables[broken-idx]` silently landed on the WRONG table.
//
// This test parses the Bicep source, extracts the `tableNames` array and
// the index variables, and asserts each variable's value resolves to a
// table whose name matches the variable's suffix (case-insensitive). A
// future PR that inserts a new entry into `tableNames` without bumping
// the downstream indices fails this test loudly at PR time.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const STORAGE_OPS_BICEP = join(
  here,
  "..",
  "..",
  "infra",
  "modules",
  "storage-ops.bicep",
);

/**
 * Extract the contents of `var tableNames = [ 'A' 'B' ... ]` in source
 * order. Strips inline comments. Throws if the array can't be parsed —
 * the parse logic is deliberately strict so a malformed Bicep file
 * surfaces clearly instead of producing a misleading empty list.
 */
function extractTableNames(src: string): readonly string[] {
  const match = /var\s+tableNames\s*=\s*\[([\s\S]*?)\n\]/.exec(src);
  if (!match) {
    throw new Error("could not find `var tableNames = [...]` block");
  }
  const body = match[1] ?? "";
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const nameMatch = /^\s*'([A-Za-z0-9_]+)'/.exec(line);
    if (nameMatch?.[1]) out.push(nameMatch[1]);
  }
  return out;
}

interface IndexVar {
  readonly name: string;
  readonly suffix: string;
  readonly value: number;
}

/**
 * Extract every `var (ingestWritableIdx|agentWritableIdx)<Suffix> = N`
 * declaration. The suffix is what we'll match against the resolved table
 * name.
 */
function extractIndexVars(src: string): readonly IndexVar[] {
  const out: IndexVar[] = [];
  const re =
    /^\s*var\s+(ingestWritableIdx|agentWritableIdx)([A-Za-z0-9_]+)\s*=\s*(\d+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (!m[1] || !m[2] || !m[3]) continue;
    out.push({
      name: `${m[1]}${m[2]}`,
      suffix: m[2],
      value: Number.parseInt(m[3], 10),
    });
  }
  return out;
}

describe("storage-ops.bicep — index variables match tableNames positions (§10.70)", () => {
  const src = readFileSync(STORAGE_OPS_BICEP, "utf-8");
  const tableNames = extractTableNames(src);
  const indexVars = extractIndexVars(src);

  it("parses a non-trivial `tableNames` array", () => {
    expect(tableNames.length).toBeGreaterThan(15);
  });

  it("parses a non-trivial set of `(ingestWritable|agentWritable)Idx*` variables", () => {
    expect(indexVars.length).toBeGreaterThan(10);
  });

  for (const v of indexVars) {
    it(`${v.name} (= ${v.value}) resolves to a table whose name matches '${v.suffix}'`, () => {
      const resolved = tableNames[v.value];
      expect(
        resolved,
        `${v.name} = ${v.value} but tableNames has only ${tableNames.length} entries`,
      ).toBeDefined();
      // Case-insensitive match — `KEV` vs `Kev` is the only naturally-occurring
      // suffix-vs-name case skew today, and the invariant is "the variable
      // points at the table its name says it does", not "string equality".
      expect(
        resolved!.toLowerCase(),
        `${v.name} (= ${v.value}) resolves to '${resolved}', expected something case-equivalent to '${v.suffix}'. ` +
          `Either bump the variable to the new position of '${v.suffix}' in tableNames, OR rename the variable to match the actual table it points at.`,
      ).toBe(v.suffix.toLowerCase());
    });
  }
});
