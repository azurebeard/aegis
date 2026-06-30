// ADR-0030 Phase C §C.17 — orchestrator unit tests with mocked Graph layer.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  sendReportSnapshotEmail,
  NotConfiguredError,
  BodyTooLargeError,
  RecipientDomainBlockedError,
  EmailSendError,
  AEGIS_CORRELATION_HEADER,
  type ReportEmailConfig,
  type SendReportEmailHooks,
  type IntentAuditEvent,
  type SentAuditEvent,
  type FailedAuditEvent,
  type SendHistoryRow,
} from "../src/lib/reportEmail.js";
import type { ReportSnapshotEnvelope } from "../src/lib/reportSnapshotStore.js";
import { GraphFetchError } from "../src/lib/graphClient.js";

// ─── graphClient mock ───────────────────────────────────────────────────────

const graphPostMock = vi.fn();

vi.mock("../src/lib/graphClient.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/graphClient.js")>(
      "../src/lib/graphClient.js",
    );
  return {
    ...actual,
    graphPostJsonWithRetry: (...args: unknown[]) => graphPostMock(...args),
  };
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeEnvelope(overrides: Partial<ReportSnapshotEnvelope> = {}): ReportSnapshotEnvelope {
  return {
    schemaVersion: 1,
    contentType: "application/json",
    tenantId: "tenant-guid-aaa",
    periodKey: "2026-W19",
    periodCadence: "weekly",
    periodStart: "2026-05-04",
    periodEnd: "2026-05-10",
    capturedAt: "2026-05-11T08:00:00.000Z",
    capturedBy: "captured-by-admin",
    version: 1,
    sections: {
      secureScore: { snapshot: { percentage: 72.3 } },
      incidents: { counts: { activeCount: 4 } },
      entraRisk: { counts: { riskyUsersTotal: 1 } },
      brief: null,
      posture: null,
      ingestHealth: null,
    },
    derived: {},
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ReportEmailConfig> = {}): ReportEmailConfig {
  return {
    senderMailbox: "noreply@picnic-dev.co.uk",
    recipients: ["alice@picnic-dev.co.uk"],
    allowExternalRecipients: false,
    externalRecipientDomains: [],
    subjectPrefix: "[Aegis]",
    productName: "Aegis",
    ...overrides,
  };
}

function makeHooks(): SendReportEmailHooks & {
  readonly intent: Mock;
  readonly sent: Mock;
  readonly failed: Mock;
  readonly history: Mock;
} {
  const intent = vi.fn().mockResolvedValue(undefined);
  const sent = vi.fn().mockResolvedValue(undefined);
  const failed = vi.fn().mockResolvedValue(undefined);
  const history = vi.fn().mockResolvedValue(undefined);
  return {
    intent,
    sent,
    failed,
    history,
    onIntent: intent,
    onSent: sent,
    onFailed: failed,
    onHistoryWrite: history,
  };
}

function makeContext() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    invocationId: "test-invocation",
    functionName: "test",
    extraInputs: { get: vi.fn(), set: vi.fn() },
    extraOutputs: { get: vi.fn(), set: vi.fn() },
    options: {},
    triggerMetadata: {},
  } as unknown as import("@azure/functions").InvocationContext;
}

function baseArgs(overrides: Partial<Parameters<typeof sendReportSnapshotEmail>[0]> = {}) {
  return {
    envelope: makeEnvelope(),
    config: makeConfig(),
    mailSenderMiClientId: "mi-client-id-aaa",
    operatorPrincipal: "admin@picnic-dev.co.uk",
    triggeredBy: "admin" as const,
    context: makeContext(),
    graphBaseUrl: "https://graph.microsoft.com/v1.0",
    leaseWindowMs: 60_000,
    hooks: makeHooks(),
    ...overrides,
  };
}

// Graph mock helpers — first call is the draft create (returns {id}); second
// call is the send-draft (returns null body / 202).
function mockHappyPath(draftId = "AAMkAGI2-fake-msg-id") {
  graphPostMock
    .mockResolvedValueOnce({
      data: { id: draftId },
      attempts: 1,
      finalHttpStatus: 201,
      retryEvents: [],
    })
    .mockResolvedValueOnce({
      data: null,
      attempts: 1,
      finalHttpStatus: 202,
      retryEvents: [],
    });
}

beforeEach(() => {
  graphPostMock.mockReset();
});

// ─── Inert detection ─────────────────────────────────────────────────────────

describe("sendReportSnapshotEmail — inert detection (§C.5.2)", () => {
  it("throws NotConfiguredError when mailSenderMiClientId is empty", async () => {
    const args = baseArgs({ mailSenderMiClientId: "" });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(graphPostMock).not.toHaveBeenCalled();
    expect(args.hooks.onIntent).not.toHaveBeenCalled();
  });

  it("throws NotConfiguredError when senderMailbox is empty", async () => {
    const args = baseArgs({ config: makeConfig({ senderMailbox: "" }) });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("throws NotConfiguredError when recipients is empty", async () => {
    const args = baseArgs({ config: makeConfig({ recipients: [] }) });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("throws NotConfiguredError when senderMailbox is malformed", async () => {
    const args = baseArgs({ config: makeConfig({ senderMailbox: "not-a-upn" }) });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

// ─── Recipient-domain validation ─────────────────────────────────────────────

describe("sendReportSnapshotEmail — recipient-domain validation (§C.1 LOW C.1)", () => {
  it("blocks an external recipient when allowExternalRecipients=false", async () => {
    const args = baseArgs({
      config: makeConfig({ recipients: ["external@other.com"] }),
    });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(
      RecipientDomainBlockedError,
    );
    expect(args.hooks.onIntent).not.toHaveBeenCalled();
    expect(graphPostMock).not.toHaveBeenCalled();
  });

  it("blocks an external recipient when allow=true but domain not in allowlist", async () => {
    const args = baseArgs({
      config: makeConfig({
        recipients: ["external@other.com"],
        allowExternalRecipients: true,
        externalRecipientDomains: ["different.com"],
      }),
    });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(
      RecipientDomainBlockedError,
    );
  });

  it("passes external recipient when domain is on the allowlist", async () => {
    mockHappyPath();
    const args = baseArgs({
      config: makeConfig({
        recipients: ["external@other.com", "alice@picnic-dev.co.uk"],
        allowExternalRecipients: true,
        externalRecipientDomains: ["other.com"],
      }),
    });
    const result = await sendReportSnapshotEmail(args);
    expect(result.status).toBe("sent");
    expect(args.hooks.onIntent).toHaveBeenCalledTimes(1);
    const intent = (args.hooks.onIntent as Mock).mock.calls[0]?.[0] as IntentAuditEvent;
    expect(intent.recipientCount).toBe(2);
    expect(intent.externalRecipientCount).toBe(1);
  });

  it("rejects a recipient with no @", async () => {
    const args = baseArgs({ config: makeConfig({ recipients: ["alice"] }) });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(
      RecipientDomainBlockedError,
    );
  });
});

// ─── Body cap ────────────────────────────────────────────────────────────────

describe("sendReportSnapshotEmail — body cap (§C.6 MED C.6)", () => {
  it("throws BodyTooLargeError when rendered HTML exceeds 1 MB", async () => {
    // Force the renderer to produce > 1 MB by stuffing the operator note
    // (rendered inline). Operator note isn't length-capped at the orchestrator
    // — that's the renderer's domain — so 2 MB of "x" produces 2 MB+ HTML.
    const massive = "x".repeat(2 * 1024 * 1024);
    const args = baseArgs({
      envelope: makeEnvelope({ operatorNote: massive }),
    });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(graphPostMock).not.toHaveBeenCalled();
    expect(args.hooks.onIntent).not.toHaveBeenCalled();
  });
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("sendReportSnapshotEmail — happy path (§C.7 + §C.8)", () => {
  it("renders, posts draft, sends draft, emits audit pair, writes history", async () => {
    mockHappyPath("AAMkAGI2-id-1");
    const args = baseArgs();
    const result = await sendReportSnapshotEmail(args);

    expect(result.status).toBe("sent");
    expect(result.graphMessageId).toBe("AAMkAGI2-id-1");
    expect(result.attempts).toBe(2);

    // graphPost called twice: draft create + draft send
    expect(graphPostMock).toHaveBeenCalledTimes(2);
    const createCall = graphPostMock.mock.calls[0]!;
    const sendCall = graphPostMock.mock.calls[1]!;
    expect(createCall[0]).toBe(
      "https://graph.microsoft.com/v1.0/users/noreply%40picnic-dev.co.uk/messages",
    );
    expect(sendCall[0]).toBe(
      "https://graph.microsoft.com/v1.0/users/noreply%40picnic-dev.co.uk/messages/AAMkAGI2-id-1/send",
    );

    // Audit fingerprints
    const intent = (args.hooks.onIntent as Mock).mock.calls[0]?.[0] as IntentAuditEvent;
    expect(intent.recipientCount).toBe(1);
    expect(intent.externalRecipientCount).toBe(0);
    expect(intent.bodyBytes).toBeGreaterThan(0);
    expect(intent.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.subjectSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.recipientHashSalted).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.triggeredBy).toBe("admin");
    expect(intent.operatorPrincipal).toBe("admin@picnic-dev.co.uk");

    const sent = (args.hooks.onSent as Mock).mock.calls[0]?.[0] as SentAuditEvent;
    expect(sent.graphMessageId).toBe("AAMkAGI2-id-1");
    expect(sent.internetMessageId).toMatch(/^<[0-9a-f-]{36}@picnic-dev\.co\.uk>$/);
    expect(sent.graphClientRequestId).toMatch(/^[0-9a-f-]{36}$/);

    const history = (args.hooks.onHistoryWrite as Mock).mock.calls[0]?.[0] as SendHistoryRow;
    expect(history.graphMessageId).toBe("AAMkAGI2-id-1");
    expect(history.recipients).toEqual(["alice@picnic-dev.co.uk"]);
  });

  it("invokes hooks in order: intent → graphPost(draft) → graphPost(send) → sent → history", async () => {
    mockHappyPath("AAMkAGI2-order");
    const callOrder: string[] = [];
    const args = baseArgs();
    (args.hooks.onIntent as Mock).mockImplementation(async () => {
      callOrder.push("intent");
    });
    (args.hooks.onSent as Mock).mockImplementation(async () => {
      callOrder.push("sent");
    });
    (args.hooks.onHistoryWrite as Mock).mockImplementation(async () => {
      callOrder.push("history");
    });
    graphPostMock.mockReset();
    graphPostMock
      .mockImplementationOnce(async () => {
        callOrder.push("graph_draft");
        return { data: { id: "AAMkAGI2-order" }, attempts: 1, finalHttpStatus: 201, retryEvents: [] };
      })
      .mockImplementationOnce(async () => {
        callOrder.push("graph_send");
        return { data: null, attempts: 1, finalHttpStatus: 202, retryEvents: [] };
      });

    await sendReportSnapshotEmail(args);
    expect(callOrder).toEqual(["intent", "graph_draft", "graph_send", "sent", "history"]);
  });

  it("sets the X-Aegis-Correlation-Id header on the draft", async () => {
    mockHappyPath("AAMkAGI2-correlation");
    const args = baseArgs();
    await sendReportSnapshotEmail(args);
    const createCall = graphPostMock.mock.calls[0]!;
    const draftPayload = createCall[1] as {
      readonly internetMessageHeaders: ReadonlyArray<{ name: string; value: string }>;
    };
    expect(draftPayload.internetMessageHeaders).toHaveLength(1);
    expect(draftPayload.internetMessageHeaders[0]?.name).toBe(AEGIS_CORRELATION_HEADER);
    expect(draftPayload.internetMessageHeaders[0]?.value).toMatch(
      /^<[0-9a-f-]{36}@picnic-dev\.co\.uk>$/,
    );
  });

  it("passes client-request-id on both Graph POSTs", async () => {
    mockHappyPath("AAMkAGI2-crid");
    const args = baseArgs();
    await sendReportSnapshotEmail(args);
    const createPostOpts = graphPostMock.mock.calls[0]![4] as {
      readonly extraHeaders: Record<string, string>;
    };
    const sendPostOpts = graphPostMock.mock.calls[1]![4] as {
      readonly extraHeaders: Record<string, string>;
    };
    expect(createPostOpts.extraHeaders["client-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sendPostOpts.extraHeaders["client-request-id"]).toBe(
      createPostOpts.extraHeaders["client-request-id"],
    );
  });

  it("returns 'sent_but_history_write_failed' when history hook throws", async () => {
    mockHappyPath("AAMkAGI2-histfail");
    const args = baseArgs();
    (args.hooks.onHistoryWrite as Mock).mockRejectedValueOnce(new Error("table 503"));
    const result = await sendReportSnapshotEmail(args);
    expect(result.status).toBe("sent_but_history_write_failed");
    expect(args.hooks.onSent).toHaveBeenCalled();
  });
});

// ─── Failure paths ───────────────────────────────────────────────────────────

describe("sendReportSnapshotEmail — failure paths (§C.8)", () => {
  it("emits onFailed and throws EmailSendError when draft create returns 4xx", async () => {
    graphPostMock.mockRejectedValueOnce(
      new GraphFetchError("4xx", "graph POST 400 terminal: invalid", 400, 1),
    );
    const args = baseArgs();
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(EmailSendError);
    expect(args.hooks.onFailed).toHaveBeenCalledTimes(1);
    const failed = (args.hooks.onFailed as Mock).mock.calls[0]?.[0] as FailedAuditEvent;
    expect(failed.errorKind).toBe("4xx");
    expect(args.hooks.onSent).not.toHaveBeenCalled();
    expect(args.hooks.onHistoryWrite).not.toHaveBeenCalled();
  });

  it("emits onFailed and throws when send-draft returns 5xx after retries", async () => {
    graphPostMock
      .mockResolvedValueOnce({
        data: { id: "AAMkAGI2-step1" },
        attempts: 1,
        finalHttpStatus: 201,
        retryEvents: [],
      })
      .mockRejectedValueOnce(
        new GraphFetchError("5xx", "graph POST 503 after 3 attempts", 503, 3),
      );
    const args = baseArgs();
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(EmailSendError);
    expect(args.hooks.onSent).not.toHaveBeenCalled();
    const failed = (args.hooks.onFailed as Mock).mock.calls[0]?.[0] as FailedAuditEvent;
    expect(failed.errorKind).toBe("5xx");
    expect(failed.attempt).toBe(3);
  });

  it("throws when draft create returns 2xx without an id", async () => {
    graphPostMock.mockResolvedValueOnce({
      data: {},
      attempts: 1,
      finalHttpStatus: 201,
      retryEvents: [],
    });
    const args = baseArgs();
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(EmailSendError);
    expect(args.hooks.onFailed).toHaveBeenCalledTimes(1);
  });

  it("intent line is emitted even when send fails", async () => {
    graphPostMock.mockRejectedValueOnce(
      new GraphFetchError("network", "graph POST network", null, 3),
    );
    const args = baseArgs();
    await expect(sendReportSnapshotEmail(args)).rejects.toBeDefined();
    expect(args.hooks.onIntent).toHaveBeenCalledTimes(1);
    expect(args.hooks.onFailed).toHaveBeenCalledTimes(1);
  });

  it("aborts the send when onIntent throws (audit before Graph contract)", async () => {
    const args = baseArgs();
    (args.hooks.onIntent as Mock).mockRejectedValueOnce(new Error("blob 503"));
    await expect(sendReportSnapshotEmail(args)).rejects.toThrow("blob 503");
    expect(graphPostMock).not.toHaveBeenCalled();
    expect(args.hooks.onSent).not.toHaveBeenCalled();
    expect(args.hooks.onFailed).not.toHaveBeenCalled();
  });
});

// ─── Slice 1(b) WS10 hardening — UPN regex, operatorNote cap, IDN ────────────

describe("sendReportSnapshotEmail — WS10 hardening (LOW #6/#7/#8, MEDIUM #2)", () => {
  it("rejects senderMailbox with CRLF (header injection defence)", async () => {
    const args = baseArgs({
      config: makeConfig({ senderMailbox: "noreply@picnic-dev.co.uk\r\nBcc: a@x.com" }),
    });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("rejects senderMailbox with control chars", async () => {
    const args = baseArgs({
      config: makeConfig({ senderMailbox: "noreply @picnic-dev.co.uk" }),
    });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("rejects operatorNote larger than 4 KB before render", async () => {
    const big = "n".repeat(5 * 1024);
    const args = baseArgs({ envelope: makeEnvelope({ operatorNote: big }) });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(graphPostMock).not.toHaveBeenCalled();
  });

  it("canonicalises recipients (trim + lowercase) before hash + Graph payload", async () => {
    mockHappyPath("AAMkAGI2-canon");
    const args = baseArgs({
      config: makeConfig({
        recipients: [" Alice@PICNIC-DEV.co.uk ", "alice@picnic-dev.co.uk"],
      }),
    });
    const result = await sendReportSnapshotEmail(args);
    // De-dup after canonicalise → 1 recipient.
    expect(result.recipientCount).toBe(1);
    const draftPayload = graphPostMock.mock.calls[0]![1] as {
      readonly toRecipients: ReadonlyArray<{ emailAddress: { address: string } }>;
    };
    expect(draftPayload.toRecipients).toHaveLength(1);
    expect(draftPayload.toRecipients[0]?.emailAddress.address).toBe("alice@picnic-dev.co.uk");
  });

  it("produces stable recipient hash regardless of input order", async () => {
    const args1 = baseArgs({
      config: makeConfig({ recipients: ["alice@picnic-dev.co.uk", "bob@picnic-dev.co.uk"] }),
    });
    const args2 = baseArgs({
      config: makeConfig({ recipients: ["bob@picnic-dev.co.uk", "alice@picnic-dev.co.uk"] }),
    });
    mockHappyPath("AAMkAGI2-hash-1");
    await sendReportSnapshotEmail(args1);
    graphPostMock.mockReset();
    mockHappyPath("AAMkAGI2-hash-2");
    await sendReportSnapshotEmail(args2);
    const h1 = ((args1.hooks.onIntent as Mock).mock.calls[0]?.[0] as IntentAuditEvent).recipientHashSalted;
    const h2 = ((args2.hooks.onIntent as Mock).mock.calls[0]?.[0] as IntentAuditEvent).recipientHashSalted;
    expect(h1).toBe(h2);
  });

  it("ADR-0030 §C.21 — emits recipientHashSalted (legacy) when no pepper is configured", async () => {
    // No KV env vars set → loader returns null → orchestrator emits the
    // pre-pepper field. Verifies the mutual-exclusion invariant and that
    // the legacy field's hash shape (sha256 hex) is unchanged.
    mockHappyPath("AAMkAGI2-no-pepper");
    const args = baseArgs();
    await sendReportSnapshotEmail(args);
    const intent = (args.hooks.onIntent as Mock).mock.calls[0]?.[0] as IntentAuditEvent;
    expect(intent.recipientHashSalted).toMatch(/^[0-9a-f]{64}$/);
    expect(intent.recipientHashSaltedV2).toBeUndefined();
  });

  it("ADR-0030 §C.21 — emits recipientHashSaltedV2 (peppered) when pepper is loaded; legacy field omitted", async () => {
    // Override the pepper loader for this single test. Importing dynamically
    // so the vi.mock doesn't leak into other tests; we re-import after.
    const { resetRecipientHashPepperCache } = await import(
      "../src/lib/recipientHashPepper.js"
    );
    resetRecipientHashPepperCache();
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_NAME", "kv-aegis-dev-uks");
    vi.stubEnv("RECIPIENT_HASH_PEPPER_KV_SECRET_NAME", "recipient-hash-pepper");
    vi.stubEnv("MAIL_SENDER_MI_CLIENT_ID", "mi-1");
    // Mock the KV SecretClient at the SDK boundary so the loader returns a
    // deterministic pepper without hitting Azure.
    const { SecretClient } = await import("@azure/keyvault-secrets");
    const getSecret = vi.fn().mockResolvedValue({ value: "test-pepper-256bit" });
    vi.spyOn(SecretClient.prototype, "getSecret").mockImplementation(getSecret as never);
    try {
      mockHappyPath("AAMkAGI2-pepper");
      const args = baseArgs();
      await sendReportSnapshotEmail(args);
      const intent = (args.hooks.onIntent as Mock).mock.calls[0]?.[0] as IntentAuditEvent;
      expect(intent.recipientHashSaltedV2).toMatch(/^[0-9a-f]{64}$/);
      expect(intent.recipientHashSalted).toBeUndefined();
      // Peppered hash MUST differ from legacy hash for the same recipient list
      // (otherwise the pepper isn't actually entering the digest).
      const expectedLegacy = (await import("node:crypto"))
        .createHash("sha256")
        .update("tenant-guid-aaa:alice@picnic-dev.co.uk")
        .digest("hex");
      expect(intent.recipientHashSaltedV2).not.toBe(expectedLegacy);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      resetRecipientHashPepperCache();
    }
  });

  it("blocks Unicode-homograph external recipient (NFC + lowercase normalisation)", async () => {
    // Cyrillic 'а' (U+0430) vs Latin 'a' (U+0061) in the domain. Allowlist
    // contains the ASCII form. Recipient uses the homograph — must be blocked.
    const homographDomain = "pаcnic-dev.co.uk"; // Cyrillic 'а' inside the domain
    const args = baseArgs({
      config: makeConfig({
        recipients: [`evil@${homographDomain}`],
        allowExternalRecipients: true,
        externalRecipientDomains: ["pacnic-dev.co.uk"], // ASCII lookalike on allowlist
      }),
    });
    await expect(sendReportSnapshotEmail(args)).rejects.toBeInstanceOf(
      RecipientDomainBlockedError,
    );
  });
});
