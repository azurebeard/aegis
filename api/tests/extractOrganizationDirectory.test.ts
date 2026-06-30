// Unit tests for extractOrganizationDirectory — pulls the tenant's
// (id, displayName) out of the /v1.0/organization probe response shape.

import { describe, it, expect } from "vitest";
import { extractOrganizationDirectory } from "../src/lib/graphClient.js";

describe("extractOrganizationDirectory", () => {
  it("returns {id, displayName} for a normal single-org response", () => {
    const got = extractOrganizationDirectory({
      value: [
        {
          id: "764279e8-66e9-49b4-901f-a7592435ae1d",
          displayName: "Picnic Dev",
          assignedPlans: [],
        },
      ],
    });
    expect(got).toEqual({
      id: "764279e8-66e9-49b4-901f-a7592435ae1d",
      displayName: "Picnic Dev",
    });
  });

  it("trims whitespace around displayName and id", () => {
    const got = extractOrganizationDirectory({
      value: [
        {
          id: "  gid  ",
          displayName: "  Acme  ",
          assignedPlans: [],
        },
      ],
    });
    expect(got).toEqual({ id: "gid", displayName: "Acme" });
  });

  it("returns null when value is empty", () => {
    expect(extractOrganizationDirectory({ value: [] })).toBeNull();
  });

  it("returns null when value is missing", () => {
    expect(extractOrganizationDirectory({})).toBeNull();
  });

  it("returns null when displayName is missing", () => {
    expect(
      extractOrganizationDirectory({
        value: [{ id: "gid", assignedPlans: [] }],
      }),
    ).toBeNull();
  });

  it("returns null when id is missing", () => {
    expect(
      extractOrganizationDirectory({
        value: [{ displayName: "Acme", assignedPlans: [] }],
      }),
    ).toBeNull();
  });

  it("returns null when displayName is empty string", () => {
    expect(
      extractOrganizationDirectory({
        value: [{ id: "gid", displayName: "", assignedPlans: [] }],
      }),
    ).toBeNull();
  });

  it("takes the first org when multiple are returned (single-tenant MI invariant)", () => {
    // /organization is single-tenant-scoped — multiple rows should not occur
    // in practice, but the helper must be deterministic if it does.
    const got = extractOrganizationDirectory({
      value: [
        { id: "first", displayName: "First" },
        { id: "second", displayName: "Second" },
      ],
    });
    expect(got).toEqual({ id: "first", displayName: "First" });
  });
});
