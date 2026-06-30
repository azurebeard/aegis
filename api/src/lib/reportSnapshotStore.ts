// ADR-0030 §3 — ReportSnapshots table accessor.
//
// Row shape:
//   PartitionKey = tenantId
//   RowKey       = `<periodKey>_<capturedAt>` (capturedAt = ISO-8601 UTC)
//   Columns      = SchemaVersion, ContentType, Cadence, PeriodKey,
//                  PeriodStart, PeriodEnd, CapturedAt, CapturedBy,
//                  Version, Envelope (gzip+base64), EnvelopeBytes
//
// Envelope encoding (ADR-0030 §4):
//   1. JSON.stringify(envelope)      → utf-8 bytes
//   2. zlib.gzipSync                 → compressed bytes
//   3. Buffer.toString("base64")     → UTF-16 string suitable for the column
//   4. Hard-fail at 60 KB compressed (caller emits status=size_exceeded)
//
// Reads decode in reverse. EnvelopeBytes is the pre-compression count for
// telemetry; operators can spot drift toward the cap on the recent-reports
// list endpoint without decoding payloads.
//
// RBAC (infra/modules/storage-ops.bicep):
//   - Ingest MI: Contributor — capture writes
//   - Api-reader MI: Reader  — list + get reads
//   - Agent MI: nothing (deferred to Phase B agent-narrative summary)

import { gzipSync, gunzipSync } from "node:zlib";
import { odata, RestError, type TableClient, type TableEntity } from "@azure/data-tables";
import type { ReportCadence } from "./reportPeriod.js";

/** Hard cap on Envelope column post-compression. ADR-0030 §4. */
export const MAX_COMPRESSED_ENVELOPE_BYTES = 60 * 1024;

/** Floor on REPORT_SNAPSHOT_VERSIONS_PER_PERIOD. ADR-0030 §3 retention table. */
export const MIN_VERSIONS_PER_PERIOD = 3;

/** Branding snapshot — captured into the envelope so historical reports
 *  render with the branding in effect at capture time, not the current.
 *
 *  `logoDataUrl` is a `data:image/...;base64,...` URI computed at capture
 *  time so the rendered HTML is genuinely self-contained (works offline,
 *  survives email forwarding, no live `/api/branding/.../logo` round-trip).
 *  Omitted when the tenant has no logo OR the asset exceeds the embed cap
 *  (LOGO_EMBED_MAX_BYTES) — in that case the renderer falls back to a
 *  product-name-only header. */
export interface ReportEnvelopeBranding {
  readonly productName: string;
  readonly primaryHex: string;
  readonly footerText: string;
  readonly logoDataUrl?: string;
}

/** Comparative-period summary — the stored snapshot one period prior, if
 *  any. Surfaced in the executive summary as "Secure Score N% (UP from M%
 *  last period)" and as per-tile delta suffixes under each section's hero
 *  subtitle. Optional: the renderer omits any line whose corresponding
 *  field is null. The two count fields are additive — older Phase A
 *  snapshots were captured without them and parse cleanly with `undefined`.
 *  Renderer treats `undefined` and `null` identically (no comparison). */
export interface ReportEnvelopeComparison {
  readonly priorPeriodKey: string;
  readonly priorSecureScorePercentage: number | null;
  readonly priorIncidentsActive?: number | null;
  readonly priorRiskyUsersTotal?: number | null;
  readonly priorCapturedAt: string;
}

export interface ReportSnapshotEnvelope {
  readonly schemaVersion: 1;
  readonly contentType: "application/json";
  readonly tenantId: string;
  readonly periodKey: string;
  readonly periodCadence: ReportCadence;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly capturedAt: string;
  readonly capturedBy: string;
  readonly version: number;
  /** ADR-0030 — capture-run UUID. Mirrors the audit-line `runId` so
   *  forensic verification (`/api/audit/verify?source=report.snapshot`)
   *  can correlate envelope ↔ audit line. Forward-compat optional. */
  readonly captureRunId?: string;
  /** Operator-supplied free-text note — meeting context the data alone
   *  can't surface (e.g. "Onboarded customer X this month, deprecated
   *  server Y"). Length-capped + control-char-stripped at write time.
   *  Forward-compat optional. */
  readonly operatorNote?: string;
  /** Forward-compat: optional so Phase A snapshots that pre-date this
   *  field still parse. Renderer falls back to default branding when
   *  absent. */
  readonly branding?: ReportEnvelopeBranding;
  /** Forward-compat: optional. Populated by the assembler when a prior
   *  stored snapshot exists for the same cadence. */
  readonly comparison?: ReportEnvelopeComparison;
  readonly sections: {
    readonly secureScore: unknown;
    readonly incidents: unknown;
    readonly entraRisk: unknown;
    readonly brief: unknown;
    readonly posture: unknown;
    readonly ingestHealth: unknown;
    /** Forward-compat: optional. Populated when capture has access to the
     *  StackItems + KEV + KevSuppressions tables. */
    readonly stackKevExposure?: unknown;
    /** Forward-compat: optional. Snapshots captured before §10.62 omit
     *  these fields. Renderers MUST tolerate undefined and either render
     *  an empty section or skip entirely. */
    readonly userDormancy?: unknown; // ADR-0034 §3.1
    readonly signIns?: unknown; // ADR-0034 §3.2
    readonly conditionalAccess?: unknown; // ADR-0034 §3.3
    readonly azureSecureScore?: unknown; // ADR-0036
  };
  readonly derived: Readonly<Record<string, string>>;
}

/** Embed cap for the inline logo. Bytes ABOVE this size are dropped from
 *  the envelope (logoDataUrl unset) — keeps the compressed envelope under
 *  the 60 KB cap (MAX_COMPRESSED_ENVELOPE_BYTES). 32 KB raw → ~43 KB
 *  base64 → ~48 KB encoded after gzip; leaves headroom for the rest of
 *  the snapshot. PNG/WebP logos at 192x192 typically fit comfortably. */
export const LOGO_EMBED_MAX_BYTES = 32 * 1024;

interface ReportSnapshotEntity extends TableEntity {
  readonly SchemaVersion: number;
  readonly ContentType: string;
  readonly Cadence: ReportCadence;
  readonly PeriodKey: string;
  readonly PeriodStart: string;
  readonly PeriodEnd: string;
  readonly CapturedAt: string;
  readonly CapturedBy: string;
  readonly Version: number;
  readonly Envelope: string; // gzip+base64
  readonly EnvelopeBytes: number;
}

export interface ReportSnapshotListItem {
  readonly periodKey: string;
  readonly cadence: ReportCadence;
  readonly version: number;
  readonly capturedAt: string;
  readonly capturedBy: string;
  readonly contentType: string;
  readonly envelopeBytes: number;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export class EnvelopeTooLargeError extends Error {
  readonly compressedBytes: number;
  constructor(compressedBytes: number) {
    super(
      `report envelope exceeds compressed cap (${compressedBytes} > ${MAX_COMPRESSED_ENVELOPE_BYTES}); add ADR-0030 Phase B blob fallback to handle`,
    );
    this.name = "EnvelopeTooLargeError";
    this.compressedBytes = compressedBytes;
  }
}

/** Encode envelope → (compressedBytes, base64 string for column). */
export function encodeEnvelope(envelope: ReportSnapshotEnvelope): {
  readonly column: string;
  readonly compressedBytes: number;
  readonly preCompressionBytes: number;
} {
  const json = JSON.stringify(envelope);
  const preCompressionBytes = Buffer.byteLength(json, "utf-8");
  const gz = gzipSync(Buffer.from(json, "utf-8"));
  if (gz.byteLength > MAX_COMPRESSED_ENVELOPE_BYTES) {
    throw new EnvelopeTooLargeError(gz.byteLength);
  }
  return {
    column: gz.toString("base64"),
    compressedBytes: gz.byteLength,
    preCompressionBytes,
  };
}

/** Decode a stored Envelope column back to the envelope object. */
export function decodeEnvelope(column: string): ReportSnapshotEnvelope {
  const gz = Buffer.from(column, "base64");
  const json = gunzipSync(gz).toString("utf-8");
  return JSON.parse(json) as ReportSnapshotEnvelope;
}

/**
 * Build the RowKey from periodKey + capturedAt. Both ISO-8601-friendly
 * components — lex-sort gives chronological order under a period prefix.
 * Underscore separator never appears inside ISO timestamps or period keys
 * (`YYYY-Www`, `YYYY-MM`, `YYYY-Qn` all use `-`).
 */
export function rowKeyFor(periodKey: string, capturedAt: string): string {
  return `${periodKey}_${capturedAt}`;
}

function entityToListItem(e: ReportSnapshotEntity): ReportSnapshotListItem {
  return {
    periodKey: e.PeriodKey,
    cadence: e.Cadence,
    version: e.Version,
    capturedAt: e.CapturedAt,
    capturedBy: e.CapturedBy,
    contentType: e.ContentType,
    envelopeBytes: e.EnvelopeBytes,
    periodStart: e.PeriodStart,
    periodEnd: e.PeriodEnd,
  };
}

/**
 * Load all versions for a (tenantId, periodKey) in chronological order
 * (oldest → newest). Used to compute the next version number under a
 * lease-protected capture and to drive trim.
 */
export async function listVersionsForPeriod(
  table: TableClient,
  tenantId: string,
  periodKey: string,
): Promise<readonly ReportSnapshotEntity[]> {
  const prefix = `${periodKey}_`;
  // RowKey is `<periodKey>_<capturedAt>`. Tables OData has no startsWith;
  // emulate via half-open range. `~` is greater than every printable ASCII
  // char and never legitimately appears in our RowKey alphabet.
  const high = `${prefix}~`;
  const out: ReportSnapshotEntity[] = [];
  for await (const e of table.listEntities<ReportSnapshotEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId} and RowKey ge ${prefix} and RowKey lt ${high}`,
    },
  })) {
    out.push(e);
  }
  // Tables enumeration order is RowKey-asc per partition for filtered
  // queries; sort defensively so the contract is invariant.
  out.sort((a, b) => (a.rowKey < b.rowKey ? -1 : 1));
  return out;
}

/**
 * Insert a new versioned snapshot row. Caller has already determined the
 * version number (typically `existing.length + 1`) and computed the encoded
 * envelope. Returns the inserted entity for downstream audit-line emission.
 *
 * No conditional create — unique RowKey via capturedAt. Concurrent captures
 * with the same `capturedAt` (millisecond resolution) collide; the lease
 * semantics on IngestHealth[report.snapshot] serialise capture so this is
 * a non-issue under normal operation.
 */
export async function insertSnapshot(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly envelope: ReportSnapshotEnvelope;
    readonly encoded: { readonly column: string; readonly compressedBytes: number; readonly preCompressionBytes: number };
  },
): Promise<void> {
  const { tenantId, envelope, encoded } = args;
  const entity: ReportSnapshotEntity = {
    partitionKey: tenantId,
    rowKey: rowKeyFor(envelope.periodKey, envelope.capturedAt),
    SchemaVersion: envelope.schemaVersion,
    ContentType: envelope.contentType,
    Cadence: envelope.periodCadence,
    PeriodKey: envelope.periodKey,
    PeriodStart: envelope.periodStart,
    PeriodEnd: envelope.periodEnd,
    CapturedAt: envelope.capturedAt,
    CapturedBy: envelope.capturedBy,
    Version: envelope.version,
    Envelope: encoded.column,
    EnvelopeBytes: encoded.preCompressionBytes,
  };
  await table.createEntity(entity);
}

/**
 * Trim oldest versions when a (tenantId, periodKey) exceeds the
 * versions-per-period cap. Returns the deleted rows so callers can emit one
 * `audit.report.trim` line per deletion.
 *
 * The minimum cap of 3 is enforced at config-load time (ConfigError);
 * passing < 3 here is treated as a programmer error and throws.
 */
export async function trimVersionsForPeriod(
  table: TableClient,
  tenantId: string,
  periodKey: string,
  versionsPerPeriod: number,
): Promise<readonly ReportSnapshotEntity[]> {
  if (versionsPerPeriod < MIN_VERSIONS_PER_PERIOD) {
    throw new Error(
      `trimVersionsForPeriod: versionsPerPeriod=${versionsPerPeriod} below floor (${MIN_VERSIONS_PER_PERIOD})`,
    );
  }
  const all = await listVersionsForPeriod(table, tenantId, periodKey);
  if (all.length <= versionsPerPeriod) return [];
  const toDelete = all.slice(0, all.length - versionsPerPeriod); // oldest first
  for (const e of toDelete) {
    try {
      await table.deleteEntity(e.partitionKey, e.rowKey);
    } catch (err) {
      // 404 means another concurrent trim already deleted the row — fine.
      if (err instanceof RestError && err.statusCode === 404) continue;
      throw err;
    }
  }
  return toDelete;
}

/**
 * Get the latest version of a snapshot for a period. Returns null if no
 * snapshots exist. Decoding happens here so callers receive the parsed
 * envelope.
 */
export async function readLatestSnapshot(
  table: TableClient,
  tenantId: string,
  periodKey: string,
): Promise<ReportSnapshotEnvelope | null> {
  const all = await listVersionsForPeriod(table, tenantId, periodKey);
  if (all.length === 0) return null;
  const latest = all[all.length - 1] as ReportSnapshotEntity;
  return decodeEnvelope(latest.Envelope);
}

/** Get a specific version. Returns null if absent. */
export async function readVersion(
  table: TableClient,
  tenantId: string,
  periodKey: string,
  version: number,
): Promise<ReportSnapshotEnvelope | null> {
  const all = await listVersionsForPeriod(table, tenantId, periodKey);
  const match = all.find((e) => e.Version === version);
  return match ? decodeEnvelope(match.Envelope) : null;
}

/**
 * List recent snapshots across periods. Used by the SPA's "Recent reports"
 * sidebar. Filters by cadence so weekly / monthly / quarterly views don't
 * inter-mix; cap at `limit` after sorting (newest first by capturedAt).
 *
 * Walks the entire partition; acceptable because snapshots are small in
 * count (versions × periods per cadence) and Table partition scans within
 * a single tenantId are fast at this volume.
 */
export async function listRecentSnapshots(
  table: TableClient,
  tenantId: string,
  cadence: ReportCadence,
  limit: number,
): Promise<readonly ReportSnapshotListItem[]> {
  const out: ReportSnapshotEntity[] = [];
  for await (const e of table.listEntities<ReportSnapshotEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId} and Cadence eq ${cadence}`,
    },
  })) {
    out.push(e);
  }
  out.sort((a, b) => (a.CapturedAt < b.CapturedAt ? 1 : -1)); // newest first
  return out.slice(0, Math.max(0, limit)).map(entityToListItem);
}
