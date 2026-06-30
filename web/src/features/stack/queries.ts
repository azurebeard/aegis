// ADR-0031 — React Query hooks for /api/stack/*.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  CreateStackItemInput,
  PatchStackItemInput,
  StackCatalogResponse,
  StackItem,
  StackItemsResponse,
} from "./types";

const STACK_ITEMS_KEY = ["stack", "items"] as const;
const STACK_CATALOG_KEY = ["stack", "catalog"] as const;

export function useStackItems() {
  return useQuery<StackItemsResponse>({
    queryKey: STACK_ITEMS_KEY,
    queryFn: () => api.get<StackItemsResponse>("/api/stack/items"),
    staleTime: 30_000,
  });
}

export function useStackCatalog() {
  return useQuery<StackCatalogResponse>({
    queryKey: STACK_CATALOG_KEY,
    queryFn: () => api.get<StackCatalogResponse>("/api/stack/catalog"),
    // Catalog ships with deploy — long stale window.
    staleTime: 60 * 60_000,
  });
}

export function useCreateStackItem() {
  const qc = useQueryClient();
  return useMutation<{ schemaVersion: 1; item: StackItem }, Error, CreateStackItemInput>({
    mutationFn: (input) =>
      api.post<{ schemaVersion: 1; item: StackItem }>("/api/stack/items", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STACK_ITEMS_KEY });
    },
  });
}

export function useUpdateStackItem() {
  const qc = useQueryClient();
  return useMutation<
    { schemaVersion: 1; item: StackItem },
    Error,
    { id: string; patch: PatchStackItemInput }
  >({
    mutationFn: ({ id, patch }) =>
      api.patch<{ schemaVersion: 1; item: StackItem }>(`/api/stack/items/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STACK_ITEMS_KEY });
    },
  });
}

export function useDeleteStackItem() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => api.delete<void>(`/api/stack/items/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STACK_ITEMS_KEY });
    },
  });
}

export { STACK_ITEMS_KEY, STACK_CATALOG_KEY };
