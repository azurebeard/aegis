// /kev — top-level KEV exposure page (ADR-0032).
//
// Renders one row per (stack item × CVE) match, sorted by due-date
// ascending so the most urgent remediation work is at the top. Reader-
// or-admin gated. Admin-only "Run now" button triggers the KEV ingest
// out of band (rate-limited 30/day per tenant).

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ApiError, api } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { PageSubheader } from "@/components/shell/PageSubheader";
import {
  useClearKevSuppression,
  useKevSummary,
  useSetKevSuppression,
} from "@/features/kev/queries";
import { useStackItems, STACK_ITEMS_KEY } from "@/features/stack/queries";
import {
  KEV_STATUS_LABELS,
  KEV_SUPPRESSION_STATUSES,
  STACK_CATEGORY_LABELS,
  STACK_ENVIRONMENT_LABELS,
  type CveMatchSummary,
  type KevSuppressionStatus,
  type StackItem,
} from "@/features/stack/types";

interface MatchRow {
  readonly item: StackItem;
  readonly cve: CveMatchSummary;
}

const DEFAULT_VISIBLE: ReadonlySet<KevSuppressionStatus> = new Set(["open"]);

// --- Column sort -----------------------------------------------------------

type SortColumn = "dueDate" | "cveID" | "stackItem" | "status";
type SortDir = "asc" | "desc";

const STATUS_ORDER: Readonly<Record<KevSuppressionStatus, number>> = {
  open: 0,
  acknowledged: 1,
  risk_accepted: 2,
  remediated: 3,
  not_applicable: 4,
};

function parseSortColumn(raw: string | null): SortColumn {
  if (raw === "cveID" || raw === "stackItem" || raw === "status") return raw;
  return "dueDate";
}

function parseSortDir(raw: string | null): SortDir {
  return raw === "desc" ? "desc" : "asc";
}

function compareRows(a: MatchRow, b: MatchRow, col: SortColumn): number {
  switch (col) {
    case "dueDate": {
      // Empty due-dates sink to the bottom regardless of direction so they
      // never masquerade as "needs immediate action".
      const ad = a.cve.dueDate || "9999-12-31";
      const bd = b.cve.dueDate || "9999-12-31";
      if (ad < bd) return -1;
      if (ad > bd) return 1;
      // Tiebreaker: ransomware-linked first.
      const ar = a.cve.knownRansomwareCampaignUse === "Known" ? 0 : 1;
      const br = b.cve.knownRansomwareCampaignUse === "Known" ? 0 : 1;
      if (ar !== br) return ar - br;
      return a.cve.cveID.localeCompare(b.cve.cveID);
    }
    case "cveID":
      return a.cve.cveID.localeCompare(b.cve.cveID);
    case "stackItem": {
      const av = `${a.item.vendor}${a.item.product}${a.item.version}`;
      const bv = `${b.item.vendor}${b.item.product}${b.item.version}`;
      const r = av.localeCompare(bv);
      if (r !== 0) return r;
      return a.cve.cveID.localeCompare(b.cve.cveID);
    }
    case "status": {
      const r = STATUS_ORDER[a.cve.status] - STATUS_ORDER[b.cve.status];
      if (r !== 0) return r;
      return a.cve.cveID.localeCompare(b.cve.cveID);
    }
  }
}

export function KevPage() {
  const user = useCurrentUser();
  const itemsQ = useStackItems();
  const summaryQ = useKevSummary();
  const isAdmin = user.hasRole("admin");
  const [visible, setVisible] = useState<Set<KevSuppressionStatus>>(() => new Set(DEFAULT_VISIBLE));
  const [searchParams, setSearchParams] = useSearchParams();
  const sortBy = parseSortColumn(searchParams.get("sortBy"));
  const sortDir = parseSortDir(searchParams.get("sortDir"));

  function handleSort(col: SortColumn) {
    const next = new URLSearchParams(searchParams);
    if (col === sortBy) {
      next.set("sortDir", sortDir === "asc" ? "desc" : "asc");
    } else {
      next.set("sortBy", col);
      next.set("sortDir", "asc");
    }
    setSearchParams(next, { replace: true });
  }

  const allRows = useMemo<readonly MatchRow[]>(() => {
    if (!itemsQ.data) return [];
    const out: MatchRow[] = [];
    for (const item of itemsQ.data.items) {
      const matches = item.kevMatches ?? [];
      for (const cve of matches) out.push({ item, cve });
    }
    out.sort((a, b) => {
      const c = compareRows(a, b, sortBy);
      return sortDir === "asc" ? c : -c;
    });
    return out;
  }, [itemsQ.data, sortBy, sortDir]);

  const rows = useMemo(() => allRows.filter((r) => visible.has(r.cve.status)), [allRows, visible]);

  const counts = useMemo(() => {
    const c: Record<KevSuppressionStatus, number> = {
      open: 0,
      acknowledged: 0,
      risk_accepted: 0,
      remediated: 0,
      not_applicable: 0,
    };
    for (const r of allRows) c[r.cve.status]++;
    return c;
  }, [allRows]);

  function toggleStatus(s: KevSuppressionStatus) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      // Keep at least one chip enabled — otherwise the page is blank
      // with no obvious next action.
      if (next.size === 0) next.add("open");
      return next;
    });
  }

  if (user.isLoading || !user.isAuthenticated) return null;

  return (
    <>
      <PageSubheader
        title="KEV exposure"
        sub="CISA Known Exploited Vulnerabilities cross-referenced against your registered stack inventory. Most urgent (closest due date) first."
      />
      <main className="app-main">
        <div className="kev-shell">
          <KevHeader summary={summaryQ.data ?? null} isAdmin={isAdmin} />
          <StatusFilterChips counts={counts} visible={visible} onToggle={toggleStatus} />
          {itemsQ.isPending && <p className="t-body t-body--mute">Loading…</p>}
          {itemsQ.isError && (
            <p className="t-body" style={{ color: "var(--red-fg)" }}>
              Could not load KEV exposure.{" "}
              {itemsQ.error instanceof ApiError
                ? `(${itemsQ.error.status}) ${itemsQ.error.message}`
                : (itemsQ.error as Error).message}
            </p>
          )}
          {itemsQ.isSuccess && rows.length === 0 && (
            <FilteredEmptyState
              totalItems={itemsQ.data.items.length}
              totalRows={allRows.length}
              visible={visible}
            />
          )}
          {itemsQ.isSuccess && rows.length > 0 && (
            <KevTable
              rows={rows}
              isAdmin={isAdmin}
              sortBy={sortBy}
              sortDir={sortDir}
              onSort={handleSort}
            />
          )}
        </div>
      </main>
    </>
  );
}

function KevHeader({
  summary,
  isAdmin,
}: {
  summary: ReturnType<typeof useKevSummary>["data"] | null;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const runNow = useMutation<unknown, Error, void>({
    mutationFn: () => api.post("/api/ingest/kev/run"),
    onSuccess: () => {
      // The KEV ingest can change the matches that show on /kev — invalidate
      // both queries so the page refreshes with the new state.
      void qc.invalidateQueries({ queryKey: ["kev", "summary"] });
      void qc.invalidateQueries({ queryKey: STACK_ITEMS_KEY });
    },
  });

  return (
    <div className="kev-header print-hide">
      {summary && (
        <p className="t-body t-body--mute">
          Catalog: <strong>{summary.catalog.totalEntries.toLocaleString()}</strong> active CVEs
          {summary.catalog.removedEntries > 0 &&
            ` (${summary.catalog.removedEntries} removed by CISA, retained for forensic record)`}
          {summary.health.lastSuccessAt && (
            <> · last sync {new Date(summary.health.lastSuccessAt).toLocaleString()}</>
          )}
          {" · ingest "}
          <strong>{summary.health.status}</strong>
        </p>
      )}
      {isAdmin && (
        <div className="row" style={{ gap: "var(--sp-s)" }}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            aria-label="Run KEV ingest now"
          >
            {runNow.isPending ? "Running…" : "Run now"}
          </button>
          <span className="t-caption">Admin-only · 30/day per tenant</span>
        </div>
      )}
      {runNow.isSuccess && (
        <p className="banner banner--success" role="status">
          KEV ingest completed. Matches refreshed.
        </p>
      )}
      {runNow.isError && (
        <p className="banner banner--danger" role="alert">
          Run failed.{" "}
          {runNow.error instanceof ApiError
            ? `(${runNow.error.status}) ${runNow.error.message}`
            : (runNow.error as Error).message}
        </p>
      )}
    </div>
  );
}

function FilteredEmptyState({
  totalItems,
  totalRows,
  visible,
}: {
  totalItems: number;
  totalRows: number;
  visible: ReadonlySet<KevSuppressionStatus>;
}) {
  if (totalItems === 0) {
    return (
      <p className="t-body t-body--mute">
        No stack items registered yet — admins can add items via{" "}
        <a href="/admin?section=stack">Admin → Stack inventory</a>.
      </p>
    );
  }
  if (totalRows === 0) {
    return (
      <p className="t-body t-body--mute">
        None of your <strong>{totalItems}</strong> registered stack items match an entry on the CISA
        KEV catalogue. This is the desired state — Aegis re-checks daily.
      </p>
    );
  }
  // Matches exist but none are in the active filter — operator has
  // selected a cohort that's currently empty.
  const visibleLabels = Array.from(visible)
    .map((s) => KEV_STATUS_LABELS[s])
    .join(", ");
  return (
    <p className="t-body t-body--mute">
      No matches in the current filter ({visibleLabels}). Toggle a chip above to widen the view —
      there are <strong>{totalRows}</strong> total matches across all statuses.
    </p>
  );
}

function StatusFilterChips({
  counts,
  visible,
  onToggle,
}: {
  counts: Record<KevSuppressionStatus, number>;
  visible: ReadonlySet<KevSuppressionStatus>;
  onToggle: (s: KevSuppressionStatus) => void;
}) {
  return (
    <div className="kev-chips print-hide" role="group" aria-label="Status filter">
      {KEV_SUPPRESSION_STATUSES.map((s) => {
        const on = visible.has(s);
        const count = counts[s];
        return (
          <button
            key={s}
            type="button"
            className={`kev-chip ${on ? "is-on" : ""}`}
            aria-pressed={on}
            onClick={() => onToggle(s)}
          >
            {KEV_STATUS_LABELS[s]} ({count})
          </button>
        );
      })}
    </div>
  );
}

function KevTable({
  rows,
  isAdmin,
  sortBy,
  sortDir,
  onSort,
}: {
  rows: readonly MatchRow[];
  isAdmin: boolean;
  sortBy: SortColumn;
  sortDir: SortDir;
  onSort: (col: SortColumn) => void;
}) {
  const now = Date.now();
  const sevenDaysMs = 7 * 86_400_000;
  const set = useSetKevSuppression();
  const clear = useClearKevSuppression();

  return (
    <table className="dt kev-table" style={{ width: "100%" }}>
      <thead>
        <tr>
          <SortableTh
            col="stackItem"
            label="Stack item"
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={onSort}
          />
          <SortableTh col="cveID" label="CVE" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
          <th>Vulnerability</th>
          <SortableTh
            col="dueDate"
            label="Due date"
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={onSort}
          />
          <th>Required action</th>
          <SortableTh
            col="status"
            label="Status"
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={onSort}
          />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ item, cve }) => {
          const dueMs = cve.dueDate ? Date.parse(cve.dueDate) : NaN;
          const overdue = Number.isFinite(dueMs) && dueMs < now;
          const dueSoon = Number.isFinite(dueMs) && dueMs >= now && dueMs - now <= sevenDaysMs;
          const dueTone = overdue ? "danger" : dueSoon ? "warning" : "neutral";
          return (
            <tr key={`${item.id}-${cve.cveID}`}>
              <td>
                <div>
                  <strong>{item.vendor}</strong> · {item.product}
                  {item.version && <span className="t-body--mute"> · {item.version}</span>}
                </div>
                <div className="t-caption">
                  {STACK_CATEGORY_LABELS[item.category]} ·{" "}
                  {STACK_ENVIRONMENT_LABELS[item.environment]}
                </div>
              </td>
              <td>
                <a
                  href={`https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cve.cveID)}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="kev-table__cve"
                >
                  {cve.cveID}
                </a>
                {cve.knownRansomwareCampaignUse === "Known" && (
                  <span
                    className="badge badge--danger"
                    title="Known to be used in ransomware campaigns"
                    style={{ marginLeft: 4 }}
                  >
                    ransomware
                  </span>
                )}
              </td>
              <td>{cve.vulnerabilityName || <span className="t-body--mute">—</span>}</td>
              <td>
                {cve.dueDate ? (
                  <span className={`badge badge--${dueTone}`}>{cve.dueDate}</span>
                ) : (
                  <span className="t-body--mute">—</span>
                )}
              </td>
              <td style={{ fontSize: "var(--fs-200)", maxWidth: 360 }}>
                {/* CISA's requiredAction is operator prose, sometimes
                 *  multi-sentence. Truncate at 240 chars for table density;
                 *  full text on the linked NVD detail. React text-render
                 *  per ADR-0012 §5 — no innerHTML. */}
                {cve.requiredAction ? (
                  cve.requiredAction.length > 240 ? (
                    `${cve.requiredAction.slice(0, 240)}…`
                  ) : (
                    cve.requiredAction
                  )
                ) : (
                  <span className="t-body--mute">—</span>
                )}
              </td>
              <td>
                <StatusCell
                  itemId={item.id}
                  cveID={cve.cveID}
                  status={cve.status}
                  isAdmin={isAdmin}
                  busy={set.isPending || clear.isPending}
                  onSet={(next) =>
                    set.mutate({ stackItemId: item.id, cveID: cve.cveID, status: next })
                  }
                  onClear={() => clear.mutate({ stackItemId: item.id, cveID: cve.cveID })}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SortableTh({
  col,
  label,
  sortBy,
  sortDir,
  onSort,
}: {
  col: SortColumn;
  label: string;
  sortBy: SortColumn;
  sortDir: SortDir;
  onSort: (c: SortColumn) => void;
}) {
  const active = col === sortBy;
  const indicator = active ? (sortDir === "asc" ? " ↑" : " ↓") : "";
  return (
    <th aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={`kev-th-sort ${active ? "is-active" : ""}`}
        onClick={() => onSort(col)}
        aria-label={`Sort by ${label}${
          active ? `, currently ${sortDir === "asc" ? "ascending" : "descending"}` : ""
        }`}
      >
        {label}
        <span aria-hidden="true">{indicator}</span>
      </button>
    </th>
  );
}

function statusBadgeTone(status: KevSuppressionStatus): string {
  switch (status) {
    case "open":
      return "danger";
    case "acknowledged":
      return "warning";
    case "risk_accepted":
      return "info";
    case "remediated":
      return "success";
    case "not_applicable":
      return "neutral";
  }
}

function StatusCell({
  itemId,
  cveID,
  status,
  isAdmin,
  busy,
  onSet,
  onClear,
}: {
  itemId: string;
  cveID: string;
  status: KevSuppressionStatus;
  isAdmin: boolean;
  busy: boolean;
  onSet: (next: KevSuppressionStatus) => void;
  onClear: () => void;
}) {
  void itemId;
  void cveID;
  if (!isAdmin) {
    return (
      <span className={`badge badge--${statusBadgeTone(status)}`}>{KEV_STATUS_LABELS[status]}</span>
    );
  }
  return (
    <div className="row" style={{ gap: 4, alignItems: "center" }}>
      <select
        className="select"
        value={status}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value as KevSuppressionStatus;
          if (next === "open") onClear();
          else onSet(next);
        }}
        aria-label={`Set status for ${cveID}`}
        style={{ fontSize: "var(--fs-200)" }}
      >
        {KEV_SUPPRESSION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {KEV_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
    </div>
  );
}
