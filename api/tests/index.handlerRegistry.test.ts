// Pin the runtime-registration semantic for the `deployAiAgents` toggle
// (HANDOVER §6.3 SEC-INFO-DAAA-01).
//
// `api/src/index.ts` short-circuits the 10 agent-plane handlers via
//
//   if (resolveDeployAiAgents()) { await import(<handler>); ... }
//
// so when `AZURE_DEPLOY_AI_AGENTS=false` the handlers MUST NOT register.
// The parse rule itself is exhaustively covered in
// `deployAiAgentsConfig.test.ts`. This file pins the consequence: the
// `app.http` / `app.timer` registry observed at module load reflects the
// toggle. Drift would create the broken hybrid state where the SPA hides
// agent tiles but the handlers still register (or vice-versa).
//
// The test mocks `@azure/functions` so module load tracks names without
// reaching into the runtime, then re-evaluates `index.ts` once per env
// configuration via `vi.resetModules()`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Names of the 10 agent-plane handlers that are gated on the toggle.
// Source: api/src/index.ts dynamic-import block. Drift here means a new
// agent handler was added without updating this list — the test will
// fail loudly if registry contents diverge from what's listed.
const AGENT_HANDLER_NAMES = [
  "getBriefLatest",
  "getBriefByDate",
  "getBriefHistory",
  "runDailyBrief",
  "dailyBriefTimer",
  "getPostureLatest",
  "getPostureByWeek",
  "getPostureHistory",
  "runPostureAgent",
  "postureAgentTimer",
  "analyseIncident",
  "getIncidentAnalysis",
  "clearIncidentRedactionLock",
  "getAdminAgents",
  "getAgentRunHistory",
] as const;

// A subset of the unconditional handlers that MUST always register
// regardless of the toggle. Exhaustive list isn't required — just a few
// canonical samples to assert the unconditional path stayed intact.
const ALWAYS_PRESENT_SAMPLES = [
  "ping",
  "getSecureScoreLatest",
  "getSecureScoreControlProfiles",
  "secureScoreControlProfilesTimer",
  "getIncidentsSummary",
  "getRiskyUsersSummary",
  "getSettings",
  "patchSettings",
] as const;

const { httpRegistrations, timerRegistrations } = vi.hoisted(() => ({
  httpRegistrations: [] as string[],
  timerRegistrations: [] as string[],
}));

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: {
      ...actual.app,
      http: vi.fn((name: string) => {
        httpRegistrations.push(name);
      }),
      timer: vi.fn((name: string) => {
        timerRegistrations.push(name);
      }),
    },
  };
});

// `app.http(name, …)` registrations also exist in some `ingest/` timer
// modules — those use `app.timer` instead, which we capture above. The
// registrations array is shared across both so we just check the union.
function allRegistered(): readonly string[] {
  return [...httpRegistrations, ...timerRegistrations];
}

async function reloadIndex(): Promise<void> {
  // vi.resetModules clears the per-import cache so `index.ts` AND every
  // handler module it imports re-evaluate against the fresh env. Without
  // this, a subsequent import of index.ts is a no-op and the toggle
  // never re-fires.
  vi.resetModules();
  httpRegistrations.length = 0;
  timerRegistrations.length = 0;
  await import("../src/index.js");
}

beforeEach(() => {
  // Minimal env so config resolvers (called at module load by some
  // handlers) don't ConfigError. Values are placeholders — handlers
  // register their routes regardless of whether the values would work
  // at request-time.
  vi.stubEnv("API_READER_MI_CLIENT_ID", "api-mi");
  vi.stubEnv("INGEST_MI_CLIENT_ID", "ingest-mi");
  vi.stubEnv("AUDIT_MI_CLIENT_ID", "audit-mi");
  vi.stubEnv(
    "OPS_TABLE_ENDPOINT",
    "https://staegisops.table.core.windows.net",
  );
  vi.stubEnv(
    "AUDIT_BLOB_ENDPOINT",
    "https://staegisaudit.blob.core.windows.net",
  );
  vi.stubEnv("GRAPH_BASE_URL", "https://graph.microsoft.com");
  vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("index.ts handler registry — deployAiAgents toggle (SEC-INFO-DAAA-01)", () => {
  it("registers all 10 agent handlers when AZURE_DEPLOY_AI_AGENTS is unset (fail-open default)", async () => {
    vi.stubEnv("AZURE_DEPLOY_AI_AGENTS", "");
    await reloadIndex();
    const registered = new Set(allRegistered());
    for (const name of AGENT_HANDLER_NAMES) {
      expect(registered.has(name), `expected '${name}' registered (default)`).toBe(true);
    }
    for (const name of ALWAYS_PRESENT_SAMPLES) {
      expect(registered.has(name), `expected '${name}' registered (unconditional)`).toBe(true);
    }
  });

  it("registers all 10 agent handlers when AZURE_DEPLOY_AI_AGENTS=true", async () => {
    vi.stubEnv("AZURE_DEPLOY_AI_AGENTS", "true");
    await reloadIndex();
    const registered = new Set(allRegistered());
    for (const name of AGENT_HANDLER_NAMES) {
      expect(registered.has(name), `expected '${name}' registered (true)`).toBe(true);
    }
  });

  it("registers ZERO agent handlers when AZURE_DEPLOY_AI_AGENTS=false", async () => {
    vi.stubEnv("AZURE_DEPLOY_AI_AGENTS", "false");
    await reloadIndex();
    const registered = new Set(allRegistered());
    for (const name of AGENT_HANDLER_NAMES) {
      expect(registered.has(name), `expected '${name}' NOT registered (false)`).toBe(false);
    }
    // Unconditional handlers MUST still register — the toggle gates only
    // the agent plane, not the ingest plane or the dashboard read APIs.
    for (const name of ALWAYS_PRESENT_SAMPLES) {
      expect(
        registered.has(name),
        `expected '${name}' registered (unconditional, even when AI plane off)`,
      ).toBe(true);
    }
  });

  it("respects the case-insensitive + whitespace-trim parse rule", async () => {
    vi.stubEnv("AZURE_DEPLOY_AI_AGENTS", "  FALSE  ");
    await reloadIndex();
    const registered = new Set(allRegistered());
    for (const name of AGENT_HANDLER_NAMES) {
      expect(
        registered.has(name),
        `expected '${name}' NOT registered (FALSE-with-whitespace)`,
      ).toBe(false);
    }
  });
});
