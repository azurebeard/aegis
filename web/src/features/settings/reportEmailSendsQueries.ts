// ADR-0030 Phase C Slice 1(d)/B — React Query hooks for the send-history
// endpoints. Read = api-reader MI on the server; delete = mailSender MI.

import { useMutation, useQuery, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export interface ReportEmailSendListItem {
  readonly schemaVersion: 1;
  readonly graphMessageId: string;
  readonly periodKey: string;
  readonly sentAt: string;
  readonly senderMailbox: string;
  readonly recipientCount: number;
  readonly operatorPrincipal: string;
  readonly auditLineSeq: number;
}

export interface ListReportEmailSendsResponse {
  readonly schemaVersion: 1;
  readonly items: readonly ReportEmailSendListItem[];
  readonly continuationToken: string | null;
}

export interface ReportEmailSendDetail {
  readonly schemaVersion: 1;
  readonly graphMessageId: string;
  readonly periodKey: string;
  readonly sentAt: string;
  readonly senderMailbox: string;
  readonly recipients: readonly string[];
  readonly operatorPrincipal: string;
  readonly internetMessageId: string;
  readonly clientRequestId: string;
  readonly auditLineSeq: number;
  readonly auditLineSha256: string;
}

const SENDS_LIST_KEY = ["reports", "email", "sends"] as const;
const SENDS_DETAIL_KEY = (id: string) => ["reports", "email", "sends", id] as const;

export function useReportEmailSends() {
  return useInfiniteQuery<ListReportEmailSendsResponse, Error>({
    queryKey: SENDS_LIST_KEY,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "20" });
      if (typeof pageParam === "string" && pageParam.length > 0) {
        params.set("continuationToken", pageParam);
      }
      return api.get<ListReportEmailSendsResponse>(`/api/reports/email/sends?${params.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.continuationToken,
    staleTime: 10_000,
  });
}

export function useReportEmailSendDetail(graphMessageId: string | null) {
  return useQuery<ReportEmailSendDetail, Error>({
    queryKey: graphMessageId
      ? SENDS_DETAIL_KEY(graphMessageId)
      : ["reports", "email", "sends", "__none__"],
    queryFn: () =>
      api.get<ReportEmailSendDetail>(
        `/api/reports/email/sends/${encodeURIComponent(graphMessageId ?? "")}`,
      ),
    enabled: graphMessageId !== null && graphMessageId.length > 0,
    staleTime: 30_000,
  });
}

export interface DeleteReportEmailSendResponse {
  readonly schemaVersion: 1;
  readonly graphMessageId: string;
  readonly deleted: boolean;
  readonly auditChainNote: string;
}

export function useDeleteReportEmailSend() {
  const qc = useQueryClient();
  return useMutation<DeleteReportEmailSendResponse, Error, string>({
    mutationFn: (graphMessageId) =>
      api.delete<DeleteReportEmailSendResponse>(
        `/api/reports/email/sends/${encodeURIComponent(graphMessageId)}`,
      ),
    onSuccess: (_resp, graphMessageId) => {
      // Invalidate the list so the row disappears; drop the detail cache
      // for the deleted id so any re-render shows the absence.
      qc.invalidateQueries({ queryKey: SENDS_LIST_KEY });
      qc.removeQueries({ queryKey: SENDS_DETAIL_KEY(graphMessageId) });
    },
  });
}

// ─── Send endpoint (POST /api/reports/snapshots/{periodKey}/email) ──────────

export interface SendReportEmailResponse {
  readonly schemaVersion: 1;
  readonly status: "sent" | "sent_but_history_write_failed";
  readonly periodKey: string;
  readonly graphMessageId: string;
  readonly internetMessageId: string;
  readonly clientRequestId: string;
  readonly sentAt: string;
  readonly recipientCount: number;
  readonly bodyBytes: number;
  readonly attempts: number;
  readonly subject: string;
}

export interface SendReportEmailVariables {
  readonly periodKey: string;
  readonly idempotencyKey: string;
}

export function useSendReportEmail() {
  const qc = useQueryClient();
  return useMutation<SendReportEmailResponse, Error, SendReportEmailVariables>({
    mutationFn: ({ periodKey, idempotencyKey }) =>
      api.post<SendReportEmailResponse>(
        `/api/reports/snapshots/${encodeURIComponent(periodKey)}/email`,
        undefined,
        { "Idempotency-Key": idempotencyKey },
      ),
    onSuccess: () => {
      // A successful send means a new row exists in the history table —
      // invalidate so the next /admin/email/sends view shows it.
      qc.invalidateQueries({ queryKey: SENDS_LIST_KEY });
    },
  });
}
