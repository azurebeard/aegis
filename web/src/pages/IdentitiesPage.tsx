// /identities — ADR-0034 Phase 8E unified identity surface.
//
// Four tabs: Humans, Agents, Service principals, Managed identities.
// Humans tab links out to /user-dormancy (Phase 8B's existing surface) —
// no point duplicating the table here. Agents/SPs/MIs each render a small
// table fed by /api/identities/service-principals with the appropriate
// `kind` filter. Each tab's data fetch is independent + cached 5 min on
// the server (cache-control: private, max-age=300 per ADR-0034 §7).

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { PageSubheader } from "@/components/shell/PageSubheader";
import { useServicePrincipals } from "@/features/identities/queries";
import type { ServicePrincipalKindFilter, ServicePrincipalRow } from "@/features/identities/types";
import { useUserDormancyList } from "@/features/user-dormancy/queries";
import { useUpdateDormancyPolicy } from "@/features/settings/queries";

type TabId = "humans" | "agents" | "service-principals" | "managed-identities";
const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string }> = [
  { id: "humans", label: "Humans" },
  { id: "agents", label: "Agents" },
  { id: "service-principals", label: "Service principals" },
  { id: "managed-identities", label: "Managed identities" },
];

function parseTabParam(raw: string | null): TabId {
  for (const t of TABS) {
    if (t.id === raw) return t.id;
  }
  return "humans";
}

export function IdentitiesPage() {
  const user = useCurrentUser();
  const [search, setSearch] = useSearchParams();
  const tab = parseTabParam(search.get("tab"));

  useEffect(() => {
    if (!user.isLoading && !user.isAuthenticated) {
      void signIn("/identities");
    }
  }, [user.isLoading, user.isAuthenticated]);

  if (user.isLoading || !user.isAuthenticated) return null;

  const setTab = (id: TabId): void => {
    const next = new URLSearchParams(search);
    if (id === "humans") next.delete("tab");
    else next.set("tab", id);
    setSearch(next, { replace: true });
  };

  return (
    <>
      <PageSubheader
        title="Identities"
        sub="Humans, agents, service principals, and managed identities in this tenant."
      />
      <main className="app-main">
        <div
          className="surface"
          style={{
            padding: "var(--sp-l)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--sp-l)",
          }}
        >
          <div role="tablist" aria-label="Identity facet" className="identities-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={tab === t.id}
                className={`identities-tab ${tab === t.id ? "is-selected" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "humans" && <HumansTab />}
          {tab === "agents" && <SpTabContent kind="application" agentsOnly />}
          {tab === "service-principals" && <SpTabContent kind="application" />}
          {tab === "managed-identities" && <SpTabContent kind="managedIdentity" />}
        </div>
      </main>
    </>
  );
}

function HumansTab() {
  // §10.55 — surfaces NEW users (created within the operator-configured
  // newUserThresholdDays window) at the top so the Humans tab is glanceably
  // useful for "what changed in identity surface lately?". The full
  // sortable per-user table lives at /user-dormancy; we link out for
  // operators who need to drill down.
  const list = useUserDormancyList({ limit: 200 });
  const update = useUpdateDormancyPolicy();
  const policy = list.data?.policy ?? null;
  const newUsers = useMemo(() => {
    const items = list.data?.items ?? [];
    return items
      .filter((it) => it.isNewUser && it.createdDateTime !== null)
      .sort((a, b) => (b.createdDateTime ?? "").localeCompare(a.createdDateTime ?? ""));
  }, [list.data]);

  const [draftThreshold, setDraftThreshold] = useState<number | null>(null);
  const effectiveThreshold = draftThreshold ?? policy?.newUserThresholdDays ?? 7;
  const dirty =
    policy !== null && draftThreshold !== null && draftThreshold !== policy.newUserThresholdDays;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-l)" }}>
      <section className="surface" style={{ padding: "var(--sp-m)" }}>
        <h3 className="t-eyebrow">New-user highlight window</h3>
        <p className="t-caption" style={{ marginTop: 4, marginBottom: "var(--sp-s)" }}>
          Users created within this many days appear as &ldquo;new&rdquo; below. 1&ndash;90 days.
          Saved tenant-wide.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-s)" }}>
          <input
            type="number"
            min={1}
            max={90}
            className="input"
            style={{ width: 80 }}
            value={effectiveThreshold}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setDraftThreshold(Number.isFinite(n) ? n : null);
            }}
            disabled={list.isPending || update.isPending}
            aria-label="New-user threshold days"
          />
          <span className="t-body">days</span>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!dirty || update.isPending || draftThreshold === null}
            onClick={() => {
              if (draftThreshold === null) return;
              update.mutate({ newUserThresholdDays: draftThreshold });
            }}
          >
            {update.isPending ? "Saving…" : "Save"}
          </button>
          {update.isSuccess && !dirty && <span className="t-caption">Saved.</span>}
          {update.isError && (
            <span className="t-caption" style={{ color: "var(--red-fg)" }}>
              {update.error instanceof ApiError
                ? `(${update.error.status}) ${update.error.message}`
                : update.error.message}
            </span>
          )}
        </div>
      </section>

      <section>
        <h3 className="t-eyebrow">
          New users (last {effectiveThreshold} day{effectiveThreshold === 1 ? "" : "s"})
        </h3>
        {list.isPending && <p className="t-body t-body--mute">Loading…</p>}
        {list.isError && (
          <p className="t-body" style={{ color: "var(--red-fg)" }}>
            Could not load.{" "}
            {list.error instanceof ApiError
              ? `(${list.error.status}) ${list.error.message}`
              : (list.error as Error).message}
          </p>
        )}
        {list.isSuccess && newUsers.length === 0 && (
          <p className="t-body t-body--mute">
            No users created in the last {effectiveThreshold} day
            {effectiveThreshold === 1 ? "" : "s"}.
          </p>
        )}
        {newUsers.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>User</th>
                  <th style={th}>Created</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {newUsers.map((u) => (
                  <tr key={u.id}>
                    <td style={td}>
                      <strong>{u.displayName || u.userPrincipalName}</strong>
                      <br />
                      <span className="t-caption">{u.userPrincipalName}</span>
                    </td>
                    <td style={td}>
                      {u.createdDateTime ? new Date(u.createdDateTime).toLocaleDateString() : "—"}
                      <br />
                      <span className="t-caption">
                        {u.createdDateTime
                          ? `${Math.max(0, Math.floor((Date.now() - Date.parse(u.createdDateTime)) / 86_400_000))} day${Math.floor((Date.now() - Date.parse(u.createdDateTime)) / 86_400_000) === 1 ? "" : "s"} ago`
                          : ""}
                      </span>
                    </td>
                    <td style={td}>
                      <span className={`badge badge--${u.accountEnabled ? "success" : "neutral"}`}>
                        {u.accountEnabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="t-caption">
        Full sortable user list with dormancy metadata:{" "}
        <Link to="/user-dormancy">open dormant users →</Link>
      </p>
    </div>
  );
}

interface SpTabContentProps {
  readonly kind: ServicePrincipalKindFilter;
  readonly agentsOnly?: boolean;
}

function SpTabContent({ kind, agentsOnly }: SpTabContentProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const trimmed = searchTerm.trim();
  const q = useServicePrincipals({
    kind,
    ...(trimmed.length > 0 ? { search: trimmed } : {}),
    top: 100,
  });
  const items = useMemo(() => {
    const all = q.data?.items ?? [];
    return agentsOnly
      ? all.filter((r) => r.kind === "agent")
      : all.filter((r) => r.kind !== "agent");
  }, [q.data, agentsOnly]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-m)" }}>
      <label
        className="t-caption"
        style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 360 }}
      >
        <span>Filter by display-name prefix</span>
        <input
          type="text"
          className="input"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="e.g. aegis"
          maxLength={64}
        />
      </label>

      {q.isPending && <p className="t-body t-body--mute">Loading…</p>}
      {q.isError && (
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load.{" "}
          {q.error instanceof ApiError
            ? `(${q.error.status}) ${q.error.message}`
            : (q.error as Error).message}
        </p>
      )}
      {q.isSuccess && (
        <>
          {agentsOnly && items.length === 0 && (
            <p className="t-body t-body--mute">
              No agent identities surfaced on this tenant. Microsoft has not yet shipped the
              <code> agentSubtype </code>
              field on <code>/v1.0/servicePrincipals</code> at the time of this build — Copilot
              Studio agents will appear here once that field becomes available.
            </p>
          )}
          {!agentsOnly && items.length === 0 && (
            <p className="t-body t-body--mute">
              No matching {kind === "managedIdentity" ? "managed identities" : "service principals"}
              .
            </p>
          )}
          {items.length > 0 && <SpTable items={items} />}
          {q.data?.nextLink && (
            <p className="t-caption t-body--mute">
              More results available — refine the search prefix to narrow.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SpTable({ items }: { readonly items: readonly ServicePrincipalRow[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Display name</th>
            <th style={th}>Type</th>
            <th style={th}>Audience</th>
            <th style={th}>Owner tenant</th>
            <th style={th}>Credentials</th>
            <th style={th}>Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td style={td}>
                <strong>{r.displayName}</strong>
                <br />
                <span className="t-caption">{r.appId}</span>
              </td>
              <td style={td}>{r.servicePrincipalType}</td>
              <td style={td}>{r.signInAudience ?? "—"}</td>
              <td style={td}>
                {r.appOwnerOrganizationId ? (
                  <span title={r.appOwnerOrganizationId}>
                    {r.appOwnerOrganizationId.slice(0, 8)}…
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td style={td}>
                <CredentialsBadge row={r} />
              </td>
              <td style={td}>
                {r.createdDateTime ? new Date(r.createdDateTime).toLocaleDateString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CredentialsBadge({ row }: { readonly row: ServicePrincipalRow }) {
  const { secrets, certs, expiredCount, earliestExpiryAt } = row.credentialSummary;
  const total = secrets + certs;
  if (total === 0) return <span className="t-caption">none</span>;
  const expiringSoon =
    earliestExpiryAt !== null &&
    Date.parse(earliestExpiryAt) - Date.now() < 30 * 86_400_000 &&
    Date.parse(earliestExpiryAt) > Date.now();
  const tone = expiredCount > 0 ? "danger" : expiringSoon ? "warning" : "neutral";
  const parts: string[] = [];
  if (secrets > 0) parts.push(`${secrets} secret${secrets === 1 ? "" : "s"}`);
  if (certs > 0) parts.push(`${certs} cert${certs === 1 ? "" : "s"}`);
  if (expiredCount > 0) parts.push(`${expiredCount} expired`);
  return <span className={`badge badge--${tone}`}>{parts.join(" · ")}</span>;
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "var(--sp-s) var(--sp-m)",
  borderBottom: "1px solid var(--bd)",
  fontWeight: 600,
  fontSize: "var(--fs-200)",
  color: "var(--fg-2)",
};
const td: React.CSSProperties = {
  padding: "var(--sp-s) var(--sp-m)",
  borderBottom: "1px solid var(--bd)",
  verticalAlign: "top",
};
