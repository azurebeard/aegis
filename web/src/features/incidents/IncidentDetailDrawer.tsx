// Incident detail drawer — Aegis UI Phase 3 redesign (ADR-0016 §1.3 + §6).
// Slides in from the right with TabList (Overview / Alerts / AI / Raw) +
// CounterBadge on Alerts tab. Microsoft-authored prose fields render
// plain-text only on every tab. `detailBlobMissing` banners render above
// the tabstrip so they're always visible regardless of active tab.

import { useEffect, useState } from "react";
import { Body1, Spinner } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { Icon } from "@/components/Icon";
import { useTenantSettings } from "@/features/settings/queries";
import { IncidentAnalysisPanel } from "./IncidentAnalysisPanel";
import { useIncidentDetail } from "./queries";
import type { IncidentDetailResponse } from "./types";

interface DrawerProps {
  readonly open: boolean;
  readonly incidentId: string | null;
  readonly onClose: () => void;
}

type TabId = "overview" | "alerts" | "ai" | "raw";

export function IncidentDetailDrawer({ open, incidentId, onClose }: DrawerProps) {
  const query = useIncidentDetail(incidentId);

  // Esc-to-close while open.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  return (
    <>
      {/* Scrim only mounts while the drawer is open — keeps the closed
       *  state out of the a11y tree entirely. */}
      {open && (
        <button
          type="button"
          className="scrim is-open"
          onClick={onClose}
          aria-label="Close incident detail"
          style={{ border: 0, padding: 0, cursor: "pointer" }}
        />
      )}
      <aside
        className={`drawer ${open ? "is-open" : ""}`}
        aria-hidden={!open}
        role="dialog"
        aria-label="Incident detail"
      >
        {open && query.isPending && (
          <div
            style={{
              padding: "var(--sp-xl)",
              display: "flex",
              alignItems: "center",
              gap: "var(--sp-s)",
            }}
          >
            <Spinner size="tiny" />
            <Body1>Loading…</Body1>
          </div>
        )}
        {open && query.isError && (
          <div style={{ padding: "var(--sp-xl)" }}>
            <p className="t-body" style={{ color: "var(--red-fg)" }}>
              Could not load detail. {(query.error as Error).message}
              {query.error instanceof ApiError && query.error.status === 404 && (
                <> The incident may have been deleted or trimmed by retention.</>
              )}
            </p>
          </div>
        )}
        {open && query.isSuccess && <DetailBody data={query.data} onClose={onClose} />}
      </aside>
    </>
  );
}

function DetailBody({ data, onClose }: { data: IncidentDetailResponse; onClose: () => void }) {
  const { incident, ingest } = data;
  const [tab, setTab] = useState<TabId>("overview");
  // HANDOVER §6.3 `deployAiAgents` — hide the analysis tab when the AI
  // plane is disabled. Strict `=== true` since SEC-INFO-DAAA-02 resolution
  //; the field is server-required, and during the brief
  // settings-loading window we suppress the tab rather than render +
  // re-hide it. When hidden, useIncidentAnalysis never fires.
  const settings = useTenantSettings();
  const aiPlaneEnabled = settings.data?.aiPlaneEnabled === true;

  const sevTone = severityBadgeTone(incident.severity);
  const sevLabel = severityLabel(incident.severity);
  const statusBadgeLabel = statusLabel(incident.status);
  const classBadgeLabel = classificationLabel(incident.classification);
  const alertCount = incident.alerts?.length ?? incident.alertCount ?? 0;

  return (
    <>
      <div className="drawer__head">
        <div className="drawer__head-title">
          <div className="row" style={{ gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <span className={`badge badge--${sevTone}`}>{sevLabel}</span>
            <span className="badge badge--neutral">{statusBadgeLabel}</span>
            <span className="badge badge--ghost">{classBadgeLabel}</span>
            {incident.priorityScore !== null && (
              <span className="badge badge--neutral">priority {incident.priorityScore}</span>
            )}
          </div>
          {/* Plain-text — Microsoft-authored prose. */}
          <h2 className="t-h2" style={{ margin: "4px 0 2px" }}>
            {incident.displayName}
          </h2>
          <p className="t-caption">
            Incident <code>{incident.id}</code>
            {incident.assignedTo ? ` · ${incident.assignedTo}` : " · unassigned"}
          </p>
        </div>
        <div className="drawer__head-actions">
          <button
            className="btn btn--icon btn--small btn--subtle"
            onClick={onClose}
            aria-label="Close"
            type="button"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      {ingest.detailBlobMissing && (
        <div style={{ padding: "0 var(--sp-xl)", marginTop: "var(--sp-m)" }}>
          <DetailMissingBanner
            classification={ingest.detailBlobMissingClassification ?? "unexplained"}
          />
        </div>
      )}

      <div className="drawer__tabs">
        <TabButton id="overview" active={tab} onClick={setTab} label="Overview" />
        <TabButton id="alerts" active={tab} onClick={setTab} label="Alerts" count={alertCount} />
        {aiPlaneEnabled && (
          <TabButton id="ai" active={tab} onClick={setTab} label="AI analysis" icon="sparkle" />
        )}
        <TabButton id="raw" active={tab} onClick={setTab} label="Raw" />
      </div>

      <div className="drawer__body">
        {tab === "overview" && <OverviewTab data={data} />}
        {tab === "alerts" && <AlertsTab data={data} />}
        {tab === "ai" && aiPlaneEnabled && (
          <IncidentAnalysisPanel
            incidentId={incident.id}
            incidentLastUpdateDateTime={incident.lastUpdateDateTime}
          />
        )}
        {tab === "raw" && <RawTab data={data} />}
      </div>
    </>
  );
}

function TabButton({
  id,
  active,
  onClick,
  label,
  count,
  icon,
}: {
  id: TabId;
  active: TabId;
  onClick: (id: TabId) => void;
  label: string;
  count?: number;
  icon?: "sparkle";
}) {
  const isActive = active === id;
  return (
    <button
      className={`drawer__tab ${isActive ? "is-active" : ""}`}
      onClick={() => onClick(id)}
      type="button"
      aria-selected={isActive}
      role="tab"
    >
      {icon && <Icon name={icon} size={12} />}
      {label}
      {typeof count === "number" && count > 0 && <span className="drawer__tab-count">{count}</span>}
    </button>
  );
}

function OverviewTab({ data }: { data: IncidentDetailResponse }) {
  const { incident, ingest } = data;
  const metaPairs: readonly { label: string; value: React.ReactNode; mono?: boolean }[] = [
    { label: "ID", value: incident.id, mono: true },
    { label: "Determination", value: incident.determination || "Not set" },
    { label: "Assigned to", value: incident.assignedTo ?? "— (unassigned)" },
    { label: "Created", value: incident.createdDateTime },
    { label: "Updated", value: incident.lastUpdateDateTime },
    { label: "Alert count", value: String(incident.alertCount) },
    {
      label: "Custom tags",
      value: incident.customTags.length > 0 ? incident.customTags.join(" · ") : "—",
    },
    {
      label: "Defender link",
      value: incident.incidentWebUrl ? (
        <a href={incident.incidentWebUrl} target="_blank" rel="noreferrer noopener">
          Open in security.microsoft.com →
        </a>
      ) : (
        "—"
      ),
    },
  ];

  return (
    <>
      <div className="meta-grid">
        {metaPairs.map((p) => (
          <div key={p.label} className="meta-grid__cell">
            <span className="meta-grid__label">{p.label}</span>
            <span className={`meta-grid__value${p.mono ? " meta-grid__value--mono" : ""}`}>
              {p.value}
            </span>
          </div>
        ))}
      </div>

      {incident.description && (
        <div className="section-block">
          <h3 className="t-eyebrow">Description</h3>
          {/* Plain-text — Microsoft-authored prose. */}
          <p className="t-body" style={{ whiteSpace: "pre-wrap" }}>
            {incident.description}
          </p>
        </div>
      )}

      {incident.summary && (
        <div className="section-block">
          <h3 className="t-eyebrow">Summary</h3>
          <p className="t-body" style={{ whiteSpace: "pre-wrap" }}>
            {incident.summary}
          </p>
        </div>
      )}

      <p className="t-caption">
        Ingested {ingest.ingestedAt} · run <code>{ingest.ingestRunId}</code>
      </p>
    </>
  );
}

function AlertsTab({ data }: { data: IncidentDetailResponse }) {
  const alerts = data.incident.alerts ?? [];
  if (alerts.length === 0) {
    return (
      <div className="section-block">
        <h3 className="t-eyebrow">Alerts</h3>
        <p className="t-body t-body--mute">No alerts attached to this incident.</p>
      </div>
    );
  }
  return (
    <div className="section-block">
      <h3 className="t-eyebrow">Alerts ({alerts.length})</h3>
      {alerts.map((a, i) => {
        const sev = (a.severity ?? "").toLowerCase();
        const dot =
          sev === "high" ? "high" : sev === "medium" ? "medium" : sev === "low" ? "low" : "info";
        return (
          <div key={a.id ?? i} className="alert-item">
            <span className={`dot dot--${dot}`} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* Plain-text. */}
              <p className="alert-item__title">{a.title ?? "(untitled alert)"}</p>
              {a.description && (
                <p className="t-caption" style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>
                  {a.description}
                </p>
              )}
            </div>
            {a.severity && <span className="alert-item__meta">{a.severity}</span>}
          </div>
        );
      })}
    </div>
  );
}

function RawTab({ data }: { data: IncidentDetailResponse }) {
  return (
    <pre
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-200)",
        background: "var(--bg-2)",
        padding: "var(--sp-l)",
        borderRadius: "var(--r-m)",
        color: "var(--fg-2)",
        overflow: "auto",
        margin: 0,
      }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function DetailMissingBanner({
  classification,
}: {
  classification: "lifecycle-trim" | "lookup-failure" | "unexplained";
}) {
  const { tone, text } =
    classification === "lifecycle-trim"
      ? {
          tone: "info" as const,
          text: "Detail blob has been trimmed by retention — only the summary is available.",
        }
      : classification === "lookup-failure"
        ? {
            tone: "warning" as const,
            text: "Couldn't reach the detail-blob store. Retry may resolve a transient issue.",
          }
        : {
            tone: "danger" as const,
            text: "Detail blob is missing within the retention window — possible out-of-band deletion or writer anomaly.",
          };
  return (
    <div
      role="status"
      className={`badge--${tone}`}
      style={{
        display: "block",
        padding: "var(--sp-s) var(--sp-m)",
        borderRadius: "var(--r-m)",
        border: "1px solid",
      }}
    >
      <p className="t-body" style={{ fontWeight: 600 }}>
        Detail blob unavailable
      </p>
      <p className="t-caption">{text}</p>
    </div>
  );
}

function severityBadgeTone(s: string): string {
  if (s === "high") return "danger";
  if (s === "medium") return "warning";
  if (s === "low") return "info";
  return "neutral";
}

function severityLabel(s: string): string {
  if (s === "informational") return "Info";
  if (s === "unknown") return "Unknown";
  return s[0]!.toUpperCase() + s.slice(1);
}

function statusLabel(s: string): string {
  if (s === "inProgress") return "In progress";
  if (s === "awaitingAction") return "Awaiting action";
  return s[0]!.toUpperCase() + s.slice(1);
}

function classificationLabel(c: string): string {
  if (c === "truePositive") return "True positive";
  if (c === "falsePositive") return "False positive";
  if (c === "informationalExpectedActivity") return "Benign positive";
  if (c === "unknown") return "Unknown classification";
  return c;
}
