// ADR-0033 Phase 2.5 — bulk-acknowledge orchestrator tests.

import { describe, expect, it } from "vitest";
import { applyKevBaseline } from "../src/lib/kevBaseline.js";
import type { KevRow } from "../src/lib/kevStore.js";
import type { KevSuppressionRow } from "../src/lib/kevSuppressionsStore.js";
import type { StackItem } from "../src/lib/stackItemsStore.js";
import type { TableClient } from "@azure/data-tables";

const TENANT = "tenant-uuid";
const ITEM_A = "550e8400-e29b-41d4-a716-446655440001";
const ITEM_B = "550e8400-e29b-41d4-a716-446655440002";
const NOW = "2026-04-29T10:00:00.000Z";

function stackItem(overrides: Partial<StackItem> = {}): StackItem {
  return {
    id: ITEM_A,
    vendor: "Microsoft",
    product: "Windows Server 2022",
    version: "21H2",
    category: "os",
    environment: "production",
    notes: "",
    tags: [],
    canonical: true,
    addedAt: NOW,
    addedBy: "admin",
    updatedAt: NOW,
    updatedBy: "admin",
    ...overrides,
  };
}

function kevRow(overrides: Partial<KevRow> = {}): KevRow {
  return {
    cveID: "CVE-2024-00001",
    vendorProject: "Microsoft",
    product: "Windows Server 2022",
    vulnerabilityName: "Test",
    dateAdded: "2024-04-15",
    shortDescription: "",
    requiredAction: "",
    dueDate: "2024-05-06",
    knownRansomwareCampaignUse: "Unknown",
    notes: "",
    cwes: [],
    ingestedAt: NOW,
    lastSeenAt: NOW,
    removed: false,
    ingestRunId: "run-1",
    ...overrides,
  };
}

interface CapturedWrite {
  partitionKey: string;
  rowKey: string;
  Status: string;
  Notes: string;
  ExpiresAt: string;
  UpdatedAt: string;
  UpdatedBy: string;
}

function fakeSuppressionsTable(): {
  table: TableClient;
  writes: CapturedWrite[];
} {
  const writes: CapturedWrite[] = [];
  const table = {
    upsertEntity: async (entity: CapturedWrite) => {
      writes.push(entity);
    },
  } as unknown as TableClient;
  return { table, writes };
}

describe("applyKevBaseline", () => {
  it("acknowledges every match with dateAdded < baselineDate when no suppressions exist", async () => {
    const items = [stackItem()];
    const kev = [
      kevRow({ cveID: "CVE-2024-OLD-A", dateAdded: "2024-01-15" }),
      kevRow({ cveID: "CVE-2024-OLD-B", dateAdded: "2024-04-01" }),
    ];
    const { table, writes } = fakeSuppressionsTable();
    const result = await applyKevBaseline({
      tenantId: TENANT,
      baselineDate: "2026-04-29",
      stackItems: items,
      kevRows: kev,
      existingSuppressions: [],
      suppressionsTable: table,
      updatedBy: "admin",
      now: NOW,
    });
    expect(result.acknowledgedCount).toBe(2);
    expect(result.alreadyHandledCount).toBe(0);
    expect(result.afterBaselineCount).toBe(0);
    expect(result.totalMatches).toBe(2);
    expect(writes.length).toBe(2);
    for (const w of writes) {
      expect(w.partitionKey).toBe(TENANT);
      expect(w.Status).toBe("acknowledged");
      expect(w.Notes).toBe("Deployment baseline 2026-04-29");
      expect(w.UpdatedBy).toBe("admin");
      expect(w.UpdatedAt).toBe(NOW);
      expect(w.ExpiresAt).toBe("");
    }
  });

  it("skips matches with dateAdded >= baselineDate", async () => {
    const items = [stackItem()];
    const kev = [
      kevRow({ cveID: "CVE-2024-OLD", dateAdded: "2024-01-01" }),
      kevRow({ cveID: "CVE-2024-NEW", dateAdded: "2026-04-29" }), // == baselineDate
      kevRow({ cveID: "CVE-2024-FUTURE", dateAdded: "2026-05-01" }),
    ];
    const { table, writes } = fakeSuppressionsTable();
    const result = await applyKevBaseline({
      tenantId: TENANT,
      baselineDate: "2026-04-29",
      stackItems: items,
      kevRows: kev,
      existingSuppressions: [],
      suppressionsTable: table,
      updatedBy: "admin",
      now: NOW,
    });
    expect(result.acknowledgedCount).toBe(1);
    expect(result.afterBaselineCount).toBe(2);
    expect(writes.length).toBe(1);
    expect(writes[0]!.rowKey.endsWith("CVE-2024-OLD")).toBe(true);
  });

  it("skips matches with empty dateAdded (cannot compare)", async () => {
    const items = [stackItem()];
    const kev = [kevRow({ cveID: "CVE-2024-NODATE", dateAdded: "" })];
    const { table, writes } = fakeSuppressionsTable();
    const result = await applyKevBaseline({
      tenantId: TENANT,
      baselineDate: "2026-04-29",
      stackItems: items,
      kevRows: kev,
      existingSuppressions: [],
      suppressionsTable: table,
      updatedBy: "admin",
      now: NOW,
    });
    expect(result.acknowledgedCount).toBe(0);
    expect(result.afterBaselineCount).toBe(1);
    expect(writes.length).toBe(0);
  });

  it("preserves operator decisions — skips matches with existing suppression rows", async () => {
    const items = [stackItem()];
    const kev = [
      kevRow({ cveID: "CVE-2024-OPEN", dateAdded: "2024-01-01" }),
      kevRow({ cveID: "CVE-2024-REMED", dateAdded: "2024-01-02" }),
      kevRow({ cveID: "CVE-2024-NA", dateAdded: "2024-01-03" }),
      kevRow({ cveID: "CVE-2024-FRESH", dateAdded: "2024-01-04" }),
    ];
    // Operator has touched three of the four — every status (including
    // `open`, which means they explicitly cleared a prior suppression)
    // should be preserved.
    const existing: KevSuppressionRow[] = [
      {
        stackItemId: ITEM_A,
        cveID: "CVE-2024-OPEN",
        status: "open",
        notes: "",
        expiresAt: "",
        updatedAt: NOW,
        updatedBy: "admin",
      },
      {
        stackItemId: ITEM_A,
        cveID: "CVE-2024-REMED",
        status: "remediated",
        notes: "patched",
        expiresAt: "",
        updatedAt: NOW,
        updatedBy: "admin",
      },
      {
        stackItemId: ITEM_A,
        cveID: "CVE-2024-NA",
        status: "not_applicable",
        notes: "wrong product",
        expiresAt: "",
        updatedAt: NOW,
        updatedBy: "admin",
      },
    ];
    const { table, writes } = fakeSuppressionsTable();
    const result = await applyKevBaseline({
      tenantId: TENANT,
      baselineDate: "2026-04-29",
      stackItems: items,
      kevRows: kev,
      existingSuppressions: existing,
      suppressionsTable: table,
      updatedBy: "admin",
      now: NOW,
    });
    expect(result.acknowledgedCount).toBe(1); // only CVE-2024-FRESH
    expect(result.alreadyHandledCount).toBe(3);
    expect(writes.length).toBe(1);
    expect(writes[0]!.rowKey.endsWith("CVE-2024-FRESH")).toBe(true);
  });

  it("is idempotent — second run on the same baseline writes nothing", async () => {
    const items = [stackItem()];
    const kev = [kevRow({ cveID: "CVE-2024-OLD", dateAdded: "2024-01-01" })];

    // First run: writes once.
    const t1 = fakeSuppressionsTable();
    const r1 = await applyKevBaseline({
      tenantId: TENANT,
      baselineDate: "2026-04-29",
      stackItems: items,
      kevRows: kev,
      existingSuppressions: [],
      suppressionsTable: t1.table,
      updatedBy: "admin",
      now: NOW,
    });
    expect(r1.acknowledgedCount).toBe(1);

    // Second run with the first run's output supplied as
    // `existingSuppressions`: writes nothing.
    const t2 = fakeSuppressionsTable();
    const r2 = await applyKevBaseline({
      tenantId: TENANT,
      baselineDate: "2026-04-29",
      stackItems: items,
      kevRows: kev,
      existingSuppressions: [
        {
          stackItemId: ITEM_A,
          cveID: "CVE-2024-OLD",
          status: "acknowledged",
          notes: "Deployment baseline 2026-04-29",
          expiresAt: "",
          updatedAt: NOW,
          updatedBy: "admin",
        },
      ],
      suppressionsTable: t2.table,
      updatedBy: "admin",
      now: NOW,
    });
    expect(r2.acknowledgedCount).toBe(0);
    expect(r2.alreadyHandledCount).toBe(1);
    expect(t2.writes.length).toBe(0);
  });

  it("walks every stack item, not just the first", async () => {
    const items = [
      stackItem({ id: ITEM_A, product: "Windows Server 2022" }),
      stackItem({ id: ITEM_B, product: "ESXi" , vendor: "VMware" }),
    ];
    const kev = [
      kevRow({ cveID: "CVE-W", dateAdded: "2024-01-01" }), // matches ITEM_A
      kevRow({
        cveID: "CVE-V",
        vendorProject: "VMware",
        product: "ESXi",
        dateAdded: "2024-01-02",
      }), // matches ITEM_B
    ];
    const { table, writes } = fakeSuppressionsTable();
    const result = await applyKevBaseline({
      tenantId: TENANT,
      baselineDate: "2026-04-29",
      stackItems: items,
      kevRows: kev,
      existingSuppressions: [],
      suppressionsTable: table,
      updatedBy: "admin",
      now: NOW,
    });
    expect(result.acknowledgedCount).toBe(2);
    expect(writes.length).toBe(2);
    const itemIdsTouched = new Set(writes.map((w) => w.rowKey.split("_")[0]));
    expect(itemIdsTouched.has(ITEM_A)).toBe(true);
    expect(itemIdsTouched.has(ITEM_B)).toBe(true);
  });

  it("returns zero counts on empty inputs", async () => {
    const { table, writes } = fakeSuppressionsTable();
    const result = await applyKevBaseline({
      tenantId: TENANT,
      baselineDate: "2026-04-29",
      stackItems: [],
      kevRows: [],
      existingSuppressions: [],
      suppressionsTable: table,
      updatedBy: "admin",
      now: NOW,
    });
    expect(result.acknowledgedCount).toBe(0);
    expect(result.alreadyHandledCount).toBe(0);
    expect(result.afterBaselineCount).toBe(0);
    expect(result.totalMatches).toBe(0);
    expect(writes.length).toBe(0);
  });
});
