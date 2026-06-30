# ADR-0009 — Frontend stack

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

XDR Hub's dashboard is a React SPA served by Azure Static Web Apps (brief §3, §13). The users are technical — SecOps engineers, MVPs, consultants (brief §2). The dashboard surfaces tiles of precomputed data (Secure Score trend, incidents list, Entra risk, CA coverage, tech-stack/KEV matches, Daily Brief, Approvals, Audit, Manual Tasks — brief §13). The SPA does not talk to Microsoft Graph or Defender directly; it reads the operational store via authenticated Functions (ADR-0002, ADR-0006).

This ADR fixes the frontend stack so that `package.json`, the `staticwebapp.config.json`, and the build/deploy pipeline can all be written without rework. The choices follow from four constraints:

1. **Brand alignment.** Users arriving from Defender XDR, Entra, Sentinel, and the Microsoft Security portal expect a Fluent design language. A non-Fluent SPA looks foreign.
2. **Cold-start budget.** SWA serves static assets with CDN caching — build size and TTI (time to interactive) are the concern, not runtime cost.
3. **Contributor profile.** Community contributors and MVPs. React is the lingua franca.
4. **No SSR / no Node server.** SWA is static hosting. No Next.js server components, no Remix, no Node server in front.

## Decision

### Core stack

- **React 18** + **TypeScript 5.x** (strict mode).
- **Vite** as the build tool — fast dev server, first-class TS support, sensible defaults for SWA static hosting.
- **React Router v6** (data routers with `createBrowserRouter`) for client-side routing.
- **TanStack Query v5** (`@tanstack/react-query`) for server state: fetch caching, retry, stale-while-revalidate, DevTools.
- **Fluent UI v9** (`@fluentui/react-components`) as the component library and design language. Theme defaults to the system colour scheme; explicit light / dark toggle available.
- **No Redux, no Zustand, no Jotai, no Recoil.** TanStack Query covers server state; React Context covers the handful of local UI concerns (theme, user, active incident). If local state outgrows Context, a superseding ADR reopens this.

### Testing

- **Vitest** + **React Testing Library**. Same test runner in `/web` as `/api` (ADR-0002 primary TypeScript) — one mental model.
- **Playwright** for end-to-end auth + navigation tests — runs against a locally running `swa start` during CI. One smoke scenario in v1: log in, hit the ping page, see the authenticated principal name.

### Lint, format, types

- **ESLint** with `@typescript-eslint`, `react`, `react-hooks`, `jsx-a11y`, `@tanstack/query` rule sets.
- **Prettier** for formatting (not used as an ESLint rule; separate `prettier --check` in CI).
- **`tsc --noEmit`** runs in CI as a separate step from the Vite build so type errors surface distinctly from bundler errors.

### Auth integration

- **No MSAL in the browser.** Per ADR-0007, SWA Easy Auth does all OIDC work.
- The SPA reads `/.auth/me` to determine authentication state. A small `useCurrentUser()` hook wraps a TanStack Query call to this endpoint. The hook returns `{ user, roles, isAuthenticated }` with a short staleTime so session changes propagate quickly.
- Unauthenticated users are not handled in-SPA — the `staticwebapp.config.json` `responseOverrides` 401→302 redirect to `/.auth/login/aad` does the work.

### Data fetching

- Every Function call goes through a single `api` module that:
  - Uses `fetch` with `credentials: 'include'` (SWA session cookie).
  - Throws typed errors derived from OpenAPI schemas (generated from the API's `/api/openapi.json`, a later build-order step).
  - Is consumed by TanStack Query hooks defined under `src/features/<feature>/queries.ts`.
- In v1 this module has exactly one call: `GET /api/ping`.

### File structure

```text
web/
├── package.json
├── tsconfig.json
├── tsconfig.app.json
├── vite.config.ts
├── index.html
├── public/
├── src/
│   ├── main.tsx                # React root, router, QueryClient, FluentProvider
│   ├── app/
│   │   ├── router.tsx
│   │   └── theme.ts
│   ├── auth/
│   │   └── useCurrentUser.ts
│   ├── api/
│   │   └── client.ts           # single fetch wrapper
│   ├── features/
│   │   └── ping/
│   │       ├── PingPage.tsx
│   │       └── queries.ts
│   └── styles/
├── tests/
│   └── PingPage.test.tsx
└── e2e/
    └── auth-and-ping.spec.ts
```

### Accessibility

Fluent UI v9 components are accessibility-tested upstream. The SPA meets WCAG 2.1 AA by default for built-in components. `jsx-a11y` ESLint rules enforce on custom markup. Not a formal WCAG audit deliverable in v1 but a baseline.

### Build and deploy

- `vite build` → `dist/`. SWA `app_artifact_location: "dist"`.
- Source maps emitted but **not uploaded** to production. A later pass wires source maps to App Insights for error attribution if needed.
- Security headers are configured in `staticwebapp.config.json`'s `globalHeaders` block (served on every response — meta CSP is not used because `frame-ancestors` cannot be set from a meta tag). The header set, pinned:

  | Header | Value | Purpose |
  |---|---|---|
  | `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://login.microsoftonline.com` | App integrity; clickjacking defence via `frame-ancestors 'none'`; Entra ID `form-action` exception for the OIDC redirect. |
  | `X-Frame-Options` | `DENY` | Fallback for browsers that lag on CSP Level 2. |
  | `X-Content-Type-Options` | `nosniff` | MIME-sniffing defence. |
  | `Referrer-Policy` | `strict-origin-when-cross-origin` | Minimises referrer leakage. |
  | `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), browsing-topics=()` | Opts out of sensor and Topics APIs the SPA does not need. |
  | `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | HSTS one year. SWA terminates TLS on its CDN. |

- **`style-src 'unsafe-inline'` rationale:** Fluent UI v9 uses Griffel runtime CSS-in-JS, which generates `<style>` tags with content that changes per-render. Nonce-based CSP would require per-response nonce injection at the edge, which is non-trivial on a static SWA and not available without a custom middleware surface. `'unsafe-inline'` for styles is the accepted trade-off; compensated by strict `script-src 'self'` (no inline scripts permitted) and the full header set above. Re-evaluation trigger: if a Vite plugin emerges that stamps nonces into the SWA's edge response headers reliably, this reopens.

### 403-no-role UX (authenticated but unauthorised users)

A tenant user who authenticates successfully but carries no XDR Hub App Role assignment hits `/api/*` and receives 403 per the route rules in ADR-0007. The SPA must render an informative, non-leaky state:

- A dedicated route `/no-access` rendered by the SPA shell, containing:
  - A neutral message — "You are signed in but have not been granted access to this deployment. Contact the administrator." No mention of the tenant or the specific user.
  - A "Sign out" link to `/.auth/logout`.
  - No attempt at self-service role request.
- `staticwebapp.config.json` `responseOverrides` maps `403` on HTML requests to a 302 redirect to `/no-access`. JSON 403 responses from `/api/*` are passed through to the SPA as-is; the SPA's error boundary surfaces a toast and offers the same "Sign out" affordance.
- The message text must not differ between "user exists but no role" and "unknown user" — both terminate at the same screen.

### Versioning and upgrades

- `package.json` pins majors; lock file pins exacts.
- Dependabot already configured at repo level for `github-actions` ecosystem; extends to `npm` for `/web` and `/api` under this ADR.

## Consequences

### Positive

- **Microsoft design language alignment** — dashboard feels native to the Microsoft Security portfolio, lowering user cognitive load.
- **Vite dev experience** — sub-second HMR, TypeScript first-class.
- **Small server-state surface** — TanStack Query covers caching, retries, and DevTools; no separate state-manager ADR needed.
- **Accessibility as a default**, not as an afterthought.
- **Test pyramid is the right shape** — Vitest for unit, RTL for component behaviour, Playwright for end-to-end. One smoke scenario at v1 scale.

### Negative / trade-offs

- **Fluent UI v9 bundle size** is heavier than headless-component alternatives (shadcn + Tailwind). Mitigated by Fluent's tree-shaking and SWA's static CDN; first-paint size measured and tracked in CI.
- **Two test runners** (Vitest and Playwright) is a small operational cost. Accepted for the end-to-end auth-path coverage.
- **No MSAL** means the SPA cannot call Graph directly if a future feature requires it. This is the intended design and mirrors the deterministic-first rule (brief §5). A reopen trigger if that changes.

### Neutral

- `React Router` vs `TanStack Router` — TanStack Router is newer and has stronger type safety, but v1 has a handful of routes. React Router v6 is the lower-risk, larger-ecosystem choice. Reopenable in a later ADR when route count grows.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **shadcn/ui + Tailwind** | Best-in-class DX but foreign-feeling for Microsoft Security users. Brand mismatch is a real adoption cost for the target audience. |
| **Mantine** | Excellent components, but no Microsoft alignment. Same reason as shadcn. |
| **Material UI** | Google design language. Clashes with the Microsoft-portfolio feel for a Security-focused tool. |
| **Next.js** | SWA supports statically-exported Next, but this adds Next's mental model (app router, RSC, etc.) with no SSR benefit for a static dashboard. Overhead without return. |
| **Remix** | Same as Next.js — server features irrelevant for static SWA hosting. |
| **Angular** | Not in the React-dominant OSS community the project targets. |
| **Svelte / SvelteKit** | Strong DX, but smaller contributor pool; brief §2 and §15 favour the largest-contributor-pool choice. |
| **Redux + Redux Toolkit Query** | Would duplicate what TanStack Query does, with higher boilerplate. Rejected on scope. |

## Related

- `PROJECT_BRIEF.md` §3 — Architecture decisions (Frontend row)
- `PROJECT_BRIEF.md` §13 — MVP scope (dashboard tiles)
- `PROJECT_BRIEF.md` §16 — Coding and docs conventions
- ADR-0001 — Codename and repo identity (SWA naming)
- ADR-0002 — API runtime language (shared TypeScript across `/api` and `/web`, shared types package pattern)
- ADR-0007 — Easy Auth configuration (`/.auth/me`, role consumption)
- ADR-0008 — Entra app registration strategy (the authorisation model the SPA renders against)
