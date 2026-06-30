// User dormancy list view (ADR-0034 §3.1).
//
// Sortable table with dormant-only toggle. Plain-text-only rendering on
// UPN + displayName (ADR-0012 §5). The list endpoint already projects to
// the SPA-safe shape (no chain SHAs / no error.message — see
// getUserDormancyList.ts).

import { useState } from "react";
import {
  Body1,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Skeleton,
  SkeletonItem,
  Subtitle2,
  Title2,
  tokens,
} from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useUserDormancyList, type UserDormancyListParams } from "./queries";
import type { UserDormancyListItem } from "./types";

const SORTS: ReadonlyArray<{
  readonly key: NonNullable<UserDormancyListParams["sort"]>;
  readonly label: string;
}> = [
  { key: "lastSignIn", label: "Last sign-in (oldest first)" },
  { key: "upn", label: "User principal name" },
  { key: "displayName", label: "Display name" },
];

export function UserDormancyList() {
  const [dormantOnly, setDormantOnly] = useState(true);
  const [sort, setSort] = useState<NonNullable<UserDormancyListParams["sort"]>>("lastSignIn");
  const [limit, setLimit] = useState(50);
  const query = useUserDormancyList({ dormantOnly, sort, limit });

  return (
    <Card style={{ width: "100%", maxWidth: 1200 }}>
      <CardHeader
        header={<Title2>Dormant accounts</Title2>}
        {...(query.data?.policy
          ? {
              description: (
                <Subtitle2>
                  Threshold: &gt;{query.data.policy.thresholdDays} days since last sign-in.{" "}
                  {query.data.policy.includeDisabledAccounts
                    ? "Disabled accounts included."
                    : "Disabled accounts excluded."}
                  {query.data.policy.excludeServiceAccountSuffixes.length > 0 && (
                    <>
                      {" "}
                      Excluded suffixes:{" "}
                      <code>{query.data.policy.excludeServiceAccountSuffixes.join(", ")}</code>.
                    </>
                  )}
                </Subtitle2>
              ),
            }
          : {})}
      />

      <div
        style={{
          display: "flex",
          gap: tokens.spacingHorizontalL,
          alignItems: "center",
          flexWrap: "wrap",
          padding: tokens.spacingHorizontalM,
        }}
      >
        <Checkbox
          checked={dormantOnly}
          onChange={(_, v) => setDormantOnly(v.checked === true)}
          label="Dormant only"
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: tokens.spacingHorizontalS,
          }}
        >
          Sort by:
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as NonNullable<UserDormancyListParams["sort"]>)}
            style={{ padding: 4 }}
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: tokens.spacingHorizontalS,
          }}
        >
          Limit:
          <select
            value={limit}
            onChange={(e) => setLimit(Number.parseInt(e.target.value, 10))}
            style={{ padding: 4 }}
          >
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {query.isPending && (
        <div style={{ padding: tokens.spacingHorizontalL }}>
          <Skeleton>
            <SkeletonItem size={32} />
            <SkeletonItem size={32} style={{ marginTop: 8 }} />
            <SkeletonItem size={32} style={{ marginTop: 8 }} />
          </Skeleton>
        </div>
      )}
      {query.isError && (
        <Body1
          style={{
            color: tokens.colorPaletteRedForeground1,
            padding: tokens.spacingHorizontalL,
          }}
        >
          Could not load dormancy list.{" "}
          {query.error instanceof ApiError
            ? `(${query.error.status}) ${query.error.message}`
            : (query.error as Error).message}
          <div style={{ marginTop: tokens.spacingVerticalS }}>
            <Button onClick={() => query.refetch()}>Retry</Button>
          </div>
        </Body1>
      )}
      {query.isSuccess && query.data.health.status === "licence_required" && (
        <Body1 style={{ padding: tokens.spacingHorizontalL }}>
          Dormancy data requires Entra ID P1.
        </Body1>
      )}
      {query.isSuccess && query.data.items.length === 0 && (
        <Body1
          style={{
            padding: tokens.spacingHorizontalL,
            color: tokens.colorNeutralForeground3,
          }}
        >
          {dormantOnly
            ? "No dormant accounts under the current policy."
            : "No users tracked for this tenant."}
        </Body1>
      )}
      {query.isSuccess && query.data.items.length > 0 && <ListTable items={query.data.items} />}
      {query.isSuccess &&
        query.data.range.totalRows !== undefined &&
        query.data.range.returnedCount < (query.data.range.totalRows ?? 0) && (
          <Body1
            style={{
              padding: tokens.spacingHorizontalM,
              color: tokens.colorNeutralForeground3,
              fontSize: tokens.fontSizeBase200,
            }}
          >
            Showing {query.data.range.returnedCount} of {query.data.range.totalRows} rows. Increase
            the limit to see more.
          </Body1>
        )}
    </Card>
  );
}

function ListTable({ items }: { readonly items: readonly UserDormancyListItem[] }) {
  return (
    <table className="dt" style={{ fontSize: "var(--fs-200)", margin: "var(--sp-m)" }}>
      <thead>
        <tr>
          <th>UPN</th>
          <th>Display name</th>
          <th>Status</th>
          <th>Last sign-in</th>
          <th className="num">Age (days)</th>
          <th>Dormant</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.id}>
            <td>{r.userPrincipalName}</td>
            <td>{r.displayName}</td>
            <td>
              <span className={`badge badge--${r.accountEnabled ? "success" : "neutral"}`}>
                {r.accountEnabled ? "Enabled" : "Disabled"}
              </span>
            </td>
            <td className="t-body--mute">
              {r.lastSignIn === null ? "never" : new Date(r.lastSignIn).toLocaleDateString()}
            </td>
            <td className="num tnum">{r.ageDays === null ? "—" : r.ageDays}</td>
            <td>
              {r.isDormant ? (
                <span className="badge badge--warning">Dormant</span>
              ) : (
                <span className="badge badge--neutral">Active</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
