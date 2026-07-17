// ADR-0030 Phase C §C.5.1 — Idempotency-Key replay cache store helpers.

import { describe, it, expect, vi } from "vitest";
import {
  readReportEmailIdempotency,
  upsertReportEmailIdempotency,
  REPORT_EMAIL_IDEMPOTENCY_ROW_PREFIX,
  REPORT_EMAIL_IDEMPOTENCY_TTL_MS,
} from "../src/lib/tenantSettingsStore.js";
import type { TableClient } from "@azure/data-tables";

function makeFakeTable(getEntityImpl?: (pk: string, rk: string) => Promise<unknown>) {
  return {
    getEntity:
      getEntityImpl ??
      vi.fn(async () => {
        const e = new Error("not found") as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      }),
    upsertEntity: vi.fn().mockResolvedValue({}),
  } as unknown as TableClient;
}

describe("readReportEmailIdempotency", () => {
  it("returns null when the row is absent (404)", async () => {
    const table = makeFakeTable();
    const r = await readReportEmailIdempotency(table, "tenant-x", "abc12345");
    expect(r).toBeNull();
  });

  it("returns the parsed response when within the 24h window", async () => {
    const cachedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + REPORT_EMAIL_IDEMPOTENCY_TTL_MS - 60_000).toISOString();
    const table = makeFakeTable(async () => ({
      partitionKey: "tenant-x",
      rowKey: `${REPORT_EMAIL_IDEMPOTENCY_ROW_PREFIX}abc12345`,
      SchemaVersion: 1,
      IdempotencyKey: "abc12345",
      PeriodKey: "2026-W19",
      ResponseBody: JSON.stringify({ status: "sent", graphMessageId: "AAMkAGI2" }),
      CachedAt: cachedAt,
      ExpiresAt: expiresAt,
    }));
    const r = await readReportEmailIdempotency(table, "tenant-x", "abc12345");
    expect(r).not.toBeNull();
    expect(r?.idempotencyKey).toBe("abc12345");
    expect(r?.periodKey).toBe("2026-W19");
    expect(r?.responseBody.status).toBe("sent");
    expect(r?.responseBody.graphMessageId).toBe("AAMkAGI2");
  });

  it("returns null when the row is past the TTL (stale)", async () => {
    const staleExpires = new Date(Date.now() - 1_000).toISOString();
    const table = makeFakeTable(async () => ({
      ExpiresAt: staleExpires,
      ResponseBody: JSON.stringify({ status: "sent" }),
      IdempotencyKey: "stale",
      PeriodKey: "x",
      CachedAt: staleExpires,
      SchemaVersion: 1,
    }));
    const r = await readReportEmailIdempotency(table, "tenant-x", "stale");
    expect(r).toBeNull();
  });

  it("returns null when ExpiresAt is unparseable", async () => {
    const table = makeFakeTable(async () => ({
      ExpiresAt: "not-a-date",
      ResponseBody: JSON.stringify({}),
      IdempotencyKey: "k",
      PeriodKey: "",
      CachedAt: "",
      SchemaVersion: 1,
    }));
    expect(await readReportEmailIdempotency(table, "tenant-x", "k")).toBeNull();
  });

  it("returns null on malformed ResponseBody JSON", async () => {
    const table = makeFakeTable(async () => ({
      ExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      ResponseBody: "{not json",
      IdempotencyKey: "k",
      PeriodKey: "",
      CachedAt: "",
      SchemaVersion: 1,
    }));
    expect(await readReportEmailIdempotency(table, "tenant-x", "k")).toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    const table = makeFakeTable(async () => {
      const e = new Error("server error") as Error & { statusCode: number };
      e.statusCode = 500;
      throw e;
    });
    await expect(
      readReportEmailIdempotency(table, "tenant-x", "k"),
    ).rejects.toThrow("server error");
  });
});

describe("upsertReportEmailIdempotency", () => {
  it("writes a row under the idempotency RowKey prefix with JSON-encoded response", async () => {
    const upsertEntity = vi.fn().mockResolvedValue({});
    const table = { upsertEntity } as unknown as TableClient;
    const now = Date.now();
    await upsertReportEmailIdempotency(table, "tenant-x", {
      idempotencyKey: "xyz",
      periodKey: "2026-W19",
      responseBody: { status: "sent", graphMessageId: "AAMkAGI2" },
      cachedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + REPORT_EMAIL_IDEMPOTENCY_TTL_MS).toISOString(),
    });
    expect(upsertEntity).toHaveBeenCalledTimes(1);
    const [entity, mode] = upsertEntity.mock.calls[0]!;
    expect(mode).toBe("Replace");
    expect(entity.rowKey).toBe(`${REPORT_EMAIL_IDEMPOTENCY_ROW_PREFIX}xyz`);
    expect(entity.partitionKey).toBe("tenant-x");
    expect(entity.SchemaVersion).toBe(1);
    expect(JSON.parse(entity.ResponseBody)).toEqual({
      status: "sent",
      graphMessageId: "AAMkAGI2",
    });
  });
});
