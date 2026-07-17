// Lazy-expand "Recent runs" block, mounted under the Secure Score tile when
// the ingest is failing or has not yet produced a snapshot. Reads the last 20
// audit lines from /api/agents/observability/ingest-runs and renders one row
// per run (started, status, rows, graph attempts, snapshot date).
//
// Lazy pattern matches AgentObservabilityPage.RunHistoryBlock — query is
// `enabled` only when expanded, so the audit-blob walk doesn't fire on every
// dashboard load. Admin-gated at the API layer; non-admins won't see the
// trigger button (caller passes `isAdmin`).

import { ApiError } from "@/api/client";
import {
  useIngestRunHistory,
  type IngestRunHistoryItem,
  type IngestSourceKey,
} from "./ingestRunHistory";

export function IngestRunHistoryBlock({
  source,
  expanded,
  onToggle,
}: {
  source: IngestSourceKey;
  expanded: boolean;
  onToggle: () => void;
}) {
  const query = useIngestRunHistory(expanded ? source : null, 20);
  return (
    <section style={{ marginTop: "var(--sp-m)" }}>
      <div className="row row--between">
        <p className="t-eyebrow">Recent ingest runs</p>
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
            <IngestRunHistoryTable items={query.data.items} />
          )}
        </div>
      )}
    </section>
  );
}

function IngestRunHistoryTable({ items }: { items: readonly IngestRunHistoryItem[] }) {
  return (
    <table className="dt" style={{ fontSize: "var(--fs-200)" }}>
      <thead>
        <tr>
          <th>Started</th>
          <th>Status</th>
          <th className="num">Rows</th>
          <th className="num">Graph attempts</th>
          <th>Snapshot</th>
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
              {r.rowsWritten !== null ? r.rowsWritten.toLocaleString() : "—"}
            </td>
            <td className="num tnum">{r.graphAttempts !== null ? r.graphAttempts : "—"}</td>
            <td className="t-body--mute">{r.snapshotDate ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function statusTone(status: string | null, errorKind: string | null): string {
  if (errorKind) return "danger";
  if (status === "success") return "success";
  if (status === "no_data") return "info";
  if (status === "error") return "danger";
  return "neutral";
}
