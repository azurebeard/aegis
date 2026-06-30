// ADR-0031 §3 — StackItems table accessor.
//
//   PartitionKey  = tenantId
//   RowKey        = UUID v4
//   Columns       = Vendor, Product, Version, Category, Environment,
//                   Notes, TagsJson, AddedAt, AddedBy, UpdatedAt, UpdatedBy
//
// Table Storage doesn't have an array column type, so `tags` is JSON-
// serialised into TagsJson (matches the EnabledServices precedent in
// tables.ts). All other fields are flat strings.

import { odata, RestError, type TableClient, type TableEntity } from "@azure/data-tables";
import { isCanonicalPair } from "./stackCatalog.js";

export const STACK_CATEGORIES = [
  "os",
  "application",
  "network-device",
  "library",
  "service",
  "other",
] as const;
export type StackCategory = (typeof STACK_CATEGORIES)[number];
const STACK_CATEGORY_SET = new Set<string>(STACK_CATEGORIES);

export const STACK_ENVIRONMENTS = [
  "production",
  "staging",
  "development",
  "unknown",
] as const;
export type StackEnvironment = (typeof STACK_ENVIRONMENTS)[number];
const STACK_ENVIRONMENT_SET = new Set<string>(STACK_ENVIRONMENTS);

export const STACK_BOUNDS = Object.freeze({
  vendor: { maxChars: 64 } as const,
  product: { maxChars: 64 } as const,
  version: { maxChars: 32 } as const,
  notes: { maxChars: 256 } as const,
  tags: { maxCount: 5, maxCharsEach: 24 } as const,
});

/** ADR-0031 §6 — hard cap on stack items per tenant. */
export const STACK_ITEMS_CAP = 100;

export function isValidStackCategory(value: unknown): value is StackCategory {
  return typeof value === "string" && STACK_CATEGORY_SET.has(value);
}

export function isValidStackEnvironment(value: unknown): value is StackEnvironment {
  return typeof value === "string" && STACK_ENVIRONMENT_SET.has(value);
}

export interface StackItem {
  readonly id: string;
  readonly vendor: string;
  readonly product: string;
  readonly version: string; // "" when absent
  readonly category: StackCategory;
  readonly environment: StackEnvironment;
  readonly notes: string; // "" when absent
  readonly tags: readonly string[]; // [] when absent
  readonly canonical: boolean; // computed against stackCatalog at read-time
  readonly addedAt: string;
  readonly addedBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

interface StackItemEntity extends TableEntity {
  readonly Vendor: string;
  readonly Product: string;
  readonly Version: string;
  readonly Category: string;
  readonly Environment: string;
  readonly Notes: string;
  readonly TagsJson: string;
  readonly AddedAt: string;
  readonly AddedBy: string;
  readonly UpdatedAt: string;
  readonly UpdatedBy: string;
}

export class StackItemsCapReachedError extends Error {
  readonly cap: number;
  constructor(cap: number) {
    super(`stack items cap reached (${cap})`);
    this.name = "StackItemsCapReachedError";
    this.cap = cap;
  }
}

function entityToItem(e: StackItemEntity): StackItem {
  const category: StackCategory = isValidStackCategory(e.Category) ? e.Category : "other";
  const environment: StackEnvironment = isValidStackEnvironment(e.Environment)
    ? e.Environment
    : "unknown";
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(e.TagsJson || "[]");
    if (Array.isArray(parsed)) {
      tags = parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    tags = [];
  }
  return {
    id: e.rowKey,
    vendor: e.Vendor,
    product: e.Product,
    version: e.Version ?? "",
    category,
    environment,
    notes: e.Notes ?? "",
    tags,
    canonical: isCanonicalPair(e.Vendor, e.Product),
    addedAt: e.AddedAt,
    addedBy: e.AddedBy,
    updatedAt: e.UpdatedAt,
    updatedBy: e.UpdatedBy,
  };
}

export interface ListFilter {
  readonly category?: StackCategory;
  readonly environment?: StackEnvironment;
}

/**
 * List every stack item for a tenant. Optional category / environment
 * filters apply server-side via odata. Returns items sorted by
 * `(vendor, product, version)` for deterministic UI ordering.
 */
export async function listStackItems(
  table: TableClient,
  tenantId: string,
  filter: ListFilter = {},
): Promise<readonly StackItem[]> {
  const filterClauses: string[] = [];
  // PartitionKey first via the odata tag; subsequent equality clauses
  // appended manually since we already have the OData-formatted prefix.
  let filterStr = odata`PartitionKey eq ${tenantId}`;
  if (filter.category) {
    filterStr += ` and Category eq '${filter.category.replace(/'/g, "''")}'`;
  }
  if (filter.environment) {
    filterStr += ` and Environment eq '${filter.environment.replace(/'/g, "''")}'`;
  }
  void filterClauses;
  const out: StackItem[] = [];
  for await (const e of table.listEntities<StackItemEntity>({
    queryOptions: { filter: filterStr },
  })) {
    out.push(entityToItem(e));
  }
  out.sort((a, b) => {
    const v = a.vendor.localeCompare(b.vendor);
    if (v !== 0) return v;
    const p = a.product.localeCompare(b.product);
    if (p !== 0) return p;
    return a.version.localeCompare(b.version);
  });
  return out;
}

/**
 * Count items (used for cap check at insert time). Cheap — partition
 * scan with PartitionKey-only filter plus a counter.
 */
export async function countStackItems(
  table: TableClient,
  tenantId: string,
): Promise<number> {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _e of table.listEntities<StackItemEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${tenantId}` },
  })) {
    n++;
  }
  return n;
}

export async function readStackItem(
  table: TableClient,
  tenantId: string,
  id: string,
): Promise<StackItem | null> {
  try {
    const e = await table.getEntity<StackItemEntity>(tenantId, id);
    return entityToItem(e);
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return null;
    throw err;
  }
}

export interface CreateStackItemArgs {
  readonly tenantId: string;
  readonly id: string; // caller-supplied UUID for stable RowKey
  readonly vendor: string;
  readonly product: string;
  readonly version: string;
  readonly category: StackCategory;
  readonly environment: StackEnvironment;
  readonly notes: string;
  readonly tags: readonly string[];
  readonly addedBy: string;
  readonly now: string;
}

/**
 * Insert a new stack item. Performs the cap check inline — if the
 * tenant already has STACK_ITEMS_CAP rows, throws StackItemsCapReachedError
 * BEFORE the create call so the count is authoritative against
 * concurrent reads. Two concurrent POST 100 + 100 requests can both
 * see "currently 99, 99 < cap, insert" — Table Storage's createEntity
 * will succeed for both, the cap can briefly overshoot by 1. Mitigation:
 * the cap is a soft ceiling, not a hard one; the next POST will fail.
 */
export async function createStackItem(
  table: TableClient,
  args: CreateStackItemArgs,
): Promise<StackItem> {
  const existing = await countStackItems(table, args.tenantId);
  if (existing >= STACK_ITEMS_CAP) {
    throw new StackItemsCapReachedError(STACK_ITEMS_CAP);
  }
  const entity: StackItemEntity = {
    partitionKey: args.tenantId,
    rowKey: args.id,
    Vendor: args.vendor,
    Product: args.product,
    Version: args.version,
    Category: args.category,
    Environment: args.environment,
    Notes: args.notes,
    TagsJson: JSON.stringify(args.tags),
    AddedAt: args.now,
    AddedBy: args.addedBy,
    UpdatedAt: args.now,
    UpdatedBy: args.addedBy,
  };
  await table.createEntity(entity);
  return {
    id: args.id,
    vendor: args.vendor,
    product: args.product,
    version: args.version,
    category: args.category,
    environment: args.environment,
    notes: args.notes,
    tags: [...args.tags],
    canonical: isCanonicalPair(args.vendor, args.product),
    addedAt: args.now,
    addedBy: args.addedBy,
    updatedAt: args.now,
    updatedBy: args.addedBy,
  };
}

export interface UpdateStackItemPatch {
  readonly vendor?: string;
  readonly product?: string;
  readonly version?: string;
  readonly category?: StackCategory;
  readonly environment?: StackEnvironment;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

/**
 * Partial update — read existing, merge patch, write back. Returns the
 * updated item. Throws when the row doesn't exist (caller surfaces 404).
 *
 * Read-then-write is intentionally non-leased — concurrent edits last-
 * write-wins. Stack inventory edits are rare enough that this is safe;
 * a future contention surface (multi-admin orgs) can add IfMatch later
 * without breaking the row shape.
 */
export async function updateStackItem(
  table: TableClient,
  args: {
    readonly tenantId: string;
    readonly id: string;
    readonly patch: UpdateStackItemPatch;
    readonly updatedBy: string;
    readonly now: string;
  },
): Promise<StackItem | null> {
  const existing = await readStackItem(table, args.tenantId, args.id);
  if (!existing) return null;
  const merged: StackItem = {
    ...existing,
    vendor: args.patch.vendor ?? existing.vendor,
    product: args.patch.product ?? existing.product,
    version: args.patch.version ?? existing.version,
    category: args.patch.category ?? existing.category,
    environment: args.patch.environment ?? existing.environment,
    notes: args.patch.notes ?? existing.notes,
    tags: args.patch.tags ?? existing.tags,
    updatedAt: args.now,
    updatedBy: args.updatedBy,
  };
  const entity: StackItemEntity = {
    partitionKey: args.tenantId,
    rowKey: args.id,
    Vendor: merged.vendor,
    Product: merged.product,
    Version: merged.version,
    Category: merged.category,
    Environment: merged.environment,
    Notes: merged.notes,
    TagsJson: JSON.stringify(merged.tags),
    AddedAt: existing.addedAt,
    AddedBy: existing.addedBy,
    UpdatedAt: args.now,
    UpdatedBy: args.updatedBy,
  };
  await table.updateEntity(entity, "Replace");
  return { ...merged, canonical: isCanonicalPair(merged.vendor, merged.product) };
}

/** Hard delete. Idempotent: 404 → "already gone" → caller returns 404. */
export async function deleteStackItem(
  table: TableClient,
  tenantId: string,
  id: string,
): Promise<boolean> {
  try {
    await table.deleteEntity(tenantId, id);
    return true;
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return false;
    throw err;
  }
}
