// Tests for the secureScoreControlProfile cache helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@azure/functions", async () => {
  const actual =
    await vi.importActual<typeof import("@azure/functions")>("@azure/functions");
  return {
    ...actual,
    app: { ...actual.app, http: vi.fn(), timer: vi.fn() },
  };
});

beforeEach(() => {
  vi.stubEnv("API_READER_MI_CLIENT_ID", "api-mi");
  vi.stubEnv("INGEST_MI_CLIENT_ID", "ingest-mi");
  vi.stubEnv("AUDIT_MI_CLIENT_ID", "audit-mi");
  vi.stubEnv(
    "OPS_TABLE_ENDPOINT",
    "https://staegisops.table.core.windows.net",
  );
  vi.stubEnv(
    "AUDIT_BLOB_ENDPOINT",
    "https://staegisaudit.blob.core.windows.net",
  );
  vi.stubEnv("GRAPH_BASE_URL", "https://graph.microsoft.com");
  vi.stubEnv("AZURE_TENANT_ID", "tenant-1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("profileToEntity / entityToRow", () => {
  it("round-trips primitive fields and JSON-encodes threats[]", async () => {
    const { profileToEntity, entityToRow } = await import(
      "../src/lib/secureScoreControlProfileStore.js"
    );
    const entity = profileToEntity(
      {
        id: "AdminMFAV2",
        title: "Require MFA for admin roles",
        controlCategory: "Identity",
        tier: "Core",
        service: "Microsoft Entra ID",
        maxScore: 10,
        rank: 1,
        actionType: "Config",
        actionUrl: "https://security.microsoft.com/securescore",
        remediation: "Enable MFA on every admin role.",
        remediationImpact: "Admins receive MFA prompts.",
        userImpact: "low",
        implementationCost: "low",
        threats: ["accountBreach", "elevationOfPrivilege"],
        deprecated: false,
        lastModifiedDateTime: "2025-12-01T00:00:00Z",
      },
      "2026-04-28T03:00:00Z",
    );
    expect(entity.partitionKey).toBe("profile");
    expect(entity.rowKey).toBe("AdminMFAV2");
    expect(entity.MaxScore).toBe(10);
    expect(entity.Tier).toBe("Core");
    expect(JSON.parse(entity.ThreatsJson)).toEqual([
      "accountBreach",
      "elevationOfPrivilege",
    ]);

    const row = entityToRow(entity);
    expect(row.controlName).toBe("AdminMFAV2");
    expect(row.maxScore).toBe(10);
    expect(row.tier).toBe("Core");
    expect(row.threats).toEqual(["accountBreach", "elevationOfPrivilege"]);
    expect(row.deprecated).toBe(false);
  });

  it("collapses missing maxScore + rank to null on read-back via the -1 sentinel", async () => {
    const { profileToEntity, entityToRow } = await import(
      "../src/lib/secureScoreControlProfileStore.js"
    );
    const entity = profileToEntity(
      { id: "Stub", maxScore: null, rank: undefined },
      "2026-04-28T00:00:00Z",
    );
    const row = entityToRow(entity);
    expect(row.maxScore).toBeNull();
    expect(row.rank).toBeNull();
  });

  it("clamps oversized remediation text below the table-property cap", async () => {
    const { profileToEntity } = await import(
      "../src/lib/secureScoreControlProfileStore.js"
    );
    const huge = "x".repeat(40_000);
    const entity = profileToEntity(
      { id: "Stub", remediation: huge },
      "2026-04-28T00:00:00Z",
    );
    expect(entity.Remediation.length).toBe(32_000);
  });

  it("path-sanitises the controlName into the RowKey", async () => {
    const { profileToEntity } = await import(
      "../src/lib/secureScoreControlProfileStore.js"
    );
    const entity = profileToEntity(
      { id: "Bad / control # name?" },
      "2026-04-28T00:00:00Z",
    );
    // `/`, `\`, `#`, `?`, and ` ` (space) all forbidden in Table RowKey;
    // replaced with `_`.
    expect(entity.rowKey).not.toContain("/");
    expect(entity.rowKey).not.toContain("#");
    expect(entity.rowKey).not.toContain("?");
    expect(entity.rowKey).not.toContain(" ");
  });
});

describe("listControlProfiles", () => {
  it("filters to PartitionKey='profile' and sorts ascending by RowKey", async () => {
    const { listControlProfiles } = await import(
      "../src/lib/secureScoreControlProfileStore.js"
    );
    const observed: string[] = [];
    const entities = [
      mkProfileEntity("Beta"),
      mkProfileEntity("Alpha"),
      mkProfileEntity("Gamma"),
    ];
    const table = {
      listEntities: vi.fn((opts: { queryOptions?: { filter?: string } }) => {
        observed.push(opts.queryOptions?.filter ?? "(none)");
        return mkAsyncIter(entities);
      }),
    } as unknown as Parameters<typeof listControlProfiles>[0];
    const rows = await listControlProfiles(table);
    // Filter must scope to the profile partition only — never accidentally
    // pull snapshot rows.
    expect(observed[0]).toContain("PartitionKey eq 'profile'");
    expect(rows.map((r) => r.controlName)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

function mkProfileEntity(controlName: string) {
  return {
    partitionKey: "profile",
    rowKey: controlName,
    ControlCategory: "Identity",
    Title: `Title for ${controlName}`,
    Tier: "Core",
    Service: "",
    MaxScore: 10,
    Rank: 1,
    ActionType: "Config",
    ActionUrl: "https://security.microsoft.com/securescore",
    Remediation: "",
    RemediationImpact: "",
    UserImpact: "",
    ImplementationCost: "",
    ThreatsJson: "[]",
    Deprecated: false,
    ProfileLastModified: "",
    IngestedAt: "2026-04-28T00:00:00Z",
  };
}

function mkAsyncIter<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let i = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (i >= items.length) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return Promise.resolve({ value: items[i++] as T, done: false });
        },
      };
    },
  };
}
