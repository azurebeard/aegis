import { Body1, Card, CardHeader, Link, Title2, tokens } from "@fluentui/react-components";
import { signOut } from "@/auth/authActions";

// WS10 SEC-M-ADR-09-02: neutral, non-leaking message. Same text whether the user
// is unknown to the tenant or authenticated without a role assignment.
export function NoAccessPage() {
  return (
    <Card style={{ margin: tokens.spacingHorizontalXL, maxWidth: 640 }}>
      <CardHeader header={<Title2>Access not granted</Title2>} />
      <Body1 block>
        You are signed in but have not been granted access to this deployment. Contact the
        administrator.
      </Body1>
      <Body1 block style={{ marginTop: tokens.spacingVerticalM }}>
        <Link as="button" onClick={() => void signOut()}>
          Sign out
        </Link>
      </Body1>
    </Card>
  );
}
