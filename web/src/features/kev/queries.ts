// ADR-0032 + ADR-0033 — React Query hooks for /api/kev/*.

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { STACK_ITEMS_KEY } from "@/features/stack/queries";
import type {
  CveMatchSummary,
  KevSuppressionStatus,
  StackItem,
  StackItemsResponse,
} from "@/features/stack/types";
import type { KevSummaryResponse } from "./types";

export function useKevSummary() {
  return useQuery<KevSummaryResponse>({
    queryKey: ["kev", "summary"],
    queryFn: () => api.get<KevSummaryResponse>("/api/kev/summary"),
    staleTime: 60_000,
  });
}

export interface KevSuppressionPatch {
  readonly stackItemId: string;
  readonly cveID: string;
  readonly status: KevSuppressionStatus;
  readonly notes?: string;
  readonly expiresAt?: string;
}

interface OptimisticContext {
  readonly previous: StackItemsResponse | undefined;
}

// Patch a single (item, cve) match in the StackItemsResponse cache. Returns
// a NEW response object (no in-place mutation — React Query cached values
// are treated as immutable so consumers re-render).
function patchMatchInCache(
  cache: StackItemsResponse,
  stackItemId: string,
  cveID: string,
  patch: Partial<CveMatchSummary>,
): StackItemsResponse {
  const items: StackItem[] = cache.items.map((item) => {
    if (item.id !== stackItemId) return item;
    const matches = item.kevMatches ?? [];
    const next: CveMatchSummary[] = matches.map((m) =>
      m.cveID === cveID ? { ...m, ...patch } : m,
    );
    return { ...item, kevMatches: next };
  });
  return { ...cache, items };
}

async function snapshotAndPatch(
  qc: QueryClient,
  stackItemId: string,
  cveID: string,
  patch: Partial<CveMatchSummary>,
): Promise<OptimisticContext> {
  // Cancel any in-flight refetches so they don't overwrite our optimistic
  // patch before the server round-trip lands.
  await qc.cancelQueries({ queryKey: STACK_ITEMS_KEY });
  const previous = qc.getQueryData<StackItemsResponse>(STACK_ITEMS_KEY);
  if (previous) {
    qc.setQueryData<StackItemsResponse>(
      STACK_ITEMS_KEY,
      patchMatchInCache(previous, stackItemId, cveID, patch),
    );
  }
  return { previous };
}

function rollback(qc: QueryClient, ctx: OptimisticContext | undefined) {
  if (ctx?.previous) qc.setQueryData(STACK_ITEMS_KEY, ctx.previous);
}

function invalidateBoth(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: STACK_ITEMS_KEY });
  void qc.invalidateQueries({ queryKey: ["kev", "summary"] });
}

/** ADR-0033 — admin sets/changes suppression status on a (item, CVE) pair. */
export function useSetKevSuppression() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, KevSuppressionPatch, OptimisticContext>({
    mutationFn: (input) => {
      const { stackItemId, cveID, ...body } = input;
      return api.patch(
        `/api/kev/suppressions/${encodeURIComponent(stackItemId)}/${encodeURIComponent(cveID)}`,
        body,
      );
    },
    onMutate: ({ stackItemId, cveID, status, notes, expiresAt }) =>
      snapshotAndPatch(qc, stackItemId, cveID, {
        status,
        notes: notes ?? null,
        expiresAt: expiresAt ?? null,
        // updatedAt/updatedBy reconciled by the server via onSettled invalidate.
        updatedAt: new Date().toISOString(),
      }),
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    // The /kev page reads matches via getStackItems (kevMatches[]); the
    // KevTile reads counts via /api/kev/summary. Both refresh on settle so
    // the optimistic patch is reconciled against the server (covers the
    // success path AND any rollback after error).
    onSettled: () => invalidateBoth(qc),
  });
}

/** ADR-0033 — admin clears a suppression (status reverts to `open`). */
export function useClearKevSuppression() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { stackItemId: string; cveID: string }, OptimisticContext>({
    mutationFn: ({ stackItemId, cveID }) =>
      api.delete(
        `/api/kev/suppressions/${encodeURIComponent(stackItemId)}/${encodeURIComponent(cveID)}`,
      ),
    onMutate: ({ stackItemId, cveID }) =>
      snapshotAndPatch(qc, stackItemId, cveID, {
        status: "open",
        notes: null,
        expiresAt: null,
        updatedAt: null,
        updatedBy: null,
      }),
    onError: (_err, _vars, ctx) => rollback(qc, ctx),
    onSettled: () => invalidateBoth(qc),
  });
}
