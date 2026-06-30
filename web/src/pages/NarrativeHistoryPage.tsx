// /history — Brief + Posture run history with side-by-side compare-with-latest.
//
// HANDOVER §6.3 history view: lists prior daily-brief and weekly-posture
// runs from the existing BriefCache + PostureCache tables, clicks open the
// full markdown body via the existing /api/brief/{date} and /api/posture/{week}
// detail endpoints. Compare button toggles a 2-column layout showing the
// selected run alongside the latest run. v1 does not implement text-diff
// highlighting — adjacent rendering is sufficient for "what changed?" at
// the section level.
//
// Plain-text-only render path: bullet bodies go through SafeMarkdown (the
// same renderer the BriefTile uses). No dangerouslySetInnerHTML.

import { useEffect, useMemo, useState } from "react";
import { Skeleton, SkeletonItem, Spinner } from "@fluentui/react-components";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { ApiError } from "@/api/client";
import { Icon } from "@/components/Icon";
import { PageSubheader } from "@/components/shell/PageSubheader";
import { SafeMarkdown } from "@/features/brief/SafeMarkdown";
import { useBriefByDate, useBriefHistory, useBriefLatest } from "@/features/brief/queries";
import { usePostureByWeek, usePostureHistory, usePostureLatest } from "@/features/posture/queries";
import type { BriefHistoryItem } from "@/features/brief/types";
import type { PostureHistoryItem } from "@/features/posture/types";

type Tab = "brief" | "posture";

export function NarrativeHistoryPage() {
  const user = useCurrentUser();
  const [tab, setTab] = useState<Tab>("brief");

  useEffect(() => {
    if (!user.isLoading && !user.isAuthenticated) {
      void signIn("/history");
    }
  }, [user.isLoading, user.isAuthenticated]);

  if (user.isLoading || !user.isAuthenticated) return null;

  return (
    <>
      <PageSubheader
        title="Narrative history"
        sub="Past Daily Brief and Weekly Posture runs. Open a run to see the full narrative; compare against the latest to spot what's changed."
      />
      <main className="app-main">
        <div className="surface" style={{ overflow: "hidden" }}>
          <div className="incidents-toolbar" style={{ justifyContent: "flex-start" }}>
            <button
              type="button"
              className="chip-filter"
              aria-pressed={tab === "brief"}
              onClick={() => setTab("brief")}
            >
              Daily Brief
            </button>
            <button
              type="button"
              className="chip-filter"
              aria-pressed={tab === "posture"}
              onClick={() => setTab("posture")}
            >
              Weekly Posture
            </button>
          </div>
          {tab === "brief" ? <BriefHistoryView /> : <PostureHistoryView />}
        </div>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Brief history view
// ---------------------------------------------------------------------------

function BriefHistoryView() {
  const list = useBriefHistory(14);
  const latest = useBriefLatest();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const detail = useBriefByDate(selectedDate);

  // Auto-select the most-recent run on first load so the right pane never
  // sits empty after the list resolves.
  useEffect(() => {
    if (selectedDate === null && list.data && list.data.items.length > 0) {
      setSelectedDate(list.data.items[0]?.briefDate ?? null);
    }
  }, [list.data, selectedDate]);

  const latestDate = latest.data?.brief?.briefDate ?? latest.data?.briefDate ?? null;
  const isLatestSelected = selectedDate === latestDate;

  if (list.isPending) return <ListSkeleton />;
  if (list.isError) return <ListError error={list.error} />;
  if (list.data.items.length === 0) {
    return (
      <p className="t-body t-body--mute" style={{ padding: "var(--sp-l)" }}>
        No briefs cached yet. The first daily brief lands ~03:00 UTC tomorrow.
      </p>
    );
  }

  return (
    <div className="history-grid">
      <div className="history-grid__list">
        <table className="dt">
          <thead>
            <tr>
              <th>Date</th>
              <th style={{ width: 110 }}>Tokens</th>
              <th style={{ width: 130 }}>Generated</th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((it) => (
              <BriefRow
                key={it.briefDate}
                item={it}
                selected={selectedDate === it.briefDate}
                onSelect={() => setSelectedDate(it.briefDate)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="history-grid__detail">
        <DetailHeader
          label={selectedDate ?? "—"}
          isLatest={isLatestSelected}
          compare={compare}
          onCompareToggle={() => setCompare((c) => !c)}
        />
        {compare && !isLatestSelected ? (
          <BriefComparePane selectedDate={selectedDate} />
        ) : (
          <BriefDetailPane query={detail} />
        )}
      </div>
    </div>
  );
}

function BriefRow({
  item,
  selected,
  onSelect,
}: {
  item: BriefHistoryItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr className={selected ? "is-selected" : ""} onClick={onSelect}>
      <td>
        <p className="name">{item.briefDate}</p>
        <span className="id">{item.modelDeployment}</span>
      </td>
      <td className="num tnum">{(item.tokensIn + item.tokensOut).toLocaleString()}</td>
      <td className="t-body--mute">
        {new Date(item.generatedAt).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        })}
      </td>
    </tr>
  );
}

function BriefDetailPane({ query }: { query: ReturnType<typeof useBriefByDate> }) {
  if (query.isPending) {
    return (
      <div style={{ padding: "var(--sp-l)" }}>
        <Spinner size="tiny" />
      </div>
    );
  }
  if (query.isError) return <DetailError error={query.error} />;
  return <BriefBody headline={query.data.headline} sections={query.data.sections} />;
}

function BriefComparePane({ selectedDate }: { selectedDate: string | null }) {
  const selected = useBriefByDate(selectedDate);
  const latest = useBriefLatest();
  const latestData = useMemo(() => {
    if (!latest.data) return null;
    if (latest.data.brief) return latest.data.brief;
    if (latest.data.briefDate && latest.data.headline && latest.data.sections) {
      return {
        briefDate: latest.data.briefDate,
        headline: latest.data.headline,
        sections: latest.data.sections,
      };
    }
    return null;
  }, [latest.data]);

  return (
    <div className="history-compare">
      <section className="history-compare__col">
        <p className="t-eyebrow">Selected · {selectedDate}</p>
        {selected.isPending ? (
          <Spinner size="tiny" />
        ) : selected.isError ? (
          <DetailError error={selected.error} />
        ) : (
          <BriefBody headline={selected.data.headline} sections={selected.data.sections} />
        )}
      </section>
      <section className="history-compare__col">
        <p className="t-eyebrow">Latest · {latestData?.briefDate ?? "—"}</p>
        {latest.isPending ? (
          <Spinner size="tiny" />
        ) : latest.isError ? (
          <DetailError error={latest.error} />
        ) : latestData ? (
          <BriefBody headline={latestData.headline} sections={latestData.sections} />
        ) : (
          <p className="t-body t-body--mute">No latest brief available.</p>
        )}
      </section>
    </div>
  );
}

function BriefBody({
  headline,
  sections,
}: {
  headline: string;
  sections: readonly { heading: string; bullets: readonly string[] }[];
}) {
  return (
    <div className="narrative">
      <p className="narrative__lede">{headline}</p>
      {sections.map((s) => (
        <div key={s.heading} className="narrative__section">
          <h4>{s.heading}</h4>
          <SafeMarkdown>{s.bullets.map((b) => `- ${b}`).join("\n")}</SafeMarkdown>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Posture history view (mirror of brief)
// ---------------------------------------------------------------------------

function PostureHistoryView() {
  const list = usePostureHistory(12);
  const latest = usePostureLatest();
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const detail = usePostureByWeek(selectedWeek);

  useEffect(() => {
    if (selectedWeek === null && list.data && list.data.items.length > 0) {
      setSelectedWeek(list.data.items[0]?.isoWeek ?? null);
    }
  }, [list.data, selectedWeek]);

  const latestWeek = latest.data?.isoWeek ?? null;
  const isLatestSelected = selectedWeek === latestWeek;

  if (list.isPending) return <ListSkeleton />;
  if (list.isError) return <ListError error={list.error} />;
  if (list.data.items.length === 0) {
    return (
      <p className="t-body t-body--mute" style={{ padding: "var(--sp-l)" }}>
        No posture narratives cached yet. The first weekly run lands Monday at 06:00 UTC.
      </p>
    );
  }

  return (
    <div className="history-grid">
      <div className="history-grid__list">
        <table className="dt">
          <thead>
            <tr>
              <th>ISO week</th>
              <th style={{ width: 110 }}>Tokens</th>
              <th style={{ width: 130 }}>Generated</th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((it) => (
              <PostureRow
                key={it.isoWeek}
                item={it}
                selected={selectedWeek === it.isoWeek}
                onSelect={() => setSelectedWeek(it.isoWeek)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="history-grid__detail">
        <DetailHeader
          label={selectedWeek ?? "—"}
          isLatest={isLatestSelected}
          compare={compare}
          onCompareToggle={() => setCompare((c) => !c)}
        />
        {compare && !isLatestSelected ? (
          <PostureComparePane selectedWeek={selectedWeek} />
        ) : (
          <PostureDetailPane query={detail} />
        )}
      </div>
    </div>
  );
}

function PostureRow({
  item,
  selected,
  onSelect,
}: {
  item: PostureHistoryItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr className={selected ? "is-selected" : ""} onClick={onSelect}>
      <td>
        <p className="name">{item.isoWeek}</p>
        <span className="id">{item.modelDeployment}</span>
      </td>
      <td className="num tnum">{(item.tokensIn + item.tokensOut).toLocaleString()}</td>
      <td className="t-body--mute">
        {new Date(item.generatedAt).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        })}
      </td>
    </tr>
  );
}

function PostureDetailPane({ query }: { query: ReturnType<typeof usePostureByWeek> }) {
  if (query.isPending) {
    return (
      <div style={{ padding: "var(--sp-l)" }}>
        <Spinner size="tiny" />
      </div>
    );
  }
  if (query.isError) return <DetailError error={query.error} />;
  return <PostureBody headline={query.data.headline} sections={query.data.sections} />;
}

function PostureComparePane({ selectedWeek }: { selectedWeek: string | null }) {
  const selected = usePostureByWeek(selectedWeek);
  const latest = usePostureLatest();
  return (
    <div className="history-compare">
      <section className="history-compare__col">
        <p className="t-eyebrow">Selected · {selectedWeek}</p>
        {selected.isPending ? (
          <Spinner size="tiny" />
        ) : selected.isError ? (
          <DetailError error={selected.error} />
        ) : (
          <PostureBody headline={selected.data.headline} sections={selected.data.sections} />
        )}
      </section>
      <section className="history-compare__col">
        <p className="t-eyebrow">Latest · {latest.data?.isoWeek ?? "—"}</p>
        {latest.isPending ? (
          <Spinner size="tiny" />
        ) : latest.isError ? (
          <DetailError error={latest.error} />
        ) : latest.data?.sections && latest.data.headline ? (
          <PostureBody headline={latest.data.headline} sections={latest.data.sections} />
        ) : (
          <p className="t-body t-body--mute">No latest posture available.</p>
        )}
      </section>
    </div>
  );
}

function PostureBody({
  headline,
  sections,
}: {
  headline: string;
  sections: {
    readonly currentPosture: string;
    readonly recentMovement: string;
    readonly priorityActions: string;
  };
}) {
  return (
    <div className="narrative">
      <p className="narrative__lede">{headline}</p>
      {sections.currentPosture && (
        <PostureSection heading="Current posture" body={sections.currentPosture} />
      )}
      {sections.recentMovement && (
        <PostureSection heading="Recent movement" body={sections.recentMovement} />
      )}
      {sections.priorityActions && (
        <PostureSection heading="Priority actions" body={sections.priorityActions} variant="warn" />
      )}
    </div>
  );
}

function PostureSection({
  heading,
  body,
  variant,
}: {
  heading: string;
  body: string;
  variant?: "warn";
}) {
  if (!body) return null;
  return (
    <div className={`narrative__section${variant ? ` narrative__section--${variant}` : ""}`}>
      <h4>{heading}</h4>
      <SafeMarkdown>{body}</SafeMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function DetailHeader({
  label,
  isLatest,
  compare,
  onCompareToggle,
}: {
  label: string;
  isLatest: boolean;
  compare: boolean;
  onCompareToggle: () => void;
}) {
  return (
    <div
      className="row row--between"
      style={{
        padding: "var(--sp-m) var(--sp-l)",
        borderBottom: "1px solid var(--stroke-2)",
      }}
    >
      <div className="row" style={{ gap: "var(--sp-s)" }}>
        <Icon name="doc" size={14} />
        <strong>{label}</strong>
        {isLatest && <span className="badge badge--success">Latest</span>}
      </div>
      <button
        type="button"
        className={`btn btn--small ${compare ? "btn--primary" : ""}`}
        onClick={onCompareToggle}
        disabled={isLatest}
        title={isLatest ? "Selected run already is the latest" : undefined}
      >
        {compare ? "Hide compare" : "Compare with latest"}
      </button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div style={{ padding: "var(--sp-l)" }}>
      <Skeleton>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonItem key={i} size={32} style={{ marginTop: "var(--sp-s)" }} />
        ))}
      </Skeleton>
    </div>
  );
}

function ListError({ error }: { error: Error }) {
  return (
    <p className="t-body" style={{ color: "var(--red-fg)", padding: "var(--sp-l)" }}>
      Could not load history.{" "}
      {error instanceof ApiError ? `(${error.status}) ${error.message}` : error.message}
    </p>
  );
}

function DetailError({ error }: { error: Error }) {
  return (
    <p className="t-body" style={{ color: "var(--red-fg)", padding: "var(--sp-l)" }}>
      Could not load detail.{" "}
      {error instanceof ApiError ? `(${error.status}) ${error.message}` : error.message}
      {error instanceof ApiError && error.status === 404 && (
        <> The run may have been trimmed by retention.</>
      )}
    </p>
  );
}
