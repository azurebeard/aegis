// Sign-ins list view (ADR-0034 §3.2). Sortable + filterable table
// (out-of-area-only / CA-failures-only / limit). Plain-text-only rendering
// (ADR-0012 §5).

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
import { useSignInsList } from "./queries";
import type { SignInsListItem } from "./types";

export function SignInsList() {
  const [outOfAreaOnly, setOutOfAreaOnly] = useState(true);
  const [caFailuresOnly, setCaFailuresOnly] = useState(false);
  const [limit, setLimit] = useState(50);
  const query = useSignInsList({ outOfAreaOnly, caFailuresOnly, limit });

  return (
    <Card style={{ width: "100%", maxWidth: 1200 }}>
      <CardHeader
        header={<Title2>Sign-ins</Title2>}
        {...(query.data
          ? {
              description: (
                <Subtitle2>
                  Last {query.data.range.lookbackDays} days. Showing{" "}
                  {query.data.range.returnedCount}
                  {query.data.range.totalRows !== undefined
                    ? ` of ${query.data.range.totalRows}`
                    : ""}{" "}
                  rows.
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
          checked={outOfAreaOnly}
          onChange={(_, v) => setOutOfAreaOnly(v.checked === true)}
          label="Out-of-area only"
        />
        <Checkbox
          checked={caFailuresOnly}
          onChange={(_, v) => setCaFailuresOnly(v.checked === true)}
          label="CA failures only"
        />
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
          Could not load sign-ins.{" "}
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
          Sign-in log access requires Entra ID P1.
        </Body1>
      )}
      {query.isSuccess && query.data.items.length === 0 && (
        <Body1
          style={{
            padding: tokens.spacingHorizontalL,
            color: tokens.colorNeutralForeground3,
          }}
        >
          No sign-ins matched the current filters.
        </Body1>
      )}
      {query.isSuccess && query.data.items.length > 0 && <ListTable items={query.data.items} />}
    </Card>
  );
}

function ListTable({ items }: { readonly items: readonly SignInsListItem[] }) {
  return (
    <table className="dt" style={{ fontSize: "var(--fs-200)", margin: "var(--sp-m)" }}>
      <thead>
        <tr>
          <th>Time</th>
          <th>User</th>
          <th>App</th>
          <th>Country</th>
          <th>City</th>
          <th>IP</th>
          <th>CA</th>
          <th>Flag</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.id}>
            <td className="t-body--mute">
              {new Date(r.createdDateTime).toLocaleString(undefined, {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </td>
            <td>{r.userPrincipalName || r.userDisplayName || r.userId}</td>
            <td className="t-body--mute">{r.appDisplayName}</td>
            <td>{r.country.toUpperCase() || "—"}</td>
            <td className="t-body--mute">{r.city || "—"}</td>
            <td className="t-mono">{r.ipAddress || "—"}</td>
            <td>
              <span
                className={`badge badge--${
                  r.conditionalAccessStatus === "failure"
                    ? "danger"
                    : r.conditionalAccessStatus === "success"
                      ? "success"
                      : "neutral"
                }`}
              >
                {r.conditionalAccessStatus || "—"}
              </span>
            </td>
            <td>
              {r.outOfArea ? (
                <span className="badge badge--warning">Out-of-area</span>
              ) : (
                <span className="badge badge--neutral">In-area</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
