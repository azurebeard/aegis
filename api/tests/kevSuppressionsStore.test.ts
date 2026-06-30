// ADR-0033 — store helpers (effective-status resolver + RowKey shape).

import { describe, expect, it, vi } from "vitest";
import { RestError, type TableClient } from "@azure/data-tables";
import {
  indexSuppressions,
  resolveEffective,
  suppressionRowKey,
  sweepExpiredSuppressions,
  type KevSuppressionRow,
} from "../src/lib/kevSuppressionsStore.js";

const ITEM_ID = "550e8400-e29b-41d4-a716-446655440000";
const CVE_ID = "CVE-2024-12345";

function row(overrides: Partial<KevSuppressionRow> = {}): KevSuppressionRow {
  return {
    stackItemId: ITEM_ID,
    cveID: CVE_ID,
    status: "acknowledged",
    notes: "",
    expiresAt: "",
    updatedAt: "2026-04-28T10:00:00.000Z",
    updatedBy: "admin-oid",
    ...overrides,
  };
}

describe("suppressionRowKey", () => {
  it("composes stable underscore-separated key", () => {
    expect(suppressionRowKey(ITEM_ID, CVE_ID)).toBe(`${ITEM_ID}_${CVE_ID}`);
  });
});

describe("resolveEffective", () => {
  it("returns the default `open` shape when no row exists", () => {
    const map = indexSuppressions([]);
    const eff = resolveEffective(map, ITEM_ID, CVE_ID);
    expect(eff.status).toBe("open");
    expect(eff.notes).toBeNull();
    expect(eff.expiresAt).toBeNull();
    expect(eff.updatedAt).toBeNull();
    expect(eff.updatedBy).toBeNull();
  });

  it("returns the stored row when present + not expired", () => {
    const map = indexSuppressions([row({ status: "remediated", notes: "patched" })]);
    const eff = resolveEffective(map, ITEM_ID, CVE_ID);
    expect(eff.status).toBe("remediated");
    expect(eff.notes).toBe("patched");
  });

  it("returns null fields when stored row has empty strings", () => {
    const map = indexSuppressions([row({ status: "remediated", notes: "" })]);
    const eff = resolveEffective(map, ITEM_ID, CVE_ID);
    expect(eff.status).toBe("remediated");
    expect(eff.notes).toBeNull();
    expect(eff.expiresAt).toBeNull();
  });

  it("reverts to `open` when row's expiresAt is in the past", () => {
    const map = indexSuppressions([
      row({ status: "acknowledged", expiresAt: "2020-01-01T00:00:00Z" }),
    ]);
    const eff = resolveEffective(map, ITEM_ID, CVE_ID, new Date("2026-04-28T00:00:00Z"));
    expect(eff.status).toBe("open");
    expect(eff.expiresAt).toBeNull();
  });

  it("preserves stored status when expiresAt is in the future", () => {
    const map = indexSuppressions([
      row({ status: "acknowledged", expiresAt: "2099-12-31T00:00:00Z" }),
    ]);
    const eff = resolveEffective(map, ITEM_ID, CVE_ID, new Date("2026-04-28T00:00:00Z"));
    expect(eff.status).toBe("acknowledged");
    expect(eff.expiresAt).toBe("2099-12-31T00:00:00Z");
  });

  it("treats malformed expiresAt as no-expiry (preserves stored status)", () => {
    const map = indexSuppressions([
      row({ status: "risk_accepted", expiresAt: "not-a-date" }),
    ]);
    const eff = resolveEffective(map, ITEM_ID, CVE_ID);
    expect(eff.status).toBe("risk_accepted");
  });
});

// --- ADR-0033 §5 Phase 2.5 — expiry sweeper -------------------------------

const TENANT = "tenant-uuid";

interface FakeEntity {
  partitionKey: string;
  rowKey: string;
  Status: string;
  Notes: string;
  ExpiresAt: string;
  UpdatedAt: string;
  UpdatedBy: string;
}

function fakeSuppressionsTable(entities: FakeEntity[]): {
  table: TableClient;
  deleted: Array<{ partitionKey: string; rowKey: string }>;
  deleteEntity: ReturnType<typeof vi.fn>;
} {
  const deleted: Array<{ partitionKey: string; rowKey: string }> = [];
  const deleteEntity = vi.fn(async (pk: string, rk: string) => {
    deleted.push({ partitionKey: pk, rowKey: rk });
    const idx = entities.findIndex((e) => e.partitionKey === pk && e.rowKey === rk);
    if (idx === -1) {
      throw new RestError("not found", { statusCode: 404 });
    }
    entities.splice(idx, 1);
  });
  const table = {
    listEntities: () => ({
      [Symbol.asyncIterator]: async function* () {
        // Snapshot — iteration shouldn't observe the in-loop deletes
        // (real Table Storage gives a consistent snapshot per page).
        for (const e of [...entities]) yield e;
      },
    }),
    deleteEntity,
  } as unknown as TableClient;
  return { table, deleted, deleteEntity };
}

function ent(overrides: Partial<FakeEntity> = {}): FakeEntity {
  return {
    partitionKey: TENANT,
    rowKey: `${ITEM_ID}_CVE-2024-DEFAULT`,
    Status: "acknowledged",
    Notes: "",
    ExpiresAt: "",
    UpdatedAt: "2026-04-01T00:00:00Z",
    UpdatedBy: "admin",
    ...overrides,
  };
}

describe("sweepExpiredSuppressions", () => {
  const NOW = new Date("2026-04-29T12:00:00Z");

  it("deletes rows with ExpiresAt strictly before now", async () => {
    const entities: FakeEntity[] = [
      ent({ rowKey: "k_CVE-EXPIRED", ExpiresAt: "2026-04-01T00:00:00Z" }),
      ent({ rowKey: "k_CVE-FUTURE", ExpiresAt: "2099-12-31T00:00:00Z" }),
    ];
    const { table, deleted } = fakeSuppressionsTable(entities);
    const r = await sweepExpiredSuppressions(table, TENANT, NOW);
    expect(r.scanned).toBe(2);
    expect(r.deleted).toBe(1);
    expect(deleted.length).toBe(1);
    expect(deleted[0]!.rowKey).toBe("k_CVE-EXPIRED");
  });

  it("deletes rows with ExpiresAt exactly equal to now (boundary inclusive)", async () => {
    const entities: FakeEntity[] = [
      ent({ rowKey: "k_CVE-AT-NOW", ExpiresAt: NOW.toISOString() }),
    ];
    const { table } = fakeSuppressionsTable(entities);
    const r = await sweepExpiredSuppressions(table, TENANT, NOW);
    expect(r.deleted).toBe(1);
  });

  it("skips rows with empty ExpiresAt (no expiry → never sweep)", async () => {
    const entities: FakeEntity[] = [
      ent({ rowKey: "k_CVE-NEVER", ExpiresAt: "" }),
      ent({ rowKey: "k_CVE-OLDISH", ExpiresAt: "2024-01-01T00:00:00Z" }),
    ];
    const { table, deleted } = fakeSuppressionsTable(entities);
    const r = await sweepExpiredSuppressions(table, TENANT, NOW);
    expect(r.scanned).toBe(2);
    expect(r.deleted).toBe(1);
    expect(deleted[0]!.rowKey).toBe("k_CVE-OLDISH");
  });

  it("skips rows with malformed ExpiresAt (read-time resolver mirrors this)", async () => {
    const entities: FakeEntity[] = [
      ent({ rowKey: "k_CVE-GARBAGE", ExpiresAt: "not-a-date" }),
    ];
    const { table } = fakeSuppressionsTable(entities);
    const r = await sweepExpiredSuppressions(table, TENANT, NOW);
    expect(r.scanned).toBe(1);
    expect(r.deleted).toBe(0);
  });

  it("treats a 404 from deleteEntity as already-swept (concurrent admin DELETE)", async () => {
    const entities: FakeEntity[] = [
      ent({ rowKey: "k_CVE-RACE", ExpiresAt: "2026-01-01T00:00:00Z" }),
    ];
    const { table, deleteEntity } = fakeSuppressionsTable(entities);
    // Override to always throw 404 so we exercise the swallow branch.
    (deleteEntity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RestError("not found", { statusCode: 404 }),
    );
    const r = await sweepExpiredSuppressions(table, TENANT, NOW);
    expect(r.scanned).toBe(1);
    // Even though the row matched the predicate, the 404 short-circuits
    // the increment — operator complaint protection.
    expect(r.deleted).toBe(0);
  });

  it("rethrows non-404 backend errors so the timer surfaces them", async () => {
    const entities: FakeEntity[] = [
      ent({ rowKey: "k_CVE-503", ExpiresAt: "2026-01-01T00:00:00Z" }),
    ];
    const { table, deleteEntity } = fakeSuppressionsTable(entities);
    (deleteEntity as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new RestError("server busy", { statusCode: 503 }),
    );
    await expect(sweepExpiredSuppressions(table, TENANT, NOW)).rejects.toThrow(
      "server busy",
    );
  });

  it("returns zero counts on an empty partition", async () => {
    const { table } = fakeSuppressionsTable([]);
    const r = await sweepExpiredSuppressions(table, TENANT, NOW);
    expect(r.scanned).toBe(0);
    expect(r.deleted).toBe(0);
  });
});
