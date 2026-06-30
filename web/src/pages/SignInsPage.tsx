// /sign-ins — drilldown page for Entra sign-in events with geo-fence filter
// (ADR-0034 §3.2). Mirrors UserDormancyPage shell pattern.

import { useEffect } from "react";
import { tokens } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { SignInsList } from "@/features/sign-ins/SignInsList";

export function SignInsPage() {
  const user = useCurrentUser();

  useEffect(() => {
    if (!user.isLoading && !user.isAuthenticated) {
      void signIn("/sign-ins");
    }
  }, [user.isLoading, user.isAuthenticated]);

  if (user.isLoading || !user.isAuthenticated) return null;

  return (
    <main
      style={{
        padding: tokens.spacingHorizontalXL,
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalL,
      }}
    >
      <Link to="/">&larr; Back</Link>
      <SignInsList />
    </main>
  );
}
