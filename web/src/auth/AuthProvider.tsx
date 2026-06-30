// ADR-0035 Phase D2 — top-level MSAL provider + redirect-handler bootstrap.
//
// The PublicClientApplication MUST be initialised BEFORE the React tree
// mounts, otherwise an early `acquireTokenSilent()` call from a TanStack
// Query in flight at first paint can race against MSAL's own internal init
// state and reject. We initialise + handleRedirectPromise() at module load,
// then provide MsalProvider once the promise resolves.

import { PublicClientApplication, EventType } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { useEffect, useState, type ReactNode } from "react";
import { getMsalConfig } from "./msalConfig";

// Lazy singleton — `getMsalConfig()` reads VITE_* env vars at first call,
// not module-load. Tests that import (transitively) any auth helper without
// touching MSAL run cleanly without the build-time env vars set; the SPA
// hits this path on first render.
let _instance: PublicClientApplication | null = null;
let _initPromise: Promise<void> | null = null;

export function getMsalInstance(): PublicClientApplication {
  if (_instance) return _instance;
  _instance = new PublicClientApplication(getMsalConfig());
  // Keep the active account in sync with login events. Without this,
  // a logout from one tab leaves the other tabs holding a stale active account.
  _instance.addEventCallback((event) => {
    if (
      _instance &&
      event.eventType === EventType.LOGIN_SUCCESS &&
      event.payload &&
      "account" in event.payload
    ) {
      const payload = event.payload as { account: { homeAccountId: string } };
      const account = _instance.getAccountByHomeId(payload.account.homeAccountId);
      if (account) _instance.setActiveAccount(account);
    }
  });
  return _instance;
}

function initOnce(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async (): Promise<void> => {
    const inst = getMsalInstance();
    await inst.initialize();
    const result = await inst.handleRedirectPromise();
    if (result?.account) {
      inst.setActiveAccount(result.account);
    } else {
      const accounts = inst.getAllAccounts();
      if (accounts.length > 0 && accounts[0] && !inst.getActiveAccount()) {
        inst.setActiveAccount(accounts[0]);
      }
    }
  })();
  return _initPromise;
}

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    initOnce().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    // Minimal pre-MSAL placeholder. The app's full Spinner is in app/router.
    return null;
  }
  return <MsalProvider instance={getMsalInstance()}>{children}</MsalProvider>;
}
