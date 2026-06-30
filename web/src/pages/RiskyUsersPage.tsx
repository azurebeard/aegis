import { useEffect } from "react";
import { tokens } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { useCurrentUser } from "@/auth/useCurrentUser";
import { signIn } from "@/auth/authActions";
import { RiskyUsersList } from "@/features/risky-users/RiskyUsersList";

export function RiskyUsersPage() {
  const user = useCurrentUser();

  useEffect(() => {
    if (!user.isLoading && !user.isAuthenticated) {
      void signIn("/risky-users");
    }
  }, [user.isLoading, user.isAuthenticated]);

  if (user.isLoading || !user.isAuthenticated) {
    return null;
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
      <Link to="/">&larr; Back</Link>
      <RiskyUsersList />
    </main>
  );
}
