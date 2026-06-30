// Shared admin-refresh hook for dashboard tiles (HANDOVER §6.3 refresh-now
// follow-up). Encapsulates the post-to-admin-endpoint + cache-bypass + react-
// query rehydrate pattern first proven on SecureScoreTile. Used by every
// populated tile so a signed-in admin can force a fresh ingest without
// navigating to the empty-state variant.
//
// The hook:
//  1. Gates on the current user's `admin` role (returns { canRefresh: false }
//     for non-admins; the tile should not render the button in that case).
//  2. On invocation: POSTs to `runEndpoint`, captures any `outcome.error` the
//     handler surfaces, then force-re-fetches `readEndpoint` with
//     `cache: "no-store"` so the Function App's `max-age=60` Cache-Control on
//     the read path does not keep the old snapshot visible client-side.
//  3. Writes the fresh body into the React Query cache via `setQueryData`
//     against `readQueryKey` so dependents re-render without a second fetch.
//  4. Invalidates `invalidateQueryKeys` (e.g. a trend query that derives from
//     the same ingest) as a catch-all.
//  5. Tracks a typed state machine (idle/running/success/error) the UI renders.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { api, ApiError } from "@/api/client";

export type AdminRefreshState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "success" }
  | { status: "error"; message: string; kind: string };

/**
 * Compile-time constraint — `runEndpoint` must target an admin-gated
 * `/api/ingest/{vertical}/run` path (WS10 SEC-L-UI-POLISH-02 resolution,
 * tightened per SEC-L-POLISH-BUNDLE-02). The SWA route rule
 * `/api/ingest/*` → `["admin"]` is the authoritative admin boundary; the
 * template-literal type closes a misconfiguration surface where a future
 * tile author points the hook at a non-admin path and the button still
 * renders for admin users (giving a misleading "refresh-implies-admin-path"
 * UX). Encoding the `/run` suffix matches the repo convention across all
 * four admin-run endpoints and rejects common typos ("/api/ingest/",
 * "/api/ingest/foo?bar=baz") at compile time. The SWA layer remains the
 * authoritative security boundary — this is defence-in-depth at the
 * developer level.
 */
export type AdminRunEndpoint = `/api/ingest/${string}/run`;

export interface AdminTileRefreshOptions {
  /** API path POSTed to trigger a fresh ingest. Must be admin-role-gated at the SWA layer. */
  readonly runEndpoint: AdminRunEndpoint;
  /** API path to re-fetch with cache-bypass after a successful run. */
  readonly readEndpoint: string;
  /** React Query cache key to write the fresh body back into. */
  readonly readQueryKey: readonly unknown[];
  /** Additional cache keys to invalidate (e.g. derived trend queries). */
  readonly invalidateQueryKeys?: readonly (readonly unknown[])[];
}

export interface AdminTileRefreshResult {
  /** True when the current user has the admin role. UI should hide the button otherwise. */
  readonly canRefresh: boolean;
  readonly state: AdminRefreshState;
  /** Call to trigger a refresh. No-op if canRefresh is false. */
  readonly refresh: () => Promise<void>;
}

/**
 * Run-and-rehydrate mutation wrapper for dashboard tile admin refresh buttons.
 *
 * Consumed by SecureScoreTile / IncidentsTile / RiskyUsersTile / BriefTile to
 * share the run-endpoint + cache-bypass + setQueryData pattern without copy-
 * pasting ~60 lines per tile.
 */
export function useAdminTileRefresh(opts: AdminTileRefreshOptions): AdminTileRefreshResult {
  const user = useCurrentUser();
  const qc = useQueryClient();
  const [state, setState] = useState<AdminRefreshState>({ status: "idle" });
  const canRefresh = user.roles.includes("admin");

  async function refresh(): Promise<void> {
    if (!canRefresh) return;
    setState({ status: "running" });
    try {
      const outcome = await api.post<{
        outcome?: { status?: string; error?: { kind?: string; message?: string } };
      }>(opts.runEndpoint);
      // Some admin handlers return 202 + envelope, some 200 + envelope; both
      // may (on error-in-success path) carry `outcome.error` even on 2xx.
      if (outcome?.outcome?.status === "error") {
        setState({
          status: "error",
          message: outcome.outcome.error?.message ?? "Ingest failed",
          kind: outcome.outcome.error?.kind ?? "unknown",
        });
        return;
      }

      try {
        const fresh = await fetch(opts.readEndpoint, {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (fresh.ok) {
          const freshBody = (await fresh.json()) as unknown;
          qc.setQueryData(opts.readQueryKey, freshBody);
        }
      } catch {
        // Non-fatal — invalidateQueries below will schedule a re-fetch.
      }

      for (const key of opts.invalidateQueryKeys ?? []) {
        await qc.invalidateQueries({ queryKey: key });
      }
      setState({ status: "success" });
    } catch (e) {
      const err = e as ApiError | Error;
      const payload =
        err instanceof ApiError && typeof err.payload === "object" && err.payload !== null
          ? (err.payload as { outcome?: { error?: { message?: string; kind?: string } } })
          : null;
      setState({
        status: "error",
        message: payload?.outcome?.error?.message ?? err.message ?? String(err),
        kind: payload?.outcome?.error?.kind ?? "http",
      });
    }
  }

  return { canRefresh, state, refresh };
}
