// Full-chart page for Secure Score (ADR-0012 §2, §4).
// v1: renders the same tile at top plus the 90-day trend; axes + tooltip
// are deferred to a later polish pass. The page exists now so the tile's
// "Open full chart" link has a target and the route is wired.

import {
  Body1,
  Card,
  CardHeader,
  Link as FluentLink,
  Spinner,
  Subtitle2,
  Title1,
  tokens,
} from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { useSecureScoreTrend } from "@/features/secureScore/queries";
import { SecureScoreTrend } from "@/features/secureScore/SecureScoreTrend";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";

export function SecureScorePage() {
  const user = useCurrentUser();
  const trend = useSecureScoreTrend(90);

  if (!user.isAuthenticated && !user.isLoading) {
    return (
      <main style={{ padding: tokens.spacingHorizontalXL }}>
        <Body1>
          <FluentLink as="button" onClick={() => void signIn("/secure-score")}>
            Sign in
          </FluentLink>{" "}
          to view the trend.
        </Body1>
      </main>
    );
  }

  return (
    <main
      style={{
        padding: tokens.spacingHorizontalXL,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
      }}
    >
      <Card style={{ maxWidth: 960, width: "100%" }}>
        <CardHeader
          header={<Title1>Secure Score — trend</Title1>}
          description={<Subtitle2>Last 90 days of daily snapshots.</Subtitle2>}
        />
        {trend.isPending && <Spinner label="Loading trend" />}
        {trend.isError && (
          <Body1 style={{ color: tokens.colorPaletteRedForeground1 }}>
            Could not load the trend. {(trend.error as Error).message}
          </Body1>
        )}
        {trend.data && (
          <div style={{ marginTop: tokens.spacingVerticalM }}>
            <SecureScoreTrend
              data={trend.data.snapshots}
              height={280}
              ariaLabel="90-day Secure Score trend"
            />
            <Body1
              style={{
                marginTop: tokens.spacingVerticalS,
                color: tokens.colorNeutralForeground3,
                fontSize: tokens.fontSizeBase200,
              }}
            >
              {trend.data.range.returnedCount} daily snapshots · range{" "}
              {trend.data.range.from ?? "—"} to {trend.data.range.to ?? "—"}
            </Body1>
          </div>
        )}
        <Body1 block style={{ marginTop: tokens.spacingVerticalM }}>
          <Link to="/">Back to dashboard</Link>
        </Body1>
      </Card>
    </main>
  );
}
