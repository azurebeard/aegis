// Risky Users list view — tabular display with riskLevel / riskState filters,
// cursor pagination, soft-delete + remediated-state toggles (ADR-0024 §1.2).
// Every displayed field is rendered plain-text only (ADR-0024 §6).

import { useState } from "react";
import {
  Badge,
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
import { useRiskyUsersList } from "./queries";
import type { EntraRiskLevel, EntraRiskState, RiskyUser } from "./types";

const RISK_LEVELS: readonly EntraRiskLevel[] = [
  "high",
  "medium",
  "low",
  "hidden",
  "none",
  "unknown",
];

const RISK_STATES: readonly EntraRiskState[] = [
  "atRisk",
  "confirmedCompromised",
  "remediated",
  "confirmedSafe",
  "dismissed",
  "none",
  "unknown",
];

const ENTRA_DEEP_LINK = (id: string) =>
  `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/UserDetailsMenuBlade/~/RiskInformation/userId/${encodeURIComponent(id)}/hidePreviewBanner~/true`;

export function RiskyUsersList() {
  const [riskLevel, setRiskLevel] = useState<readonly EntraRiskLevel[]>([]);
  const [riskState, setRiskState] = useState<readonly EntraRiskState[]>([]);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [includeRemediated, setIncludeRemediated] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

  const query = useRiskyUsersList({
    riskLevel,
    riskState,
    includeDeleted,
    includeRemediated,
    cursor,
    limit: 25,
  });

  return (
    <Card style={{ width: "100%", maxWidth: 1200 }}>
      <CardHeader header={<Title2>Risky users</Title2>} />

      <FilterBar
        riskLevel={riskLevel}
        riskState={riskState}
        includeDeleted={includeDeleted}
        includeRemediated={includeRemediated}
        onRiskLevelChange={(v) => {
          setRiskLevel(v);
          setCursor(null);
        }}
        onRiskStateChange={(v) => {
          setRiskState(v);
          setCursor(null);
        }}
        onIncludeDeletedChange={(v) => {
          setIncludeDeleted(v);
          setCursor(null);
        }}
        onIncludeRemediatedChange={(v) => {
          setIncludeRemediated(v);
          setCursor(null);
        }}
      />

      {query.isPending && (
        <Skeleton style={{ marginTop: tokens.spacingVerticalM }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonItem key={i} size={32} style={{ marginTop: tokens.spacingVerticalS }} />
          ))}
        </Skeleton>
      )}

      {query.isError && (
        <Body1
          block
          style={{ color: tokens.colorPaletteRedForeground1, marginTop: tokens.spacingVerticalM }}
        >
          Could not load risky users. {(query.error as Error).message}
          {query.error instanceof ApiError && query.error.status === 400 && (
            <> &mdash; try resetting filters and try again.</>
          )}
        </Body1>
      )}

      {query.isSuccess && (
        <>
          <Subtitle2
            style={{
              marginTop: tokens.spacingVerticalM,
              color: tokens.colorNeutralForeground3,
            }}
          >
            {query.data.riskyUsers.length} of{" "}
            {query.data.page.hasMore
              ? `${query.data.riskyUsers.length}+ (more available)`
              : query.data.riskyUsers.length}
          </Subtitle2>
          <RiskyUsersTable users={query.data.riskyUsers} />
          <div
            style={{
              display: "flex",
              gap: tokens.spacingHorizontalS,
              marginTop: tokens.spacingVerticalM,
            }}
          >
            <Button disabled={cursor === null} onClick={() => setCursor(null)}>
              First page
            </Button>
            <Button
              disabled={!query.data.page.hasMore || !query.data.page.nextCursor}
              onClick={() => setCursor(query.data.page.nextCursor)}
            >
              Next page
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function FilterBar(props: {
  readonly riskLevel: readonly EntraRiskLevel[];
  readonly riskState: readonly EntraRiskState[];
  readonly includeDeleted: boolean;
  readonly includeRemediated: boolean;
  readonly onRiskLevelChange: (v: readonly EntraRiskLevel[]) => void;
  readonly onRiskStateChange: (v: readonly EntraRiskState[]) => void;
  readonly onIncludeDeletedChange: (v: boolean) => void;
  readonly onIncludeRemediatedChange: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        marginTop: tokens.spacingVerticalM,
        display: "flex",
        flexWrap: "wrap",
        gap: tokens.spacingHorizontalL,
      }}
    >
      <FilterGroup<EntraRiskLevel>
        label="Risk level"
        values={RISK_LEVELS}
        selected={props.riskLevel}
        onChange={props.onRiskLevelChange}
      />
      <FilterGroup<EntraRiskState>
        label="Risk state"
        values={RISK_STATES}
        selected={props.riskState}
        onChange={props.onRiskStateChange}
      />
      <fieldset
        style={{
          border: `1px solid ${tokens.colorNeutralStroke2}`,
          borderRadius: tokens.borderRadiusMedium,
          padding: tokens.spacingVerticalS,
        }}
      >
        <legend style={{ fontSize: tokens.fontSizeBase300, fontWeight: 600 }}>Scope</legend>
        <Checkbox
          checked={props.includeDeleted}
          label="Show soft-deleted users"
          onChange={(_, d) => props.onIncludeDeletedChange(d.checked === true)}
        />
        <Checkbox
          checked={props.includeRemediated}
          label="Include remediated / safe / dismissed"
          onChange={(_, d) => props.onIncludeRemediatedChange(d.checked === true)}
        />
      </fieldset>
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  values,
  selected,
  onChange,
}: {
  label: string;
  values: readonly T[];
  selected: readonly T[];
  onChange: (s: readonly T[]) => void;
}) {
  const set = new Set<T>(selected);
  return (
    <fieldset
      style={{
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusMedium,
        padding: tokens.spacingVerticalS,
      }}
    >
      <legend style={{ fontSize: tokens.fontSizeBase300, fontWeight: 600 }}>{label}</legend>
      {values.map((v) => (
        <Checkbox
          key={v}
          checked={set.has(v)}
          label={v}
          onChange={(_, d) => {
            if (d.checked === true) onChange([...set, v]);
            else {
              const copy = new Set(set);
              copy.delete(v);
              onChange([...copy]);
            }
          }}
        />
      ))}
    </fieldset>
  );
}

function RiskyUsersTable({ users }: { users: readonly RiskyUser[] }) {
  return (
    <table
      style={{
        marginTop: tokens.spacingVerticalM,
        width: "100%",
        borderCollapse: "collapse",
        fontSize: tokens.fontSizeBase300,
      }}
    >
      <thead>
        <tr
          style={{
            textAlign: "left",
            borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
          }}
        >
          <Th>Risk level</Th>
          <Th>User</Th>
          <Th>State</Th>
          <Th>Detail</Th>
          <Th>Updated</Th>
          <Th>Link</Th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr
            key={u.id}
            style={{
              borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
            }}
          >
            <Td>
              <RiskLevelBadge level={u.riskLevel} />
            </Td>
            <Td>
              {/* Plain-text render — directory-authored. */}
              <div>{u.userDisplayName || u.userPrincipalName}</div>
              <div
                style={{
                  fontSize: tokens.fontSizeBase200,
                  color: tokens.colorNeutralForeground3,
                }}
              >
                {u.userPrincipalName}
              </div>
            </Td>
            <Td>
              {u.riskState}
              {u.isProcessing ? " (recalculating)" : ""}
              {u.isDeleted ? " (soft-deleted)" : ""}
            </Td>
            <Td>{u.riskDetail}</Td>
            <Td>{u.riskLastUpdatedDateTime.slice(0, 16).replace("T", " ")}</Td>
            <Td>
              <a href={ENTRA_DEEP_LINK(u.id)} target="_blank" rel="noreferrer noopener">
                Entra portal
              </a>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: tokens.spacingVerticalS,
        fontWeight: 600,
        color: tokens.colorNeutralForeground2,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: tokens.spacingVerticalS }}>{children}</td>;
}

function RiskLevelBadge({ level }: { level: EntraRiskLevel }) {
  const tone: "success" | "warning" | "danger" | "informative" =
    level === "high"
      ? "danger"
      : level === "medium"
        ? "warning"
        : level === "low"
          ? "informative"
          : "informative";
  return (
    <Badge appearance="filled" color={tone}>
      {level}
    </Badge>
  );
}
