// GET /api/notifications — aggregates "things an operator should be
// aware of right now" into a single feed for the bell-icon popover
//
// Sources, all read-only:
//   - IngestHealth rows where status != "healthy" (and not the
//     steady-state "licence_required") OR consecutiveFailureCount >= 3.
//   - AgentHealth rows for the three agents where state != "closed".
//   - TenantSettings rows changed in the last 24h.
//
// Out of scope for v1: redaction-lock notifications (would need a
// partition-scoped scan of IncidentAnalysisCache filtering on
// RedactionLockUntil > now). Trivial to add when an operator asks.
//
// Reader-or-admin SWA gate via the `/api/*` catch-all. No new RBAC,
// no new Graph scopes.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { type TableClient } from "@azure/data-tables";
import {
  AGENT_HEALTH_TABLE_NAME,
  readHealthOptional,
} from "../lib/agentHealth.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveApiConfig, resolveAuditReadContext } from "../lib/config.js";
import { readRecentConditionalAccessChanges } from "../lib/conditionalAccessRecentChanges.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import {
  listHealthRowsFederated as listIngestHealthRows,
} from "../lib/ingestHealth.js";
import {
  getTableClient,
  OPS_TABLES,
} from "../lib/tables.js";

interface Notification {
  /** Stable ID for client-side dedup + mark-as-read tracking. */
  readonly id: string;
  readonly kind:
    | "ingest-failure"
    | "ingest-degrading"
    | "agent-circuit-open"
    | "agent-circuit-half-open"
    | "settings-changed"
    | "ca-policy-changed"; // ADR-0034 §3.3 (Phase 8D)
  readonly tone: "danger" | "warning" | "info";
  readonly title: string;
  readonly detail: string;
  /** ISO8601 — drives client-side sort + last-seen comparison. */
  readonly timestamp: string;
}

interface NotificationsResponse {
  readonly schemaVersion: 1;
  readonly notifications: readonly Notification[];
  readonly generatedAt: string;
}

const SETTINGS_RECENT_WINDOW_MS = 24 * 60 * 60_000;

// Keys MUST match the actual `source` strings emitted by each ingest's
// config (see api/src/lib/config.ts). A typo silently degrades the bell to
// raw-source-string display, which §10.58 caught in two places: the
// risky-users key was `graph.identityProtection.riskyUsers` (Graph endpoint
// path, not the source string the ingest writes — the actual source is
// `graph.security.riskyUsers`), and five later verticals had no entry at all.
export const INGEST_SOURCE_LABELS: Readonly<Record<string, string>> = {
  "graph.security.secureScores": "Microsoft Secure Score ingest",
  "graph.security.incidents": "Incidents ingest",
  "graph.security.riskyUsers": "Risky Users ingest",
  "graph.users.dormancy": "User Dormancy ingest",
  "graph.auditLogs.signIns": "Sign-ins ingest",
  "graph.identity.conditionalAccess.policies": "Conditional Access ingest",
  "azure.security.defenderForCloud.secureScores": "Defender for Cloud Secure Score ingest",
  "cisa.kev": "KEV ingest",
  "external.ransomware.live": "Ransomware.live threat intel ingest",
};

const SETTINGS_ROW_LABELS: Readonly<Record<string, string>> = {
  "tile-visibility": "Tile visibility",
  "agent-budget": "Agent budget",
  "user-identifier-strategy": "User identifier strategy",
  branding: "Branding",
};

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E follow-up — Bearer required (Easy Auth retired).
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const config = resolveApiConfig();
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  // ADR-0036 v1.3 — IngestHealth split. Federated read across IngestHealth
  // (Graph-plane sources) + ArmIngestHealth (ARM-plane sources). The lib
  // helper takes the ctx (not a TableClient) so it can resolve both internally.
  const agentHealthTable = getTableClient(opsCtx, AGENT_HEALTH_TABLE_NAME);
  const settingsTable = getTableClient(opsCtx, OPS_TABLES.TenantSettings);

  try {
    // Concurrent reads — independent partitions/rows. The CA-recent-changes
    // call walks the audit blob via the shared audit-MI context resolver
    // (WS10 SEC-MED-CA-TILE-NOTIF-01 — fail-fast on missing audit env vars
    // at the central resolver, not via silent ?? "" fallbacks per handler).
    // A resolver failure OR transient blob read failure both degrade the
    // CA-changes feed to empty so a single dependency hiccup does not
    // blank the whole notifications panel.
    const caChangesPromise = (async () => {
      let auditCtx: ReturnType<typeof resolveAuditReadContext>;
      try {
        auditCtx = resolveAuditReadContext();
      } catch (err) {
        context.warn(
          `notifications.caChanges.config.missing ${String((err as Error).message ?? err)}`,
        );
        return { windowHours: 24, count: 0, samples: [] as const };
      }
      try {
        return await readRecentConditionalAccessChanges(
          {
            blobEndpoint: auditCtx.auditBlobEndpoint,
            auditContainerName: auditCtx.auditContainerName,
            managedIdentityClientId: auditCtx.auditMiClientId,
          },
          config.tenantId,
          { windowHours: 24, samples: 10 },
        );
      } catch (err) {
        context.warn(
          `notifications.caChanges.degraded ${String((err as Error).message ?? err)}`,
        );
        return { windowHours: 24, count: 0, samples: [] as const };
      }
    })();
    const [
      ingestRows,
      briefHealth,
      postureHealth,
      incidentsHealth,
      settingsRows,
      caChanges,
    ] = await Promise.all([
      listIngestHealthRows(opsCtx, config.tenantId),
      readHealthOptional(agentHealthTable, config.tenantId, "brief"),
      readHealthOptional(agentHealthTable, config.tenantId, "posture"),
      readHealthOptional(agentHealthTable, config.tenantId, "incidents-analysis"),
      listSettingsRows(settingsTable, config.tenantId),
      caChangesPromise,
    ]);

    const now = new Date();
    const recentCutoff = new Date(now.getTime() - SETTINGS_RECENT_WINDOW_MS);
    const out: Notification[] = [];

    // 1. Ingest health
    for (const row of ingestRows) {
      // licence_required is steady-state, not actionable.
      if (row.status === "licence_required") continue;
      if (row.status === "healthy" && row.consecutiveFailureCount === 0) continue;

      const sourceLabel = INGEST_SOURCE_LABELS[row.source] ?? row.source;
      if (row.status === "failing" || row.consecutiveFailureCount >= 3) {
        out.push({
          id: `ingest-failure:${row.source}`,
          kind: "ingest-failure",
          tone: "danger",
          title: `${sourceLabel} is failing`,
          detail: `${row.consecutiveFailureCount} consecutive failures${
            row.lastFailureAt ? ` · last at ${row.lastFailureAt}` : ""
          }`,
          timestamp: row.lastFailureAt ?? row.updatedAt,
        });
        continue;
      }
      if (row.status === "degrading") {
        out.push({
          id: `ingest-degrading:${row.source}`,
          kind: "ingest-degrading",
          tone: "warning",
          title: `${sourceLabel} is retrying`,
          detail: `${row.consecutiveFailureCount} consecutive failures · ingest is in backoff`,
          timestamp: row.lastFailureAt ?? row.updatedAt,
        });
      }
    }

    // 2. Agent circuit breaker
    const agents = [
      { name: "brief", row: briefHealth, label: "Daily Brief" },
      { name: "posture", row: postureHealth, label: "Weekly Posture" },
      { name: "incidents-analysis", row: incidentsHealth, label: "Incidents analysis" },
    ] as const;
    for (const a of agents) {
      if (!a.row) continue;
      if (a.row.state === "closed") continue;
      if (a.row.state === "open") {
        out.push({
          id: `agent-open:${a.name}`,
          kind: "agent-circuit-open",
          tone: "danger",
          title: `${a.label} agent · circuit tripped`,
          detail: `${a.row.consecutiveFailures} consecutive failures${
            a.row.nextProbeAt ? ` · next probe at ${a.row.nextProbeAt}` : ""
          }${a.row.lastFailureKind ? ` · ${a.row.lastFailureKind}` : ""}`,
          timestamp: a.row.lastFailureAt ?? a.row.updatedAt,
        });
        continue;
      }
      // half_open
      out.push({
        id: `agent-half-open:${a.name}`,
        kind: "agent-circuit-half-open",
        tone: "warning",
        title: `${a.label} agent · trial probe in flight`,
        detail: `Recovering after ${a.row.consecutiveFailures} consecutive failures`,
        timestamp: a.row.updatedAt,
      });
    }

    // 3. Recent CA policy changes (ADR-0034 §3.3) — one notification per
    // sampled change. The samples cap (10) covers the typical drift signal;
    // bulk re-shuffles emit a single aggregated entry instead via the count.
    if (caChanges.count > caChanges.samples.length) {
      // §10.55 L-1 fix: include `count` in the bulk-event ID so a re-emit
      // within the same hour with a different count produces a distinct
      // notification (previous shape `bulk:<hour>` collided across re-emits).
      out.push({
        id: `ca-policy-changed:bulk:${now.toISOString().slice(0, 13)}:${caChanges.count}`,
        kind: "ca-policy-changed",
        tone: "warning",
        title: `${caChanges.count} Conditional Access policy changes`,
        detail: `${caChanges.count} policy diff events in the last 24 hours — see /admin/diagnostics`,
        timestamp: now.toISOString(),
      });
    } else {
      for (const c of caChanges.samples) {
        out.push({
          id: `ca-policy-changed:${c.policyId}:${c.observedAt}`,
          kind: "ca-policy-changed",
          tone: c.diffKind === "deleted" ? "danger" : "warning",
          title: `CA policy ${c.diffKind}: ${c.displayName}`,
          detail: `Observed at ${c.observedAt}`,
          timestamp: c.observedAt,
        });
      }
    }

    // 4. Recent settings changes
    for (const row of settingsRows) {
      if (!row.updatedAt) continue;
      const t = Date.parse(row.updatedAt);
      if (!Number.isFinite(t) || t < recentCutoff.getTime()) continue;
      const label = SETTINGS_ROW_LABELS[row.rowKey] ?? row.rowKey;
      out.push({
        id: `settings-changed:${row.rowKey}:${row.updatedAt}`,
        kind: "settings-changed",
        tone: "info",
        title: `${label} updated`,
        detail: row.updatedBy
          ? `Changed by ${row.updatedBy} at ${row.updatedAt}`
          : `Changed at ${row.updatedAt}`,
        timestamp: row.updatedAt,
      });
    }

    // Sort by timestamp desc — most recent surfaces first.
    out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

    const body: NotificationsResponse = {
      schemaVersion: 1,
      notifications: out,
      generatedAt: now.toISOString(),
    };
    return {
      status: 200,
      jsonBody: body,
      headers: {
        "cache-control": "private, max-age=60",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`notifications.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "notifications data is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

interface SettingsRow {
  readonly rowKey: string;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/**
 * Partition-scoped TenantSettings list — only the metadata fields we
 * need for notifications. Avoids pulling the full row payload.
 */
async function listSettingsRows(
  table: TableClient,
  tenantId: string,
): Promise<readonly SettingsRow[]> {
  const out: SettingsRow[] = [];
  const filter = `PartitionKey eq '${tenantId.replace(/'/g, "''")}'`;
  for await (const e of table.listEntities<{
    rowKey: string;
    UpdatedAt?: string;
    UpdatedBy?: string;
  }>({
    queryOptions: { filter },
  })) {
    out.push({
      rowKey: e.rowKey,
      updatedAt: typeof e.UpdatedAt === "string" && e.UpdatedAt ? e.UpdatedAt : null,
      updatedBy: typeof e.UpdatedBy === "string" && e.UpdatedBy ? e.UpdatedBy : null,
    });
  }
  return out;
}

app.http("getNotifications", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "notifications",
  handler,
});
