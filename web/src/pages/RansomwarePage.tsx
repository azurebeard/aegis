// /ransomware — top-level ransomware.live threat-intel drilldown (ADR-0037
// Layer 5).
//
// Blended chronological list of victim disclosures + press articles for
// the configured country. Filter chips for the row family (all / victims
// only / press only). No per-row mutation surface — this is a read-only
// situational-awareness page.
//
// Plain-text-only contract (ADR-0037 §"Privacy"):
//   - The `activity` field on victim rows is threat-actor-authored prose
//     from leak-site posts.
//   - The `summary` field on press rows is HudsonRock-enriched third-
//     party prose.
// Both are control-stripped + length-capped at Layer 3b parse time. This
// page renders them via React's default-escaping text nodes ({value}) —
// the eslint `react/no-danger` rule pinned against this file enforces no
// `dangerouslySetInnerHTML` callsite.
//
// External hrefs (website / permalink / press url) are scheme-validated
// at Layer 3b (http/https/tor/onion allowlist); a regression that lets
// `javascript:` through is also defended by the `<SafeLink>` helper
// below which re-checks the scheme before producing `<a href>`.

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { PageSubheader } from "@/components/shell/PageSubheader";
import {
  RANSOMWARE_INTEL_LIST_KEY,
  RANSOMWARE_INTEL_SUMMARY_KEY,
  useRansomwareIntelList,
  useRansomwareIntelSummary,
} from "@/features/ransomware/queries";
import type { RansomwareIntelListItem, RansomwareIntelRowKind } from "@/features/ransomware/types";

type KindFilter = RansomwareIntelRowKind | "all";

const KIND_LABELS: Readonly<Record<KindFilter, string>> = {
  all: "All",
  victim: "Victims",
  press: "Press",
};

const KIND_ORDER: readonly KindFilter[] = ["all", "victim", "press"] as const;

// Server-side scheme allowlist on the data layer (Layer 3b) is the
// primary defence; this is belt-and-braces so a regression in the
// validator doesn't immediately become a client-side `<a href>` XSS
// surface.
//
// SCOPE NOTE — these schemes are for **upstream-supplied content** that
// appears in the data (victim website URLs from leak-site disclosures,
// press article URLs). They are NOT endpoints this app calls. The SPA
// only ever fetches `/api/...` paths via the central api client, which
// the SWA forwards over HTTPS. The `http://` entry below survives so
// legitimate legacy victim sites (industrial / small-business homepages
// that haven't migrated to HTTPS) still produce a clickable link — if we
// stripped them, the operator would lose the ability to confirm "yes,
// this is the right company". Mirrors `ALLOWED_URL_SCHEMES` in
// `api/src/lib/ransomwareLiveSchema.ts:urlField`.
const SAFE_URL_SCHEMES = ["https://", "http://", "tor://", "onion://"] as const;

function isSafeExternalUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return SAFE_URL_SCHEMES.some((s) => lower.startsWith(s));
}

function SafeLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!isSafeExternalUrl(href)) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

export function RansomwarePage() {
  const user = useCurrentUser();
  const isAdmin = user.hasRole("admin");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const summaryQ = useRansomwareIntelSummary();
  const listQ = useRansomwareIntelList({ kind: kindFilter, limit: 200 });

  const rows = listQ.data?.rows ?? [];

  const headerCounts = useMemo(() => {
    if (!summaryQ.data) return null;
    return summaryQ.data.counts;
  }, [summaryQ.data]);

  return (
    <>
      <PageSubheader
        title="Ransomware intel"
        sub={`Per-country leak-site disclosures + press coverage from ransomware.live PRO${
          summaryQ.data ? ` · ${summaryQ.data.country}` : ""
        }`}
      />
      <main className="app-main">
        <RansomwareHeader summary={summaryQ.data ?? null} isAdmin={isAdmin} />

        <div className="row" style={{ gap: "var(--sp-s)", margin: "var(--sp-m) 0" }}>
          {KIND_ORDER.map((k) => (
            <button
              key={k}
              type="button"
              className={`chip ${kindFilter === k ? "chip--active" : ""}`}
              onClick={() => setKindFilter(k)}
              aria-pressed={kindFilter === k}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>

        {headerCounts && (
          <p className="t-caption" style={{ marginBottom: "var(--sp-s)" }}>
            This month: <strong>{headerCounts.victimsThisMonth}</strong> victim
            {headerCounts.victimsThisMonth === 1 ? "" : "s"} ·{" "}
            <strong>{headerCounts.pressThisMonth}</strong> press article
            {headerCounts.pressThisMonth === 1 ? "" : "s"} · across{" "}
            <strong>{headerCounts.distinctGroupsThisMonth}</strong> group
            {headerCounts.distinctGroupsThisMonth === 1 ? "" : "s"}
          </p>
        )}

        {listQ.isPending && <p className="t-body t-body--mute">Loading…</p>}
        {listQ.isError && (
          <p className="t-body" style={{ color: "var(--red-fg)" }}>
            Could not load ransomware intel list.{" "}
            {listQ.error instanceof ApiError
              ? `(${listQ.error.status}) ${listQ.error.message}`
              : (listQ.error as Error).message}
          </p>
        )}

        {listQ.isSuccess && rows.length === 0 && (
          <p className="t-body t-body--mute">
            No {kindFilter === "all" ? "rows" : `${KIND_LABELS[kindFilter].toLowerCase()}`} in the
            current retention window.
          </p>
        )}

        {listQ.isSuccess && rows.length > 0 && <RowsTable rows={rows} />}

        {listQ.data?.page.hasMore && (
          <p className="t-caption" style={{ marginTop: "var(--sp-s)" }}>
            Showing the first {listQ.data.page.count} of more. Narrow with the filter chips above or
            increase the operator-side retention.
          </p>
        )}
      </main>
    </>
  );
}

function RansomwareHeader({
  summary,
  isAdmin,
}: {
  summary: ReturnType<typeof useRansomwareIntelSummary>["data"] | null;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const runNow = useMutation<unknown, Error, void>({
    mutationFn: () => api.post("/api/ingest/ransomware-intel/run"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: RANSOMWARE_INTEL_SUMMARY_KEY });
      void qc.invalidateQueries({ queryKey: RANSOMWARE_INTEL_LIST_KEY });
    },
  });

  return (
    <div className="ransomware-header print-hide">
      {summary && (
        <p className="t-body t-body--mute">
          Country: <strong>{summary.country}</strong>
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
            aria-label="Run ransomware intel ingest now"
          >
            {runNow.isPending ? "Running…" : "Run now"}
          </button>
          <span className="t-caption">Admin-only · 30/day per tenant</span>
        </div>
      )}
      {runNow.isSuccess && (
        <p className="banner banner--success" role="status">
          Ransomware intel ingest completed.
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

function RowsTable({ rows }: { rows: readonly RansomwareIntelListItem[] }) {
  return (
    <div className="surface" style={{ overflowX: "auto" }}>
      <table className="aegis-table">
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Date</th>
            <th scope="col">Headline</th>
            <th scope="col">Country</th>
            <th scope="col">Detail</th>
            <th scope="col">Source link</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <RowItem key={`${row.kind}-${row.anchorDate}-${i}`} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowItem({ row }: { row: RansomwareIntelListItem }) {
  const isVictim = row.kind === "victim";
  const detail = isVictim ? row.activity : row.summary;
  const link = isVictim ? row.permalink || row.website : row.url;

  return (
    <tr>
      <td>
        <span className={`badge ${isVictim ? "badge--warning" : "badge--mute"}`}>
          {isVictim ? "Victim" : "Press"}
        </span>
      </td>
      <td>
        <time dateTime={row.anchorDate}>
          {row.anchorDate ? new Date(row.anchorDate).toLocaleDateString() : "—"}
        </time>
      </td>
      <td>
        {/* Plain-text rendering — `headline` is the victim name or
            press article title, control-stripped + length-capped at
            parse time. */}
        <strong>{row.headline}</strong>
        {isVictim && row.group && (
          <>
            <br />
            <span className="t-caption">Group: {row.group}</span>
          </>
        )}
        {!isVictim && row.source && (
          <>
            <br />
            <span className="t-caption">{row.source}</span>
          </>
        )}
      </td>
      <td>{row.country || "—"}</td>
      <td style={{ maxWidth: 480 }}>
        {/* Adversarial-input free text. React's default text-node
            escaping is the primary defence here; the eslint rule
            pinned on this file forbids dangerouslySetInnerHTML. */}
        {detail ? (
          <span className="t-body t-body--mute">{truncate(detail, 240)}</span>
        ) : (
          <span className="t-caption">—</span>
        )}
      </td>
      <td>
        <SafeLink href={link}>open ↗</SafeLink>
      </td>
    </tr>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
