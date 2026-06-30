// Tests for the `deployAiAgents` toggle plumbing — HANDOVER §6.3.
//
// `resolveDeployAiAgents` is the single source of truth for the parse
// rule; `resolveApiConfig().deployAiAgents` MUST produce the same result.
// The parse rule is intentionally fail-open: only the literal string
// `"false"` (case-insensitive, trim-stripped) disables the plane. Any
// other value — absent, empty, `"true"`, garbage — returns true. This
// keeps pre-toggle deployments (no app setting written yet) at the
// current behaviour and fails toward keeping the AI plane on, so a
// misconfigured setting doesn't accidentally break an operator's brief
// feed overnight.

import { describe, expect, it } from "vitest";
import {
  resolveApiConfig,
  resolveDeployAiAgents,
  resolveIngestConfig,
} from "../src/lib/config.js";

function mkEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    API_READER_MI_CLIENT_ID: "api-mi",
    INGEST_MI_CLIENT_ID: "ingest-mi",
    AUDIT_MI_CLIENT_ID: "audit-mi",
    OPS_TABLE_ENDPOINT: "https://staegisops.table.core.windows.net",
    AUDIT_BLOB_ENDPOINT: "https://staegisaudit.blob.core.windows.net",
    GRAPH_BASE_URL: "https://graph.microsoft.com",
    AZURE_TENANT_ID: "tenant-1",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("resolveDeployAiAgents — parse rule", () => {
  it("returns true when AZURE_DEPLOY_AI_AGENTS is absent (fail-open default)", () => {
    expect(resolveDeployAiAgents(mkEnv())).toBe(true);
  });

  it("returns true for the literal string `true`", () => {
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "true" }))).toBe(true);
  });

  it("returns false for the literal string `false`", () => {
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "false" }))).toBe(false);
  });

  it("is case-insensitive on `false`", () => {
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "FALSE" }))).toBe(false);
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "False" }))).toBe(false);
  });

  it("trims whitespace before matching", () => {
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "  false  " }))).toBe(false);
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "\tfalse\n" }))).toBe(false);
  });

  it("returns true for any non-false-ish garbage (fail-open)", () => {
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "0" }))).toBe(true);
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "no" }))).toBe(true);
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "off" }))).toBe(true);
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "" }))).toBe(true);
    expect(resolveDeployAiAgents(mkEnv({ AZURE_DEPLOY_AI_AGENTS: "yes" }))).toBe(true);
  });
});

describe("config parity — resolveDeployAiAgents / ApiConfig.deployAiAgents / IngestConfig.deployAiAgents", () => {
  // Three entry points must agree on the flag value:
  //   - `resolveDeployAiAgents()` — read by `api/src/index.ts` at module
  //     load to gate the 10 agent-handler dynamic imports.
  //   - `resolveApiConfig().deployAiAgents` — read by `getSettings.ts`.
  //   - `resolveIngestConfig().deployAiAgents` — read by the three admin
  //     write handlers (patchSettings / uploadBrandingLogo /
  //     deleteBrandingLogo), which all call `buildFullSettingsResponse`.
  // Drift would create the hybrid state where the SPA hides agent tiles
  // but the handlers are still registered (or vice-versa). SEC-L-DAAA-01
  // resolution — standardised on apiConfig / ingestConfig across the
  // four settings-response callers.

  it("all three resolvers agree across the parse-rule matrix", () => {
    const matrix: Array<[string | undefined, boolean]> = [
      [undefined, true],
      ["", true],
      ["true", true],
      ["false", false],
      ["FALSE", false],
      ["  false ", false],
      ["1", true],
      ["0", true],
    ];
    for (const [raw, expected] of matrix) {
      const env = mkEnv(raw === undefined ? {} : { AZURE_DEPLOY_AI_AGENTS: raw });
      expect(resolveDeployAiAgents(env), `standalone(${raw})`).toBe(expected);
      expect(resolveApiConfig(env).deployAiAgents, `apiConfig(${raw})`).toBe(expected);
      expect(resolveIngestConfig(env).deployAiAgents, `ingestConfig(${raw})`).toBe(expected);
    }
  });
});
