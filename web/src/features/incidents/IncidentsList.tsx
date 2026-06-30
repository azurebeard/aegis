// Incidents list view (ADR-0016 §1.2) — Aegis UI Phase 3 redesign.
// Surface: design-system `surface` + `incidents-toolbar` (search + chip
// filters) + `dt` table + `pag` footer. Microsoft-authored prose fields
// render plain-text only.

import { useMemo, useState } from "react";
import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { Icon } from "@/components/Icon";
import { useIncidentsList } from "./queries";
import { isSameSearch, useSavedIncidentSearches, type SavedIncidentSearch } from "./savedSearches";
import type { IncidentSeverity, IncidentStatus, IncidentSummary } from "./types";

interface IncidentsListProps {
  readonly onSelect: (id: string) => void;
  readonly selectedId?: string | null;
}

const SEV_CHIPS: readonly { key: IncidentSeverity; label: string; dot: string }[] = [
  { key: "high", label: "High", dot: "high" },
  { key: "medium", label: "Medium", dot: "medium" },
  { key: "low", label: "Low", dot: "low" },
  { key: "informational", label: "Info", dot: "info" },
];

const STATUS_CHIPS: readonly { key: IncidentStatus; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "inProgress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
];

function severityBadgeTone(s: IncidentSeverity): string {
  if (s === "high") return "danger";
  if (s === "medium") return "warning";
  if (s === "low") return "info";
  return "neutral";
}

function severityDot(s: IncidentSeverity): string {
  if (s === "high") return "high";
  if (s === "medium") return "medium";
  if (s === "low") return "low";
  return "info";
}

function severityLabel(s: IncidentSeverity): string {
  if (s === "informational") return "Info";
  return s[0]!.toUpperCase() + s.slice(1);
}

function statusLabel(s: IncidentStatus): string {
  if (s === "inProgress") return "In progress";
  if (s === "awaitingAction") return "Awaiting action";
  return s[0]!.toUpperCase() + s.slice(1);
}

function classificationLabel(c: string): string {
  if (c === "truePositive") return "True positive";
  if (c === "falsePositive") return "False positive";
  if (c === "informationalExpectedActivity") return "Benign positive";
  if (c === "unknown") return "Unknown";
  return c;
}

function shortUpdated(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function IncidentsList({ onSelect, selectedId }: IncidentsListProps) {
  const [sevFilters, setSevFilters] = useState<Record<IncidentSeverity, boolean>>({
    high: true,
    medium: true,
    low: false,
    informational: false,
    unknown: false,
  });
  const [statusFilters, setStatusFilters] = useState<Record<IncidentStatus, boolean>>({
    active: true,
    inProgress: true,
    resolved: false,
    redirected: false,
    awaitingAction: false,
  });
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const savedSearches = useSavedIncidentSearches();

  const applySearch = (s: SavedIncidentSearch): void => {
    setSevFilters(s.sevFilters);
    setStatusFilters(s.statusFilters);
    setQuery(s.query);
    setCursor(null);
  };

  const onSaveCurrent = (): void => {
    const name = window.prompt("Name this saved search", "")?.trim();
    if (!name) return;
    savedSearches.add({ name, sevFilters, statusFilters, query });
  };

  const activeSeverities = useMemo(
    () => SEV_CHIPS.filter((c) => sevFilters[c.key]).map((c) => c.key),
    [sevFilters],
  );
  const activeStatuses = useMemo(
    () => STATUS_CHIPS.filter((c) => statusFilters[c.key]).map((c) => c.key),
    [statusFilters],
  );

  const list = useIncidentsList({
    severity: activeSeverities,
    status: activeStatuses,
    cursor,
    includeRedirected: false,
    limit: 25,
  });

  const filtered: readonly IncidentSummary[] = useMemo(() => {
    if (!list.data) return [];
    if (!query) return list.data.incidents;
    const q = query.toLowerCase();
    return list.data.incidents.filter(
      (i) =>
        i.displayName.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q) ||
        (i.assignedTo ?? "").toLowerCase().includes(q),
    );
  }, [list.data, query]);

  const sevToggle = (k: IncidentSeverity) => {
    setSevFilters((f) => ({ ...f, [k]: !f[k] }));
    setCursor(null);
  };
  const statusToggle = (k: IncidentStatus) => {
    setStatusFilters((f) => ({ ...f, [k]: !f[k] }));
    setCursor(null);
  };

  return (
    <div className="surface" style={{ overflow: "hidden" }}>
      {/* Saved searches row — operator-bookmarked filter sets, persisted
       *  client-side via localStorage. The chip whose filter state matches
       *  the live filters is highlighted as `aria-pressed=true` so the
       *  operator can tell at a glance which view is active. */}
      <div className="saved-searches">
        {savedSearches.searches.length === 0 ? (
          <span className="t-caption t-body--mute">
            No saved searches yet — set your filters and click Save view.
          </span>
        ) : (
          savedSearches.searches.map((s) => {
            const active = isSameSearch(s, { sevFilters, statusFilters, query });
            return (
              <span key={s.id} className="saved-searches__pill">
                <button
                  type="button"
                  className="chip-filter saved-searches__apply"
                  aria-pressed={active}
                  onClick={() => applySearch(s)}
                  title={`Apply saved search · ${s.name}`}
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  className="saved-searches__delete"
                  onClick={() => {
                    if (window.confirm(`Delete saved search "${s.name}"?`)) {
                      savedSearches.remove(s.id);
                    }
                  }}
                  aria-label={`Delete saved search ${s.name}`}
                  title={`Delete saved search ${s.name}`}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            );
          })
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn--small btn--subtle"
          onClick={onSaveCurrent}
          title="Save the current filter set as a named view"
        >
          Save view
        </button>
      </div>
      <div className="incidents-toolbar">
        <div className="search-input">
          <Icon name="search" size={14} style={{ color: "var(--fg-3)" }} />
          <input
            placeholder="Search incidents by id, name, or affected user…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search incidents"
          />
        </div>
        {SEV_CHIPS.map((c) => (
          <button
            key={c.key}
            className="chip-filter"
            aria-pressed={sevFilters[c.key]}
            onClick={() => sevToggle(c.key)}
            type="button"
          >
            <span className={`dot dot--${c.dot}`} />
            {c.label}
          </button>
        ))}
        <span
          aria-hidden
          style={{ width: 1, height: 20, background: "var(--stroke-2)", margin: "0 4px" }}
        />
        {STATUS_CHIPS.map((c) => (
          <button
            key={c.key}
            className="chip-filter"
            aria-pressed={statusFilters[c.key]}
            onClick={() => statusToggle(c.key)}
            type="button"
          >
            {c.label}
          </button>
        ))}
      </div>

      {list.isPending && (
        <div style={{ padding: "var(--sp-l)" }}>
          <Skeleton>
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonItem key={i} size={32} style={{ marginTop: "var(--sp-s)" }} />
            ))}
          </Skeleton>
        </div>
      )}

      {list.isError && (
        <div style={{ padding: "var(--sp-l)" }}>
          <p className="t-body" style={{ color: "var(--red-fg)" }}>
            Could not load incidents. {(list.error as Error).message}
            {list.error instanceof ApiError && list.error.status === 400 && (
              <> — try resetting filters and try again.</>
            )}
          </p>
        </div>
      )}

      {list.isSuccess && (
        <>
          <div style={{ overflowX: "auto" }}>
            <table className="dt">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>Severity</th>
                  <th>Incident</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th style={{ width: 150 }}>Classification</th>
                  <th className="num" style={{ width: 80 }}>
                    Alerts
                  </th>
                  <th
                    style={{ width: 60, textAlign: "center" }}
                    title="AI analysis present"
                    aria-label="AI analysis present"
                  >
                    AI
                  </th>
                  <th style={{ width: 150 }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((inc) => (
                  <tr
                    key={inc.id}
                    className={selectedId === inc.id ? "is-selected" : ""}
                    onClick={() => onSelect(inc.id)}
                  >
                    <td>
                      <span className="sev-cell">
                        <span className={`dot dot--${severityDot(inc.severity)}`} />
                        <span className={`badge badge--${severityBadgeTone(inc.severity)}`}>
                          {severityLabel(inc.severity)}
                        </span>
                      </span>
                    </td>
                    <td>
                      {/* Plain-text — Microsoft-authored prose. */}
                      <p className="name">{inc.displayName}</p>
                      <span className="id">
                        {inc.id}
                        {inc.assignedTo ? ` · ${inc.assignedTo}` : ""}
                      </span>
                    </td>
                    <td>
                      <span className="badge badge--neutral">{statusLabel(inc.status)}</span>
                    </td>
                    <td className="t-body--mute" style={{ fontSize: "var(--fs-300)" }}>
                      {classificationLabel(inc.classification)}
                    </td>
                    <td className="num tnum">{inc.alertCount}</td>
                    <td style={{ textAlign: "center" }}>
                      {inc.hasAnalysis === true ? (
                        <span
                          className="ai-mark"
                          aria-label="AI analysis available"
                          title="AI analysis available — open this incident to view"
                        >
                          AI
                        </span>
                      ) : (
                        <span className="t-body--mute" aria-hidden="true">
                          —
                        </span>
                      )}
                    </td>
                    <td className="t-body--mute">{shortUpdated(inc.lastUpdateDateTime)}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", padding: "var(--sp-xl)" }}>
                      <p className="t-body t-body--mute">No incidents match the current filters.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="pag">
            <span>
              Showing <strong style={{ color: "var(--fg-1)" }}>{filtered.length}</strong>
              {list.data.page.hasMore ? " of more (paged)" : ` of ${list.data.incidents.length}`}
            </span>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn btn--small"
                disabled={cursor === null}
                onClick={() => setCursor(null)}
                type="button"
              >
                ← First
              </button>
              <button
                className="btn btn--small"
                disabled={!list.data.page.hasMore || !list.data.page.nextCursor}
                onClick={() => setCursor(list.data.page.nextCursor)}
                type="button"
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
