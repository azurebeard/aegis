import { describe, it, expect, vi } from "vitest";
import type { TableClient } from "@azure/data-tables";
import {
  readTenantDirectory,
  upsertTenantDirectory,
} from "../src/lib/tenantDirectoryStore.js";

const TENANT = "764279e8-66e9-49b4-901f-a7592435ae1d";

function mkTable(
  overrides: Partial<{
    getEntity: TableClient["getEntity"];
    upsertEntity: TableClient["upsertEntity"];
  }> = {},
): TableClient {
  return {
    getEntity: overrides.getEntity ?? vi.fn(),
    upsertEntity: overrides.upsertEntity ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as TableClient;
}

describe("upsertTenantDirectory", () => {
  it("writes a PK=tenantId, RK=directory entity with Replace semantics", async () => {
    const upsertEntity = vi.fn().mockResolvedValue(undefined);
    const table = mkTable({ upsertEntity });
    await upsertTenantDirectory(table, {
      tenantId: TENANT,
      displayName: "Picnic Dev",
      updatedAt: "2026-04-20T08:30:00.000Z",
    });
    expect(upsertEntity).toHaveBeenCalledTimes(1);
    const [entity, mode] = upsertEntity.mock.calls[0] as [
      { partitionKey: string; rowKey: string; DisplayName: string; UpdatedAt: string },
      string,
    ];
    expect(entity.partitionKey).toBe(TENANT);
    expect(entity.rowKey).toBe("directory");
    expect(entity.DisplayName).toBe("Picnic Dev");
    expect(entity.UpdatedAt).toBe("2026-04-20T08:30:00.000Z");
    expect(mode).toBe("Replace");
  });
});

describe("readTenantDirectory", () => {
  it("returns the row when present", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "directory",
      DisplayName: "Picnic Dev",
      UpdatedAt: "2026-04-20T08:30:00.000Z",
    });
    const table = mkTable({ getEntity });
    const got = await readTenantDirectory(table, TENANT);
    expect(got).toEqual({
      tenantId: TENANT,
      displayName: "Picnic Dev",
      updatedAt: "2026-04-20T08:30:00.000Z",
    });
  });

  it("returns null on 404 (no row yet)", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const table = mkTable({ getEntity });
    const got = await readTenantDirectory(table, TENANT);
    expect(got).toBeNull();
  });

  it("returns null when the row exists but DisplayName is empty", async () => {
    const getEntity = vi.fn().mockResolvedValue({
      partitionKey: TENANT,
      rowKey: "directory",
      DisplayName: "",
      UpdatedAt: "2026-04-20T08:30:00.000Z",
    });
    const table = mkTable({ getEntity });
    const got = await readTenantDirectory(table, TENANT);
    expect(got).toBeNull();
  });

  it("propagates non-404 errors", async () => {
    const getEntity = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const table = mkTable({ getEntity });
    await expect(readTenantDirectory(table, TENANT)).rejects.toThrow("forbidden");
  });
});
