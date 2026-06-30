// React Query hooks for tenant settings (ADR-0025 Phase 1).
//
// Read is served to any authenticated/reader user so tiles can hide
// themselves. Write is admin-only at the SWA route layer. Both tile
// components and the admin page share the same cache key so a PATCH
// propagates to all four tiles + the admin page in one setQueryData.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  DefaultTheme,
  KevBaselineMode,
  ReportCadence,
  TenantSettings,
  TileVisibility,
  UserIdentifierStrategy,
} from "./types";

const SETTINGS_QUERY_KEY = ["settings", "tenant"] as const;
// PATCH lives under /api/ingest/ because the method-scoped rule on
// /api/settings is stripped by the deploy pipeline; the existing
// `/api/ingest/*` → ["admin"] SWA rule is stable.
const SETTINGS_PATCH_ENDPOINT = "/api/ingest/settings";

export function useTenantSettings(opts: { readonly enabled?: boolean } = {}) {
  // ADR-0035 Phase D2 hygiene — caller passes `enabled: user.isAuthenticated`
  // so an anonymous visitor doesn't generate /api/settings 401s.
  // BrandingProvider gates this; AuthenticatedDashboard (HomePage post-D2)
  // mounts only when authenticated so the default `enabled: true` is correct.
  return useQuery<TenantSettings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => api.get<TenantSettings>("/api/settings"),
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
  });
}

export function useUpdateTileVisibility() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, Partial<TileVisibility>>({
    mutationFn: (patch) =>
      api.patch<TenantSettings>(SETTINGS_PATCH_ENDPOINT, {
        tileVisibility: patch,
      }),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
    },
  });
}

export interface AgentBudgetPatch {
  readonly briefManualRunCeiling?: number;
  readonly briefDailyTokenBudget?: number;
}

export function useUpdateAgentBudget() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, AgentBudgetPatch>({
    mutationFn: (patch) =>
      api.patch<TenantSettings>(SETTINGS_PATCH_ENDPOINT, {
        agentBudget: patch,
      }),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
    },
  });
}

export function useUpdateUserIdentifierStrategy() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, UserIdentifierStrategy>({
    mutationFn: (strategy) =>
      api.patch<TenantSettings>(SETTINGS_PATCH_ENDPOINT, {
        userIdentifierStrategy: { strategy },
      }),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
    },
  });
}

/** ADR-0029 Phase A — branding patch (any subset of the four text fields). */
export interface BrandingPatch {
  readonly productName?: string;
  readonly primaryHex?: string;
  readonly footerText?: string;
  readonly defaultTheme?: DefaultTheme;
}

export function useUpdateBranding() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, BrandingPatch>({
    mutationFn: (patch) => api.patch<TenantSettings>(SETTINGS_PATCH_ENDPOINT, { branding: patch }),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
    },
  });
}

/** ADR-0029 Phase B — logo upload (admin). Ships the raw bytes with the
 *  caller-provided MIME type; server re-validates MIME + magic bytes. */
export interface LogoUploadInput {
  readonly blob: Blob;
  readonly contentType: string;
}

export function useUploadBrandingLogo() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, LogoUploadInput>({
    mutationFn: (input) =>
      api.upload<TenantSettings>("/api/ingest/branding/logo", input.blob, input.contentType),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
    },
  });
}

/** ADR-0030 Phase A — set the operator-controlled report cadence. */
export function useUpdateReportCadence() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, ReportCadence>({
    mutationFn: (cadence) =>
      api.patch<TenantSettings>(SETTINGS_PATCH_ENDPOINT, {
        reportCadence: { cadence },
      }),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
    },
  });
}

/** ADR-0030 Phase C Slice 1(d) — save the admin email config. The PATCH
 *  validator on the server enforces email/domain shape, recipient + domain
 *  caps, subject-prefix length, and the "enabled=true requires recipients"
 *  invariant; client-side validation duplicates the shape check to fail
 *  fast before the network round-trip. */
export interface ReportEmailConfigPatch {
  readonly enabled: boolean;
  readonly recipients: readonly string[];
  readonly allowExternalRecipients: boolean;
  readonly externalRecipientDomains: readonly string[];
  readonly subjectPrefix: string | null;
}

export function useUpdateReportEmailConfig() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, ReportEmailConfigPatch>({
    mutationFn: (patch) =>
      api.patch<TenantSettings>(SETTINGS_PATCH_ENDPOINT, {
        reportEmailConfig: patch,
      }),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
    },
  });
}

/** ADR-0033 Phase 2.5 — set/clear the KEV deployment-baseline. Supplying
 *  `mode: "from-deploy"` triggers the bulk-acknowledge sweep server-side
 *  (existing operator decisions are preserved). `mode: "historic"` is the
 *  no-op opt-out — every match starts as Open. The settings cache is
 *  refreshed on success so the section UI reflects the new mode/date. The
 *  `/api/stack/items` cache is invalidated so /kev shows the freshly
 *  acknowledged rows in the right cohort. */
export interface KevBaselinePatch {
  readonly mode: KevBaselineMode;
  readonly baselineDate: string; // "" for historic
}

export function useUpdateKevBaseline() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, KevBaselinePatch>({
    mutationFn: (patch) =>
      api.patch<TenantSettings>(SETTINGS_PATCH_ENDPOINT, { kevBaseline: patch }),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
      // The bulk-ack writes new suppression rows that overlay onto the
      // /api/stack/items read; invalidate so /kev refreshes its match
      // cohort + chip counts.
      void qc.invalidateQueries({ queryKey: ["stack", "items"] });
      void qc.invalidateQueries({ queryKey: ["kev", "summary"] });
    },
  });
}

/** ADR-0034 §4.1 — geo-fence policy patch. Saving a new policy
 *  triggers a one-shot OutOfArea reconciliation against existing SignIns
 *  rows on the server (mirrors kevBaseline pattern). The /api/sign-ins/*
 *  caches are invalidated on success so the tile + drilldown reflect the
 *  freshly recomputed flags. */
export interface GeoFencePatch {
  readonly enabled: boolean;
  readonly allowedCountries: readonly string[];
  readonly allowedIpRanges: readonly string[];
  readonly unknownLocationPolicy: "alert" | "ignore";
}

export function useUpdateGeoFence() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, GeoFencePatch>({
    mutationFn: (patch) => api.patch<TenantSettings>(SETTINGS_PATCH_ENDPOINT, { geoFence: patch }),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
      void qc.invalidateQueries({ queryKey: ["sign-ins"] });
    },
  });
}

/** §10.55 follow-up — minimal dormancy-policy patch. Currently only the
 *  newUserThresholdDays field is exposed; expand here when a fuller
 *  dormancy-policy admin section ships. Invalidates the user-dormancy
 *  cache on success so the /identities Humans tab re-renders with the
 *  new threshold without a hard reload. */
export interface DormancyPolicyPatch {
  readonly newUserThresholdDays?: number;
}

export function useUpdateDormancyPolicy() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, DormancyPolicyPatch>({
    mutationFn: (patch) =>
      api.patch<TenantSettings>(SETTINGS_PATCH_ENDPOINT, { dormancyPolicy: patch }),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
      void qc.invalidateQueries({ queryKey: ["user-dormancy"] });
    },
  });
}

/** ADR-0029 Phase B — logo delete (admin, idempotent). */
export function useDeleteBrandingLogo() {
  const qc = useQueryClient();
  return useMutation<TenantSettings, Error, void>({
    mutationFn: () => api.delete<TenantSettings>("/api/ingest/branding/logo"),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
    },
  });
}

export { SETTINGS_QUERY_KEY };
