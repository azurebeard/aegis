// /secure-score/controls — drill-down list of every control in the latest
// snapshot, joined against the Microsoft control-profile catalogue
//. The catalogue refresh lands
// daily at 02:30 UTC via `runSecureScoreControlProfilesIngest` and gives
// each row a maxScore, tier, friendly title, and Microsoft remediation
// actionUrl. v1 of this page (no profile enrichment) had no
// "potential gain" column — that's now the default sort.
//
// Plain-text-only render path on every Microsoft-authored field per
// ADR-0012 §5: controlCategory, controlName, profile title, profile
// remediation copy. The Microsoft actionUrl is allow-listed because it
// only points at Microsoft's Defender portal (asserted server-side in
// the catalogue ingest path; the SPA additionally validates the protocol).

import { useEffect, useMemo, useState } from "react";
import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { Icon } from "@/components/Icon";
import { PageSubheader } from "@/components/shell/PageSubheader";
import {
  useSecureScoreControlProfiles,
  useSecureScoreLatest,
} from "@/features/secureScore/queries";
import type { SecureScoreControlProfile } from "@/features/secureScore/types";

type SortKey = "gap-desc" | "score-asc" | "score-desc" | "name-asc" | "category";

const DEFENDER_PORTAL_URL = "https://security.microsoft.com/securescore";

/** Controls how strict we are about which actionUrl protocols / hosts
 *  to render as a link — defence-in-depth on top of the server-side
 *  trust assumption. */
const ACTION_URL_ALLOWED_PROTOCOLS = new Set(["https:"]);
const ACTION_URL_ALLOWED_HOSTS = new Set([
  "security.microsoft.com",
  "portal.azure.com",
  "admin.microsoft.com",
  "compliance.microsoft.com",
  "entra.microsoft.com",
]);

interface ControlRow {
  readonly controlCategory: string;
  readonly controlName: string;
  readonly score: number;
  readonly profile: SecureScoreControlProfile | null;
  /** Computed: maxScore - score when both are known, else null. Highest
   *  gap = best remediation candidate. */
  readonly gap: number | null;
}

export function SecureScoreControlsPage() {
  const user = useCurrentUser();
  const latest = useSecureScoreLatest();
  const profilesQ = useSecureScoreControlProfiles();
  const [search, setSearch] = useState("");
  const [activeCategories, setActiveCategories] = useState<readonly string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("gap-desc");

  useEffect(() => {
    if (!user.isLoading && !user.isAuthenticated) {
      void signIn("/secure-score/controls");
    }
  }, [user.isLoading, user.isAuthenticated]);

  // Hooks must run unconditionally — derive everything before any early
  // return. Filtering/sorting on a possibly-empty list is cheap.
  const snapshot = latest.data?.snapshot ?? null;

  // controlName → profile, for O(1) joins as we walk the snapshot's
  // controlScores[]. The store sanitises controlName for RowKey but
  // the snapshot field is the original, so look up by both forms.
  const profilesByName = useMemo(() => {
    const map = new Map<string, SecureScoreControlProfile>();
    for (const p of profilesQ.data?.items ?? []) {
      map.set(p.controlName, p);
    }
    return map;
  }, [profilesQ.data]);

  const controls = useMemo<readonly ControlRow[]>(() => {
    const raw = snapshot?.controlScores ?? [];
    return raw.map((c) => {
      const profile = profilesByName.get(c.controlName) ?? null;
      const gap =
        profile && profile.maxScore !== null ? Math.max(0, profile.maxScore - c.score) : null;
      return {
        controlCategory: c.controlCategory,
        controlName: c.controlName,
        score: c.score,
        profile,
        gap,
      };
    });
  }, [snapshot, profilesByName]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const c of controls) set.add(c.controlCategory);
    return [...set].sort();
  }, [controls]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = controls.filter((c) => {
      if (activeCategories.length > 0 && !activeCategories.includes(c.controlCategory)) {
        return false;
      }
      if (q) {
        const hay = `${c.controlName} ${c.controlCategory} ${c.profile?.title ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out = [...out].sort((a, b) => {
      switch (sortKey) {
        case "gap-desc": {
          // Rows without a known maxScore (no profile) sort to the end so
          // the actionable "gap > 0 with profile" rows surface first.
          const ga = a.gap;
          const gb = b.gap;
          if (ga === null && gb === null) {
            return a.score - b.score || a.controlName.localeCompare(b.controlName);
          }
          if (ga === null) return 1;
          if (gb === null) return -1;
          return gb - ga || a.controlName.localeCompare(b.controlName);
        }
        case "score-asc":
          return a.score - b.score || a.controlName.localeCompare(b.controlName);
        case "score-desc":
          return b.score - a.score || a.controlName.localeCompare(b.controlName);
        case "name-asc":
          return a.controlName.localeCompare(b.controlName);
        case "category":
          return (
            a.controlCategory.localeCompare(b.controlCategory) ||
            (b.gap ?? 0) - (a.gap ?? 0) ||
            a.controlName.localeCompare(b.controlName)
          );
      }
    });
    return out;
  }, [controls, activeCategories, search, sortKey]);

  if (user.isLoading || !user.isAuthenticated) return null;

  const toggleCategory = (cat: string): void => {
    setActiveCategories((cur) =>
      cur.includes(cat) ? cur.filter((c) => c !== cat) : [...cur, cat],
    );
  };

  return (
    <>
      <PageSubheader
        title="Microsoft Secure Score · controls"
        sub={
          snapshot
            ? `${controls.length} controls in the ${snapshot.snapshotDate} snapshot · ${snapshot.currentScore.toLocaleString()} of ${snapshot.maxScore.toLocaleString()} (${snapshot.percentage.toFixed(1)}%)`
            : "Loading the latest snapshot…"
        }
      >
        <a
          href={DEFENDER_PORTAL_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="btn btn--small"
        >
          <Icon name="external" size={12} />
          Open in Defender portal
        </a>
      </PageSubheader>

      <main className="app-main">
        <div className="surface" style={{ overflow: "hidden" }}>
          <div className="incidents-toolbar">
            <div className="search-input">
              <Icon name="search" size={14} style={{ color: "var(--fg-3)" }} />
              <input
                placeholder="Search controls by name or category…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search controls"
              />
            </div>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className="chip-filter"
                aria-pressed={activeCategories.includes(c)}
                onClick={() => toggleCategory(c)}
              >
                {c}
                <span className="chip-filter__count">
                  {controls.filter((x) => x.controlCategory === c).length}
                </span>
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <label
              className="t-caption"
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-s)" }}
            >
              Sort
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="input"
                style={{ height: 28, padding: "0 var(--sp-s)", width: "auto" }}
                aria-label="Sort controls"
              >
                <option value="gap-desc">Gap (high → low)</option>
                <option value="score-asc">Score (low → high)</option>
                <option value="score-desc">Score (high → low)</option>
                <option value="name-asc">Name (A → Z)</option>
                <option value="category">Category</option>
              </select>
            </label>
          </div>

          {latest.isPending && <ListSkeleton />}
          {latest.isError && (
            <p className="t-body" style={{ padding: "var(--sp-l)", color: "var(--red-fg)" }}>
              Could not load the latest snapshot.{" "}
              {latest.error instanceof ApiError
                ? `(${latest.error.status}) ${latest.error.message}`
                : (latest.error as Error).message}
            </p>
          )}
          {latest.isSuccess && !snapshot && (
            <p className="t-body t-body--mute" style={{ padding: "var(--sp-l)" }}>
              No Secure Score snapshot has been ingested yet. Once the daily Timer fires, the
              control list will populate here.
            </p>
          )}
          {latest.isSuccess && snapshot && filtered.length === 0 && (
            <p className="t-body t-body--mute" style={{ padding: "var(--sp-l)" }}>
              No controls match the current filters.
            </p>
          )}
          {latest.isSuccess && snapshot && filtered.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="dt">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Category</th>
                    <th>Control</th>
                    <th style={{ width: 100 }}>Tier</th>
                    <th className="num" style={{ width: 110 }}>
                      Score
                    </th>
                    <th className="num" style={{ width: 80 }}>
                      Gap
                    </th>
                    <th style={{ width: 70 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => (
                    <tr key={`${c.controlCategory}-${c.controlName}`} style={{ cursor: "default" }}>
                      <td>
                        <span className={`badge badge--${categoryTone(c.controlCategory)}`}>
                          {/* Plain-text — Microsoft-authored. */}
                          {c.controlCategory}
                        </span>
                      </td>
                      <td>
                        {/* Title is the friendly Microsoft-authored name; we
                         *  fall back to the controlName when the catalogue
                         *  hasn't ingested yet. Plain-text. */}
                        <p className="name">
                          {c.profile?.title ?? c.controlName}
                          {c.profile?.deprecated ? (
                            <span
                              className="badge badge--neutral"
                              style={{ marginLeft: "var(--sp-s)" }}
                            >
                              Deprecated
                            </span>
                          ) : null}
                        </p>
                        <span className="id">{c.controlName}</span>
                      </td>
                      <td>
                        {c.profile?.tier ? (
                          <span className={`badge badge--${tierTone(c.profile.tier)}`}>
                            {c.profile.tier}
                          </span>
                        ) : (
                          <span className="t-body--mute">—</span>
                        )}
                      </td>
                      <td className="num tnum">
                        <span style={{ color: scoreColour(c.score) }}>
                          {formatScore(c.score)}
                          {c.profile?.maxScore !== null && c.profile?.maxScore !== undefined
                            ? ` / ${c.profile.maxScore}`
                            : ""}
                        </span>
                      </td>
                      <td className="num tnum">
                        {c.gap !== null ? (
                          <span style={{ color: gapColour(c.gap) }}>+{formatScore(c.gap)}</span>
                        ) : (
                          <span className="t-body--mute">—</span>
                        )}
                      </td>
                      <td>{renderActionLink(c.profile?.actionUrl ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="pag">
            <span>
              Showing <strong style={{ color: "var(--fg-1)" }}>{filtered.length}</strong> of{" "}
              {controls.length} controls
            </span>
          </div>
        </div>
      </main>
    </>
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

/**
 * Rough tone mapping by category — the four major Microsoft Secure Score
 * categories (Apps, Identity, Data, Device) each get a stable badge colour
 * so eye-scan across rows is easier. Unknown categories fall back to neutral.
 */
function categoryTone(category: string): string {
  switch (category.toLowerCase()) {
    case "identity":
      return "info";
    case "apps":
      return "purple";
    case "data":
      return "warning";
    case "device":
      return "success";
    default:
      return "neutral";
  }
}

/**
 * Score colour: 0 → red (no points), low → orange, high → green.
 * Thresholds are heuristic since per-control maxScore isn't available;
 * the operator gets a visual hint without false precision.
 */
function scoreColour(score: number): string {
  if (score === 0) return "var(--red-fg)";
  if (score < 1) return "var(--orange-fg)";
  if (score < 5) return "var(--fg-2)";
  return "var(--green-fg)";
}

function formatScore(score: number): string {
  if (Number.isInteger(score)) return score.toString();
  return score.toFixed(2);
}

/**
 * Gap colour: 0 → green (already maxed), small → fg-2, large → orange,
 * very large → red. Operators scanning gap-desc see the high-gap red
 * rows as the priority backlog.
 */
function gapColour(gap: number): string {
  if (gap === 0) return "var(--green-fg)";
  if (gap < 2) return "var(--fg-2)";
  if (gap < 5) return "var(--orange-fg)";
  return "var(--red-fg)";
}

/**
 * Tier tone — Microsoft's tier vocabulary is "Core" / "Defense in Depth"
 * / "Advanced". Map to the badge palette so the SPA's `eye-scan-by-tier`
 * pass tracks Microsoft's intent (Core = highest priority).
 */
function tierTone(tier: string): string {
  switch (tier.toLowerCase()) {
    case "core":
      return "danger";
    case "defense in depth":
      return "warning";
    case "advanced":
      return "info";
    default:
      return "neutral";
  }
}

/**
 * Render the Microsoft remediation actionUrl as a sanitised link only
 * when both the protocol and host are on our allow-list. Defence-in-depth
 * over the server-side trust assumption — Microsoft sometimes returns
 * relative or vendor-other URLs in the catalogue, and we only want to
 * surface clickable links to known Microsoft surfaces.
 */
function renderActionLink(url: string | null): React.ReactElement | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!ACTION_URL_ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  if (!ACTION_URL_ALLOWED_HOSTS.has(parsed.host)) return null;
  return (
    <a
      href={parsed.href}
      target="_blank"
      rel="noreferrer noopener"
      className="btn btn--small btn--subtle"
      title={`Open Microsoft remediation page (${parsed.host})`}
    >
      <Icon name="external" size={11} />
      Action
    </a>
  );
}
