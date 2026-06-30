import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "@/app/router";
import { AuthProvider } from "@/auth/AuthProvider";
import { BrandingProvider } from "@/features/branding/BrandingProvider";
// Aegis design system — class-based stylesheet driven by Fluent v9 design
// tokens (CSS custom properties). Loaded ONCE here so every component picks
// up the canvas background + typography defaults. Fluent v9 React components
// continue to coexist; their themed surfaces (Card, Drawer, etc.) layer on
// top of the global `.theme-light` / `.theme-dark` token sets that this
// stylesheet defines. See `docs/ui-pack/` for the design source.
import "@/styles/aegis.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element missing");

// Provider order matters: AuthProvider initialises MSAL (handleRedirectPromise)
// before any TanStack Query fires — api/client.ts's acquireTokenSilent
// otherwise races MSAL's internal init. BrandingProvider calls
// useTenantSettings (a React Query hook) so QueryClientProvider must be
// above it. BrandingProvider then wraps FluentProvider with a derived
// theme (ADR-0029 Phase A).
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrandingProvider>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </BrandingProvider>
      </QueryClientProvider>
    </AuthProvider>
  </React.StrictMode>,
);
