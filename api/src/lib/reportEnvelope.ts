// ADR-0030 §1 — assemble the live envelope from existing stores.
//
// This is the "cache of the dashboard's source data" pipeline: each
// section is the existing wire shape exposed by an /api/*/latest
// endpoint, read directly from the underlying store instead of via
// HTTP. Reads happen under the api-reader MI, matching the read-side
// of every other GET endpoint.
//
// v1 captures the live state at `capturedAt`; period bounds are
// metadata only, not aggregation filters (see ADR-0030 §1 — period-
// bounded aggregations deferred to Phase B).

import {
  resolveAzureSecureScoreApiConfig,
  resolveBriefAgentConfig,
  resolveConditionalAccessApiConfig,
  resolveEntraRiskApiConfig,
  resolveSignInsApiConfig,
  resolveUserDormancyApiConfig,
} from "./config.js";
import {
  getTableClient,
  getLatestSnapshot,
  getTrendSnapshots,
  OPS_TABLES,
  type TrendRow,
} from "./tables.js";
import {
  listIncidents,
  readIncidentsCounts,
  readIncidentsTrends,
  type IncidentsCounts,
  type IncidentTrendBucket,
} from "./incidentsStore.js";
import type { IncidentSummary } from "./types.js";
import {
  readRiskyUsersCounts,
  ENTRA_RISK_TABLE_NAME,
} from "./entraRiskStore.js";
import { listHealthRowsFederated, readHealthRow } from "./ingestHealth.js";
import {
  readLatestCache as readLatestBriefCache,
  readCacheBody as readBriefBody,
} from "./briefCache.js";
import {
  readLatestCache as readLatestPostureCache,
  readCacheBody as readPostureBody,
} from "./postureCache.js";
import {
  applySuppressionsToMatches,
  listKevRows,
  matchesForStackItem,
  type CveMatchSummary,
} from "./kevStore.js";
import {
  indexSuppressions,
  listSuppressions,
} from "./kevSuppressionsStore.js";
import { listStackItems } from "./stackItemsStore.js";
import { isoWeekOf } from "./posturePromptBuilder.js";
import type { PeriodBounds } from "./reportPeriod.js";
import type {
  ReportEnvelopeBranding,
  ReportEnvelopeComparison,
  ReportSnapshotEnvelope,
} from "./reportSnapshotStore.js";
import {
  decodeEnvelope,
  LOGO_EMBED_MAX_BYTES,
  readLatestSnapshot,
} from "./reportSnapshotStore.js";
import {
  BRANDING_DEFAULTS,
  readBranding,
  readDormancyPolicy,
  readGeoFencePolicy,
} from "./tenantSettingsStore.js";
import {
  computeDormancySummary,
  listUserDormancyRows,
  type DormancySummary,
} from "./userDormancyStore.js";
import {
  computeSignInsSummary,
  listSignIns,
  type SignInsSummary,
} from "./signInsStore.js";
import { listConditionalAccessPolicies } from "./conditionalAccessStore.js";
import { listAzureSecureScores } from "./azureSecureScoreStore.js";
import { listControlProfiles } from "./secureScoreControlProfileStore.js";
import { periodForCadence } from "./reportPeriod.js";
import { ContainerClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { IngestHealthRow } from "./types.js";
import type { SecureScoreSnapshot } from "./types.js";

const INCIDENTS_TREND_DAYS = 30;
const SECURE_SCORE_TREND_DAYS = 90;
const TOP_INCIDENTS_PREVIEW = 10;
const POSTURE_LOOKBACK_WEEKS = 3;

export interface AssembleEnvelopeArgs {
  readonly tenantId: string;
  readonly capturedBy: string;
  readonly version: number;
  readonly capturedAt: string;
  readonly period: PeriodBounds;
  /** ADR-0030 — capture-run UUID, mirrors the audit-line `runId`.
   *  Optional for callers that don't yet thread one through (live render
   *  via /api/reports/current/html); persisted captures always supply
   *  it. */
  readonly captureRunId?: string;
  /** Optional operator note — already validated + sanitised by the
   *  caller. Surfaced under the executive summary when present. */
  readonly operatorNote?: string;
}

/** Per-stack-item KEV exposure roll-up. */
export interface StackKevExposureItem {
  readonly stackItemId: string;
  readonly vendor: string;
  readonly product: string;
  readonly version: string;
  readonly openMatches: number;
  readonly totalMatches: number;
  readonly ransomwareLinked: boolean;
}

export interface StackKevExposureSection {
  readonly totalStackItems: number;
  readonly totalMatches: number;
  readonly openMatches: number;
  readonly dueThisWeek: number;
  readonly ransomwareLinkedOpen: number;
  /** Top items by openMatches descending — capped to keep envelope small. */
  readonly topExposures: readonly StackKevExposureItem[];
}

/** Wire shape for the userDormancy report section. `licenceState` short-
 *  circuits the section render when Entra ID P1 isn't present (mirrors the
 *  dashboard's tile-capability gating). */
export interface UserDormancyReportSection {
  readonly licenceState: "ok" | "licence_required";
  readonly summary: DormancySummary | null;
  readonly policy: {
    readonly thresholdDays: number;
    readonly includeDisabledAccounts: boolean;
  } | null;
}

/** Wire shape for the signIns report section. `licenceState` short-
 *  circuits when sign-in logs are gated behind P1 (or P2 for full surface). */
export interface SignInsReportSection {
  readonly licenceState: "ok" | "licence_required";
  readonly summary: SignInsSummary | null;
  readonly policy: {
    readonly enabled: boolean;
    readonly allowedCountries: readonly string[];
    readonly unknownLocationPolicy: "alert" | "ignore";
  } | null;
}

/** Wire shape for the conditionalAccess report section — counts grouped by
 *  policy state. ADR-0034 §3.3. No licence gate; CA is a
 *  baseline Entra capability. */
export interface ConditionalAccessReportSection {
  readonly counts: {
    readonly total: number;
    readonly enabled: number;
    readonly disabled: number;
    readonly reportOnly: number;
  };
}

/** Wire shape for the azureSecureScore report section — per-(tracked)
 *  subscription latest snapshot + 90-day trend. ADR-0036 Phase A is single-
 *  subscription in v1 but the array shape is forward-compat for Phase B
 *  multi-sub. */
export interface AzureSecureScoreReportSection {
  readonly subscriptions: ReadonlyArray<{
    readonly subscriptionId: string;
    readonly subscriptionName: string;
    readonly latest: {
      readonly snapshotDate: string;
      readonly currentScore: number;
      readonly maxScore: number;
      readonly percentage: number;
    };
    readonly trend: ReadonlyArray<{
      readonly snapshotDate: string;
      readonly percentage: number;
    }>;
  }>;
}

interface AssembledSections {
  readonly secureScore: {
    readonly snapshot: SecureScoreSnapshot | null;
    readonly trend: readonly TrendRow[];
  };
  readonly incidents: {
    readonly counts: IncidentsCounts;
    readonly trend: readonly IncidentTrendBucket[];
    readonly preview: readonly IncidentSummary[];
  };
  readonly entraRisk: {
    readonly counts: unknown;
  };
  readonly brief: {
    readonly briefDate: string | null;
    readonly body: string | null;
    readonly modelDeployment: string | null;
  };
  readonly posture: {
    readonly isoWeek: string | null;
    readonly body: string | null;
    readonly modelDeployment: string | null;
  };
  readonly ingestHealth: readonly IngestHealthRow[];
  readonly stackKevExposure: StackKevExposureSection;
  readonly userDormancy: UserDormancyReportSection;
  readonly signIns: SignInsReportSection;
  readonly conditionalAccess: ConditionalAccessReportSection;
  readonly azureSecureScore: AzureSecureScoreReportSection;
}

const STACK_KEV_TOP_N = 10;
const KEV_DUE_WINDOW_MS = 7 * 86_400_000;

/**
 * Assemble the live envelope. Each section read is independently faulted —
 * a single store outage produces an empty section rather than aborting
 * the whole capture, matching the dashboard's per-tile failure model.
 *
 * Brief + posture are best-effort: when the AI plane is disabled (or has
 * never run), they return null bodies. The capture still succeeds.
 */
export async function assembleLiveEnvelope(
  args: AssembleEnvelopeArgs,
): Promise<ReportSnapshotEnvelope> {
  const config = resolveBriefAgentConfig();
  const tableCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };

  // EntraRisk source is on its own config object — not BriefAgentConfig.
  const entraConfig = resolveEntraRiskApiConfig();
  const [sections, branding, comparison] = await Promise.all([
    assembleSections(args, config, entraConfig, tableCtx),
    assembleBranding(tableCtx, args.tenantId),
    assembleComparison(tableCtx, args.tenantId, args.period),
  ]);

  return {
    schemaVersion: 1,
    contentType: "application/json",
    tenantId: args.tenantId,
    periodKey: args.period.periodKey,
    periodCadence: args.period.cadence,
    periodStart: args.period.periodStart,
    periodEnd: args.period.periodEnd,
    capturedAt: args.capturedAt,
    capturedBy: args.capturedBy,
    version: args.version,
    ...(args.captureRunId ? { captureRunId: args.captureRunId } : {}),
    ...(args.operatorNote ? { operatorNote: args.operatorNote } : {}),
    branding,
    ...(comparison ? { comparison } : {}),
    sections: {
      secureScore: sections.secureScore,
      incidents: sections.incidents,
      entraRisk: sections.entraRisk,
      brief: sections.brief,
      posture: sections.posture,
      ingestHealth: sections.ingestHealth,
      stackKevExposure: sections.stackKevExposure,
      userDormancy: sections.userDormancy,
      signIns: sections.signIns,
      conditionalAccess: sections.conditionalAccess,
      azureSecureScore: sections.azureSecureScore,
    },
    derived: {},
  };
}

async function assembleSections(
  args: AssembleEnvelopeArgs,
  config: ReturnType<typeof resolveBriefAgentConfig>,
  entraConfig: ReturnType<typeof resolveEntraRiskApiConfig>,
  tableCtx: { endpoint: string; managedIdentityClientId: string },
): Promise<AssembledSections> {
  // §10.62 — resolvers for the four §10.62 verticals. Resolved synchronously
  // (env reads only) so the parallel-Promise.all below stays clean.
  const userDormancyConfig = resolveUserDormancyApiConfig();
  const signInsConfig = resolveSignInsApiConfig();
  const conditionalAccessConfig = resolveConditionalAccessApiConfig();
  const azureSecureScoreConfig = resolveAzureSecureScoreApiConfig();

  // Run section reads in parallel — they don't share state.
  const [
    secureScore,
    incidents,
    entraRisk,
    brief,
    posture,
    ingestHealth,
    stackKevExposure,
    userDormancy,
    signIns,
    conditionalAccess,
    azureSecureScore,
  ] = await Promise.all([
    assembleSecureScore(tableCtx),
    assembleIncidents(tableCtx, args.tenantId),
    assembleEntraRisk(tableCtx, args.tenantId, entraConfig.entraRiskSource),
    assembleBrief(config, tableCtx, args.tenantId),
    assemblePosture(config, tableCtx, args.tenantId),
    assembleIngestHealth(tableCtx, args.tenantId),
    assembleStackKevExposure(tableCtx, args.tenantId),
    assembleUserDormancy(
      tableCtx,
      args.tenantId,
      userDormancyConfig.userDormancySource,
    ),
    assembleSignIns(tableCtx, args.tenantId, signInsConfig.signInsSource),
    assembleConditionalAccess(tableCtx, args.tenantId),
    assembleAzureSecureScore(tableCtx, args.tenantId),
  ]);
  // Reference the configs to suppress unused-var warnings — only the source
  // strings are actually consumed; the rest of each config is unused here.
  void conditionalAccessConfig;
  void azureSecureScoreConfig;
  return {
    secureScore,
    incidents,
    entraRisk,
    brief,
    posture,
    ingestHealth,
    stackKevExposure,
    userDormancy,
    signIns,
    conditionalAccess,
    azureSecureScore,
  };
}

/** Capture the tenant branding triple + logo at envelope time so historical
 *  reports render with the branding in effect at capture (not the
 *  current branding, which may have changed). Logo is base64-inlined as a
 *  `data:` URI so the rendered HTML is genuinely self-contained — works
 *  offline + survives email forwarding. Logos above LOGO_EMBED_MAX_BYTES
 *  are silently dropped (envelope size budget) — renderer falls back to
 *  text-only branding. Falls back to defaults when any read fails. */
async function assembleBranding(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
): Promise<ReportEnvelopeBranding> {
  try {
    const settingsTable = getTableClient(tableCtx, OPS_TABLES.TenantSettings);
    const branding = await readBranding(settingsTable, tenantId);
    const logoDataUrl = await tryFetchLogoDataUrl(
      branding.logoSha256,
      branding.logoContentType,
      branding.logoSize,
      tenantId,
      tableCtx.managedIdentityClientId,
    );
    return {
      productName: branding.productName,
      primaryHex: branding.primaryHex,
      footerText: branding.footerText,
      ...(logoDataUrl ? { logoDataUrl } : {}),
    };
  } catch {
    return {
      productName: BRANDING_DEFAULTS.productName,
      primaryHex: BRANDING_DEFAULTS.primaryHex,
      footerText: BRANDING_DEFAULTS.footerText,
    };
  }
}

/** Best-effort fetch of the branding logo bytes; encode as data URL.
 *  Returns null when:
 *    - no logo is configured (sha256 / content-type / size all empty)
 *    - the logo size exceeds LOGO_EMBED_MAX_BYTES (would overshoot the
 *      compressed envelope cap)
 *    - the blob fetch fails for any reason
 *  In all null cases the renderer falls back to text-only branding. */
async function tryFetchLogoDataUrl(
  logoSha256: string,
  logoContentType: string,
  logoSize: number,
  tenantId: string,
  apiReaderMiClientId: string,
): Promise<string | null> {
  if (!logoSha256 || !logoContentType || logoSize === 0) return null;
  if (logoSize > LOGO_EMBED_MAX_BYTES) return null;
  try {
    const opsBlobEndpoint =
      process.env.OPS_BLOB_ENDPOINT ??
      (process.env.OPS_TABLE_ENDPOINT ?? "").replace(".table.", ".blob.");
    if (!opsBlobEndpoint) return null;
    const containerName = process.env.BRANDING_ASSETS_CONTAINER ?? "branding-assets";
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: apiReaderMiClientId,
    });
    const container = new ContainerClient(
      `${opsBlobEndpoint}/${containerName}`,
      credential,
    );
    // Mirror brandingLogoBlobPath() in uploadBrandingLogo.ts — same allowlist.
    const safeTenant = tenantId.replace(/[^A-Za-z0-9_-]/g, "_");
    const blob = container.getBlobClient(`${safeTenant}/logo`);
    const buf = await blob.downloadToBuffer();
    if (buf.byteLength > LOGO_EMBED_MAX_BYTES) return null;
    return `data:${logoContentType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Look up the prior period's most recent stored snapshot for the given
 *  cadence and pull SecureScore.percentage off the envelope. Returns null
 *  when there is no prior snapshot — renderer omits the comparison line.
 *
 *  Prior period derived by stepping ONE millisecond before the current
 *  period's start, then asking periodForCadence to bracket that instant.
 *  Robust at year-boundaries (W01 → W52/W53 of prior year handled by ISO
 *  week math; Q1 → Q4 of prior year by month math). */
async function assembleComparison(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
  period: PeriodBounds,
): Promise<ReportEnvelopeComparison | null> {
  try {
    const startMs = Date.parse(period.periodStart);
    if (!Number.isFinite(startMs)) return null;
    const justBefore = new Date(startMs - 1);
    const priorPeriod = periodForCadence(period.cadence, justBefore);
    const reportTable = getTableClient(tableCtx, OPS_TABLES.ReportSnapshots);
    const prior = await readLatestSnapshot(reportTable, tenantId, priorPeriod.periodKey);
    if (!prior) return null;
    const ss = prior.sections.secureScore as
      | { snapshot?: { percentage?: number } }
      | null
      | undefined;
    const pct =
      ss && ss.snapshot && typeof ss.snapshot.percentage === "number"
        ? ss.snapshot.percentage
        : null;
    // Per-tile prior-period counts. Both fields are optional in the
    // envelope and tolerate the older Phase A snapshot shape (snapshots
    // captured before this code shipped omit them entirely; we surface
    // null in that case so the renderer skips the suffix).
    const incidents = prior.sections.incidents as
      | { counts?: { activeCount?: unknown } }
      | null
      | undefined;
    const priorIncidentsActive =
      incidents &&
      incidents.counts &&
      typeof incidents.counts.activeCount === "number"
        ? incidents.counts.activeCount
        : null;
    const entraRisk = prior.sections.entraRisk as
      | { counts?: { total?: unknown; licenceState?: unknown } }
      | null
      | undefined;
    // Skip when prior was licence-required (no comparable data point).
    const priorRiskyUsersTotal =
      entraRisk &&
      entraRisk.counts &&
      typeof entraRisk.counts.total === "number" &&
      entraRisk.counts.licenceState !== "licence_required"
        ? entraRisk.counts.total
        : null;
    return {
      priorPeriodKey: prior.periodKey,
      priorSecureScorePercentage: pct,
      priorIncidentsActive,
      priorRiskyUsersTotal,
      priorCapturedAt: prior.capturedAt,
    };
  } catch {
    return null;
  }
}
// readLatestSnapshot returns the decoded envelope; the import is at the
// top of the file. `decodeEnvelope` is exported for use elsewhere.
void decodeEnvelope;

/** Roll up the live KEV-vs-stack join into a per-item exposure summary.
 *  Open matches are the operationally relevant cohort (effective status
 *  `"open"` per the read-time resolver — handles expiry); other statuses
 *  show as totalMatches but not openMatches. Top-N capped to keep the
 *  envelope under the 60 KB compressed cap. Best-effort — a transient
 *  read failure produces an empty section rather than aborting capture. */
async function assembleStackKevExposure(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
): Promise<StackKevExposureSection> {
  try {
    const stackTable = getTableClient(tableCtx, OPS_TABLES.StackItems);
    const kevTable = getTableClient(tableCtx, OPS_TABLES.KEV);
    const suppressionsTable = getTableClient(tableCtx, OPS_TABLES.KevSuppressions);
    const [stackItems, kevRows, suppressionRows] = await Promise.all([
      listStackItems(stackTable, tenantId),
      listKevRows(kevTable),
      listSuppressions(suppressionsTable, tenantId),
    ]);
    const suppressionsByKey = indexSuppressions(suppressionRows);
    const now = Date.now();

    let totalMatches = 0;
    let openMatches = 0;
    let dueThisWeek = 0;
    let ransomwareLinkedOpen = 0;
    const perItem: StackKevExposureItem[] = [];

    for (const item of stackItems) {
      const baseMatches = matchesForStackItem(kevRows, {
        vendor: item.vendor,
        product: item.product,
      });
      if (baseMatches.length === 0) continue;
      const overlaid: readonly CveMatchSummary[] = applySuppressionsToMatches(
        item.id,
        baseMatches,
        suppressionsByKey,
      );
      let itemOpen = 0;
      let itemRansomwareLinked = false;
      for (const m of overlaid) {
        totalMatches++;
        if (m.status !== "open") continue;
        openMatches++;
        itemOpen++;
        if (m.knownRansomwareCampaignUse === "Known") {
          ransomwareLinkedOpen++;
          itemRansomwareLinked = true;
        }
        if (m.dueDate) {
          const dueMs = Date.parse(m.dueDate);
          if (Number.isFinite(dueMs) && dueMs >= now && dueMs - now <= KEV_DUE_WINDOW_MS) {
            dueThisWeek++;
          }
        }
      }
      perItem.push({
        stackItemId: item.id,
        vendor: item.vendor,
        product: item.product,
        version: item.version,
        openMatches: itemOpen,
        totalMatches: overlaid.length,
        ransomwareLinked: itemRansomwareLinked,
      });
    }

    perItem.sort((a, b) => {
      if (b.openMatches !== a.openMatches) return b.openMatches - a.openMatches;
      // Tie-break: ransomware-linked first, then by total matches.
      const ar = a.ransomwareLinked ? 0 : 1;
      const br = b.ransomwareLinked ? 0 : 1;
      if (ar !== br) return ar - br;
      return b.totalMatches - a.totalMatches;
    });

    return {
      totalStackItems: stackItems.length,
      totalMatches,
      openMatches,
      dueThisWeek,
      ransomwareLinkedOpen,
      topExposures: perItem.slice(0, STACK_KEV_TOP_N),
    };
  } catch {
    return {
      totalStackItems: 0,
      totalMatches: 0,
      openMatches: 0,
      dueThisWeek: 0,
      ransomwareLinkedOpen: 0,
      topExposures: [],
    };
  }
}

/** Defensive cap on the per-control title length copied into the envelope.
 *  Microsoft's published titles are short (<120 chars in practice), but a
 *  hostile or future-bloated profile cache could push the envelope toward
 *  the compressed cap (MAX_COMPRESSED_ENVELOPE_BYTES in reportSnapshotStore).
 *  WS10 SEC-L-SS-TITLE-01 — closed inline. */
const CONTROL_TITLE_MAX_CHARS = 200;

/** Pure decorator — join Microsoft-supplied control titles onto the
 *  snapshot's controlScores[]. Extracted so the join logic is testable
 *  without table-client mocking. Empty/whitespace titles are skipped (the
 *  renderer's controlName fallback handles them anyway, but skipping keeps
 *  the envelope smaller). */
export function decorateSnapshotWithControlTitles(
  snapshot: SecureScoreSnapshot,
  profiles: ReadonlyArray<{ controlName: string; title: string }>,
): SecureScoreSnapshot {
  const titleByName = new Map<string, string>();
  for (const p of profiles) {
    const title = (p.title ?? "").trim();
    if (title.length === 0) continue;
    titleByName.set(
      p.controlName,
      title.length > CONTROL_TITLE_MAX_CHARS
        ? title.slice(0, CONTROL_TITLE_MAX_CHARS)
        : title,
    );
  }
  if (titleByName.size === 0) return snapshot;
  return {
    ...snapshot,
    controlScores: snapshot.controlScores.map((c) => {
      const title = titleByName.get(c.controlName);
      return title ? { ...c, title } : c;
    }),
  };
}

async function assembleSecureScore(tableCtx: {
  endpoint: string;
  managedIdentityClientId: string;
}): Promise<AssembledSections["secureScore"]> {
  const table = getTableClient(tableCtx, OPS_TABLES.SecureScore);
  const [snapshot, trend, profiles] = await Promise.all([
    getLatestSnapshot(table),
    getTrendSnapshots(table, SECURE_SCORE_TREND_DAYS),
    // Profiles live in the same table under PartitionKey="profile" — same
    // RBAC scope as the snapshot read. Best-effort: a fetch failure produces
    // an empty profile map and the renderer falls back to controlName.
    listControlProfiles(table).catch(() => [] as Array<{ controlName: string; title: string }>),
  ]);
  if (!snapshot) return { snapshot, trend };
  return { snapshot: decorateSnapshotWithControlTitles(snapshot, profiles), trend };
}

async function assembleIncidents(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
): Promise<AssembledSections["incidents"]> {
  const table = getTableClient(tableCtx, OPS_TABLES.Incidents);
  const sinceIso = new Date(
    Date.now() - INCIDENTS_TREND_DAYS * 86_400_000,
  ).toISOString();
  const [counts, trend, list] = await Promise.all([
    readIncidentsCounts(table, tenantId),
    readIncidentsTrends(table, tenantId, sinceIso, INCIDENTS_TREND_DAYS),
    listIncidents(table, tenantId, { limit: TOP_INCIDENTS_PREVIEW }),
  ]);
  return { counts, trend, preview: list.incidents };
}

async function assembleEntraRisk(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
  source: string,
): Promise<AssembledSections["entraRisk"]> {
  const entraTable = getTableClient(tableCtx, ENTRA_RISK_TABLE_NAME);
  const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);
  const health = await readHealthRow(healthTable, tenantId, source);
  // licence_required short-circuit per ADR-0024 §1.1 — skip the partition walk.
  if (health?.status === "licence_required") {
    return { counts: { licenceState: "licence_required" } };
  }
  const counts = await readRiskyUsersCounts(entraTable, tenantId);
  return { counts };
}

async function assembleBrief(
  config: ReturnType<typeof resolveBriefAgentConfig>,
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
): Promise<AssembledSections["brief"]> {
  // Brief lives in BriefCache (Table) + daily-briefs (Blob). When the AI
  // plane is disabled the table is empty (read returns null); the body
  // fetch is skipped. Outer try/catch is best-effort: a transient blob
  // outage produces a row-without-body envelope rather than aborting the
  // whole capture, matching the dashboard's per-tile failure model.
  try {
    const cacheTable = getTableClient(tableCtx, OPS_TABLES.BriefCache);
    const row = await readLatestBriefCache(cacheTable, tenantId);
    if (!row) return { briefDate: null, body: null, modelDeployment: null };
    const body = await readBriefBody(
      config.opsBlobEndpoint,
      config.apiReaderMiClientId,
      config.briefCacheContainer,
      row.blobPath,
    );
    return {
      briefDate: row.briefDate,
      body: body.body,
      modelDeployment: row.modelDeployment ?? null,
    };
  } catch {
    return { briefDate: null, body: null, modelDeployment: null };
  }
}

async function assemblePosture(
  config: ReturnType<typeof resolveBriefAgentConfig>,
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
): Promise<AssembledSections["posture"]> {
  try {
    const cacheTable = getTableClient(tableCtx, OPS_TABLES.PostureCache);
    const now = new Date();
    const thisWeek = isoWeekOf(now);
    const stepBack = (weeksBack: number): string =>
      isoWeekOf(new Date(now.getTime() - weeksBack * 7 * 86_400_000));
    const row = await readLatestPostureCache(
      cacheTable,
      tenantId,
      thisWeek,
      POSTURE_LOOKBACK_WEEKS,
      stepBack,
    );
    if (!row) return { isoWeek: null, body: null, modelDeployment: null };
    const body = await readPostureBody(
      config.opsBlobEndpoint,
      config.apiReaderMiClientId,
      config.postureCacheContainer,
      row.blobPath,
    );
    return {
      isoWeek: row.isoWeek,
      body: body.body,
      modelDeployment: row.modelDeployment ?? null,
    };
  } catch {
    return { isoWeek: null, body: null, modelDeployment: null };
  }
}

async function assembleIngestHealth(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
): Promise<readonly IngestHealthRow[]> {
  // ADR-0036 v1.3 — IngestHealth split. Federated read covers both
  // IngestHealth (Graph-plane) and ArmIngestHealth (ARM-plane) so the
  // envelope's freshness section continues to span every ingest source.
  return await listHealthRowsFederated(tableCtx, tenantId);
}

/** §10.62 — User dormancy summary at capture time. Best-effort: licence_required
 *  short-circuits the full partition scan; transient store outage produces an
 *  empty section rather than aborting capture. */
async function assembleUserDormancy(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
  source: string,
): Promise<UserDormancyReportSection> {
  try {
    const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);
    const settingsTable = getTableClient(tableCtx, OPS_TABLES.TenantSettings);
    const dormancyTable = getTableClient(tableCtx, OPS_TABLES.UserDormancy);
    const health = await readHealthRow(healthTable, tenantId, source);
    if (health?.status === "licence_required") {
      return { licenceState: "licence_required", summary: null, policy: null };
    }
    const [rows, policy] = await Promise.all([
      listUserDormancyRows(dormancyTable, tenantId),
      readDormancyPolicy(settingsTable, tenantId),
    ]);
    const summary = computeDormancySummary(rows, policy);
    return {
      licenceState: "ok",
      summary,
      policy: {
        thresholdDays: policy.thresholdDays,
        includeDisabledAccounts: policy.includeDisabledAccounts,
      },
    };
  } catch {
    return { licenceState: "ok", summary: null, policy: null };
  }
}

/** §10.62 — Sign-ins summary at capture time. The "today" window inside
 *  computeSignInsSummary is derived from the partition scan (relative to
 *  capturedAt); for a period-bounded report this is "the most recent 24h"
 *  not "the period". Period-bounded aggregation is deferred per ADR-0030 §1. */
async function assembleSignIns(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
  source: string,
): Promise<SignInsReportSection> {
  try {
    const healthTable = getTableClient(tableCtx, OPS_TABLES.IngestHealth);
    const settingsTable = getTableClient(tableCtx, OPS_TABLES.TenantSettings);
    const signInsTable = getTableClient(tableCtx, OPS_TABLES.SignIns);
    const health = await readHealthRow(healthTable, tenantId, source);
    if (health?.status === "licence_required") {
      return { licenceState: "licence_required", summary: null, policy: null };
    }
    const [rows, policy] = await Promise.all([
      listSignIns(signInsTable, tenantId, {}),
      readGeoFencePolicy(settingsTable, tenantId),
    ]);
    const summary = computeSignInsSummary(rows);
    return {
      licenceState: "ok",
      summary,
      policy: {
        enabled: policy.enabled,
        allowedCountries: policy.allowedCountries,
        unknownLocationPolicy: policy.unknownLocationPolicy,
      },
    };
  } catch {
    return { licenceState: "ok", summary: null, policy: null };
  }
}

/** §10.62 — Conditional Access policy counts grouped by state at capture
 *  time. Mirrors the dashboard tile minus the recent-changes feed (Phase 8D
 *  drift detection); the report is period-bounded and reflects state, not
 *  drift events. */
async function assembleConditionalAccess(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
): Promise<ConditionalAccessReportSection> {
  try {
    const caTable = getTableClient(tableCtx, OPS_TABLES.ConditionalAccessPolicies);
    const policies = await listConditionalAccessPolicies(caTable, tenantId);
    let enabled = 0;
    let disabled = 0;
    let reportOnly = 0;
    for (const p of policies) {
      switch (p.state) {
        case "enabled":
          enabled++;
          break;
        case "disabled":
          disabled++;
          break;
        case "enabledForReportingButNotEnforced":
          reportOnly++;
          break;
      }
    }
    return {
      counts: {
        total: policies.length,
        enabled,
        disabled,
        reportOnly,
      },
    };
  } catch {
    return { counts: { total: 0, enabled: 0, disabled: 0, reportOnly: 0 } };
  }
}

/** §10.62 — Defender for Cloud Secure Score per-subscription latest +
 *  90-day trend at capture time. Mirrors the shape of
 *  /api/azure-secure-score/summary (single-sub today; array shape forward-
 *  compat for ADR-0036 Phase B multi-sub). */
async function assembleAzureSecureScore(
  tableCtx: { endpoint: string; managedIdentityClientId: string },
  tenantId: string,
): Promise<AzureSecureScoreReportSection> {
  try {
    const scoresTable = getTableClient(tableCtx, OPS_TABLES.AzureSecureScores);
    const rows = await listAzureSecureScores(scoresTable, tenantId);
    if (rows.length === 0) return { subscriptions: [] };
    const bySub = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = bySub.get(r.subscriptionId);
      if (list) list.push(r);
      else bySub.set(r.subscriptionId, [r]);
    }
    const subscriptions = Array.from(bySub.entries()).map(([subscriptionId, list]) => {
      const sortedAsc = [...list].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
      const latestRow = sortedAsc[sortedAsc.length - 1]!;
      return {
        subscriptionId,
        subscriptionName: latestRow.subscriptionName,
        latest: {
          snapshotDate: latestRow.snapshotDate,
          currentScore: latestRow.currentScore,
          maxScore: latestRow.maxScore,
          percentage: latestRow.percentage,
        },
        trend: sortedAsc.map((r) => ({
          snapshotDate: r.snapshotDate,
          percentage: r.percentage,
        })),
      };
    });
    return { subscriptions };
  } catch {
    return { subscriptions: [] };
  }
}
