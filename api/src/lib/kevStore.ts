// ADR-0032 §2 — KEV table accessor.
//
// Single global partition, RowKey = cveID. Reads + writes use the same
// table (no per-tenant fan-out). The forensic record per tenant lives
// on the audit chain via IngestHealth[<tenantId>][cisa.kev]; this table
// is a public-data cache.

import { odata, RestError, type TableClient, type TableEntity } from "@azure/data-tables";
import type { RawKevEntry } from "./kevFeedClient.js";
import {
  resolveEffective,
  type KevSuppressionRow,
} from "./kevSuppressionsStore.js";

export const KEV_PARTITION = "kev";

export interface KevRow {
  readonly cveID: string;
  readonly vendorProject: string;
  readonly product: string;
  readonly vulnerabilityName: string;
  readonly dateAdded: string;
  readonly shortDescription: string;
  readonly requiredAction: string;
  readonly dueDate: string;
  readonly knownRansomwareCampaignUse: "Known" | "Unknown";
  readonly notes: string;
  readonly cwes: readonly string[];
  readonly ingestedAt: string;
  readonly lastSeenAt: string;
  readonly removed: boolean;
  readonly ingestRunId: string;
}

interface KevEntity extends TableEntity {
  readonly VendorProject: string;
  readonly Product: string;
  readonly VulnerabilityName: string;
  readonly DateAdded: string;
  readonly ShortDescription: string;
  readonly RequiredAction: string;
  readonly DueDate: string;
  readonly KnownRansomwareCampaignUse: string;
  readonly Notes: string;
  readonly CwesJson: string;
  readonly IngestedAt: string;
  readonly LastSeenAt: string;
  readonly Removed: boolean;
  readonly IngestRunId: string;
}

function entityToRow(e: KevEntity): KevRow {
  let cwes: string[] = [];
  try {
    const parsed = JSON.parse(e.CwesJson || "[]");
    if (Array.isArray(parsed)) {
      cwes = parsed.filter((c): c is string => typeof c === "string");
    }
  } catch {
    cwes = [];
  }
  return {
    cveID: e.rowKey,
    vendorProject: e.VendorProject ?? "",
    product: e.Product ?? "",
    vulnerabilityName: e.VulnerabilityName ?? "",
    dateAdded: e.DateAdded ?? "",
    shortDescription: e.ShortDescription ?? "",
    requiredAction: e.RequiredAction ?? "",
    dueDate: e.DueDate ?? "",
    knownRansomwareCampaignUse:
      e.KnownRansomwareCampaignUse === "Known" ? "Known" : "Unknown",
    notes: e.Notes ?? "",
    cwes,
    ingestedAt: e.IngestedAt ?? "",
    lastSeenAt: e.LastSeenAt ?? "",
    removed: e.Removed === true,
    ingestRunId: e.IngestRunId ?? "",
  };
}

/** List the entire KEV catalog. Used by the read-time match in
 *  GET /api/stack/items + the summary endpoint. Cap is set on the caller
 *  side (~1100 entries today; 50K hard ceiling at the parser). */
export async function listKevRows(table: TableClient): Promise<readonly KevRow[]> {
  const out: KevRow[] = [];
  for await (const e of table.listEntities<KevEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${KEV_PARTITION}` },
  })) {
    out.push(entityToRow(e));
  }
  return out;
}

/** Get a single CVE by ID. Returns null on 404. */
export async function readKevRow(
  table: TableClient,
  cveID: string,
): Promise<KevRow | null> {
  try {
    const e = await table.getEntity<KevEntity>(KEV_PARTITION, cveID);
    return entityToRow(e);
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return null;
    throw err;
  }
}

export interface UpsertSummary {
  readonly addedCount: number;
  readonly updatedCount: number;
}

/**
 * Upsert each entry in the parsed feed. Returns counts so the audit
 * line can record `addedThisRun` accurately. `lastSeenAt` is set to
 * `now`; the sweeper sets `removed=true` on rows whose `lastSeenAt` is
 * older than `now`.
 */
export async function upsertKevEntries(
  table: TableClient,
  args: {
    readonly entries: readonly RawKevEntry[];
    readonly now: string;
    readonly ingestRunId: string;
  },
): Promise<UpsertSummary> {
  let added = 0;
  let updated = 0;
  for (const e of args.entries) {
    // Existence check is the cheapest way to disambiguate added vs updated
    // for the audit line. At ~1100 entries × ~10ms per round-trip that's
    // ~11s per ingest run — fine for a daily Timer. If it ever bites we'd
    // switch to a "read all into a Set, diff, batch-write" strategy.
    const existing = await readKevRow(table, e.cveID);
    const entity: KevEntity = {
      partitionKey: KEV_PARTITION,
      rowKey: e.cveID,
      VendorProject: e.vendorProject,
      Product: e.product,
      VulnerabilityName: e.vulnerabilityName,
      DateAdded: e.dateAdded,
      ShortDescription: e.shortDescription,
      RequiredAction: e.requiredAction,
      DueDate: e.dueDate,
      KnownRansomwareCampaignUse: e.knownRansomwareCampaignUse,
      Notes: e.notes,
      CwesJson: JSON.stringify(e.cwes),
      IngestedAt: existing?.ingestedAt || args.now,
      LastSeenAt: args.now,
      Removed: false,
      IngestRunId: args.ingestRunId,
    };
    await table.upsertEntity(entity, "Replace");
    if (existing) updated++;
    else added++;
  }
  return { addedCount: added, updatedCount: updated };
}

/**
 * Sweep rows whose `LastSeenAt` is older than the current ingest run's
 * `startedAt` — these CVEs were missing from the latest feed. Mark
 * `Removed = true` (don't delete; ADR-0032 §4 forensic rule).
 *
 * Returns the number of rows newly marked removed.
 */
export async function sweepRemovedKevRows(
  table: TableClient,
  args: {
    readonly currentRunStartedAt: string;
    readonly now: string;
    readonly ingestRunId: string;
  },
): Promise<number> {
  let marked = 0;
  for await (const e of table.listEntities<KevEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${KEV_PARTITION}` },
  })) {
    if (e.Removed === true) continue;
    if ((e.LastSeenAt ?? "") >= args.currentRunStartedAt) continue;
    const updated: KevEntity = {
      ...e,
      Removed: true,
      IngestRunId: args.ingestRunId,
    };
    await table.updateEntity(updated, "Replace");
    marked++;
  }
  return marked;
}

// --- Read-time match against StackItems ----------------------------------

export interface CveMatchSummary {
  readonly cveID: string;
  readonly vendorProject: string;
  readonly product: string;
  readonly vulnerabilityName: string;
  readonly dateAdded: string;
  readonly dueDate: string;
  readonly knownRansomwareCampaignUse: "Known" | "Unknown";
  /** ADR-0032 §3 (revised) — CISA's `requiredAction` text. Length-capped
   *  at parse time (kevFeedClient.ts). Plain-text-only render (ADR-0012 §5).
   *  Surfaced on /kev so operators see the remediation prose without a
   *  round-trip to NVD. */
  readonly requiredAction: string;
  /** ADR-0033 — operator-set workflow state. Default `"open"` when no
   *  suppression row exists. Effective state honours expiry — an
   *  expired non-open row resolves to `"open"`. */
  readonly status: "open" | "acknowledged" | "risk_accepted" | "remediated" | "not_applicable";
  readonly notes: string | null;
  readonly expiresAt: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/**
 * Find KEV entries whose `(vendorProject, product)` matches a stack
 * item's `(vendor, product)`. Excludes rows where `Removed = true`.
 *
 * Vendor: case-insensitive exact match (after trim). Cross-vendor matches
 * are never wanted — KEV "Microsoft" must not match operator "Mandiant".
 *
 * Product: **bidirectional contiguous-token subphrase match** (case-
 * insensitive, after trim + whitespace-tokenise). Either one of the two
 * product strings must be a contiguous run of tokens within the other.
 * Examples:
 *   - "Windows 11"               ↔ "Windows"                    ✓
 *   - "VMware ESXi"              ↔ "ESXi"                       ✓
 *   - "Microsoft Defender for Endpoint" ↔ "Defender"            ✓
 *   - "Windows Server"           ↔ "Windows 11"                 ✗ (no overlap)
 *   - "Windows"                  ↔ "Window"                     ✗ (token, not substring)
 *
 * The operator's catalog (ADR-0031 §2) nudges them toward common short
 * forms ("Microsoft", "Apache") that line up with KEV's vendorProject
 * taxonomy; the contiguous-token rule then absorbs version / variant
 * differences on the product side without producing false positives
 * across unrelated vendors. Documented as the ADR-0032 "Phase B+ fuzzy
 * matching" follow-up; landed 2026-04-28 PM after a live trial-run
 * surfaced the exact-match miss rate.
 */
export function matchesForStackItem(
  kev: readonly KevRow[],
  stackItem: { readonly vendor: string; readonly product: string },
): readonly CveMatchSummary[] {
  const v = stackItem.vendor.trim().toLowerCase();
  const opTokens = tokenise(stackItem.product);
  if (opTokens.length === 0) return [];
  const out: CveMatchSummary[] = [];
  for (const k of kev) {
    if (k.removed) continue;
    if (k.vendorProject.trim().toLowerCase() !== v) continue;
    const kevTokens = tokenise(k.product);
    if (kevTokens.length === 0) continue;
    if (!productMatches(opTokens, kevTokens)) continue;
    out.push({
      cveID: k.cveID,
      vendorProject: k.vendorProject,
      product: k.product,
      vulnerabilityName: k.vulnerabilityName,
      dateAdded: k.dateAdded,
      dueDate: k.dueDate,
      knownRansomwareCampaignUse: k.knownRansomwareCampaignUse,
      requiredAction: k.requiredAction,
      // ADR-0033 default. Callers overlay actual status from
      // `KevSuppressions` via `applySuppressionsToMatches` below.
      status: "open",
      notes: null,
      expiresAt: null,
      updatedAt: null,
      updatedBy: null,
    });
  }
  return out;
}

/** Lowercase + whitespace-tokenise a product string. Drops empty tokens. */
function tokenise(s: string): readonly string[] {
  return s.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Bidirectional contiguous-token subphrase test. True iff one token
 * sequence is a contiguous run of the other. Both inputs assumed already
 * tokenised + lowercased. O(min(a, b) × |a - b|) — negligible at v1
 * scale (product strings are 1-5 tokens typically).
 */
export function productMatches(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return containsContiguous(a, b) || containsContiguous(b, a);
}

function containsContiguous(
  longer: readonly string[],
  shorter: readonly string[],
): boolean {
  if (shorter.length === 0 || shorter.length > longer.length) return false;
  outer: for (let i = 0; i <= longer.length - shorter.length; i++) {
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] !== shorter[j]) continue outer;
    }
    return true;
  }
  return false;
}

// --- ADR-0033 status overlay -----------------------------------------------

/**
 * Overlay per-(stackItemId, cveID) suppression status onto a list of
 * matches produced by `matchesForStackItem`. The default match shape
 * carries `status: "open"`; this function replaces those fields with
 * the operator-set workflow state from `KevSuppressions`, honouring
 * expiry via `resolveEffective`.
 *
 * Pure function — no I/O. Caller does the table read once per
 * `getStackItems` request and reuses the indexed map across all
 * (item, match) pairs.
 */
export function applySuppressionsToMatches(
  stackItemId: string,
  matches: readonly CveMatchSummary[],
  suppressionsByKey: ReadonlyMap<string, KevSuppressionRow>,
  now: Date = new Date(),
): readonly CveMatchSummary[] {
  return matches.map((m) => {
    const eff = resolveEffective(suppressionsByKey, stackItemId, m.cveID, now);
    return {
      ...m,
      status: eff.status,
      notes: eff.notes,
      expiresAt: eff.expiresAt,
      updatedAt: eff.updatedAt,
      updatedBy: eff.updatedBy,
    };
  });
}
