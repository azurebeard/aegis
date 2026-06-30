// ADR-0034 Phase 8E — narrow + skip-not-throw on Graph
// /v1.0/servicePrincipals payloads.

import { describe, expect, it } from "vitest";
import { parseServicePrincipalsPage } from "../src/lib/servicePrincipalParser.js";

const NOW = "2026-05-10T12:00:00.000Z";
const ID_A = "00000000-0000-0000-0000-000000000001"; // gitleaks:allow
const APP_A = "11111111-1111-1111-1111-111111111111"; // gitleaks:allow
const ID_B = "00000000-0000-0000-0000-000000000002"; // gitleaks:allow
const APP_B = "22222222-2222-2222-2222-222222222222"; // gitleaks:allow

describe("parseServicePrincipalsPage", () => {
  it("parses a well-formed Application row", () => {
    const out = parseServicePrincipalsPage(
      {
        value: [
          {
            id: ID_A,
            appId: APP_A,
            displayName: "Aegis API",
            servicePrincipalType: "Application",
            signInAudience: "AzureADMyOrg",
            accountEnabled: true,
            appOwnerOrganizationId: "33333333-3333-3333-3333-333333333333", // gitleaks:allow
            createdDateTime: "2026-04-01T00:00:00Z",
            tags: ["WindowsAzureActiveDirectoryIntegratedApp"],
            keyCredentials: [],
            passwordCredentials: [],
          },
        ],
      },
      NOW,
    );
    expect(out.skippedMalformed).toBe(0);
    expect(out.rows).toHaveLength(1);
    const r = out.rows[0]!;
    expect(r.id).toBe(ID_A);
    expect(r.kind).toBe("application");
    expect(r.servicePrincipalType).toBe("Application");
    expect(r.tags).toEqual(["WindowsAzureActiveDirectoryIntegratedApp"]);
    expect(r.credentialSummary).toEqual({
      secrets: 0,
      certs: 0,
      earliestExpiryAt: null,
      expiredCount: 0,
    });
  });

  it("classifies a ManagedIdentity row", () => {
    const out = parseServicePrincipalsPage(
      {
        value: [
          {
            id: ID_B,
            appId: APP_B,
            displayName: "ingest-mi",
            servicePrincipalType: "ManagedIdentity",
            signInAudience: "AzureADMyOrg",
            accountEnabled: true,
          },
        ],
      },
      NOW,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.kind).toBe("managedIdentity");
  });

  it("promotes a row with non-null agentSubtype to kind='agent' even when type='Application'", () => {
    // Forward-compat — Microsoft schema TBC; the parser must NOT reject the
    // row and MUST tag it as 'agent' for the SPA tab discriminator.
    const out = parseServicePrincipalsPage(
      {
        value: [
          {
            id: ID_A,
            appId: APP_A,
            displayName: "Copilot HR Agent",
            servicePrincipalType: "Application",
            agentSubtype: "copilotStudio",
            accountEnabled: true,
          },
        ],
      },
      NOW,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.kind).toBe("agent");
  });

  it("rolls up credential expiry across keyCredentials + passwordCredentials", () => {
    const past = "2026-04-01T00:00:00Z";
    const future = "2026-08-01T00:00:00Z";
    const out = parseServicePrincipalsPage(
      {
        value: [
          {
            id: ID_A,
            appId: APP_A,
            displayName: "App with creds",
            servicePrincipalType: "Application",
            keyCredentials: [{ endDateTime: future }],
            passwordCredentials: [{ endDateTime: past }, { endDateTime: future }],
          },
        ],
      },
      NOW,
    );
    const r = out.rows[0]!;
    expect(r.credentialSummary.secrets).toBe(2);
    expect(r.credentialSummary.certs).toBe(1);
    expect(r.credentialSummary.expiredCount).toBe(1);
    expect(r.credentialSummary.earliestExpiryAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("skips malformed rows (missing id, non-GUID id, missing displayName)", () => {
    const out = parseServicePrincipalsPage(
      {
        value: [
          { appId: APP_A, displayName: "no-id" },
          { id: "not-a-guid", appId: APP_A, displayName: "bad-id" },
          { id: ID_A, appId: APP_A }, // no displayName
          // valid one to confirm we DON'T early-return
          {
            id: ID_B,
            appId: APP_B,
            displayName: "valid",
            servicePrincipalType: "Application",
          },
        ],
      },
      NOW,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.displayName).toBe("valid");
    expect(out.skippedMalformed).toBe(3);
  });

  it("returns empty batch on non-object input", () => {
    expect(parseServicePrincipalsPage(null, NOW)).toEqual({ rows: [], skippedMalformed: 0 });
    expect(parseServicePrincipalsPage(42, NOW)).toEqual({ rows: [], skippedMalformed: 0 });
    expect(parseServicePrincipalsPage({ value: "nope" }, NOW)).toEqual({
      rows: [],
      skippedMalformed: 0,
    });
  });
});
