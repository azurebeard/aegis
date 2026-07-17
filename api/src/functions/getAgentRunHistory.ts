// GET /api/agents/observability/runs?agent=<name>&limit=N
//
// Powers the Agent observability page's run-history section (HANDOVER §6.3
// v2 follow-up — was Info on the cache-derived v1 endpoint). Reads recent
// `agent.run` lines from the audit blob and projects them into a
// metadata-only shape the SPA can render.
//
// Why this is its own endpoint and not folded into /api/agents/observability:
//   - It needs a different RBAC surface (audit-blob Reader on the api-reader
//     MI, granted in `infra/modules/storage-audit.bicep`).
//   - The fetch involves a multi-day blob walk; keeping it separate means
//     the per-agent observability fan-out endpoint stays under a tight
//     latency budget.
//
// Admin-only — Bearer-JWT validated by authMiddleware (§10.66 Phase E),
// admin role enforced in-handler via `principal.userRoles.includes("admin")`.
// Routed under `/api/agents/*` to avoid the `/api/admin/*` SWA route prefix
// which doesn't forward correctly in this deployment topology (commit
// eb88125).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import {
  readRecentAuditLines,
  type AuditLineRead,
} from "../lib/audit.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { sanitiseLog } from "../lib/sanitiseLog.js";

type AgentName = "brief" | "posture" | "incidents-analysis";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const LOOKBACK_DAYS = 14;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // Admin gate — defence-in-depth alongside the SWA route layer (which
  // sees this as /api/agents/* under reader+admin) so a future route-rule
  // change can't accidentally let readers walk audit history.
  const principal = await readClientPrincipal(request, context);
  const roles = principal?.userRoles ?? [];
  if (!roles.includes("admin")) {
    return {
      status: 403,
      jsonBody: {
        error: {
          code: "forbidden",
          message: "agent run history requires the admin role",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const agentParam = request.query.get("agent") ?? "";
  const agent = parseAgent(agentParam);
  if (!agent) {
    return {
      status: 400,
      jsonBody: {
        error: {
          code: "bad_request",
          message:
            "agent must be one of: brief, posture, incidents-analysis",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const parsedLimit = parseLimit(request.query.get("limit"));
  if (parsedLimit.kind === "error") return parsedLimit.response;
  const limit = parsedLimit.value;

  const config = resolveBriefAgentConfig();
  const auditCtx = {
    blobEndpoint: config.auditBlobEndpoint,
    auditContainerName: config.auditContainerName,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const source = agentSource(agent, config);

  try {
    const lines = await readRecentAuditLines(
      auditCtx,
      source,
      config.tenantId,
      limit,
      LOOKBACK_DAYS,
    );
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        agent,
        items: lines.map(projectLine),
        range: {
          lookbackDays: LOOKBACK_DAYS,
          requestedLimit: limit,
          returnedCount: lines.length,
        },
      },
      headers: {
        "cache-control": "private, max-age=30",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(
      `agents.runs.error agent=${sanitiseLog(agent)} ${sanitiseLog((err as Error).message)}`,
    );
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "audit store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

function parseAgent(raw: string): AgentName | null {
  if (raw === "brief" || raw === "posture" || raw === "incidents-analysis") {
    return raw;
  }
  return null;
}

function agentSource(
  agent: AgentName,
  config: ReturnType<typeof resolveBriefAgentConfig>,
): string {
  switch (agent) {
    case "brief":
      return config.agentBriefSource;
    case "posture":
      return config.agentPostureSource;
    case "incidents-analysis":
      return config.agentIncidentsSource;
  }
}

type ParsedLimit =
  | { kind: "ok"; value: number }
  | { kind: "error"; response: HttpResponseInit };

export function parseLimit(raw: string | null): ParsedLimit {
  if (raw === null || raw === "") return { kind: "ok", value: DEFAULT_LIMIT };
  const trimmed = raw.trim();
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || String(n) !== trimmed || n < 1 || n > MAX_LIMIT) {
    return {
      kind: "error",
      response: {
        status: 400,
        jsonBody: {
          error: {
            code: "bad_request",
            message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
          },
        },
        headers: { "cache-control": "no-store" },
      },
    };
  }
  return { kind: "ok", value: n };
}

interface RunHistoryItem {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: string | null;
  readonly modelDeployment: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly latencyMs: number | null;
  readonly trigger: string | null;
  readonly errorKind: string | null;
  readonly day: string;
}

/**
 * Project the raw audit line into an SPA-safe shape — drop chain SHAs
 * (verifier-side surface, not operator-facing), drop `error.message`
 * (may carry adversary-influenceable text — operators see `error.kind`
 * and look at the audit blob directly for full context), drop
 * `redactedFields` (KQL surface only).
 */
function projectLine(line: AuditLineRead): RunHistoryItem {
  return {
    runId: line.runId ?? "",
    startedAt: line.startedAt,
    endedAt: line.endedAt ?? null,
    status: line.status ?? null,
    modelDeployment: line.modelDeployment ?? null,
    tokensIn: line.tokensIn ?? null,
    tokensOut: line.tokensOut ?? null,
    latencyMs: line.latencyMs ?? null,
    trigger: line.trigger ?? null,
    errorKind: line.error?.kind ?? null,
    day: line.day,
  };
}

app.http("getAgentRunHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "agents/observability/runs",
  handler,
});
