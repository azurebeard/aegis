// /user-dormancy — drilldown page for the dormant-account report
// (ADR-0034 §3.1). Mirrors RiskyUsersPage shell pattern.

import { useEffect } from "react";
import { tokens } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { UserDormancyList } from "@/features/user-dormancy/UserDormancyList";

export function UserDormancyPage() {
  const user = useCurrentUser();

  useEffect(() => {
    if (!user.isLoading && !user.isAuthenticated) {
      void signIn("/user-dormancy");
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
      <UserDormancyList />
    </main>
  );
}
