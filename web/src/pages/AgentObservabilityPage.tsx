// /admin/agents — operator view of "what's the AI plane doing right now"
//
// Three cards (brief / posture / incidents-analysis), each surfacing:
//   - Circuit-breaker state (closed / half_open / open) as a tone badge
//   - Latest successful run timestamp + model + tokens + key
//   - This-period budget bucket (today's daily for brief + incidents,
//     this-ISO-week for posture) + spend-line + meter against ceiling
//   - Schedule (next fire ETA for daily/weekly, "on-demand" for incidents)
//
// Refetches every 30s — operators leaving this page open get near-realtime
// state without polling pressure on the API.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { Icon, type IconName } from "@/components/Icon";
import { PageSubheader } from "@/components/shell/PageSubheader";
import {
  useAdminAgents,
  useAgentRunHistory,
  type AgentBudgetView,
  type AgentHealthView,
  type AgentLatestRunView,
  type AgentName,
  type AgentObservability,
  type AgentRunHistoryItem,
  type AgentScheduleView,
} from "@/features/common/agentObservability";

const AGENT_DISPLAY_NAMES: Readonly<Record<AgentName, string>> = {
  brief: "Daily Brief",
  posture: "Weekly Posture",
  "incidents-analysis": "Incidents analysis",
};

const AGENT_ICONS: Readonly<Record<AgentName, IconName>> = {
  brief: "doc",
  posture: "shield",
  "incidents-analysis": "alert",
};

export function AgentObservabilityPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const query = useAdminAgents();

  useEffect(() => {
    if (!user.isLoading && !user.hasRole("admin")) {
      navigate("/", { replace: true });
    }
  }, [user.isLoading, user, navigate]);

  if (user.isLoading || !user.hasRole("admin")) return null;

  return (
    <>
      <PageSubheader
        title="Agent observability"
        sub="Live state of the three AI specialists — circuit-breaker, last run, current spend bucket, and next fire."
      />
      <main className="app-main">
        {query.isPending && <CardsSkeleton />}
        {query.isError && (
          <p className="t-body" style={{ color: "var(--red-fg)" }}>
            Could not load agent state.{" "}
            {query.error instanceof ApiError
              ? `(${query.error.status}) ${query.error.message}`
              : (query.error as Error).message}
          </p>
        )}
        {query.isSuccess && (
          <div className="agent-cards">
            {query.data.agents.map((a) => (
              <AgentCard key={a.agentName} agent={a} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}

function AgentCard({ agent }: { agent: AgentObservability }) {
  // Run-history is lazy — query only fires when the operator expands the
  // section. Keeps the page's first paint fast and avoids three audit-blob
  // walks per page-load when the operator just wanted the at-a-glance view.
  const [showRuns, setShowRuns] = useState(false);
  return (
    <article className="tile">
      <div className="tile__head">
        <h2 className="tile__title">
          <Icon name={AGENT_ICONS[agent.agentName]} size={14} className="tile__title-icon" />
          {AGENT_DISPLAY_NAMES[agent.agentName]}
        </h2>
        <div className="tile__head-meta">
          <HealthBadge health={agent.health} />
        </div>
      </div>
      <div
        className="tile__body"
        style={{ display: "flex", flexDirection: "column", gap: "var(--sp-l)" }}
      >
        <LatestRunBlock latest={agent.latestRun} cadence={agent.cadence} />
        <BudgetBlock budget={agent.budget} />
        <ScheduleBlock schedule={agent.schedule} />
        {agent.health.lastFailureKind && <LastFailureBlock health={agent.health} />}
        <RunHistoryBlock
          agentName={agent.agentName}
          expanded={showRuns}
          onToggle={() => setShowRuns((s) => !s)}
        />
      </div>
    </article>
  );
}

function RunHistoryBlock({
  agentName,
  expanded,
  onToggle,
}: {
  agentName: AgentName;
  expanded: boolean;
  onToggle: () => void;
}) {
  const query = useAgentRunHistory(expanded ? agentName : null, 20);
  return (
    <section>
      <div className="row row--between">
        <p className="t-eyebrow">Recent runs</p>
        <button
          type="button"
          className="btn btn--small btn--subtle"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {expanded ? "Hide" : "Show last 20"}
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: "var(--sp-s)" }}>
          {query.isPending && <p className="t-caption">Loading recent runs…</p>}
          {query.isError && (
            <p className="t-body" style={{ color: "var(--red-fg)" }}>
              Could not load run history.{" "}
              {query.error instanceof ApiError
                ? `(${query.error.status}) ${query.error.message}`
                : (query.error as Error).message}
            </p>
          )}
          {query.isSuccess && query.data.items.length === 0 && (
            <p className="t-body t-body--mute">
              No runs in the last {query.data.range.lookbackDays} days.
            </p>
          )}
          {query.isSuccess && query.data.items.length > 0 && (
            <RunHistoryTable items={query.data.items} />
          )}
        </div>
      )}
    </section>
  );
}

function RunHistoryTable({ items }: { items: readonly AgentRunHistoryItem[] }) {
  return (
    <table className="dt" style={{ fontSize: "var(--fs-200)" }}>
      <thead>
        <tr>
          <th>Started</th>
          <th>Status</th>
          <th className="num">Tokens</th>
          <th className="num">Latency</th>
          <th>Trigger</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r, i) => (
          <tr key={`${r.runId}-${i}`}>
            <td className="t-body--mute">
              {new Date(r.startedAt).toLocaleString(undefined, {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </td>
            <td>
              <span className={`badge badge--${statusTone(r.status, r.errorKind)}`}>
                {r.errorKind ?? r.status ?? "—"}
              </span>
            </td>
            <td className="num tnum">
              {r.tokensIn !== null && r.tokensOut !== null
                ? (r.tokensIn + r.tokensOut).toLocaleString()
                : "—"}
            </td>
            <td className="num tnum">{r.latencyMs !== null ? `${r.latencyMs} ms` : "—"}</td>
            <td className="t-body--mute">{r.trigger ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function statusTone(status: string | null, errorKind: string | null): string {
  if (errorKind) return "danger";
  if (status === "success") return "success";
  if (status === "no_data" || status === "cache_hit") return "info";
  if (status === "degraded") return "warning";
  if (status === "budget_exhausted" || status === "circuit_open") return "warning";
  if (status === "error") return "danger";
  return "neutral";
}

function HealthBadge({ health }: { health: AgentHealthView }) {
  if (health.state === "closed") {
    return <span className="badge badge--success">Healthy</span>;
  }
  if (health.state === "half_open") {
    return (
      <span className="badge badge--warning">Probing · {health.consecutiveFailures} failures</span>
    );
  }
  return (
    <span className="badge badge--danger">Tripped · {health.consecutiveFailures} failures</span>
  );
}

function LatestRunBlock({
  latest,
  cadence,
}: {
  latest: AgentLatestRunView | null;
  cadence: "daily" | "weekly" | "on-demand";
}) {
  if (!latest) {
    const cadenceWord =
      cadence === "daily"
        ? "Awaiting first daily run."
        : cadence === "weekly"
          ? "Awaiting first weekly run."
          : "No on-demand analyses yet.";
    return (
      <section>
        <p className="t-eyebrow">Latest run</p>
        <p className="t-body t-body--mute">{cadenceWord}</p>
      </section>
    );
  }
  const totalTokens = latest.tokensIn + latest.tokensOut;
  return (
    <section>
      <p className="t-eyebrow">Latest run</p>
      <div className="row" style={{ gap: "var(--sp-m)", flexWrap: "wrap" }}>
        <span className="badge badge--neutral">
          {latest.keyKind === "briefDate" && `briefDate ${latest.key}`}
          {latest.keyKind === "isoWeek" && `isoWeek ${latest.key}`}
          {latest.keyKind === "incidentId" && `incident ${latest.key}`}
        </span>
        <span className="t-body--mute">{new Date(latest.generatedAt).toLocaleString()}</span>
      </div>
      <p className="t-caption" style={{ marginTop: 4 }}>
        <span className="t-mono">{latest.modelDeployment}</span>
        {" · "}
        {totalTokens.toLocaleString()} tokens ({latest.tokensIn.toLocaleString()} in
        {" / "}
        {latest.tokensOut.toLocaleString()} out)
      </p>
    </section>
  );
}

function BudgetBlock({ budget }: { budget: AgentBudgetView }) {
  const cadenceLabel = budget.bucketCadence === "weekly" ? "This week" : "Today";
  const tokenPct =
    budget.ceilings.tokens > 0
      ? Math.min(100, Math.round((budget.tokensActualTotal / budget.ceilings.tokens) * 100))
      : 0;
  const meterCls =
    tokenPct > 80
      ? "meter__fill meter__fill--danger"
      : tokenPct > 50
        ? "meter__fill meter__fill--warn"
        : "meter__fill";
  if (budget.empty) {
    return (
      <section>
        <p className="t-eyebrow">Budget · {cadenceLabel.toLowerCase()}</p>
        <p className="t-body t-body--mute" style={{ fontStyle: "italic" }}>
          No runs yet for this bucket ({budget.bucketKey}).
        </p>
      </section>
    );
  }
  const totalRuns = budget.runsSucceeded + budget.runsFailed;
  const manualPct =
    budget.ceilings.manualRun > 0
      ? Math.min(100, Math.round((budget.manualRunsToday / budget.ceilings.manualRun) * 100))
      : 0;
  return (
    <section>
      <p className="t-eyebrow">Budget · {cadenceLabel.toLowerCase()}</p>
      <div className="meter">
        <div className={meterCls} style={{ width: `${tokenPct}%` }} />
      </div>
      <div className="spend-line" style={{ marginTop: 6 }}>
        <span className="spend-line__metric">
          <strong>{budget.tokensActualTotal.toLocaleString()} tk</strong> ({tokenPct}% of ceiling)
        </span>
        <span className="spend-line__metric">
          <strong>{totalRuns}</strong> run{totalRuns === 1 ? "" : "s"} ({budget.runsSucceeded} ok
          {budget.runsFailed > 0 ? `, ${budget.runsFailed} failed` : ""})
        </span>
        <span className="spend-line__metric">
          <strong>{budget.manualRunsToday}</strong> manual today ({manualPct}% of ceiling)
        </span>
      </div>
    </section>
  );
}

function ScheduleBlock({ schedule }: { schedule: AgentScheduleView }) {
  if (schedule.cadence === "on-demand") {
    return (
      <section>
        <p className="t-eyebrow">Schedule</p>
        <p className="t-body t-body--mute">
          On-demand only — fires when an admin requests an analysis.
        </p>
      </section>
    );
  }
  if (!schedule.nextFireAt) {
    return (
      <section>
        <p className="t-eyebrow">Schedule</p>
        <p className="t-body t-body--mute">
          Cron <code>{schedule.cron ?? "—"}</code> · next fire unknown.
        </p>
      </section>
    );
  }
  const next = new Date(schedule.nextFireAt);
  const deltaMs = next.getTime() - Date.now();
  return (
    <section>
      <p className="t-eyebrow">Schedule</p>
      <p className="t-body">
        Cron <code>{schedule.cron ?? "—"}</code>
        {" · "}
        next fire {next.toLocaleString()} ({formatRelativeFuture(deltaMs)})
      </p>
    </section>
  );
}

function LastFailureBlock({ health }: { health: AgentHealthView }) {
  return (
    <section>
      <p className="t-eyebrow">Last failure</p>
      <p className="t-body">
        <span className="badge badge--warning">{health.lastFailureKind}</span>
        {health.lastFailureAt && (
          <>
            {" "}
            <span className="t-body--mute">
              at {new Date(health.lastFailureAt).toLocaleString()}
            </span>
          </>
        )}
      </p>
      {health.nextProbeAt && (
        <p className="t-caption" style={{ marginTop: 4 }}>
          Next probe at {new Date(health.nextProbeAt).toLocaleString()}
        </p>
      )}
    </section>
  );
}

function CardsSkeleton() {
  return (
    <div className="agent-cards">
      {[0, 1, 2].map((i) => (
        <article key={i} className="tile">
          <div className="tile__head">
            <h2 className="tile__title">Loading…</h2>
          </div>
          <div className="tile__body">
            <Skeleton>
              <SkeletonItem size={48} />
              <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
              <SkeletonItem size={48} style={{ marginTop: "var(--sp-s)" }} />
            </Skeleton>
          </div>
        </article>
      ))}
    </div>
  );
}

function formatRelativeFuture(deltaMs: number): string {
  if (deltaMs <= 0) return "overdue";
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `in ${days}d`;
}
