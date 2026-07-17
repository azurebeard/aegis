// ADR-0035 Phase D2 — sign-in / sign-out helpers backed by MSAL.
// Replaces the legacy /.auth/login/aad?post_login_redirect_uri=... and
// /.auth/logout?post_logout_redirect_uri=... URL patterns scattered through
// the SPA components.

import { InteractionRequiredAuthError, type AccountInfo } from "@azure/msal-browser";
import { getMsalInstance } from "./AuthProvider";
import { getApiTokenRequest, getLoginRequest } from "./msalConfig";

export async function signIn(returnTo?: string): Promise<void> {
  const msal = getMsalInstance();
  await msal.loginRedirect({
    scopes: getLoginRequest().scopes,
    state: returnTo ?? window.location.pathname,
  });
}

export async function signOut(): Promise<void> {
  const msal = getMsalInstance();
  const account = msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
  await msal.logoutRedirect({
    account,
    postLogoutRedirectUri: window.location.origin + "/",
  });
}

// Token acquisition for outbound API calls. Pattern:
//   1. Try silent (uses sessionStorage cache + refresh-token rotation).
//   2. On InteractionRequiredAuthError (CAE / step-up / consent-required),
//      fall back to acquireTokenRedirect — full-page redirect to Entra and
//      back. The current page is replaced by the auth handshake; the
//      redirect lands back on /auth/callback which AuthProvider resolves.
export async function acquireApiToken(): Promise<string | null> {
  const msal = getMsalInstance();
  const account = msal.getActiveAccount();
  if (!account) return null;
  try {
    const result = await msal.acquireTokenSilent({
      scopes: getApiTokenRequest().scopes,
      account,
    });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      // Returns a Promise that never resolves — the redirect navigates away.
      await msal.acquireTokenRedirect({
        scopes: getApiTokenRequest().scopes,
        account,
      });
      return null; // unreachable; satisfies the type
    }
    throw err;
  }
}

export function getActiveAccount(): AccountInfo | null {
  const msal = getMsalInstance();
  return msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null;
}
