// PATCH /api/ingest/settings — update tenant settings (ADR-0025 Phase 1 + 2 + 3).
//
// Admin-gated at the SWA route rule `/api/ingest/*` → ["admin"] (which is
// reliably preserved across deploys, unlike the method-scoped
// `/api/settings` PATCH rule that the deploy pipeline has been observed
// stripping — see pitfall 25). Easy Auth gates the Function App to the
// SWA MI. `authLevel: "anonymous"` per repo convention. Defence-in-depth:
// client-principal presence check + strict body schema validation + per-
// tenant rate limit (30/day, shared constant). The read surface stays at
// GET /api/settings (authenticated/reader via the `/api/*` catch-all) —
// split by path rather than method.
//
// Body accepts any subset of three concerns — ADR-0025 §9.4:
//  - tileVisibility
//  - agentBudget
//  - userIdentifierStrategy

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { emitAievent } from "../lib/aievent.js";
import { readClientPrincipal, type ClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden, unauthenticated } from "../lib/httpAuthResponses.js";
import {
  resolveBriefAgentConfig,
  resolveIngestConfig,
  resolveReportSnapshotConfig,
} from "../lib/config.js";
import {
  ADMIN_RUN_DAILY_CEILING,
  SlidingWindowRateLimiter,
} from "../lib/rateLimit.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import {
  AGENT_BUDGET_BOUNDS,
  BRANDING_BOUNDS,
  DEFAULT_THEMES,
  KEV_BASELINE_DATE_PATTERN,
  KEV_BASELINE_MODES,
  REPORT_CADENCES,
  USER_IDENTIFIER_STRATEGIES,
  readGeoFencePolicy,
  readKevBaseline,
  readReportCadence,
  readReportEmailConfig,
  readUserIdentifierStrategy,
  upsertAgentBudget,
  upsertBranding,
  upsertGeoFencePolicy,
  upsertKevBaseline,
  upsertReportCadence,
  upsertReportEmailConfig,
  upsertTileVisibility,
  upsertUserIdentifierStrategy,
  type ReportEmailConfigPatch,
  type AgentBudgetPatch,
  type BrandingPatch,
  type DefaultTheme,
  type KevBaselineMode,
  type ReportCadenceValue,
  type TileKey,
  type TileVisibility,
  type UserIdentifierStrategy,
  TILE_KEYS,
  DORMANCY_POLICY_BOUNDS,
} from "../lib/tenantSettingsStore.js";
import { applyKevBaseline } from "../lib/kevBaseline.js";
import { listKevRows } from "../lib/kevStore.js";
import { listSuppressions } from "../lib/kevSuppressionsStore.js";
import { listStackItems } from "../lib/stackItemsStore.js";
import { buildFullSettingsResponse } from "../lib/settingsResponse.js";

const MAX_BODY_BYTES = 4096; // bumped for ADR-0029 branding — four concerns fit comfortably.
const MAX_UPDATED_BY_CHARS = 256;
const TILE_KEY_SET = new Set<string>(TILE_KEYS);
const STRATEGY_SET = new Set<string>(USER_IDENTIFIER_STRATEGIES);
const DEFAULT_THEME_SET = new Set<string>(DEFAULT_THEMES);
const REPORT_CADENCE_SET = new Set<string>(REPORT_CADENCES);
const KEV_BASELINE_MODE_SET = new Set<string>(KEV_BASELINE_MODES);

// 30/day per tenant (same ceiling as the admin-run endpoints). Keyed by
// tenantId so multiple admins share the budget.
const settingsPatchRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_CEILING,
  24 * 60 * 60_000,
);

export interface ValidatedKevBaseline {
  readonly mode: KevBaselineMode;
  readonly baselineDate: string;
}

export interface ValidatedGeoFence {
  readonly enabled: boolean;
  readonly allowedCountries: readonly string[];
  readonly allowedIpRanges: readonly string[];
  readonly unknownLocationPolicy: "alert" | "ignore";
}

/** §10.55 follow-up — operator-configurable new-user highlight window for
 *  the /identities Humans tab. Other dormancy-policy fields (thresholdDays,
 *  includeDisabledAccounts, excludeServiceAccountSuffixes) are out of
 *  PATCH scope in this commit; they continue to use defaults until a
 *  dedicated dormancy-policy admin section ships. */
export interface ValidatedDormancyPolicy {
  readonly newUserThresholdDays?: number;
}

export interface ValidatedPatch {
  readonly tileVisibility?: Partial<TileVisibility>;
  readonly agentBudget?: AgentBudgetPatch;
  readonly userIdentifierStrategy?: { strategy: UserIdentifierStrategy };
  readonly branding?: BrandingPatch;
  readonly reportCadence?: { cadence: ReportCadenceValue };
  readonly kevBaseline?: ValidatedKevBaseline;
  readonly geoFence?: ValidatedGeoFence;
  readonly dormancyPolicy?: ValidatedDormancyPolicy;
  readonly reportEmailConfig?: ReportEmailConfigPatch;
}

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // ADR-0035 Phase D2 retired the SWA route rule `/api/ingest/* →
  // ["admin"]`; every /api/* path is now `["anonymous"]` at the SWA edge
  // and authentication + role enforcement is FA-side via authMiddleware.ts.
  // §10.55 follow-up closes
  // the inherited gap: every PATCH dispatch branch below (tileVisibility,
  // agentBudget, userIdentifierStrategy, branding, reportCadence,
  // kevBaseline, geoFence, dormancyPolicy) is a WRITE surface and MUST
  // require the admin role. Mirrors the pattern used by every sibling
  // write handler (deleteStackItem, postStackItem, runConditionalAccess
  // Ingest, etc.).
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (!principal.userRoles.includes("admin")) {
    return forbidden(context, "settings patch requires the admin role");
  }

  // Early body-size gate (polite clients) — re-checked after parsing below.
  const lenHeader = request.headers.get("content-length");
  if (lenHeader !== null) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return payloadTooLarge(context);
    }
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return badRequest(context, "unable to read request body");
  }
  // Post-parse byte gate — catches chunked-encoding clients that omit
  // Content-Length (same pattern as runDailyBrief per SEC-M-STEP5-CODE-05).
  if (Buffer.byteLength(rawBody, "utf-8") > MAX_BODY_BYTES) {
    return payloadTooLarge(context);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return badRequest(context, "body is not valid JSON");
  }

  const validated = validatePatchBody(parsed);
  if ("error" in validated) {
    return badRequest(context, validated.error);
  }

  const ingestConfig = resolveIngestConfig();
  const briefConfig = resolveBriefAgentConfig();
  const reportConfig = resolveReportSnapshotConfig();
  const rate = settingsPatchRateLimiter.check(ingestConfig.tenantId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limit_endpoint",
          message: `settings-patch budget exhausted: ${ADMIN_RUN_DAILY_CEILING}/day per tenant`,
          correlationId: context.invocationId,
        },
      },
      headers: {
        "retry-after": Math.ceil(rate.retryAfterMs / 1000).toString(),
        "cache-control": "no-store",
      },
    };
  }

  try {
    const tableCtx = {
      endpoint: ingestConfig.opsTableEndpoint,
      managedIdentityClientId: ingestConfig.ingestMiClientId,
    };
    const settingsTable = getTableClient(tableCtx, OPS_TABLES.TenantSettings);
    const updatedBy = deriveUpdatedBy(principal);
    const updatedAt = new Date().toISOString();
    const budgetDefaults = {
      briefManualRunCeiling: briefConfig.briefDailyManualRunCeiling,
      briefDailyTokenBudget: briefConfig.briefDailyTokenBudget,
      postureManualRunCeiling: briefConfig.postureWeeklyManualRunCeiling,
      postureWeeklyTokenBudget: briefConfig.postureWeeklyTokenBudget,
      incidentsAnalysisManualRunCeiling:
        briefConfig.incidentsAnalysisDailyManualRunCeiling,
      incidentsAnalysisDailyTokenBudget:
        briefConfig.incidentsAnalysisDailyTokenBudget,
    };

    const changed: string[] = [];
    const auditEntries: Array<Record<string, unknown>> = [];

    if (validated.tileVisibility) {
      await upsertTileVisibility(settingsTable, {
        tenantId: ingestConfig.tenantId,
        patch: validated.tileVisibility,
        updatedBy,
        updatedAt,
      });
      auditEntries.push({
        action: "tile-visibility-update",
        changed: Object.keys(validated.tileVisibility),
      });
      changed.push("tileVisibility");
    }

    if (validated.agentBudget) {
      await upsertAgentBudget(settingsTable, {
        tenantId: ingestConfig.tenantId,
        patch: validated.agentBudget,
        defaults: budgetDefaults,
        updatedBy,
        updatedAt,
      });
      auditEntries.push({
        action: "agent-budget-update",
        changed: Object.keys(validated.agentBudget),
      });
      changed.push("agentBudget");
    }

    if (validated.userIdentifierStrategy) {
      // WS10 SEC-L-ADR25-P3-02: audit both `from` and `to` for a strategy
      // transition. Pre-write read captures the prior value — one extra
      // round-trip on a rare path (days apart typically) is cheap
      // insurance for change-traceability on a prompt-governance setting
      // (NIST SP 800-53 AU-3).
      const priorStrategy = await readUserIdentifierStrategy(
        settingsTable,
        ingestConfig.tenantId,
      );
      await upsertUserIdentifierStrategy(settingsTable, {
        tenantId: ingestConfig.tenantId,
        strategy: validated.userIdentifierStrategy.strategy,
        updatedBy,
        updatedAt,
      });
      auditEntries.push({
        action: "user-identifier-strategy-update",
        from: priorStrategy.strategy,
        to: validated.userIdentifierStrategy.strategy,
      });
      changed.push("userIdentifierStrategy");
    }

    if (validated.branding) {
      await upsertBranding(settingsTable, {
        tenantId: ingestConfig.tenantId,
        patch: validated.branding,
        updatedBy,
        updatedAt,
      });
      auditEntries.push({
        action: "branding-update",
        changed: Object.keys(validated.branding),
      });
      changed.push("branding");
    }

    if (validated.reportCadence) {
      // Audit both `from` and `to` for cadence transitions — operators
      // may want to know when "weekly" became "monthly" without spelunking
      // through the audit blob. Same precedent as user-identifier-strategy.
      const priorCadence = await readReportCadence(
        settingsTable,
        ingestConfig.tenantId,
      );
      await upsertReportCadence(settingsTable, {
        tenantId: ingestConfig.tenantId,
        cadence: validated.reportCadence.cadence,
        updatedBy,
        updatedAt,
      });
      auditEntries.push({
        action: "report-cadence-update",
        from: priorCadence.cadence,
        to: validated.reportCadence.cadence,
      });
      changed.push("reportCadence");
    }

    if (validated.kevBaseline) {
      // ADR-0033 Phase 2.5 — flipping mode to `from-deploy` triggers a
      // bulk-acknowledge sweep against existing KEV matches. Operator
      // decisions are NEVER clobbered (existing suppression rows are
      // preserved regardless of status).
      const priorBaseline = await readKevBaseline(settingsTable, ingestConfig.tenantId);
      await upsertKevBaseline(settingsTable, {
        tenantId: ingestConfig.tenantId,
        mode: validated.kevBaseline.mode,
        baselineDate: validated.kevBaseline.baselineDate,
        updatedBy,
        updatedAt,
      });
      const auditBase: Record<string, unknown> = {
        action: "kev-baseline-update",
        from: { mode: priorBaseline.mode, baselineDate: priorBaseline.baselineDate },
        to: { mode: validated.kevBaseline.mode, baselineDate: validated.kevBaseline.baselineDate },
      };

      if (
        validated.kevBaseline.mode === "from-deploy" &&
        validated.kevBaseline.baselineDate
      ) {
        const stackTable = getTableClient(tableCtx, OPS_TABLES.StackItems);
        const kevTable = getTableClient(tableCtx, OPS_TABLES.KEV);
        const suppressionsTable = getTableClient(tableCtx, OPS_TABLES.KevSuppressions);
        const [stackItems, kevRows, existingSuppressions] = await Promise.all([
          listStackItems(stackTable, ingestConfig.tenantId),
          listKevRows(kevTable),
          listSuppressions(suppressionsTable, ingestConfig.tenantId),
        ]);
        const result = await applyKevBaseline({
          tenantId: ingestConfig.tenantId,
          baselineDate: validated.kevBaseline.baselineDate,
          stackItems,
          kevRows,
          existingSuppressions,
          suppressionsTable,
          updatedBy,
          now: updatedAt,
        });
        auditBase.acknowledgedCount = result.acknowledgedCount;
        auditBase.alreadyHandledCount = result.alreadyHandledCount;
        auditBase.totalMatches = result.totalMatches;
      }

      auditEntries.push(auditBase);
      changed.push("kevBaseline");
    }

    if (validated.geoFence) {
      // ADR-0034 §4.1 Phase 8C — geo-fence policy. Saving a new policy
      // triggers a one-shot reconciliation against existing SignIns rows
      // (recompute OutOfArea per row); bounded by partition scan at
      // single-tenant volume (mirrors kevBaseline pattern).
      const priorGeoFence = await readGeoFencePolicy(settingsTable, ingestConfig.tenantId);
      await upsertGeoFencePolicy(settingsTable, {
        tenantId: ingestConfig.tenantId,
        enabled: validated.geoFence.enabled,
        allowedCountries: validated.geoFence.allowedCountries,
        allowedIpRanges: validated.geoFence.allowedIpRanges,
        unknownLocationPolicy: validated.geoFence.unknownLocationPolicy,
        updatedBy,
        updatedAt,
      });
      // OutOfArea reconciliation — only when SignIns table data exists
      // (the reconcileOutOfArea helper is a no-op when partition is empty).
      const { reconcileOutOfArea, SIGN_INS_TABLE_NAME } = await import(
        "../lib/signInsStore.js"
      );
      const signInsTable = getTableClient(tableCtx, SIGN_INS_TABLE_NAME);
      const allowedSet = new Set(
        validated.geoFence.allowedCountries.map((c) => c.toLowerCase()),
      );
      const recon = await reconcileOutOfArea(
        signInsTable,
        ingestConfig.tenantId,
        (countryLower: string): boolean => {
          if (!validated.geoFence!.enabled) return false;
          if (countryLower === "") {
            return validated.geoFence!.unknownLocationPolicy === "alert";
          }
          return !allowedSet.has(countryLower);
        },
      );
      auditEntries.push({
        action: "geo-fence-update",
        from: {
          enabled: priorGeoFence.enabled,
          allowedCountries: priorGeoFence.allowedCountries,
          unknownLocationPolicy: priorGeoFence.unknownLocationPolicy,
        },
        to: {
          enabled: validated.geoFence.enabled,
          allowedCountries: validated.geoFence.allowedCountries,
          unknownLocationPolicy: validated.geoFence.unknownLocationPolicy,
        },
        reconciled: recon,
      });
      changed.push("geoFence");
    }

    if (validated.dormancyPolicy) {
      // §10.55 follow-up — minimal dormancy-policy patch (newUserThresholdDays
      // only). The upsert reads the current row, merges the patch, and
      // writes back. Audit entry follows the geo-fence shape.
      const { upsertDormancyPolicy, readDormancyPolicy } = await import(
        "../lib/tenantSettingsStore.js"
      );
      const priorPolicy = await readDormancyPolicy(settingsTable, ingestConfig.tenantId);
      const nextPolicy = await upsertDormancyPolicy(settingsTable, {
        tenantId: ingestConfig.tenantId,
        patch: validated.dormancyPolicy,
        updatedBy,
        updatedAt,
      });
      auditEntries.push({
        action: "dormancy-policy-update",
        from: { newUserThresholdDays: priorPolicy.newUserThresholdDays },
        to: { newUserThresholdDays: nextPolicy.newUserThresholdDays },
      });
      changed.push("dormancyPolicy");
    }

    if (validated.reportEmailConfig) {
      // ADR-0030 Phase C Slice 1(d) — admin email config patch. Reads the
      // prior row for audit-trail provenance (enabled / recipient count
      // transitions are interesting), writes back the new shape. Recipients
      // are NOT logged verbatim — only count + enabled-state diff goes into
      // the audit line. The plaintext list persists in the row itself,
      // protected by the patchSettings KNOWN allowlist + the per-tenant
      // 30/day rate limit on this endpoint.
      const priorEmailConfig = await readReportEmailConfig(
        settingsTable,
        ingestConfig.tenantId,
      );
      await upsertReportEmailConfig(settingsTable, {
        tenantId: ingestConfig.tenantId,
        patch: validated.reportEmailConfig,
        updatedBy,
        updatedAt,
      });
      auditEntries.push({
        action: "report-email-config-update",
        from: {
          enabled: priorEmailConfig.enabled,
          recipientCount: priorEmailConfig.recipients.length,
          allowExternalRecipients: priorEmailConfig.allowExternalRecipients,
        },
        to: {
          enabled: validated.reportEmailConfig.enabled,
          recipientCount: validated.reportEmailConfig.recipients.length,
          allowExternalRecipients: validated.reportEmailConfig.allowExternalRecipients,
        },
      });
      changed.push("reportEmailConfig");
    }

    for (const entry of auditEntries) {
      emitAievent(context, "TenantSettingsChange", {
        ...entry,
        tenantId: ingestConfig.tenantId,
        principal: updatedBy,
      });
    }

    // The AgentBudget read for `agentSpendCurrent` (B4) goes via the
    // api-reader MI, not the ingest MI. Ingest MI is per-table-scoped
    // to the tables it WRITES (SecureScore / Incidents / EntraRisk /
    // IngestHealth / TenantDirectory / TenantSettings); api-reader has
    // account-scope Table Data Reader and is the right identity for
    // the cross-table read inside `buildFullSettingsResponse`.
    const apiReaderCtx = {
      endpoint: ingestConfig.opsTableEndpoint,
      managedIdentityClientId: ingestConfig.apiReaderMiClientId,
    };
    const body = await buildFullSettingsResponse({
      tenantId: ingestConfig.tenantId,
      settingsTable,
      budgetDefaults,
      schedules: {
        briefTimerCron: briefConfig.briefTimerCron,
        postureTimerCron: briefConfig.postureTimerCron,
        reportSnapshotAutoCaptureCron: reportConfig.autoCaptureCron,
      },
      opsTableCtx: apiReaderCtx,
      // Ingest config shares the same `AZURE_DEPLOY_AI_AGENTS` parse as
      // resolveApiConfig; echoed to the SPA so the response post-PATCH
      // keeps the tile + admin-section visibility in sync.
      aiPlaneEnabled: ingestConfig.deployAiAgents,
    });

    return {
      status: 200,
      jsonBody: body,
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`settings.patch.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "settings store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

export function validatePatchBody(body: unknown): ValidatedPatch | { error: string } {
  if (body === null || typeof body !== "object") {
    return { error: "body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  // ADR-0030 Phase C §C.7 — top-level allowlist. None of these map to a
  // TenantSettings row whose RowKey starts with `report-email-send:` (the
  // per-send history rows are mailSender-MI-only). The `report-email-config`
  // admin-managed row is owned by a future dedicated admin endpoint (Slice
  // 1(d)), not this generic patchSettings handler — keeping the allowlist
  // tight ensures patchSettings can never widen the email-send surface even
  // by accident.
  const KNOWN = [
    "tileVisibility",
    "agentBudget",
    "userIdentifierStrategy",
    "branding",
    "reportCadence",
    "kevBaseline",
    "geoFence",
    "dormancyPolicy",
    "reportEmailConfig", // ADR-0030 Phase C Slice 1(d) — admin email config
  ];
  for (const key of Object.keys(obj)) {
    if (!KNOWN.includes(key)) {
      return { error: `unknown top-level key: ${key}` };
    }
  }

  const out: {
    tileVisibility?: Partial<TileVisibility>;
    agentBudget?: AgentBudgetPatch;
    userIdentifierStrategy?: { strategy: UserIdentifierStrategy };
    branding?: BrandingPatch;
    reportCadence?: { cadence: ReportCadenceValue };
    kevBaseline?: ValidatedKevBaseline;
    geoFence?: ValidatedGeoFence;
    dormancyPolicy?: ValidatedDormancyPolicy;
    reportEmailConfig?: ReportEmailConfigPatch;
  } = {};

  if (obj.tileVisibility !== undefined) {
    const r = validateTileVisibility(obj.tileVisibility);
    if ("error" in r) return r;
    out.tileVisibility = r.value;
  }
  if (obj.agentBudget !== undefined) {
    const r = validateAgentBudget(obj.agentBudget);
    if ("error" in r) return r;
    out.agentBudget = r.value;
  }
  if (obj.userIdentifierStrategy !== undefined) {
    const r = validateUserIdentifierStrategy(obj.userIdentifierStrategy);
    if ("error" in r) return r;
    out.userIdentifierStrategy = r.value;
  }
  if (obj.branding !== undefined) {
    const r = validateBranding(obj.branding);
    if ("error" in r) return r;
    out.branding = r.value;
  }
  if (obj.reportCadence !== undefined) {
    const r = validateReportCadence(obj.reportCadence);
    if ("error" in r) return r;
    out.reportCadence = r.value;
  }
  if (obj.kevBaseline !== undefined) {
    const r = validateKevBaseline(obj.kevBaseline);
    if ("error" in r) return r;
    out.kevBaseline = r.value;
  }
  if (obj.geoFence !== undefined) {
    const r = validateGeoFence(obj.geoFence);
    if ("error" in r) return r;
    out.geoFence = r.value;
  }
  if (obj.dormancyPolicy !== undefined) {
    const r = validateDormancyPolicy(obj.dormancyPolicy);
    if ("error" in r) return r;
    out.dormancyPolicy = r.value;
  }
  if (obj.reportEmailConfig !== undefined) {
    const r = validateReportEmailConfig(obj.reportEmailConfig);
    if ("error" in r) return r;
    out.reportEmailConfig = r.value;
  }

  if (
    out.tileVisibility === undefined &&
    out.agentBudget === undefined &&
    out.userIdentifierStrategy === undefined &&
    out.branding === undefined &&
    out.reportCadence === undefined &&
    out.kevBaseline === undefined &&
    out.geoFence === undefined &&
    out.dormancyPolicy === undefined &&
    out.reportEmailConfig === undefined
  ) {
    return {
      error:
        "body must include at least one of tileVisibility, agentBudget, userIdentifierStrategy, branding, reportCadence, kevBaseline, geoFence, dormancyPolicy, reportEmailConfig",
    };
  }

  return out;
}

// ADR-0030 Phase C Slice 1(d) — admin patch surface for report-email-config.
// Caps + shape mirror the orchestrator's runtime expectations (NFC + trim +
// lowercase canonicalisation happens at the orchestrator; here we validate
// that values look like emails / domains so a typo fails 400 at PATCH time
// rather than 503 on the next send.
const REPORT_EMAIL_RECIPIENT_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const REPORT_EMAIL_DOMAIN_RE = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const REPORT_EMAIL_MAX_RECIPIENTS = 50;
const REPORT_EMAIL_MAX_EXTERNAL_DOMAINS = 20;
const REPORT_EMAIL_SUBJECT_PREFIX_MAX = 30; // leaves room for the 78-char auto-subject

function validateReportEmailConfig(
  raw: unknown,
): { value: ReportEmailConfigPatch } | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "body.reportEmailConfig must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    "enabled",
    "recipients",
    "allowExternalRecipients",
    "externalRecipientDomains",
    "subjectPrefix",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.has(k)) {
      return { error: `unknown reportEmailConfig key: ${k}` };
    }
  }
  if (typeof obj.enabled !== "boolean") {
    return { error: "body.reportEmailConfig.enabled must be a boolean" };
  }
  if (typeof obj.allowExternalRecipients !== "boolean") {
    return { error: "body.reportEmailConfig.allowExternalRecipients must be a boolean" };
  }
  if (!Array.isArray(obj.recipients)) {
    return { error: "body.reportEmailConfig.recipients must be an array" };
  }
  if (obj.recipients.length > REPORT_EMAIL_MAX_RECIPIENTS) {
    return {
      error: `body.reportEmailConfig.recipients must contain ≤ ${REPORT_EMAIL_MAX_RECIPIENTS} entries`,
    };
  }
  // WS10 SEC-X-LOWS-BATCH-02 — server-side dedupe parity with SPA parseList.
  // Set-based dedupe after NFC/trim/lowercase canonicalisation; a hand-crafted
  // PATCH (curl, scripted client) bypassing the SPA can no longer smuggle
  // duplicates up to the per-recipient count cap. Insertion-order preserved.
  const recipients: string[] = [];
  const recipientSeen = new Set<string>();
  for (const r of obj.recipients) {
    if (typeof r !== "string") {
      return { error: "body.reportEmailConfig.recipients entries must be strings" };
    }
    const canonical = r.normalize("NFC").trim().toLowerCase();
    if (canonical.length === 0) continue; // tolerate empty rows from the UI
    if (!REPORT_EMAIL_RECIPIENT_RE.test(canonical)) {
      return {
        error: `body.reportEmailConfig.recipients entry '${r}' is not a valid email address`,
      };
    }
    if (recipientSeen.has(canonical)) continue;
    recipientSeen.add(canonical);
    recipients.push(canonical);
  }
  if (!Array.isArray(obj.externalRecipientDomains)) {
    return { error: "body.reportEmailConfig.externalRecipientDomains must be an array" };
  }
  if (obj.externalRecipientDomains.length > REPORT_EMAIL_MAX_EXTERNAL_DOMAINS) {
    return {
      error: `body.reportEmailConfig.externalRecipientDomains must contain ≤ ${REPORT_EMAIL_MAX_EXTERNAL_DOMAINS} entries`,
    };
  }
  const externalRecipientDomains: string[] = [];
  const domainSeen = new Set<string>();
  for (const d of obj.externalRecipientDomains) {
    if (typeof d !== "string") {
      return {
        error: "body.reportEmailConfig.externalRecipientDomains entries must be strings",
      };
    }
    const canonical = d.normalize("NFC").trim().toLowerCase();
    if (canonical.length === 0) continue;
    if (!REPORT_EMAIL_DOMAIN_RE.test(canonical)) {
      return {
        error: `body.reportEmailConfig.externalRecipientDomains entry '${d}' is not a valid domain`,
      };
    }
    if (domainSeen.has(canonical)) continue;
    domainSeen.add(canonical);
    externalRecipientDomains.push(canonical);
  }
  let subjectPrefix: string | null = null;
  if (obj.subjectPrefix !== undefined && obj.subjectPrefix !== null) {
    if (typeof obj.subjectPrefix !== "string") {
      return { error: "body.reportEmailConfig.subjectPrefix must be a string or null" };
    }
    const trimmed = obj.subjectPrefix.trim();
    if (trimmed.length > REPORT_EMAIL_SUBJECT_PREFIX_MAX) {
      return {
        error: `body.reportEmailConfig.subjectPrefix must be ≤ ${REPORT_EMAIL_SUBJECT_PREFIX_MAX} chars`,
      };
    }
    subjectPrefix = trimmed.length > 0 ? trimmed : null;
  }
  // Enabling without recipients would 503 every send — fail fast at PATCH.
  if (obj.enabled === true && recipients.length === 0) {
    return {
      error: "body.reportEmailConfig.enabled=true requires at least one recipient",
    };
  }
  return {
    value: {
      enabled: obj.enabled,
      recipients,
      allowExternalRecipients: obj.allowExternalRecipients,
      externalRecipientDomains,
      subjectPrefix,
    },
  };
}

const COUNTRY_RE = /^[A-Za-z]{2}$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$|^[0-9a-fA-F:]+\/(?:1[0-2][0-8]|[1-9]?[0-9])$/;

function validateGeoFence(
  raw: unknown,
): { value: ValidatedGeoFence } | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "body.geoFence must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const KNOWN = ["enabled", "allowedCountries", "allowedIpRanges", "unknownLocationPolicy"];
  for (const key of Object.keys(obj)) {
    if (!KNOWN.includes(key)) return { error: `unknown geoFence key: ${key}` };
  }
  if (typeof obj.enabled !== "boolean") {
    return { error: "body.geoFence.enabled must be a boolean" };
  }
  const ac = obj.allowedCountries;
  if (!Array.isArray(ac)) {
    return { error: "body.geoFence.allowedCountries must be an array" };
  }
  if (ac.length > 50) {
    return { error: "body.geoFence.allowedCountries length must be ≤ 50" };
  }
  const allowedCountries: string[] = [];
  for (const c of ac) {
    if (typeof c !== "string" || !COUNTRY_RE.test(c)) {
      return {
        error: 'body.geoFence.allowedCountries entries must be ISO 3166-1 alpha-2 codes (e.g. "GB")',
      };
    }
    allowedCountries.push(c.toLowerCase());
  }
  const ip = obj.allowedIpRanges ?? [];
  if (!Array.isArray(ip)) {
    return { error: "body.geoFence.allowedIpRanges must be an array" };
  }
  if (ip.length > 100) {
    return { error: "body.geoFence.allowedIpRanges length must be ≤ 100" };
  }
  const allowedIpRanges: string[] = [];
  for (const r of ip) {
    if (typeof r !== "string" || r.length === 0 || r.length > 64) {
      return { error: "body.geoFence.allowedIpRanges entries must be 1–64 char strings" };
    }
    if (!CIDR_RE.test(r)) {
      return { error: `body.geoFence.allowedIpRanges entry not a valid CIDR: ${r.slice(0, 32)}` };
    }
    allowedIpRanges.push(r);
  }
  const ulp = obj.unknownLocationPolicy ?? "alert";
  if (ulp !== "alert" && ulp !== "ignore") {
    return { error: 'body.geoFence.unknownLocationPolicy must be "alert" or "ignore"' };
  }
  return {
    value: {
      enabled: obj.enabled,
      allowedCountries,
      allowedIpRanges,
      unknownLocationPolicy: ulp,
    },
  };
}

function validateKevBaseline(
  raw: unknown,
): { value: ValidatedKevBaseline } | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "body.kevBaseline must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const KNOWN = ["mode", "baselineDate"];
  for (const key of Object.keys(obj)) {
    if (!KNOWN.includes(key)) {
      return { error: `unknown kevBaseline key: ${key}` };
    }
  }
  const mode = obj.mode;
  if (typeof mode !== "string" || !KEV_BASELINE_MODE_SET.has(mode)) {
    return {
      error: `body.kevBaseline.mode must be one of: ${KEV_BASELINE_MODES.join(", ")}`,
    };
  }
  if (mode === "historic") {
    // Historic mode has no cutoff — baselineDate is meaningless. Accept
    // missing OR explicit empty string; reject anything else so a
    // typo'd date doesn't get silently dropped.
    if (
      obj.baselineDate !== undefined &&
      obj.baselineDate !== "" &&
      typeof obj.baselineDate !== "undefined"
    ) {
      // Only allow `undefined` or empty string for historic.
      const bd = obj.baselineDate;
      if (typeof bd !== "string" || bd !== "") {
        return {
          error: 'body.kevBaseline.baselineDate must be empty when mode is "historic"',
        };
      }
    }
    return { value: { mode: "historic", baselineDate: "" } };
  }
  // mode === "from-deploy" — baselineDate is required + must parse.
  const bd = obj.baselineDate;
  if (typeof bd !== "string" || !KEV_BASELINE_DATE_PATTERN.test(bd)) {
    return {
      error: "body.kevBaseline.baselineDate must match YYYY-MM-DD",
    };
  }
  const parsed = Date.parse(`${bd}T00:00:00Z`);
  if (!Number.isFinite(parsed)) {
    return { error: "body.kevBaseline.baselineDate is not a parseable date" };
  }
  return { value: { mode: "from-deploy", baselineDate: bd } };
}

function validateReportCadence(
  rc: unknown,
): { value: { cadence: ReportCadenceValue } } | { error: string } {
  if (rc === null || typeof rc !== "object") {
    return { error: "body.reportCadence must be an object" };
  }
  const obj = rc as Record<string, unknown>;
  const cadence = obj["cadence"];
  if (typeof cadence !== "string" || !REPORT_CADENCE_SET.has(cadence)) {
    return {
      error: "body.reportCadence.cadence must be one of: weekly, monthly, quarterly",
    };
  }
  return { value: { cadence: cadence as ReportCadenceValue } };
}

function validateTileVisibility(
  tv: unknown,
): { value: Partial<TileVisibility> } | { error: string } {
  if (tv === null || typeof tv !== "object") {
    return { error: "body.tileVisibility must be an object" };
  }
  const tvObj = tv as Record<string, unknown>;
  const value: Partial<TileVisibility> = {};
  let touched = 0;
  for (const [key, v] of Object.entries(tvObj)) {
    if (!TILE_KEY_SET.has(key)) {
      return { error: `unknown tile key: ${key}` };
    }
    if (typeof v !== "boolean") {
      return { error: `body.tileVisibility.${key} must be a boolean` };
    }
    value[key as TileKey] = v;
    touched++;
  }
  if (touched === 0) {
    return { error: "body.tileVisibility must include at least one tile key" };
  }
  return { value };
}

/** §10.55 follow-up — minimal dormancy-policy patch. Accepts only the
 *  newUserThresholdDays field for now; other fields (thresholdDays,
 *  includeDisabledAccounts, excludeServiceAccountSuffixes) keep using
 *  defaults until a dedicated dormancy-policy admin section ships. */
function validateDormancyPolicy(
  raw: unknown,
): { value: ValidatedDormancyPolicy } | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "body.dormancyPolicy must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const KNOWN = ["newUserThresholdDays"];
  for (const key of Object.keys(obj)) {
    if (!KNOWN.includes(key)) {
      return { error: `unknown dormancyPolicy key: ${key}` };
    }
  }
  const out: { newUserThresholdDays?: number } = {};
  if (obj.newUserThresholdDays !== undefined) {
    const n = obj.newUserThresholdDays;
    const { min, max } = DORMANCY_POLICY_BOUNDS.newUserThresholdDays;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < min ||
      n > max
    ) {
      return {
        error: `body.dormancyPolicy.newUserThresholdDays must be an integer between ${min} and ${max}`,
      };
    }
    out.newUserThresholdDays = n;
  }
  if (Object.keys(out).length === 0) {
    return { error: "body.dormancyPolicy must include at least one field" };
  }
  return { value: out };
}

function validateAgentBudget(
  raw: unknown,
): { value: AgentBudgetPatch } | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "body.agentBudget must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const KNOWN = [
    "briefManualRunCeiling",
    "briefDailyTokenBudget",
    "postureManualRunCeiling",
    "postureWeeklyTokenBudget",
    "incidentsAnalysisManualRunCeiling",
    "incidentsAnalysisDailyTokenBudget",
  ];
  for (const key of Object.keys(obj)) {
    if (!KNOWN.includes(key)) {
      return { error: `unknown agentBudget key: ${key}` };
    }
  }
  const mutable: {
    briefManualRunCeiling?: number;
    briefDailyTokenBudget?: number;
    postureManualRunCeiling?: number;
    postureWeeklyTokenBudget?: number;
    incidentsAnalysisManualRunCeiling?: number;
    incidentsAnalysisDailyTokenBudget?: number;
  } = {};
  for (const key of KNOWN) {
    if (obj[key] === undefined) continue;
    const n = obj[key];
    const bounds = AGENT_BUDGET_BOUNDS[key as keyof typeof AGENT_BUDGET_BOUNDS];
    if (typeof n !== "number" || !Number.isInteger(n)) {
      return { error: `body.agentBudget.${key} must be an integer` };
    }
    if (n < bounds.min || n > bounds.max) {
      return {
        error: `body.agentBudget.${key} must be in [${bounds.min}, ${bounds.max}]`,
      };
    }
    (mutable as Record<string, number>)[key] = n;
  }
  if (Object.keys(mutable).length === 0) {
    return { error: "body.agentBudget must include at least one key" };
  }
  const value: AgentBudgetPatch = mutable as AgentBudgetPatch;
  return { value };
}

function validateUserIdentifierStrategy(
  raw: unknown,
): { value: { strategy: UserIdentifierStrategy } } | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "body.userIdentifierStrategy must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const KNOWN = ["strategy"];
  for (const key of Object.keys(obj)) {
    if (!KNOWN.includes(key)) {
      return { error: `unknown userIdentifierStrategy key: ${key}` };
    }
  }
  const s = obj.strategy;
  if (typeof s !== "string" || !STRATEGY_SET.has(s)) {
    return {
      error:
        "body.userIdentifierStrategy.strategy must be one of: " +
        USER_IDENTIFIER_STRATEGIES.join(", "),
    };
  }
  return { value: { strategy: s as UserIdentifierStrategy } };
}

function validateBranding(
  raw: unknown,
): { value: BrandingPatch } | { error: string } {
  if (raw === null || typeof raw !== "object") {
    return { error: "body.branding must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const KNOWN = ["productName", "primaryHex", "footerText", "defaultTheme"];
  for (const key of Object.keys(obj)) {
    if (!KNOWN.includes(key)) {
      return { error: `unknown branding key: ${key}` };
    }
  }
  const mutable: {
    productName?: string;
    primaryHex?: string;
    footerText?: string;
    defaultTheme?: DefaultTheme;
  } = {};
  if (obj.productName !== undefined) {
    if (typeof obj.productName !== "string") {
      return { error: "body.branding.productName must be a string" };
    }
    if (obj.productName.length > BRANDING_BOUNDS.productName.maxChars) {
      return {
        error: `body.branding.productName must be ≤ ${BRANDING_BOUNDS.productName.maxChars} chars`,
      };
    }
    mutable.productName = obj.productName;
  }
  if (obj.primaryHex !== undefined) {
    if (typeof obj.primaryHex !== "string") {
      return { error: "body.branding.primaryHex must be a string" };
    }
    if (!BRANDING_BOUNDS.primaryHex.pattern.test(obj.primaryHex)) {
      return {
        error: "body.branding.primaryHex must match #RRGGBB (6 hex chars)",
      };
    }
    mutable.primaryHex = obj.primaryHex;
  }
  if (obj.footerText !== undefined) {
    if (typeof obj.footerText !== "string") {
      return { error: "body.branding.footerText must be a string" };
    }
    if (obj.footerText.length > BRANDING_BOUNDS.footerText.maxChars) {
      return {
        error: `body.branding.footerText must be ≤ ${BRANDING_BOUNDS.footerText.maxChars} chars`,
      };
    }
    mutable.footerText = obj.footerText;
  }
  if (obj.defaultTheme !== undefined) {
    if (typeof obj.defaultTheme !== "string" || !DEFAULT_THEME_SET.has(obj.defaultTheme)) {
      return {
        error: `body.branding.defaultTheme must be one of: ${DEFAULT_THEMES.join(", ")}`,
      };
    }
    mutable.defaultTheme = obj.defaultTheme as DefaultTheme;
  }
  if (Object.keys(mutable).length === 0) {
    return { error: "body.branding must include at least one key" };
  }
  const value: BrandingPatch = mutable as BrandingPatch;
  return { value };
}

function deriveUpdatedBy(principal: ClientPrincipal): string {
  // Prefer `userDetails` (upn or email per SWA docs), fall back to `userId`
  // (the object ID GUID). Bound the length so a crafted principal can't
  // bloat the row. Strip C0 + DEL control chars before truncation to close
  // a theoretical log-injection path through the `AIEVENT` customEvent
  // (WS10 SEC-L-ADMIN-SETTINGS-01 resolution — defence-in-depth since
  // Easy Auth's claim → userDetails channel is server-trusted but keeping
  // untrusted-data hygiene uniform across ingest + admin surfaces).
  const candidate = principal.userDetails && principal.userDetails.trim() !== ""
    ? principal.userDetails
    : principal.userId;
  const cleaned = candidate.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned.slice(0, MAX_UPDATED_BY_CHARS);
}

function badRequest(context: InvocationContext, message: string): HttpResponseInit {
  return {
    status: 400,
    jsonBody: {
      error: {
        code: "bad_request",
        message,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

function payloadTooLarge(context: InvocationContext): HttpResponseInit {
  return {
    status: 413,
    jsonBody: {
      error: {
        code: "payload_too_large",
        message: `request body must be ≤ ${MAX_BODY_BYTES} bytes`,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("patchSettings", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "ingest/settings",
  handler,
});
