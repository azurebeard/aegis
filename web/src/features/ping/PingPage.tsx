import {
  Body1,
  Card,
  CardHeader,
  Link,
  Spinner,
  Subtitle2,
  Text,
  Title2,
  tokens,
} from "@fluentui/react-components";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { usePing } from "./queries";

export function PingPage() {
  const user = useCurrentUser();
  const ping = usePing();

  if (user.isLoading) {
    return <Spinner label="Loading session" />;
  }
  if (!user.isAuthenticated) {
    return (
      <Card style={{ margin: tokens.spacingHorizontalXL, maxWidth: 640 }}>
        <CardHeader header={<Title2>Sign in required</Title2>} />
        <Body1>
          <Link as="button" onClick={() => void signIn("/ping")}>
            Sign in with Entra ID
          </Link>
        </Body1>
      </Card>
    );
  }

  return (
    <Card style={{ margin: tokens.spacingHorizontalXL, maxWidth: 720 }}>
      <CardHeader
        header={<Title2>XDR Hub — ping</Title2>}
        description={<Subtitle2>End-to-end auth wire smoke test.</Subtitle2>}
      />
      <Body1 block>
        <Text weight="semibold">SWA session:</Text> {user.principal?.userDetails} · roles:{" "}
        <code>{user.roles.join(", ") || "none"}</code>
      </Body1>
      {ping.isLoading && <Spinner label="Calling /api/ping" />}
      {ping.isError && (
        <Body1 style={{ color: tokens.colorPaletteRedForeground1 }}>
          <Text weight="semibold">/api/ping failed:</Text> {(ping.error as Error).message}
        </Body1>
      )}
      {ping.data && (
        <pre
          style={{
            background: tokens.colorNeutralBackground2,
            padding: tokens.spacingHorizontalM,
            borderRadius: tokens.borderRadiusMedium,
            overflow: "auto",
          }}
        >
          {JSON.stringify(ping.data, null, 2)}
        </pre>
      )}
    </Card>
  );
}
