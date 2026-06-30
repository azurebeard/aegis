// Wire shapes + query hook + last-seen helpers for /api/notifications
//
// "Mark as read" is purely client-side. Persisting per-user read-state
// server-side would need a TenantSettings sub-table or per-user blob
// — overscope for v1. localStorage is enough for the single-tenant
// dashboard's typical operator population.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export type NotificationKind =
  | "ingest-failure"
  | "ingest-degrading"
  | "agent-circuit-open"
  | "agent-circuit-half-open"
  | "settings-changed";

export type NotificationTone = "danger" | "warning" | "info";

export interface Notification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly tone: NotificationTone;
  readonly title: string;
  readonly detail: string;
  readonly timestamp: string;
}

export interface NotificationsResponse {
  readonly schemaVersion: 1;
  readonly notifications: readonly Notification[];
  readonly generatedAt: string;
}

export function useNotifications(opts: { readonly enabled?: boolean } = {}) {
  // ADR-0035 Phase D2 hygiene — caller passes `enabled: user.isAuthenticated`
  // so an unauthenticated visitor doesn't generate /api/notifications 401s
  // every 60 s on the polling interval.
  return useQuery<NotificationsResponse>({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationsResponse>("/api/notifications"),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    enabled: opts.enabled ?? true,
  });
}

const LAST_SEEN_KEY = "aegis.notifications.lastSeenAt";

/**
 * Track the operator's "mark all as read" timestamp in localStorage.
 * Returns the current timestamp + a setter that bumps it to "now".
 *
 * The unread count derives from comparing each notification's timestamp
 * against this value — anything strictly greater is unread.
 */
export function useNotificationsLastSeen(): {
  lastSeenAt: string;
  markAllRead: () => void;
} {
  const [lastSeenAt, setLastSeenAt] = useState<string>(() => {
    try {
      return window.localStorage.getItem(LAST_SEEN_KEY) ?? "";
    } catch {
      return "";
    }
  });

  // Cross-tab sync — if the operator marks read in one tab, other tabs
  // pick it up via the storage event. Safe-guarded against environments
  // that don't expose `addEventListener` on window.
  useEffect(() => {
    const handler = (e: StorageEvent): void => {
      if (e.key === LAST_SEEN_KEY) {
        setLastSeenAt(e.newValue ?? "");
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const markAllRead = (): void => {
    const now = new Date().toISOString();
    try {
      window.localStorage.setItem(LAST_SEEN_KEY, now);
    } catch {
      // localStorage may be blocked (e.g. strict privacy mode).
      // Persist in-memory only — survives the session.
    }
    setLastSeenAt(now);
  };

  return { lastSeenAt, markAllRead };
}

/**
 * Count notifications whose timestamp is strictly after the supplied
 * lastSeenAt. Empty `lastSeenAt` treats every notification as unread,
 * which is the right thing on first run / cleared cache.
 */
export function countUnread(notifications: readonly Notification[], lastSeenAt: string): number {
  if (!lastSeenAt) return notifications.length;
  let count = 0;
  for (const n of notifications) {
    if (n.timestamp > lastSeenAt) count++;
  }
  return count;
}
