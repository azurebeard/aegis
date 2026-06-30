// ADR-0035 Phase D2 — useCurrentUser backed by MSAL active account.
//
// Pre-Phase D2 this hook called SWA's /.auth/me endpoint to read the
// SWA-computed client principal (identityProvider, userId, userDetails,
// userRoles[]). Phase D2 removes SWA's built-in auth — the same shape is
// now derived from the MSAL ID-token claims of the active account.
//
// The shape is preserved verbatim so the 21 component callers do not need
// per-component refactoring. Roles are read from the `roles` claim (Entra
// App Roles assigned on the API app's service principal — Phase B
// bootstrap-entra.ps1 sets this for the operator account on the API SP).

import { useMsal } from "@azure/msal-react";

export interface SwaClientPrincipal {
  readonly identityProvider: string;
  readonly userId: string;
  readonly userDetails: string;
  readonly userRoles: readonly string[];
}

interface IdTokenClaims {
  readonly oid?: string;
  readonly preferred_username?: string;
  readonly upn?: string;
  readonly roles?: readonly string[];
  readonly name?: string;
}

const ROLE_VALUES = new Set(["admin", "reader"]);

export function useCurrentUser() {
  const { accounts, inProgress } = useMsal();
  // Loading covers MSAL's internal "interaction in progress" state — login
  // redirect handling, token-renewal, popup handling. We treat all of those
  // as "still loading" rather than "unauthenticated" to avoid flashing
  // sign-in prompts during a normal redirect roundtrip.
  const isLoading = inProgress !== "none";
  const account = accounts.length > 0 ? accounts[0] : null;

  if (!account) {
    return {
      isLoading,
      isAuthenticated: false,
      principal: null,
      roles: [] as readonly string[],
      hasRole: (_r: string) => false,
    } as const;
  }

  const claims = (account.idTokenClaims ?? {}) as IdTokenClaims;
  const oid = claims.oid ?? account.localAccountId;
  const upn = claims.preferred_username ?? claims.upn ?? account.username;
  const rolesRaw = Array.isArray(claims.roles) ? claims.roles : [];
  const roles = rolesRaw.filter((r): r is string => typeof r === "string" && ROLE_VALUES.has(r));
  // Admin implies reader (mirrors the API-side normalisation).
  if (roles.includes("admin") && !roles.includes("reader")) {
    roles.push("reader");
  }

  const principal: SwaClientPrincipal = {
    identityProvider: "aad",
    userId: oid,
    userDetails: upn,
    userRoles: roles,
  };

  return {
    isLoading,
    isAuthenticated: true,
    principal,
    roles: principal.userRoles,
    hasRole: (r: string) => principal.userRoles.includes(r),
  } as const;
}
