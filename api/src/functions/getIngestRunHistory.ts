// GET /api/agents/observability/ingest-runs?source=<name>&limit=N
//
// Sibling of getAgentRunHistory, but projects the ingest-shaped audit fields
// (rowsWritten / graphAttempts / snapshotDate / error.kind) instead of the
// agent-shaped ones. Powers the "Recent runs" expand on the Secure Score
// failing/empty tile so an admin seeing "Ingest is failing" can drill straight
// into the last N audit lines without leaving the dashboard.
//
// Routed under `/api/agents/*` for the same reason as getAgentRunHistory:
// the `/api/admin/*` SWA route prefix doesn't forward correctly in this
// deployment topology (commit eb88125). Admin role is enforced in-handler
// via authMiddleware-validated Bearer JWT (§10.66 Phase E).
//
// Source allow-list — only sources that actually emit ingest.run audit lines
// today: secure-score, incidents, entra-risk, kev. Restricting at the handler
// keeps the audit-blob walker from being pointed at arbitrary attacker-supplied
// strings (the underlying readRecentAuditLines sanitises path components, but
// the allow-list is the operator-facing contract).
//
// `secure-score-control-profiles` is deliberately NOT in the list — that
// timer's runs don't write to the audit chain (idempotent catalogue refresh,
// AIEVENT only). Surface its run history via App Insights `AIEVENT
// SecureScoreControlProfilesIngest` if needed.

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
import {
  auditSourceForKey,
  DIAGNOSTICS_SOURCES,
  isDiagnosticsSourceKey,
} from "../lib/diagnosticsSources.js";
import { sanitiseLog } from "../lib/sanitiseLog.js";

// Source-key type derived from the registry — adding/removing a key in
// `diagnosticsSources.ts` automatically tightens the type union here.
type IngestSourceKey = (typeof DIAGNOSTICS_SOURCES)[number]["key"];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const LOOKBACK_DAYS = 14;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  const roles = principal?.userRoles ?? [];
  if (!roles.includes("admin")) {
    return {
      status: 403,
      jsonBody: {
        error: {
          code: "forbidden",
          message: "ingest run history requires the admin role",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const sourceParam = request.query.get("source") ?? "";
  const sourceKey = parseSource(sourceParam);
  if (!sourceKey) {
    // Build the operator-facing error message from the live registry so
    // it never goes stale relative to the actual allowlist.
    const known = DIAGNOSTICS_SOURCES.map((s) => s.key).join(", ");
    return {
      status: 400,
      jsonBody: {
        error: {
          code: "bad_request",
          message: `source must be one of: ${known}`,
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
  const source = resolveSource(sourceKey);

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
        source: sourceKey,
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
      `ingest.runs.error source=${sanitiseLog(sourceKey)} ${sanitiseLog((err as Error).message)}`,
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

/** Parse the `?source=` URL segment. Returns the typed key when it
 *  matches a registered diagnostics source; null otherwise. Delegates to
 *  the registry so the allowlist + the type union stay aligned. */
export function parseSource(raw: string): IngestSourceKey | null {
  if (isDiagnosticsSourceKey(raw)) {
    return raw as IngestSourceKey;
  }
  return null;
}

/** Resolve the diagnostics URL-segment key to the audit-chain source
 *  string the orchestrator writes lines under. The registry is the
 *  single source of truth; per-source env-var overrides were dropped
 *  because they could drift away from the orchestrator's actual source
 *  (which reads from the per-vertical config resolvers) and silently
 *  hide audit lines from the diagnostics page. Operators forking the
 *  source-string convention edit the registry. */
function resolveSource(key: IngestSourceKey): string {
  // Type-safe: `key` came from `parseSource` which only returns
  // registered keys, so the lookup is total.
  return auditSourceForKey(key) as string;
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

export interface IngestRunHistoryItem {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: string | null;
  readonly rowsWritten: number | null;
  readonly retentionRowsDeleted: number | null;
  readonly graphAttempts: number | null;
  readonly snapshotDate: string | null;
  readonly currentScore: number | null;
  readonly maxScore: number | null;
  readonly errorKind: string | null;
  readonly day: string;
}

/**
 * Project the raw audit line into an SPA-safe shape — drop chain SHAs
 * (verifier-side surface), drop `error.message` (may carry adversary-
 * influenceable text — operators see `error.kind` and look at the audit
 * blob directly for full context), drop callerPrincipalMiClientId
 * (internal binding, not operator-facing).
 */
export function projectLine(line: AuditLineRead): IngestRunHistoryItem {
  return {
    runId: line.runId ?? "",
    startedAt: line.startedAt,
    endedAt: line.endedAt ?? null,
    status: line.status ?? null,
    rowsWritten: line.rowsWritten ?? null,
    retentionRowsDeleted: line.retentionRowsDeleted ?? null,
    graphAttempts: line.graphAttempts ?? null,
    snapshotDate: line.snapshotDate ?? null,
    currentScore: line.currentScore ?? null,
    maxScore: line.maxScore ?? null,
    errorKind: line.error?.kind ?? null,
    day: line.day,
  };
}

app.http("getIngestRunHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "agents/observability/ingest-runs",
  handler,
});
