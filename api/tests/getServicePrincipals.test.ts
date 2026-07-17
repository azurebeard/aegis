// ADR-0034 Phase 8E — query-parsing + filter-building unit tests for the
// /api/identities/service-principals handler. The endpoint's E2E behaviour
// (Graph 503 → 503, 200 → schema-versioned envelope) is exercised at
// integration-test time; here we cover the critical input-validation +
// OData filter-construction surfaces.

import { describe, expect, it } from "vitest";
import { __test__ } from "../src/functions/getServicePrincipals.js";
import type { ServicePrincipalRow } from "../src/lib/servicePrincipalParser.js";

const { parseQuery, buildGraphFilter, filterByKind } = __test__;

function makeReq(qs: Record<string, string | undefined>): { query: URLSearchParams } {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(qs)) {
    if (v !== undefined) params.set(k, v);
  }
  return {
    query: {
      get: (k: string) => (params.has(k) ? params.get(k) : null),
    } as unknown as URLSearchParams,
  };
}

describe("parseQuery — defaults + happy path", () => {
  it("defaults kind=all, search=null, top=100, nextLink=null", () => {
    const r = parseQuery(makeReq({}) as never);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value.kindFilter.kind).toBe("all");
    expect(r.value.search).toBeNull();
    expect(r.value.top).toBe(100);
    expect(r.value.nextLink).toBeNull();
  });

  it("accepts kind=application", () => {
    const r = parseQuery(makeReq({ kind: "application" }) as never);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.value.kindFilter.kind).toBe("application");
  });

  it("accepts kind=managedIdentity (case-insensitive)", () => {
    const r = parseQuery(makeReq({ kind: "ManagedIdentity" }) as never);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.value.kindFilter.kind).toBe("managedIdentity");
  });

  it("accepts a 64-char search term", () => {
    const r = parseQuery(makeReq({ search: "a".repeat(64) }) as never);
    expect(r.kind).toBe("ok");
  });
});

describe("parseQuery — rejection cases", () => {
  it("rejects unknown kind", () => {
    const r = parseQuery(makeReq({ kind: "user" }) as never);
    expect(r.kind).toBe("error");
  });

  it("rejects search >64 chars", () => {
    const r = parseQuery(makeReq({ search: "a".repeat(65) }) as never);
    expect(r.kind).toBe("error");
  });

  it("rejects search with disallowed characters", () => {
    for (const v of ["foo'", "x<script", "bad`tick", "'; DROP"]) {
      const r = parseQuery(makeReq({ search: v }) as never);
      expect(r.kind, `value ${JSON.stringify(v)} should reject`).toBe("error");
    }
  });

  it("rejects top out of [1,999]", () => {
    for (const v of ["0", "1000", "-1", "abc", "10.5"]) {
      const r = parseQuery(makeReq({ top: v }) as never);
      expect(r.kind, `value ${JSON.stringify(v)} should reject`).toBe("error");
    }
  });

  it("rejects nextLink that isn't a graph.microsoft.com URL", () => {
    for (const v of [
      "https://attacker.example.com/v1.0/servicePrincipals",
      "http://graph.microsoft.com/v1.0/servicePrincipals",
      "javascript:alert(1)",
      "//graph.microsoft.com/x",
    ]) {
      const r = parseQuery(makeReq({ nextLink: v }) as never);
      expect(r.kind, `value ${JSON.stringify(v)} should reject`).toBe("error");
    }
  });

  it("accepts a valid graph.microsoft.com nextLink and ignores other params", () => {
    const r = parseQuery(
      makeReq({
        nextLink: "https://graph.microsoft.com/v1.0/servicePrincipals?$skiptoken=abc",
        kind: "application",
        search: "ignored",
      }) as never,
    );
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value.nextLink).toContain("$skiptoken=abc");
    // kind defaults to 'all' when nextLink takes precedence.
    expect(r.value.kindFilter.kind).toBe("all");
  });
});

describe("buildGraphFilter — OData escaping", () => {
  it("returns null when nothing to filter", () => {
    expect(buildGraphFilter({ kind: "all" }, null)).toBeNull();
  });

  it("emits servicePrincipalType clause for application", () => {
    expect(buildGraphFilter({ kind: "application" }, null)).toBe(
      "servicePrincipalType eq 'Application'",
    );
  });

  it("emits servicePrincipalType clause for managedIdentity", () => {
    expect(buildGraphFilter({ kind: "managedIdentity" }, null)).toBe(
      "servicePrincipalType eq 'ManagedIdentity'",
    );
  });

  it("doubles single quotes in the search term per OData v4 §5.1.1.6", () => {
    // Even though parseQuery now rejects single quotes, the OData escape is
    // a defence-in-depth invariant — the filter builder must not assume
    // input is clean.
    const f = buildGraphFilter({ kind: "all" }, "O'Brien Co");
    expect(f).toBe("startswith(displayName,'O''Brien Co')");
  });

  it("AND-combines kind + search", () => {
    expect(buildGraphFilter({ kind: "application" }, "Aegis")).toBe(
      "servicePrincipalType eq 'Application' and startswith(displayName,'Aegis')",
    );
  });
});

describe("filterByKind — defence-in-depth post-fetch filter", () => {
  function row(partial: Partial<ServicePrincipalRow>): ServicePrincipalRow {
    return {
      id: "x",
      appId: "y",
      displayName: "z",
      servicePrincipalType: "Application",
      kind: "application",
      signInAudience: null,
      accountEnabled: true,
      appOwnerOrganizationId: null,
      createdDateTime: null,
      tags: [],
      credentialSummary: { secrets: 0, certs: 0, earliestExpiryAt: null, expiredCount: 0 },
      ...partial,
    };
  }

  it("kind=all returns everything", () => {
    const rs = [row({ kind: "application" }), row({ kind: "managedIdentity" })];
    expect(filterByKind(rs, { kind: "all" })).toHaveLength(2);
  });

  it("kind=application keeps both 'application' and 'agent' rows", () => {
    const rs = [
      row({ kind: "application" }),
      row({ kind: "managedIdentity" }),
      row({ kind: "agent" }),
      row({ kind: "other" }),
    ];
    const out = filterByKind(rs, { kind: "application" });
    const kinds = out.map((r) => r.kind).sort();
    expect(kinds).toEqual(["agent", "application"]);
  });

  it("kind=managedIdentity keeps only managedIdentity rows", () => {
    const rs = [row({ kind: "application" }), row({ kind: "managedIdentity" })];
    const out = filterByKind(rs, { kind: "managedIdentity" });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("managedIdentity");
  });
});
