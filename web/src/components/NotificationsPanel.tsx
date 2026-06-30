// Bell-icon popover surfacing recent ingest / agent / settings signals.
//
// Visual: anchors below the bell button via absolute positioning. Empty
// state when the API returns zero notifications. Mark-all-read button
// in the foot bumps the localStorage `lastSeenAt`, which clears the
// counter badge on the bell.
//
// Closes on Esc or click-outside (handled in AppHeader where this is
// mounted).

import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { Icon, type IconName } from "@/components/Icon";
import {
  useNotifications,
  type Notification,
  type NotificationKind,
  type NotificationTone,
} from "@/features/common/notifications";

interface PanelProps {
  readonly onClose: () => void;
  readonly onMarkAllRead: () => void;
  readonly lastSeenAt: string;
}

const KIND_ICONS: Readonly<Record<NotificationKind, IconName>> = {
  "ingest-failure": "alert",
  "ingest-degrading": "clock",
  "agent-circuit-open": "alert",
  "agent-circuit-half-open": "refresh",
  "settings-changed": "settings",
};

export function NotificationsPanel({ onClose, onMarkAllRead, lastSeenAt }: PanelProps) {
  const query = useNotifications();
  const notifications = query.data?.notifications ?? [];
  const hasAny = notifications.length > 0;

  return (
    <div role="dialog" aria-label="Notifications" aria-modal="false" className="notif-panel">
      <div className="notif-panel__head">
        <span className="t-eyebrow">Notifications</span>
        <button
          type="button"
          className="btn btn--small btn--subtle"
          onClick={onClose}
          aria-label="Close notifications"
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="notif-panel__body">
        {query.isPending && (
          <div style={{ padding: "var(--sp-l)" }}>
            <Skeleton>
              <SkeletonItem size={32} style={{ marginTop: "var(--sp-s)" }} />
              <SkeletonItem size={32} style={{ marginTop: "var(--sp-s)" }} />
              <SkeletonItem size={32} style={{ marginTop: "var(--sp-s)" }} />
            </Skeleton>
          </div>
        )}
        {query.isError && (
          <p className="t-body" style={{ padding: "var(--sp-l)", color: "var(--red-fg)" }}>
            Could not load notifications.{" "}
            {query.error instanceof ApiError
              ? `(${query.error.status}) ${query.error.message}`
              : (query.error as Error).message}
          </p>
        )}
        {query.isSuccess && !hasAny && (
          <div
            style={{
              padding: "var(--sp-xl)",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              gap: "var(--sp-s)",
              alignItems: "center",
            }}
          >
            <Icon name="bell" size={20} style={{ color: "var(--fg-3)" }} />
            <p className="t-body t-body--mute">All quiet.</p>
            <p className="t-caption">
              You&apos;ll see ingest failures, agent circuit-breaker trips, and recent settings
              changes here.
            </p>
          </div>
        )}
        {query.isSuccess && hasAny && (
          <ul className="notif-list">
            {notifications.map((n) => (
              <NotificationItem
                key={n.id}
                notification={n}
                unread={!lastSeenAt || n.timestamp > lastSeenAt}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="notif-panel__foot">
        <span className="t-caption t-body--mute">
          {query.data?.generatedAt
            ? `Refreshed ${new Date(query.data.generatedAt).toLocaleTimeString()}`
            : ""}
        </span>
        <button type="button" className="btn btn--small" onClick={onMarkAllRead} disabled={!hasAny}>
          Mark all read
        </button>
      </div>
    </div>
  );
}

function NotificationItem({
  notification,
  unread,
}: {
  notification: Notification;
  unread: boolean;
}) {
  return (
    <li className={`notif-item${unread ? " is-unread" : ""}`}>
      <span className={`notif-item__dot notif-item__dot--${notification.tone}`} aria-hidden />
      <Icon
        name={KIND_ICONS[notification.kind]}
        size={14}
        style={{ color: toneColour(notification.tone) }}
      />
      <div className="notif-item__main">
        <p className="notif-item__title">{notification.title}</p>
        <p className="notif-item__detail">{notification.detail}</p>
        <p className="t-caption notif-item__meta">
          {new Date(notification.timestamp).toLocaleString()}
        </p>
      </div>
    </li>
  );
}

function toneColour(tone: NotificationTone): string {
  switch (tone) {
    case "danger":
      return "var(--red-fg)";
    case "warning":
      return "var(--orange-fg)";
    case "info":
      return "var(--brand-fg)";
  }
}
