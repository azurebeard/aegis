// ADR-0030 Phase C §C.16 — list/get/delete send-history rows.

import { describe, it, expect, vi } from "vitest";
import {
  listReportEmailSends,
  readReportEmailSend,
  deleteReportEmailSend,
  REPORT_EMAIL_SEND_ROW_PREFIX,
  LIST_REPORT_EMAIL_SENDS_MAX_LIMIT,
} from "../src/lib/tenantSettingsStore.js";
import type { TableClient } from "@azure/data-tables";

// Mock listEntities to return a fixed array of entities, paginated as a
// single page. The store helper iterates with `for await`, so the mock
// returns an async iterable.
function makeListMock(entities: Array<Record<string, unknown>>): TableClient {
  return {
    listEntities: () => ({
      async *[Symbol.asyncIterator]() {
        for (const e of entities) yield e;
      },
    }),
    getEntity: vi.fn(),
    deleteEntity: vi.fn(),
    createEntity: vi.fn(),
    upsertEntity: vi.fn(),
  } as unknown as TableClient;
}

function makeRow(
  graphMessageId: string,
  sentAt: string,
  extras: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    partitionKey: "tenant-x",
    rowKey: `${REPORT_EMAIL_SEND_ROW_PREFIX}${graphMessageId}`,
    SchemaVersion: 1,
    PeriodKey: "2026-W19",
    SentAt: sentAt,
    SenderMailbox: "noreply@picnic-dev.co.uk",
    Recipients: JSON.stringify(["alice@picnic-dev.co.uk"]),
    OperatorPrincipal: "admin@picnic-dev.co.uk",
    InternetMessageId: `<${graphMessageId}@picnic-dev.co.uk>`,
    ClientRequestId: "00000000-0000-0000-0000-000000000001",
    AuditLineSeq: 1,
    AuditLineSha256: "x".repeat(64),
    ...extras,
  };
}

describe("listReportEmailSends", () => {
  it("returns items sorted by sentAt descending", async () => {
    const table = makeListMock([
      makeRow("A", "2026-05-12T09:00:00Z"),
      makeRow("B", "2026-05-13T09:00:00Z"),
      makeRow("C", "2026-05-11T09:00:00Z"),
    ]);
    const r = await listReportEmailSends(table, {
      tenantId: "tenant-x",
      limit: 10,
      continuationToken: null,
    });
    expect(r.items.map((i) => i.graphMessageId)).toEqual(["B", "A", "C"]);
    expect(r.continuationToken).toBeNull();
  });

  it("paginates via opaque continuationToken", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeRow(`row-${i}`, `2026-05-${10 + i}T09:00:00Z`),
    );
    const table = makeListMock(rows);
    const first = await listReportEmailSends(table, {
      tenantId: "tenant-x",
      limit: 2,
      continuationToken: null,
    });
    expect(first.items).toHaveLength(2);
    expect(first.continuationToken).not.toBeNull();
    expect(first.items[0]?.graphMessageId).toBe("row-4"); // newest first

    const second = await listReportEmailSends(table, {
      tenantId: "tenant-x",
      limit: 2,
      continuationToken: first.continuationToken,
    });
    expect(second.items).toHaveLength(2);
    expect(second.items[0]?.graphMessageId).toBe("row-2");

    const third = await listReportEmailSends(table, {
      tenantId: "tenant-x",
      limit: 2,
      continuationToken: second.continuationToken,
    });
    expect(third.items).toHaveLength(1);
    expect(third.items[0]?.graphMessageId).toBe("row-0");
    expect(third.continuationToken).toBeNull();
  });

  it("projects items — does NOT include the recipients[] array", async () => {
    const table = makeListMock([makeRow("A", "2026-05-12T09:00:00Z")]);
    const r = await listReportEmailSends(table, {
      tenantId: "tenant-x",
      limit: 10,
      continuationToken: null,
    });
    expect(r.items[0]).toMatchObject({ graphMessageId: "A", recipientCount: 1 });
    expect((r.items[0] as Record<string, unknown>).recipients).toBeUndefined();
  });

  it("caps limit at LIST_REPORT_EMAIL_SENDS_MAX_LIMIT", async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      makeRow(`row-${i}`, `2026-05-01T${String(i).padStart(2, "0")}:00:00Z`),
    );
    const table = makeListMock(rows);
    const r = await listReportEmailSends(table, {
      tenantId: "tenant-x",
      limit: 9999,
      continuationToken: null,
    });
    expect(r.items.length).toBe(LIST_REPORT_EMAIL_SENDS_MAX_LIMIT);
  });

  it("treats malformed continuationToken as offset=0 (no crash)", async () => {
    const table = makeListMock([makeRow("A", "2026-05-12T09:00:00Z")]);
    const r = await listReportEmailSends(table, {
      tenantId: "tenant-x",
      limit: 10,
      continuationToken: "not-base64-and-not-json",
    });
    expect(r.items).toHaveLength(1);
  });
});

describe("readReportEmailSend", () => {
  it("returns the full record including recipients[]", async () => {
    const table = {
      getEntity: vi.fn(async () => makeRow("A", "2026-05-12T09:00:00Z")),
    } as unknown as TableClient;
    const r = await readReportEmailSend(table, "tenant-x", "A");
    expect(r).not.toBeNull();
    expect(r?.graphMessageId).toBe("A");
    expect(r?.recipients).toEqual(["alice@picnic-dev.co.uk"]);
  });

  it("returns null when the row is absent (404)", async () => {
    const table = {
      getEntity: vi.fn(async () => {
        const e = new Error("not found") as Error & { statusCode: number };
        e.statusCode = 404;
        throw e;
      }),
    } as unknown as TableClient;
    expect(await readReportEmailSend(table, "tenant-x", "A")).toBeNull();
  });
});

describe("deleteReportEmailSend", () => {
  it("returns true when the row is deleted", async () => {
    const deleteEntity = vi.fn().mockResolvedValue({});
    const table = { deleteEntity } as unknown as TableClient;
    const r = await deleteReportEmailSend(table, "tenant-x", "A");
    expect(r).toBe(true);
    expect(deleteEntity).toHaveBeenCalledWith("tenant-x", `${REPORT_EMAIL_SEND_ROW_PREFIX}A`);
  });

  it("returns false when the row is already absent (idempotent)", async () => {
    const deleteEntity = vi.fn(async () => {
      const e = new Error("not found") as Error & { statusCode: number };
      e.statusCode = 404;
      throw e;
    });
    const table = { deleteEntity } as unknown as TableClient;
    expect(await deleteReportEmailSend(table, "tenant-x", "A")).toBe(false);
  });
});
