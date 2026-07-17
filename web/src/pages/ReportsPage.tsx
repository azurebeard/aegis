// /reports — ADR-0030 Phase A.
//
// Three view modes via query string:
//   /reports                       — current period of TenantSettings.reportCadence
//   /reports?period=<periodKey>    — historical snapshot (defaults to latest version)
//   /reports?period=<…>&version=N  — specific version of a historical snapshot
//   /reports?cadence=…             — current period of an explicit cadence
//
// Print CSS sits in styles/aegis.css (`@media print`); the operator's
// browser "Print to PDF" produces a clean board-ready document. Admin-only
// "Capture this period" button is the only mutation surface.

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { api, ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { PageSubheader } from "@/components/shell/PageSubheader";
import { NextFireBadge } from "@/features/common/NextFireBadge";
import { useTenantSettings } from "@/features/settings/queries";
import {
  useSendReportEmail,
  type SendReportEmailResponse,
} from "@/features/settings/reportEmailSendsQueries";
import {
  REPORT_CADENCE_LABELS,
  type ReportCadence,
  type ReportEmailConfigRecord,
} from "@/features/settings/types";
import {
  useCaptureReportSnapshot,
  useReportCurrent,
  useReportSnapshot,
  useReportSnapshotList,
} from "@/features/reports/queries";
import type { ReportEnvelope, ReportSnapshotListItem } from "@/features/reports/types";

const PERIOD_KEY_RE = /^\d{4}-(?:W\d{2}|\d{2}|Q[1-4])$/;
const CADENCES: readonly ReportCadence[] = ["weekly", "monthly", "quarterly"];

export function ReportsPage() {
  const user = useCurrentUser();
  const settings = useTenantSettings();
  const [search, setSearch] = useSearchParams();

  const tenantCadence = settings.data?.reportCadence?.cadence ?? "monthly";
  const overrideCadence = parseCadenceParam(search.get("cadence"));
  const cadence: ReportCadence = overrideCadence ?? tenantCadence;
  const periodKey = parsePeriodKeyParam(search.get("period"));
  const versionParam = parseVersionParam(search.get("version"));

  const isHistorical = periodKey !== null;
  const liveQ = useReportCurrent(isHistorical ? null : cadence);
  const histQ = useReportSnapshot(periodKey, versionParam);
  const listQ = useReportSnapshotList(cadence);
  const capture = useCaptureReportSnapshot();
  const sendMut = useSendReportEmail();
  const [operatorNote, setOperatorNote] = useState<string>("");
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [lastSendResult, setLastSendResult] = useState<SendReportEmailResponse | null>(null);

  // Reset capture state when navigating away from the live view, otherwise
  // the success banner persists across what is effectively a new page.
  useEffect(() => {
    if (isHistorical) capture.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHistorical, periodKey]);

  if (user.isLoading || !user.isAuthenticated) return null;

  const envelope: ReportEnvelope | null = isHistorical
    ? (histQ.data ?? null)
    : (liveQ.data ?? null);
  const isAdmin = user.hasRole("admin");
  const emailConfig: ReportEmailConfigRecord | null = settings.data?.reportEmailConfig ?? null;
  const emailReady =
    isAdmin &&
    envelope !== null &&
    emailConfig !== null &&
    emailConfig.enabled &&
    emailConfig.recipients.length > 0;

  return (
    <>
      <PageSubheader
        title="Reports"
        sub={
          isHistorical
            ? `Historical snapshot · ${periodKey}${versionParam !== null ? ` v${versionParam}` : ""}`
            : `Live ${cadence} report — captures are point-in-time and addressable by period key.`
        }
      />
      <main className="app-main">
        <div className="reports-shell">
          <ReportsHeader
            cadence={cadence}
            overrideCadence={overrideCadence}
            isHistorical={isHistorical}
            envelope={envelope}
            isAdmin={isAdmin}
            nextAutoCaptureAt={settings.data?.reportSchedules?.autoCapture?.nextFireAt ?? null}
            htmlDownloadUrl={
              isHistorical && periodKey
                ? `/api/reports/snapshots/${encodeURIComponent(periodKey)}/html${
                    versionParam !== null ? `?version=${versionParam}` : ""
                  }`
                : `/api/reports/current/html?cadence=${encodeURIComponent(cadence)}`
            }
            captureBusy={capture.isPending}
            captureSuccess={capture.isSuccess}
            captureError={capture.error}
            operatorNote={operatorNote}
            emailReady={emailReady}
            onOperatorNoteChange={setOperatorNote}
            onCapture={() => {
              const trimmed = operatorNote.trim();
              capture.mutate({
                cadence,
                ...(trimmed ? { notes: trimmed } : {}),
              });
              // Clear the field on submit so it doesn't persist into the
              // next capture (each period gets its own context).
              if (trimmed) setOperatorNote("");
            }}
            onSend={() => {
              sendMut.reset();
              setLastSendResult(null);
              setSendDialogOpen(true);
            }}
            onCadenceChange={(c) => {
              const next = new URLSearchParams(search);
              if (c === tenantCadence) next.delete("cadence");
              else next.set("cadence", c);
              next.delete("period");
              next.delete("version");
              setSearch(next, { replace: true });
            }}
          />
          {lastSendResult && (
            <p className="banner banner--success" role="status">
              Email sent. Graph message ID:{" "}
              <code>{lastSendResult.graphMessageId.slice(0, 24)}…</code> ·{" "}
              <Link to="/admin/email/sends">Send history</Link>
              {lastSendResult.status === "sent_but_history_write_failed" && (
                <>
                  {" "}
                  <strong>· history-row write failed</strong> — send committed to audit chain;
                  reconcile via Exchange message trace.
                </>
              )}
            </p>
          )}
          <SendConsentDialog
            open={sendDialogOpen}
            periodKey={isHistorical ? periodKey : (envelope?.periodKey ?? null)}
            emailConfig={emailConfig}
            senderUpn={settings.data?.reportEmailSenderUpn ?? ""}
            isPending={sendMut.isPending}
            error={sendMut.error}
            onClose={() => setSendDialogOpen(false)}
            onConfirm={async (resolvedPeriodKey, idempotencyKey) => {
              try {
                const result = await sendMut.mutateAsync({
                  periodKey: resolvedPeriodKey,
                  idempotencyKey,
                });
                setLastSendResult(result);
                setSendDialogOpen(false);
              } catch {
                // error surfaces in the dialog via sendMut.isError
              }
            }}
          />
          <div className="reports-grid">
            <article className="reports-content">
              {(liveQ.isPending && !isHistorical) || (histQ.isPending && isHistorical) ? (
                <p className="t-body t-body--mute">Loading report…</p>
              ) : null}
              {(liveQ.isError && !isHistorical) || (histQ.isError && isHistorical) ? (
                <ReportError error={(isHistorical ? histQ.error : liveQ.error) as Error} />
              ) : null}
              {envelope && <ReportBody envelope={envelope} />}
            </article>
            <aside className="reports-sidebar print-hide">
              <RecentReportsList
                cadence={cadence}
                items={listQ.data?.items ?? []}
                pending={listQ.isPending}
                error={listQ.error}
                activePeriodKey={periodKey}
              />
            </aside>
          </div>
        </div>
      </main>
    </>
  );
}

function ReportsHeader({
  cadence,
  overrideCadence,
  isHistorical,
  envelope,
  isAdmin,
  nextAutoCaptureAt,
  htmlDownloadUrl,
  captureBusy,
  captureSuccess,
  captureError,
  operatorNote,
  emailReady,
  onOperatorNoteChange,
  onCapture,
  onSend,
  onCadenceChange,
}: {
  cadence: ReportCadence;
  overrideCadence: ReportCadence | null;
  isHistorical: boolean;
  envelope: ReportEnvelope | null;
  isAdmin: boolean;
  nextAutoCaptureAt: string | null;
  htmlDownloadUrl: string;
  captureBusy: boolean;
  captureSuccess: boolean;
  captureError: Error | null;
  operatorNote: string;
  emailReady: boolean;
  onOperatorNoteChange: (next: string) => void;
  onCapture: () => void;
  onSend: () => void;
  onCadenceChange: (c: ReportCadence) => void;
}) {
  return (
    <div className="reports-header print-hide">
      <div className="row" style={{ gap: "var(--sp-m)", alignItems: "center" }}>
        <label className="t-eyebrow" htmlFor="reports-cadence">
          Cadence
        </label>
        <select
          id="reports-cadence"
          className="select"
          value={cadence}
          onChange={(e) => onCadenceChange(e.target.value as ReportCadence)}
          disabled={isHistorical}
        >
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {REPORT_CADENCE_LABELS[c]}
            </option>
          ))}
        </select>
        {overrideCadence && (
          <span className="badge badge--info" style={{ marginLeft: 8 }}>
            override · admin can save tenant default in <Link to="/admin">Admin</Link>
          </span>
        )}
      </div>
      {!isHistorical && isAdmin && (
        <div style={{ marginTop: 8 }}>
          <label
            htmlFor="reports-operator-note"
            className="t-caption"
            style={{ display: "block", marginBottom: 4 }}
          >
            Operator note (optional, surfaces in the report)
          </label>
          <textarea
            id="reports-operator-note"
            className="input"
            value={operatorNote}
            onChange={(e) => onOperatorNoteChange(e.target.value.slice(0, 1000))}
            placeholder="e.g. Onboarded customer X this month, deprecated server Y."
            rows={2}
            maxLength={1000}
            disabled={captureBusy}
            style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
          />
          <p className="t-caption" style={{ marginTop: 2 }}>
            {operatorNote.length} / 1000 chars
          </p>
        </div>
      )}
      <div className="row" style={{ gap: "var(--sp-s)", alignItems: "center" }}>
        {!isHistorical && isAdmin && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onCapture}
            disabled={captureBusy || envelope === null}
            aria-label={`Capture ${cadence} report`}
          >
            {captureBusy ? "Capturing…" : "Capture this period"}
          </button>
        )}
        {!isHistorical && <NextFireBadge nextFireAt={nextAutoCaptureAt} />}
        <button
          type="button"
          className="btn btn--subtle"
          disabled={envelope === null}
          aria-label="Download standalone HTML report"
          onClick={() => openAuthGatedHtmlInNewTab(htmlDownloadUrl)}
        >
          Download HTML
        </button>
        <button
          type="button"
          className="btn btn--subtle"
          onClick={() => window.print()}
          disabled={envelope === null}
          aria-label="Print report"
        >
          Print
        </button>
        {isAdmin && (
          <button
            type="button"
            className="btn btn--subtle"
            onClick={onSend}
            disabled={!emailReady}
            title={
              !emailReady
                ? "Configure /admin/email and capture a snapshot before sending."
                : "Send this snapshot to the configured recipients."
            }
            aria-label="Send report by email"
          >
            Send by email
          </button>
        )}
      </div>
      {captureSuccess && (
        <p className="banner banner--success" role="status">
          Captured. New version available in the sidebar.
        </p>
      )}
      {captureError && (
        <p className="banner banner--danger" role="alert">
          Capture failed.{" "}
          {captureError instanceof ApiError
            ? `(${captureError.status}) ${captureError.message}`
            : captureError.message}
        </p>
      )}
    </div>
  );
}

function ReportBody({ envelope }: { envelope: ReportEnvelope }) {
  const periodLabel = useMemo(() => {
    const start = new Date(envelope.periodStart);
    const end = new Date(envelope.periodEnd);
    return `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`;
  }, [envelope.periodStart, envelope.periodEnd]);
  const captured = new Date(envelope.capturedAt);

  return (
    <div className="reports-doc">
      <header className="reports-doc__head">
        <h1 className="t-h1">{envelope.periodKey}</h1>
        <p className="t-body t-body--mute">
          {REPORT_CADENCE_LABELS[envelope.periodCadence]} · {periodLabel}
        </p>
        <p className="t-caption">
          Captured {captured.toLocaleString()} · v{envelope.version}
        </p>
      </header>
      <ReportSection title="Microsoft Secure Score" data={envelope.sections.secureScore} />
      <ReportSection title="Incidents" data={envelope.sections.incidents} />
      <ReportSection title="Risky Users" data={envelope.sections.entraRisk} />
      <ReportSection title="Daily Brief" data={envelope.sections.brief} />
      <ReportSection title="Weekly Posture" data={envelope.sections.posture} />
      <ReportSection title="Ingest health" data={envelope.sections.ingestHealth} />
    </div>
  );
}

/**
 * Generic section renderer — for v1 we surface the JSON for transparency
 * and so the operator can see what's in the snapshot. Phase B will swap
 * each section for a tailored renderer (sparkline, badge grid, prose).
 *
 * Pre-formatted text rendering keeps Microsoft-authored prose strings
 * plain-text only (ADR-0012 §5) — `<pre>` doesn't interpret HTML and
 * React escapes the JSON.stringify output, so a hostile control name
 * stored in SecureScore can't break out into executable markup here.
 */
function ReportSection({ title, data }: { title: string; data: unknown }) {
  return (
    <section className="reports-doc__section">
      <h2 className="t-h2">{title}</h2>
      {data === null || data === undefined ? (
        <p className="t-body t-body--mute">No data captured.</p>
      ) : (
        <pre className="reports-doc__json">{JSON.stringify(data, null, 2)}</pre>
      )}
    </section>
  );
}

function RecentReportsList({
  cadence,
  items,
  pending,
  error,
  activePeriodKey,
}: {
  cadence: ReportCadence;
  items: readonly ReportSnapshotListItem[];
  pending: boolean;
  error: unknown;
  activePeriodKey: string | null;
}) {
  return (
    <section className="reports-recent" aria-label={`Recent ${cadence} reports`}>
      <p className="t-eyebrow">Recent {cadence} reports</p>
      {pending && <p className="t-caption">Loading…</p>}
      {error !== null && error !== undefined && (
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load history.
        </p>
      )}
      {!pending && !error && items.length === 0 && (
        <p className="t-body t-body--mute">
          No captured reports yet. Use &ldquo;Capture this period&rdquo; to create the first.
        </p>
      )}
      <ul className="reports-recent__list">
        {items.map((it) => {
          const active = activePeriodKey === it.periodKey || (activePeriodKey === null && false);
          const captured = new Date(it.capturedAt);
          return (
            <li key={`${it.periodKey}-${it.version}`}>
              <Link
                to={`/reports?period=${encodeURIComponent(it.periodKey)}&version=${it.version}`}
                className={`reports-recent__item ${active ? "is-active" : ""}`}
              >
                <span className="reports-recent__period">{it.periodKey}</span>
                <span className="reports-recent__meta">
                  v{it.version} · {captured.toLocaleDateString()}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ReportError({ error }: { error: Error }) {
  return (
    <p className="t-body" style={{ color: "var(--red-fg)" }}>
      Could not load report.{" "}
      {error instanceof ApiError ? `(${error.status}) ${error.message}` : error.message}
    </p>
  );
}

// ADR-0030 Phase C §C.11 — universal consent interstitial on every Send
// click (including internal recipients). Generates a fresh Idempotency-Key
// per dialog open via crypto.randomUUID() so a double-click doesn't
// double-send; the API's 24h replay cache treats both posts as the same
// logical send and replays the first response on the second.
function SendConsentDialog({
  open,
  periodKey,
  emailConfig,
  senderUpn,
  isPending,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  periodKey: string | null;
  emailConfig: ReportEmailConfigRecord | null;
  senderUpn: string;
  isPending: boolean;
  error: Error | null;
  onClose: () => void;
  onConfirm: (periodKey: string, idempotencyKey: string) => void | Promise<void>;
}) {
  // Generate a stable key for the lifetime of this dialog session so a
  // re-render while the dialog is open doesn't rotate the value.
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => fallbackUuid());
  useEffect(() => {
    if (open) setIdempotencyKey(fallbackUuid());
  }, [open]);

  if (!open || !emailConfig || !periodKey) return null;
  // WS10 Slice 1(d)/C MED #1 — senderDomain derived from the configured
  // sender mailbox UPN (surfaced by GET /api/settings.reportEmailSenderUpn),
  // not from the envelope's tenantId (a GUID with no domain). When unset
  // (Phase C inert), every non-empty recipient domain is treated as
  // external — fail-loud so the operator sees the warning.
  const senderDomain = domainOf(senderUpn);
  const senderMailbox = senderUpn.length > 0 ? senderUpn : "(not configured)";
  const externalRecipients = emailConfig.recipients.filter((r) => {
    const d = domainOf(r);
    if (d === "") return false; // skip malformed entries — server validator rejects them
    return senderDomain === "" || d !== senderDomain;
  });

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && !isPending && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Send report by email — confirm</DialogTitle>
          <DialogContent>
            <p className="t-body">
              You are about to send the snapshot for period <strong>{periodKey}</strong> to{" "}
              <strong>{emailConfig.recipients.length}</strong> recipient
              {emailConfig.recipients.length === 1 ? "" : "s"} via the configured sender mailbox{" "}
              {senderMailbox}.
            </p>
            <p className="t-body t-body--mute">
              Every send is recorded in the audit chain. The 24-hour idempotency cache prevents
              double-sends with the same key:
            </p>
            <pre
              style={{
                background: "var(--bg-2)",
                padding: "6px 10px",
                borderRadius: 4,
                fontSize: "var(--fs-200)",
                margin: "6px 0",
              }}
            >
              Idempotency-Key: {idempotencyKey}
            </pre>

            <div style={{ marginTop: "var(--sp-m)" }}>
              <p className="t-body" style={{ fontWeight: 600, marginBottom: 6 }}>
                Recipients
              </p>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {emailConfig.recipients.map((r) => (
                  <li
                    key={r}
                    style={{
                      fontFamily: "var(--font-mono, monospace)",
                      fontSize: "var(--fs-200)",
                    }}
                  >
                    {r}
                  </li>
                ))}
              </ul>
              {emailConfig.subjectPrefix && (
                <p className="t-caption" style={{ marginTop: 8 }}>
                  Subject will be prefixed with <code>{emailConfig.subjectPrefix}</code>.
                </p>
              )}
              {externalRecipients.length > 0 && (
                <MessageBar intent="warning" style={{ marginTop: 10 }}>
                  <MessageBarBody>
                    <strong>External recipients:</strong> {externalRecipients.join(", ")}. Snapshot
                    contents will leave your tenant boundary.
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>

            {error && <SendErrorBanner error={error} />}
          </DialogContent>
          <DialogActions>
            <button
              type="button"
              className="btn btn--subtle btn--small"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary btn--small"
              onClick={() => onConfirm(periodKey, idempotencyKey)}
              disabled={isPending}
            >
              {isPending ? "Sending…" : "I confirm — send"}
            </button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Structured error shape emitted by every report-email handler (§C.5).
 *  All four documented branches (idempotency_key_mismatch, capture_in_progress,
 *  rate_limited, not_configured) populate `error.code` + `error.message` and
 *  the rate-limited branch additionally surfaces `retryAfterSeconds`. */
interface StructuredErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly retryAfterSeconds?: number;
    readonly cachedPeriodKey?: string;
    readonly cachedAt?: string;
    readonly correlationId?: string;
  };
}

function readStructuredError(err: unknown): StructuredErrorPayload["error"] | null {
  if (!(err instanceof ApiError)) return null;
  const p = err.payload as StructuredErrorPayload | undefined;
  if (!p || typeof p !== "object" || !p.error || typeof p.error !== "object") return null;
  return p.error;
}

/** Live countdown — re-renders once per second until target reaches 0.
 *  Used by the 429 banner so the operator sees the cooldown shrink instead
 *  of having to guess from a static retry-after header. */
function useCountdown(initialSeconds: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(initialSeconds);
  useEffect(() => {
    setRemaining(initialSeconds);
  }, [initialSeconds]);
  useEffect(() => {
    if (remaining === null || remaining <= 0) return;
    const t = window.setTimeout(() => setRemaining((r) => (r === null ? null : r - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [remaining]);
  return remaining;
}

function SendErrorBanner({ error }: { error: Error }) {
  const structured = readStructuredError(error);
  const code = structured?.code ?? null;
  const retryAfter = useCountdown(
    (code === "rate_limited" || code === "auto_capture_rate_limited") &&
      typeof structured?.retryAfterSeconds === "number"
      ? structured.retryAfterSeconds
      : null,
  );

  // Specific branch — idempotency-key was previously bound to a different
  // periodKey. The dialog's useEffect rotates the key on next reopen, so
  // close + reopen is the friction-free retry path.
  if (code === "idempotency_key_mismatch") {
    return (
      <MessageBar intent="warning" role="alert" style={{ marginTop: 10 }}>
        <MessageBarBody>
          This Idempotency-Key was already used for periodKey=
          <code>{structured?.cachedPeriodKey ?? "(unknown)"}</code>. Close this dialog and reopen to
          generate a fresh key, then resend.
        </MessageBarBody>
      </MessageBar>
    );
  }

  // 409 capture-in-progress — orthogonal to idempotency; another writer is
  // landing the same period. Friendly retry advice.
  if (code === "capture_in_progress") {
    return (
      <MessageBar intent="warning" role="alert" style={{ marginTop: 10 }}>
        <MessageBarBody>
          Another capture for this period is in progress. Wait a few seconds and try again.
        </MessageBarBody>
      </MessageBar>
    );
  }

  // 429 rate-limit — show a live countdown so the operator knows when to
  // retry without guessing or polling the network tab.
  if (code === "rate_limited") {
    const label =
      retryAfter !== null && retryAfter > 0
        ? `Try again in ${retryAfter}s.`
        : "Retry window has elapsed — try again.";
    return (
      <MessageBar intent="warning" role="alert" style={{ marginTop: 10 }}>
        <MessageBarBody>
          Rate-limited — this tenant is capped at 10 sends per 24 hours. {label}
        </MessageBarBody>
      </MessageBar>
    );
  }

  // 429 auto-capture sub-budget — distinct from the send budget; the operator
  // can still send for already-captured periodKeys. Tell them so.
  if (code === "auto_capture_rate_limited") {
    const label =
      retryAfter !== null && retryAfter > 0
        ? `Try again in ${retryAfter}s.`
        : "Retry window has elapsed — try again.";
    return (
      <MessageBar intent="warning" role="alert" style={{ marginTop: 10 }}>
        <MessageBarBody>
          Auto-capture is capped at 5 per 24 hours per tenant. The send budget (10/24h) is
          unaffected; sending an already-captured periodKey will still succeed. {label}
        </MessageBarBody>
      </MessageBar>
    );
  }

  // Service not configured (503).
  if (code === "not_configured") {
    return (
      <MessageBar intent="warning" role="alert" style={{ marginTop: 10 }}>
        <MessageBarBody>
          Report email isn&rsquo;t fully configured.{" "}
          <Link to="/admin/email">Open admin settings</Link> to enable it and add recipients.
        </MessageBarBody>
      </MessageBar>
    );
  }

  // Default — preserves the existing diagnostic line for unstructured errors
  // and unrecognised codes.
  return (
    <MessageBar intent="error" role="alert" style={{ marginTop: 10 }}>
      <MessageBarBody>
        Send failed.{" "}
        {error instanceof ApiError ? `(${error.status}) ${error.message}` : error.message}
      </MessageBarBody>
    </MessageBar>
  );
}

function domainOf(addr: string): string {
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return "";
  return addr.slice(at + 1).toLowerCase();
}

/** crypto.randomUUID is widely available in modern browsers; the fallback
 *  uses Math.random for environments without crypto access (none in our
 *  production targets, but keeps unit-test environments happy). The server
 *  validator enforces the regex either way. */
function fallbackUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const r = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  return `${r()}-${r().slice(0, 4)}-${r().slice(0, 4)}-${r().slice(0, 4)}-${r()}${r().slice(0, 4)}`;
}

function parseCadenceParam(raw: string | null): ReportCadence | null {
  if (raw === "weekly" || raw === "monthly" || raw === "quarterly") return raw;
  return null;
}

function parsePeriodKeyParam(raw: string | null): string | null {
  if (raw === null || raw === "") return null;
  return PERIOD_KEY_RE.test(raw) ? raw : null;
}

function parseVersionParam(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw || n < 1) return null;
  return n;
}

// Phase-D2 regression fix. Plain `<a href="/api/...">`
// browser navigation does NOT carry the MSAL Authorization: Bearer header,
// so the FA returns 401. Fetch via the api wrapper (Bearer auto-attached),
// wrap response in a Blob, open the blob URL in a new tab.
//
// Popup-blocker dance: the new tab MUST be opened synchronously inside the
// click handler (a fetch-then-open chain breaks the user-gesture chain and
// most browsers will block the popup). We open about:blank up front, then
// navigate it once the HTML resolves.
//
// `noopener` is deliberately NOT passed: per the WHATWG spec, `window.open`
// with `noopener` returns null on the caller side (the new-tab handle is
// severed) which would prevent the post-fetch navigation. Tabnabbing
// is not a concern here — the new tab loads a same-origin blob URL of our
// own server-rendered report HTML (renderEnvelopeHtml uses a tagged-
// template html helper that auto-escapes every interpolation, so the loaded
// page cannot run attacker-influenced script). We null `newTab.opener`
// after navigation completes as a belt-and-braces measure.
function openAuthGatedHtmlInNewTab(url: string): void {
  const newTab = window.open("about:blank", "_blank");
  if (!newTab) {
    // Popup blocker firing means we can't open a new tab from this gesture.
    // Surface a hint rather than fail silently.
    window.alert("Popup blocked. Allow popups for this site to download the HTML report.");
    return;
  }
  newTab.document.write(
    '<!doctype html><meta charset=utf-8><title>Loading report…</title><p style="font-family:system-ui;padding:2rem">Loading report…</p>',
  );
  newTab.document.close();
  api
    .get<string>(url)
    .then((html) => {
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      newTab.location.href = objectUrl;
      // Belt-and-braces: drop the opener reference once the trusted page
      // has loaded so any future code that runs in the report tab cannot
      // navigate this tab.
      try {
        newTab.opener = null;
      } catch {
        /* cross-origin or already-closed — harmless */
      }
      // Revoke the object URL after the new tab has had time to load it.
      // 60 s is generous; the browser hangs onto the resource for the
      // already-loaded page even after revocation.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    })
    .catch((err: unknown) => {
      const msg =
        err instanceof ApiError
          ? `(${err.status}) ${err.message}`
          : ((err as Error)?.message ?? "failed to load report");
      try {
        newTab.document.body.innerText = `Error: ${msg}`;
      } catch {
        // Tab may have been closed mid-fetch — nothing to surface.
      }
    });
}
