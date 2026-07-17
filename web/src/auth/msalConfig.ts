// ADR-0035 Phase D2 — MSAL.js public-client configuration for the SPA.
//
// Decisions per ADR-0035 §2 + WS10 verdict 2026-05-08 (Phase A) §4:
//   - Library: @azure/msal-browser v3 + @azure/msal-react v2.
//   - Flow: Authorisation Code + PKCE (the only flow MSAL Browser supports
//     for SPA platform; implicit flow is hard-disabled by Microsoft).
//   - Login UX: loginRedirect (full-page redirect). Popup mode rejected:
//     enterprise-managed browsers + Safari ITP partitioning + iOS in-app
//     browsers all break popups.
//   - Cache: sessionStorage. localStorage rejected — survives browser close,
//     broadens token-theft window via XSS (R2 in §Consequences).
//   - Token-renewal offset: 300 s (5 min before exp). Pinned explicitly per
//     SEC-L-03; v3 default that could shift in v4.
//   - storeAuthStateInCookie: false — modern Chromium-only target (ADR-0009);
//  IE/Edge legacy out of scope.
//   - nativeBrokerEnabled: false — Windows Hello / WAM out of scope at
//  single-tenant dev scale.
//   - Audience requested: <api-app-id>/api.access ONLY. No User.Read or
//     other Graph scope on the SPA token.

import { LogLevel, type Configuration } from "@azure/msal-browser";

interface RequiredEnv {
  readonly tenantId: string;
  readonly spaClientId: string;
  readonly apiAudience: string; // bare-GUID of the API app (v2.0 form)
}

function readEnv(): RequiredEnv {
  const tenantId = import.meta.env.VITE_AEGIS_TENANT_ID as string | undefined;
  const spaClientId = import.meta.env.VITE_AEGIS_SPA_CLIENT_ID as string | undefined;
  const apiAudience = import.meta.env.VITE_AEGIS_API_AUDIENCE as string | undefined;
  if (!tenantId || !spaClientId || !apiAudience) {
    // Fail at first use (not module-load) so unrelated unit tests can import
    // dependants without supplying VITE_* env vars. The build pipeline
    // (prepare-swa-config.mjs + azd env) is responsible for setting these —
    // if any is missing in production, the first MSAL operation throws here
    // and the SPA flags the misconfig in the console.
    throw new Error(
      `[msalConfig] Missing required VITE_* env vars (tenantId=${Boolean(tenantId)} spaClientId=${Boolean(spaClientId)} apiAudience=${Boolean(apiAudience)}). Build pipeline must populate VITE_AEGIS_TENANT_ID / VITE_AEGIS_SPA_CLIENT_ID / VITE_AEGIS_API_AUDIENCE.`,
    );
  }
  return { tenantId, spaClientId, apiAudience };
}

// Lazy-resolved at first use. Cached on the singleton.
let _env: RequiredEnv | null = null;
function env(): RequiredEnv {
  if (_env) return _env;
  _env = readEnv();
  return _env;
}

export function getAuthority(): string {
  return `https://login.microsoftonline.com/${env().tenantId}`;
}

export function getApiScope(): string {
  return `${env().apiAudience}/api.access`;
}

// Login + token-renewal scope set. Microsoft Identity Platform requires the
// reserved openid + profile scopes for sign-in; the API scope is what unlocks
// access to the resource. No User.Read / Mail.Read / etc. — operator never
// proxies Graph through the SPA.
export function getLoginRequest(): { scopes: string[] } {
  return { scopes: ["openid", "profile", getApiScope()] };
}

// Token-acquisition scope set for outbound API calls. Exactly the API scope.
export function getApiTokenRequest(): { scopes: string[] } {
  return { scopes: [getApiScope()] };
}

export function getMsalConfig(): Configuration {
  return {
    auth: {
      clientId: env().spaClientId,
      authority: getAuthority(),
      redirectUri: window.location.origin + "/auth/callback",
      postLogoutRedirectUri: window.location.origin + "/",
      navigateToLoginRequestUrl: true,
    },
    cache: {
      cacheLocation: "sessionStorage",
      storeAuthStateInCookie: false,
    },
    system: {
      tokenRenewalOffsetSeconds: 300,
      // SEC-L-02 — Windows broker (WAM) deliberately not enabled at single-
      // tenant dev scale. MSAL.js v3 has no `nativeBrokerEnabled` flag in
      // browser config — broker integration ships separately via the WAM
      // extension; revisit at multi-tenant.
      loggerOptions: {
        logLevel: LogLevel.Warning,
        piiLoggingEnabled: false,
        loggerCallback: (level, message): void => {
          if (level === LogLevel.Error) {
            console.error("[msal]", message);
          } else if (level === LogLevel.Warning) {
            console.warn("[msal]", message);
          }
        },
      },
    },
  };
}
