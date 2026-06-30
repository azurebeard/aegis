// ADR-0030 Phase C — TenantSettings `report-email-config` reader + send-row writer.

import { describe, it, expect, vi } from "vitest";
import {
  readReportEmailConfig,
  upsertReportEmailSend,
  DEFAULT_REPORT_EMAIL_CONFIG,
  REPORT_EMAIL_SEND_ROW_PREFIX,
} from "../src/lib/tenantSettingsStore.js";
import type { TableClient } from "@azure/data-tables";

function fakeTable(getEntity: (pk: string, rk: string) => Promise<unknown>): TableClient {
  return { getEntity, createEntity: vi.fn().mockResolvedValue({}) } as unknown as TableClient;
}

describe("readReportEmailConfig", () => {
  it("returns the default (disabled, empty) record when the row is absent", async () => {
    const table = fakeTable(async () => {
      const e = new Error("not found") as Error & { statusCode: number };
      e.statusCode = 404;
      throw e;
    });
    const r = await readReportEmailConfig(table, "tenant-x");
    expect(r).toEqual(DEFAULT_REPORT_EMAIL_CONFIG);
    expect(r.enabled).toBe(false);
    expect(r.source).toBe("default");
  });

  it("parses a populated row faithfully", async () => {
    const table = fakeTable(async () => ({
      partitionKey: "tenant-x",
      rowKey: "report-email-config",
      Enabled: true,
      Recipients: JSON.stringify(["alice@x.com", "bob@x.com"]),
      AllowExternalRecipients: true,
      ExternalRecipientDomains: JSON.stringify(["partner.com"]),
      SubjectPrefix: "[Aegis]",
      UpdatedAt: "2026-05-10T12:00:00Z",
      UpdatedBy: "admin@x.com",
    }));
    const r = await readReportEmailConfig(table, "tenant-x");
    expect(r.enabled).toBe(true);
    expect(r.recipients).toEqual(["alice@x.com", "bob@x.com"]);
    expect(r.allowExternalRecipients).toBe(true);
    expect(r.externalRecipientDomains).toEqual(["partner.com"]);
    expect(r.subjectPrefix).toBe("[Aegis]");
    expect(r.source).toBe("tenant");
  });

  it("tolerates malformed JSON in Recipients (returns empty list, not throw)", async () => {
    const table = fakeTable(async () => ({
      Enabled: true,
      Recipients: "{not json",
      AllowExternalRecipients: false,
      ExternalRecipientDomains: "",
      SubjectPrefix: "",
      UpdatedAt: "",
      UpdatedBy: "",
    }));
    const r = await readReportEmailConfig(table, "tenant-x");
    expect(r.recipients).toEqual([]);
    expect(r.externalRecipientDomains).toEqual([]);
  });

  it("filters non-string array entries", async () => {
    const table = fakeTable(async () => ({
      Enabled: true,
      Recipients: JSON.stringify(["alice@x.com", 42, null, "bob@x.com"]),
      AllowExternalRecipients: false,
      ExternalRecipientDomains: JSON.stringify([]),
      SubjectPrefix: "",
      UpdatedAt: "",
      UpdatedBy: "",
    }));
    const r = await readReportEmailConfig(table, "tenant-x");
    expect(r.recipients).toEqual(["alice@x.com", "bob@x.com"]);
  });
});

describe("upsertReportEmailSend", () => {
  it("writes the row under the report-email-send: prefix with JSON-encoded recipients", async () => {
    const createEntity = vi.fn().mockResolvedValue({});
    const table = { createEntity } as unknown as TableClient;
    await upsertReportEmailSend(table, {
      tenantId: "tenant-x",
      periodKey: "2026-W19",
      graphMessageId: "AAMkAGI2-id",
      sentAt: "2026-05-12T09:00:00Z",
      senderMailbox: "noreply@x.com",
      recipients: ["alice@x.com", "bob@x.com"],
      operatorPrincipal: "admin@x.com",
      internetMessageId: "<m@x.com>",
      clientRequestId: "00000000-0000-0000-0000-000000000001",
      auditLineSeq: 88,
      auditLineSha256: "s".repeat(64),
    });
    expect(createEntity).toHaveBeenCalledTimes(1);
    const entity = createEntity.mock.calls[0]![0];
    expect(entity.partitionKey).toBe("tenant-x");
    expect(entity.rowKey).toBe(`${REPORT_EMAIL_SEND_ROW_PREFIX}AAMkAGI2-id`);
    expect(entity.SchemaVersion).toBe(1);
    expect(entity.Recipients).toBe(JSON.stringify(["alice@x.com", "bob@x.com"]));
    expect(entity.AuditLineSeq).toBe(88);
    expect(entity.AuditLineSha256).toBe("s".repeat(64));
  });
});
