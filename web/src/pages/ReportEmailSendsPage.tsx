// /admin/email/sends — admin view of the report-email send-history.
// ADR-0030 Phase C Slice 1(d)/B. Lists rows newest-first, drill-in dialog
// exposes the full recipient list + audit pair, delete-with-confirmation
// removes the plaintext row (audit chain entries STAY).

import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
} from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { PageSubheader } from "@/components/shell/PageSubheader";
import {
  useDeleteReportEmailSend,
  useReportEmailSendDetail,
  useReportEmailSends,
  type ReportEmailSendListItem,
} from "@/features/settings/reportEmailSendsQueries";

export function ReportEmailSendsPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const listQ = useReportEmailSends();
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ReportEmailSendListItem | null>(null);
  const deleteMut = useDeleteReportEmailSend();

  useEffect(() => {
    if (!user.isLoading && !user.hasRole("admin")) {
      navigate("/", { replace: true });
    }
  }, [user.isLoading, user, navigate]);

  if (user.isLoading || !user.hasRole("admin")) {
    return (
      <main className="app-main">
        <Spinner label="Loading…" />
      </main>
    );
  }

  const items = listQ.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageSubheader
        title="Report email — send history"
        sub={
          <>
            Plaintext recipient rows for every send via the admin email endpoint.{" "}
            <RouterLink to="/admin?section=report-email">Config</RouterLink> ·{" "}
            <RouterLink to="/reports">Reports</RouterLink>
          </>
        }
      />
      <main className="app-main">
        {listQ.isPending && <Spinner label="Loading send history…" />}

        {listQ.isError && (
          <MessageBar intent="error" role="alert">
            <MessageBarBody>
              Could not load send history. {(listQ.error as Error).message}
            </MessageBarBody>
          </MessageBar>
        )}

        {listQ.data && items.length === 0 && (
          <MessageBar intent="info">
            <MessageBarBody>
              No emails have been sent yet. Triggering a send from the{" "}
              <RouterLink to="/reports">Reports</RouterLink> page will populate this list.
            </MessageBarBody>
          </MessageBar>
        )}

        {listQ.data && items.length > 0 && (
          <div className="surface" style={{ padding: "var(--sp-l)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--stroke-2)" }}>
                  <th style={th}>Sent at (UTC)</th>
                  <th style={th}>Period</th>
                  <th style={th}>Sender</th>
                  <th style={th}>Recipients</th>
                  <th style={th}>Operator</th>
                  <th style={th}>Audit seq</th>
                  <th style={{ ...th, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr
                    key={row.graphMessageId}
                    style={{ borderBottom: "1px solid var(--stroke-2)" }}
                  >
                    <td style={td}>{formatDate(row.sentAt)}</td>
                    <td style={td}>{row.periodKey}</td>
                    <td style={td}>{row.senderMailbox}</td>
                    <td style={td}>{row.recipientCount}</td>
                    <td style={td}>{row.operatorPrincipal}</td>
                    <td style={td}>{row.auditLineSeq}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn--subtle btn--small"
                        onClick={() => setDetailFor(row.graphMessageId)}
                      >
                        View
                      </button>{" "}
                      <button
                        type="button"
                        className="btn btn--subtle btn--small"
                        onClick={() => setConfirmDelete(row)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {listQ.hasNextPage && (
              <div style={{ marginTop: "var(--sp-l)", textAlign: "center" }}>
                <button
                  type="button"
                  className="btn btn--subtle btn--small"
                  disabled={listQ.isFetchingNextPage}
                  onClick={() => listQ.fetchNextPage()}
                >
                  {listQ.isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </div>
        )}

        <ViewDetailDialog graphMessageId={detailFor} onClose={() => setDetailFor(null)} />

        <ConfirmDeleteDialog
          target={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={async (id) => {
            try {
              await deleteMut.mutateAsync(id);
              setConfirmDelete(null);
            } catch {
              // mutation error surfaces in the dialog via deleteMut.isError
            }
          }}
          isPending={deleteMut.isPending}
          error={deleteMut.error}
        />
      </main>
    </>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: "var(--fs-200)",
  fontWeight: 600,
  color: "var(--fg-2)",
};
const td: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: "var(--fs-200)",
  color: "var(--fg-1)",
  verticalAlign: "top",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return iso;
  }
}

function ViewDetailDialog({
  graphMessageId,
  onClose,
}: {
  graphMessageId: string | null;
  onClose: () => void;
}) {
  const detailQ = useReportEmailSendDetail(graphMessageId);
  return (
    <Dialog open={graphMessageId !== null} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Send detail</DialogTitle>
          <DialogContent>
            {detailQ.isPending && <Spinner label="Loading detail…" />}
            {detailQ.isError && (
              <MessageBar intent="error">
                <MessageBarBody>{(detailQ.error as Error).message}</MessageBarBody>
              </MessageBar>
            )}
            {detailQ.data && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <KvRow k="Graph message ID" v={detailQ.data.graphMessageId} mono />
                <KvRow k="Internet message ID" v={detailQ.data.internetMessageId} mono />
                <KvRow k="Client request ID" v={detailQ.data.clientRequestId} mono />
                <KvRow k="Period key" v={detailQ.data.periodKey} />
                <KvRow k="Sent at" v={detailQ.data.sentAt} />
                <KvRow k="Sender" v={detailQ.data.senderMailbox} />
                <KvRow k="Operator" v={detailQ.data.operatorPrincipal} />
                <KvRow
                  k="Audit pair"
                  v={`seq=${detailQ.data.auditLineSeq} · sha256=${detailQ.data.auditLineSha256.slice(0, 12)}…`}
                  mono
                />
                <div>
                  <p className="t-body" style={{ fontWeight: 600, marginBottom: 6 }}>
                    Recipients ({detailQ.data.recipients.length})
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {detailQ.data.recipients.map((r) => (
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
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <button type="button" className="btn btn--subtle btn--small" onClick={onClose}>
              Close
            </button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function ConfirmDeleteDialog({
  target,
  onClose,
  onConfirm,
  isPending,
  error,
}: {
  target: ReportEmailSendListItem | null;
  onClose: () => void;
  onConfirm: (graphMessageId: string) => void | Promise<void>;
  isPending: boolean;
  error: Error | null;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Erase plaintext recipient row?</DialogTitle>
          <DialogContent>
            <p className="t-body">
              This removes the plaintext recipient row for{" "}
              <strong>{target?.graphMessageId.slice(0, 24)}…</strong> from TenantSettings. The audit
              chain entries (<code>report.email.intent</code> + <code>report.email.sent</code>)
              <strong> stay</strong> — chain integrity is non-negotiable. After erasure, chain
              replay shows &ldquo;send happened, plaintext purged&rdquo;.
            </p>
            {error && (
              <MessageBar intent="error" role="alert">
                <MessageBarBody>
                  Delete failed.{" "}
                  {error instanceof ApiError ? `(${error.status}) ${error.message}` : error.message}
                </MessageBarBody>
              </MessageBar>
            )}
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
              onClick={() => target && onConfirm(target.graphMessageId)}
              disabled={isPending}
            >
              {isPending ? "Erasing…" : "Erase row"}
            </button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function KvRow({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
      <span style={{ minWidth: 140, color: "var(--fg-2)", fontSize: "var(--fs-200)" }}>{k}</span>
      <span
        style={{
          fontSize: "var(--fs-200)",
          fontFamily: mono ? "var(--font-mono, monospace)" : undefined,
          wordBreak: "break-all",
        }}
      >
        {v}
      </span>
    </div>
  );
}
