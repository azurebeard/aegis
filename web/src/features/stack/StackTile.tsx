// ADR-0031 §7 — dashboard tile for stack inventory.
//
// Shows count + breakdown summary. Click → /stack. Hidden for readers
// when the tenant has zero items (admins always see it so they can
// bootstrap the inventory).

import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import type { ApiError } from "@/api/client";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { HeroStat } from "@/components/HeroStat";
import { Icon } from "@/components/Icon";
import { Tile } from "@/components/Tile";
import { useStackItems } from "./queries";
import { STACK_CATEGORY_LABELS, type StackCategory } from "./types";

export function StackTile() {
  const user = useCurrentUser();
  const q = useStackItems();
  const isAdmin = user.hasRole("admin");

  if (q.isPending) {
    return (
      <Tile title="Stack inventory" icon="tile">
        <Skeleton>
          <SkeletonItem size={48} />
          <SkeletonItem size={16} style={{ marginTop: "var(--sp-s)" }} />
        </Skeleton>
      </Tile>
    );
  }

  if (q.isError) {
    const err = q.error as ApiError | Error;
    return (
      <Tile title="Stack inventory" icon="tile">
        <p className="t-body" style={{ color: "var(--red-fg)" }}>
          Could not load stack inventory. {err.message}
        </p>
      </Tile>
    );
  }

  const items = q.data.items;
  // Hide tile entirely for readers when there's nothing yet — keeps the
  // empty-tenant dashboard clean. Admins always see it so they can act.
  if (items.length === 0 && !isAdmin) return null;

  const byCategory = new Map<StackCategory, number>();
  for (const it of items) {
    byCategory.set(it.category, (byCategory.get(it.category) ?? 0) + 1);
  }
  const categoryCount = byCategory.size;
  const lastUpdated =
    items.length === 0
      ? null
      : items.reduce((acc, it) => (it.updatedAt > acc ? it.updatedAt : acc), items[0]!.updatedAt);

  return (
    <Tile
      title="Stack inventory"
      icon="tile"
      footMeta={
        items.length === 0 ? null : (
          <>
            {categoryCount} categor{categoryCount === 1 ? "y" : "ies"}
            {lastUpdated && ` · last updated ${formatRelative(lastUpdated)}`}
          </>
        )
      }
      footAction={
        // /stack was removed in the 2026-04-28 reshape — admins manage
        // via /admin → Stack inventory; readers have no detail destination
        // beyond the dashboard tile + /kev for KEV exposure.
        isAdmin ? (
          <Link
            to="/admin?section=stack"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            {items.length === 0 ? "Add items" : "Manage"} <Icon name="chevron-right" size={11} />
          </Link>
        ) : items.length > 0 ? (
          <Link to="/kev" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            KEV exposure <Icon name="chevron-right" size={11} />
          </Link>
        ) : null
      }
    >
      {items.length === 0 ? (
        <p className="t-body t-body--mute">
          No stack items registered yet. Admins can add items to enable cross-vendor vulnerability
          tracking.
        </p>
      ) : (
        <>
          <HeroStat
            value={String(items.length)}
            caption={items.length === 1 ? "registered item" : "registered items"}
          />
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: "var(--sp-s)" }}>
            {Array.from(byCategory.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 4)
              .map(([cat, count]) => (
                <span key={cat} className="badge badge--neutral">
                  {STACK_CATEGORY_LABELS[cat]}: {count}
                </span>
              ))}
          </div>
        </>
      )}
    </Tile>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
