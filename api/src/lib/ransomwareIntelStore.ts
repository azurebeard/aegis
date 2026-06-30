// ADR-0037 — RansomwareIntel Table accessor.
//
// Single Table, two RowKey families on one PartitionKey per tenant:
//   - `victim.<base64url(post_title@group_name)>` — leak-site disclosures
//     from /victims/?country=&year=&month=
//   - `press.<sha256(url)>`                       — cyberattack press
//     coverage from /press/all?country=&year=&month=
//
// PartitionKey = tenantId (mirrors per-tenant pattern from Incidents /
// EntraRisk / SignIns). 90d retention default (env-aware sentinel-0;
// 14d dev). RowKey is content-derived so upserts naturally dedupe when
// the same row reappears across overlapping monthly fetches.
//
// Per ADR-0037 §5 — NO agent-plane consumption in v1. This store
// surfaces data to dashboard tiles + drilldown only. Plain-text-only
// rendering invariant: all text fields are surfaced via React's default
// escape; no `dangerouslySetInnerHTML` callsite consumes any field.

import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import { createHash } from "node:crypto";
import { OPS_TABLES } from "./tables.js";

export const RANSOMWARE_INTEL_TABLE_NAME = OPS_TABLES.RansomwareIntel;

// ─── Domain types ───────────────────────────────────────────────────────────

export interface RansomwareVictim {
  /** Stable identifier — base64url(post_title@group_name) per
   *  ransomware.live's API contract. Use this as a deduplication key. */
  readonly id: string;
  readonly victim: string;
  readonly group: string;
  /** ISO 8601 date string when the attack is believed to have happened
   *  (per the source). May be null when ransomware.live cannot infer one. */
  readonly attackDate: string | null;
  /** ISO 8601 date when ransomware.live first observed the leak-site
   *  post. Used as the chronological anchor in the drilldown. */
  readonly discoveredDate: string | null;
  /** ISO 3166-1 alpha-2 country code. May be empty when unknown. */
  readonly country: string;
  /** Free-text sector (e.g. "Healthcare", "Manufacturing"). May be empty. */
  readonly sector: string;
  /** Free-text "activity" field surfaced by ransomware.live — narrative
   *  description supplied by the group. Adversarial-input class data —
   *  rendered plain-text-only at the UI layer (ADR-0037 §"Privacy"). */
  readonly activity: string;
  readonly website: string;
  /** ransomware.live permalink to the source's post detail page. */
  readonly permalink: string;
  /** ISO 8601 timestamp of the row's most-recent ingest fetch. Updated
   *  on every fetch; used as the retention-trim cutoff anchor. */
  readonly ingestedAt: string;
}

export interface RansomwarePress {
  /** Stable identifier — sha256 hex of the URL. */
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly source: string;
  readonly country: string;
  /** HudsonRock-enriched summary (per ransomware.live's /press/all
   *  endpoint). Adversarial-input class data — plain-text-only at UI. */
  readonly summary: string;
  readonly ingestedAt: string;
}

/** Tagged union for the drilldown blend — sorted by chronological anchor
 *  client-side. Kind discriminator lets the SPA render victim vs press
 *  rows in their respective columns without re-fetching. */
export type RansomwareIntelRow =
  | (RansomwareVictim & { readonly kind: "victim" })
  | (RansomwarePress & { readonly kind: "press" });

// ─── Storage entity ─────────────────────────────────────────────────────────

/** Single Table entity shape — flat property bag with a `Kind`
 *  discriminator plus all possible fields. Both row families share
 *  `Country` + `IngestedAt`; everything else is per-family. Unused
 *  fields are stored as empty strings (Tables doesn't have nullable
 *  type; reading back as `??""` matches the existing signInsStore
 *  pattern). */
export interface RansomwareIntelEntity extends TableEntity {
  readonly Kind: "victim" | "press";
  readonly Country: string;
  readonly IngestedAt: string;
  // Victim-specific (empty string on press rows)
  readonly Victim: string;
  readonly Group: string;
  readonly AttackDate: string;
  readonly DiscoveredDate: string;
  readonly Sector: string;
  readonly Activity: string;
  readonly Website: string;
  readonly Permalink: string;
  // Press-specific (empty string on victim rows)
  readonly Title: string;
  readonly Url: string;
  readonly PublishedAt: string;
  readonly Source: string;
  readonly Summary: string;
}

// ─── RowKey helpers ─────────────────────────────────────────────────────────

const VICTIM_PREFIX = "victim.";
const PRESS_PREFIX = "press.";

// Table Storage RowKey allows alphanumerics + dot/underscore/hyphen but
// NOT plus/slash/equals (standard base64 chars that need conversion).
const ROW_KEY_RE = /^[A-Za-z0-9._-]{1,256}$/;

/** Convert standard base64 (potentially with `+`, `/`, `=`) to base64url
 *  (uses `-`, `_`, drops padding). Pure transform — no decode/encode
 *  cycle. Input that is already base64url is preserved verbatim. */
function toBase64Url(input: string): string {
  return input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compute the storage RowKey for a victim row. Accepts the
 *  ransomware.live API's `id` field (standard base64 of
 *  `post_title@group_name`) and normalises to a Table-Storage-safe
 *  RowKey. Throws if the resulting key violates the character set
 *  (e.g. caller passed a non-base64 string). */
export function victimRowKey(apiId: string): string {
  if (typeof apiId !== "string" || apiId.length === 0) {
    throw new Error("ransomwareIntelStore: victim id rejected (empty or non-string; out of pattern)");
  }
  const safe = toBase64Url(apiId);
  if (safe.length === 0) {
    // toBase64Url stripped everything (all padding); not a usable RowKey.
    throw new Error("ransomwareIntelStore: victim id rejected (out of pattern after base64url normalisation): empty result");
  }
  const rowKey = `${VICTIM_PREFIX}${safe}`;
  if (!ROW_KEY_RE.test(rowKey)) {
    throw new Error(
      `ransomwareIntelStore: victim id rejected (out of pattern after base64url normalisation): ${apiId.slice(0, 64)}`,
    );
  }
  return rowKey;
}

/** Compute the storage RowKey for a press row. Hashes the URL with
 *  sha256 (hex-encoded) so the RowKey is content-derived + deterministic
 *  across overlapping monthly fetches. */
export function pressRowKey(url: string): string {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("ransomwareIntelStore: pressRowKey requires a non-empty url");
  }
  const hex = createHash("sha256").update(url, "utf8").digest("hex");
  return `${PRESS_PREFIX}${hex}`;
}

/** Inverse of {@link victimRowKey} — strips the prefix; returns the
 *  base64url'd id. Used by entity-to-domain conversion. */
function victimIdFromRowKey(rowKey: string): string {
  return rowKey.startsWith(VICTIM_PREFIX)
    ? rowKey.slice(VICTIM_PREFIX.length)
    : rowKey;
}

function pressIdFromRowKey(rowKey: string): string {
  return rowKey.startsWith(PRESS_PREFIX)
    ? rowKey.slice(PRESS_PREFIX.length)
    : rowKey;
}

// ─── Domain ↔ entity ────────────────────────────────────────────────────────

function victimToEntity(
  tenantId: string,
  row: RansomwareVictim,
): RansomwareIntelEntity {
  return {
    partitionKey: tenantId,
    rowKey: victimRowKey(row.id),
    Kind: "victim",
    Country: row.country,
    IngestedAt: row.ingestedAt,
    Victim: row.victim,
    Group: row.group,
    AttackDate: row.attackDate ?? "",
    DiscoveredDate: row.discoveredDate ?? "",
    Sector: row.sector,
    Activity: row.activity,
    Website: row.website,
    Permalink: row.permalink,
    Title: "",
    Url: "",
    PublishedAt: "",
    Source: "",
    Summary: "",
  };
}

function pressToEntity(
  tenantId: string,
  row: RansomwarePress,
): RansomwareIntelEntity {
  return {
    partitionKey: tenantId,
    rowKey: pressRowKey(row.url),
    Kind: "press",
    Country: row.country,
    IngestedAt: row.ingestedAt,
    Victim: "",
    Group: "",
    AttackDate: "",
    DiscoveredDate: "",
    Sector: "",
    Activity: "",
    Website: "",
    Permalink: "",
    Title: row.title,
    Url: row.url,
    PublishedAt: row.publishedAt ?? "",
    Source: row.source,
    Summary: row.summary,
  };
}

function entityToVictim(e: RansomwareIntelEntity): RansomwareVictim {
  return {
    id: victimIdFromRowKey(e.rowKey),
    victim: e.Victim ?? "",
    group: e.Group ?? "",
    attackDate: e.AttackDate ? e.AttackDate : null,
    discoveredDate: e.DiscoveredDate ? e.DiscoveredDate : null,
    country: e.Country ?? "",
    sector: e.Sector ?? "",
    activity: e.Activity ?? "",
    website: e.Website ?? "",
    permalink: e.Permalink ?? "",
    ingestedAt: e.IngestedAt,
  };
}

function entityToPress(e: RansomwareIntelEntity): RansomwarePress {
  return {
    id: pressIdFromRowKey(e.rowKey),
    title: e.Title ?? "",
    url: e.Url ?? "",
    publishedAt: e.PublishedAt ? e.PublishedAt : null,
    source: e.Source ?? "",
    country: e.Country ?? "",
    summary: e.Summary ?? "",
    ingestedAt: e.IngestedAt,
  };
}

function entityToRow(e: RansomwareIntelEntity): RansomwareIntelRow {
  if (e.Kind === "press") {
    return { kind: "press", ...entityToPress(e) };
  }
  return { kind: "victim", ...entityToVictim(e) };
}

// ─── Public surface ─────────────────────────────────────────────────────────

export async function upsertVictim(
  table: TableClient,
  tenantId: string,
  row: RansomwareVictim,
): Promise<void> {
  await table.upsertEntity(victimToEntity(tenantId, row), "Replace");
}

export async function upsertPress(
  table: TableClient,
  tenantId: string,
  row: RansomwarePress,
): Promise<void> {
  await table.upsertEntity(pressToEntity(tenantId, row), "Replace");
}

export interface RansomwareIntelListFilter {
  /** When set, only rows with `Country eq` the value (ISO 3166-1 alpha-2). */
  readonly country?: string;
  /** When set, only rows with `IngestedAt > since` (ISO). */
  readonly ingestedSince?: string;
}

/** List all victim rows for a tenant, optionally filtered. */
export async function listVictims(
  table: TableClient,
  tenantId: string,
  filter: RansomwareIntelListFilter = {},
): Promise<readonly RansomwareVictim[]> {
  const filterStr = buildListFilter(tenantId, "victim", filter);
  const out: RansomwareVictim[] = [];
  for await (const e of table.listEntities<RansomwareIntelEntity>({
    queryOptions: { filter: filterStr },
  })) {
    out.push(entityToVictim(e));
  }
  return out;
}

/** List all press rows for a tenant, optionally filtered. */
export async function listPress(
  table: TableClient,
  tenantId: string,
  filter: RansomwareIntelListFilter = {},
): Promise<readonly RansomwarePress[]> {
  const filterStr = buildListFilter(tenantId, "press", filter);
  const out: RansomwarePress[] = [];
  for await (const e of table.listEntities<RansomwareIntelEntity>({
    queryOptions: { filter: filterStr },
  })) {
    out.push(entityToPress(e));
  }
  return out;
}

/** Drilldown blend — every row across both families, optionally
 *  filtered. Sorts client-side by best-effort chronological anchor
 *  (DiscoveredDate for victims, PublishedAt for press, falling back
 *  to IngestedAt when those are absent), descending. */
export async function listAll(
  table: TableClient,
  tenantId: string,
  filter: RansomwareIntelListFilter = {},
): Promise<readonly RansomwareIntelRow[]> {
  const parts: string[] = [`PartitionKey eq '${tenantId.replace(/'/g, "''")}'`];
  if (filter.country) {
    parts.push(`Country eq '${filter.country.replace(/'/g, "''")}'`);
  }
  if (filter.ingestedSince) {
    parts.push(`IngestedAt gt '${filter.ingestedSince.replace(/'/g, "''")}'`);
  }
  const rows: RansomwareIntelRow[] = [];
  for await (const e of table.listEntities<RansomwareIntelEntity>({
    queryOptions: { filter: parts.join(" and ") },
  })) {
    rows.push(entityToRow(e));
  }
  return rows.sort((a, b) => chronoAnchor(b).localeCompare(chronoAnchor(a)));
}

function chronoAnchor(row: RansomwareIntelRow): string {
  if (row.kind === "victim") {
    return row.discoveredDate || row.attackDate || row.ingestedAt;
  }
  return row.publishedAt || row.ingestedAt;
}

function buildListFilter(
  tenantId: string,
  kind: "victim" | "press",
  filter: RansomwareIntelListFilter,
): string {
  const parts: string[] = [
    `PartitionKey eq '${tenantId.replace(/'/g, "''")}'`,
    `Kind eq '${kind}'`,
  ];
  if (filter.country) {
    parts.push(`Country eq '${filter.country.replace(/'/g, "''")}'`);
  }
  if (filter.ingestedSince) {
    parts.push(`IngestedAt gt '${filter.ingestedSince.replace(/'/g, "''")}'`);
  }
  return parts.join(" and ");
}

/** Trim rows older than `retentionDays`. Returns count deleted. Anchors
 *  on `IngestedAt` (per-row last-fetch timestamp) per ADR-0037 §7. 404s
 *  on delete are tolerated — concurrent retention runs are race-safe. */
export async function trimRansomwareIntelRetention(
  table: TableClient,
  tenantId: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  let deleted = 0;
  for await (const e of table.listEntities<RansomwareIntelEntity>({
    queryOptions: {
      filter: odata`PartitionKey eq ${tenantId} and IngestedAt lt ${cutoff}`,
    },
  })) {
    try {
      await table.deleteEntity(e.partitionKey, e.rowKey);
      deleted++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 404) throw err;
    }
  }
  return deleted;
}

// ─── Summary derivation ─────────────────────────────────────────────────────

export interface RansomwareIntelSummary {
  /** Victims observed in the current month (UTC), filtered by tenant's
   *  selected country at read time. */
  readonly victimsThisMonth: number;
  /** Press articles observed in the current month (UTC), same filter. */
  readonly pressThisMonth: number;
  /** Prior month's totals — used for the tile's "vs last month" delta. */
  readonly victimsPriorMonth: number;
  readonly pressPriorMonth: number;
  /** Most recent victim row (any month) — surfaced in the tile sub-line. */
  readonly mostRecentVictim: RansomwareVictim | null;
  /** Distinct group count for victims in the current month. */
  readonly distinctGroupsThisMonth: number;
}

/** Period bucket: `[year, month]` for the row's chronological anchor.
 *  Used to slice victims + press by current vs prior month. */
function rowPeriod(
  row: RansomwareIntelRow,
): { year: number; month: number } | null {
  const anchor = chronoAnchor(row);
  if (!anchor) return null;
  const m = /^(\d{4})-(\d{2})/.exec(anchor);
  if (!m || !m[1] || !m[2]) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

function periodEqual(
  a: { year: number; month: number },
  b: { year: number; month: number },
): boolean {
  return a.year === b.year && a.month === b.month;
}

function priorMonth(period: { year: number; month: number }): {
  year: number;
  month: number;
} {
  if (period.month === 1) {
    return { year: period.year - 1, month: 12 };
  }
  return { year: period.year, month: period.month - 1 };
}

export function computeRansomwareIntelSummary(
  rows: readonly RansomwareIntelRow[],
  now: Date = new Date(),
): RansomwareIntelSummary {
  const current = {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
  };
  const prev = priorMonth(current);
  let victimsThisMonth = 0;
  let pressThisMonth = 0;
  let victimsPriorMonth = 0;
  let pressPriorMonth = 0;
  let mostRecentVictim: RansomwareVictim | null = null;
  const groupsThisMonth = new Set<string>();
  for (const row of rows) {
    const period = rowPeriod(row);
    if (!period) continue;
    if (row.kind === "victim") {
      if (
        !mostRecentVictim ||
        chronoAnchor(row) > chronoAnchor({ kind: "victim", ...mostRecentVictim })
      ) {
        // Strip the `kind` discriminator — RansomwareVictim doesn't carry it.
        const { kind, ...victim } = row;
        void kind;
        mostRecentVictim = victim;
      }
      if (periodEqual(period, current)) {
        victimsThisMonth++;
        if (row.group) groupsThisMonth.add(row.group);
      } else if (periodEqual(period, prev)) {
        victimsPriorMonth++;
      }
    } else {
      if (periodEqual(period, current)) {
        pressThisMonth++;
      } else if (periodEqual(period, prev)) {
        pressPriorMonth++;
      }
    }
  }
  return {
    victimsThisMonth,
    pressThisMonth,
    victimsPriorMonth,
    pressPriorMonth,
    mostRecentVictim,
    distinctGroupsThisMonth: groupsThisMonth.size,
  };
}
