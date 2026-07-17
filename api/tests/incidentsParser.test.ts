import { describe, it, expect } from "vitest";
import {
  buildDetailBlobPath,
  INCIDENT_ID_REGEX,
  IncidentIdRejectedError,
  normaliseClassification,
  normaliseSeverity,
  normaliseStatus,
  parseIncident,
  validateIncidentId,
} from "../src/lib/incidentsParser.js";
import type { RawGraphIncident } from "../src/lib/graphClient.js";

describe("validateIncidentId (ADR-0014 §3.2)", () => {
  it("accepts the observed Graph envelope", () => {
    expect(() => validateIncidentId("29")).not.toThrow();
    expect(() => validateIncidentId("abc_defGHI-123.456")).not.toThrow();
    expect(() => validateIncidentId("a".repeat(128))).not.toThrow();
  });

  it("rejects length > 128 (reject-not-truncate)", () => {
    expect(() => validateIncidentId("a".repeat(129))).toThrow(IncidentIdRejectedError);
    try {
      validateIncidentId("a".repeat(130));
    } catch (err) {
      expect((err as IncidentIdRejectedError).reason).toBe("length");
    }
  });

  it("rejects empty / null / undefined", () => {
    expect(() => validateIncidentId("")).toThrow(IncidentIdRejectedError);
    expect(() => validateIncidentId(null as unknown as string)).toThrow(IncidentIdRejectedError);
    expect(() => validateIncidentId(undefined as unknown as string)).toThrow(
      IncidentIdRejectedError,
    );
  });

  it.each([
    ["with ..", "a..b"],
    ["with /", "a/b"],
    ["with \\", "a\\b"],
    ["with [", "a[b"],
    ["with ]", "a]b"],
    ["with NUL", "a\u0000b"],
    ["with BOM", "a\uFEFFb"],
    ["with control char", "a\u0001b"],
  ])("rejects IDs %s", (_, id) => {
    expect(() => validateIncidentId(id)).toThrow(IncidentIdRejectedError);
  });

  it("rejects characters outside [A-Za-z0-9._-]", () => {
    expect(() => validateIncidentId("abc def")).toThrow(IncidentIdRejectedError);
    expect(() => validateIncidentId("abc+def")).toThrow(IncidentIdRejectedError);
    expect(() => validateIncidentId("abc!def")).toThrow(IncidentIdRejectedError);
    expect(() => validateIncidentId("abc:def")).toThrow(IncidentIdRejectedError);
  });

  it("INCIDENT_ID_REGEX matches exactly the positive character class + length bound", () => {
    expect(INCIDENT_ID_REGEX.test("validId_1.2-3")).toBe(true);
    expect(INCIDENT_ID_REGEX.test("")).toBe(false);
    expect(INCIDENT_ID_REGEX.test("a".repeat(129))).toBe(false);
  });
});

describe("buildDetailBlobPath", () => {
  it("produces yyyy/mm/dd/<id>.json from the ingestedAt UTC date", () => {
    expect(buildDetailBlobPath("29", "2026-04-18T19:45:00.000Z")).toBe("2026/04/18/29.json");
  });

  it("zero-pads month/day", () => {
    expect(buildDetailBlobPath("29", "2026-01-05T00:00:00.000Z")).toBe("2026/01/05/29.json");
  });

  it("rejects malformed ingestedAt", () => {
    expect(() => buildDetailBlobPath("29", "not-a-date")).toThrow(/invalid ingestedAt/);
  });

  it("re-validates the incident ID (defence-in-depth)", () => {
    expect(() => buildDetailBlobPath("bad id", "2026-04-18T00:00:00.000Z")).toThrow(
      IncidentIdRejectedError,
    );
  });
});

describe("normalisers", () => {
  it("severity defaults to unknown", () => {
    expect(normaliseSeverity(undefined)).toBe("unknown");
    expect(normaliseSeverity("strange")).toBe("unknown");
    expect(normaliseSeverity("high")).toBe("high");
  });

  it("status defaults to active (safest for tile rendering)", () => {
    expect(normaliseStatus(undefined)).toBe("active");
    expect(normaliseStatus("strange")).toBe("active");
    expect(normaliseStatus("resolved")).toBe("resolved");
  });

  it("classification defaults to unknown", () => {
    expect(normaliseClassification(undefined)).toBe("unknown");
    expect(normaliseClassification("strange")).toBe("unknown");
    expect(normaliseClassification("truePositive")).toBe("truePositive");
  });
});

describe("parseIncident", () => {
  const base: RawGraphIncident = {
    id: "29",
    displayName: "Multi-stage incident",
    severity: "high",
    status: "active",
    classification: "truePositive",
    determination: "multiStagedAttack",
    priorityScore: 100,
    assignedTo: "admin@contoso.com",
    createdDateTime: "2026-01-22T12:09:23.143Z",
    lastUpdateDateTime: "2026-02-25T16:29:33.100Z",
    incidentWebUrl: "https://security.microsoft.com/incident2/29",
    customTags: ["Demo"],
    systemTags: [],
    alerts: [{ id: "alert-1" }, { id: "alert-2" }],
  };

  it("maps the happy path", () => {
    const out = parseIncident(base, {
      ingestedAt: "2026-04-18T19:45:00.000Z",
      ingestRunId: "run-1",
    });
    expect(out.id).toBe("29");
    expect(out.severity).toBe("high");
    expect(out.alertCount).toBe(2);
    expect(out.priorityScore).toBe(100);
  });

  it("handles missing priorityScore as null", () => {
    const out = parseIncident({ ...base, priorityScore: null }, {
      ingestedAt: "2026-04-18T00:00:00.000Z",
      ingestRunId: "r",
    });
    expect(out.priorityScore).toBeNull();
  });

  it("truncates displayName > 256 characters with a marker", () => {
    const longName = "A".repeat(500);
    const out = parseIncident({ ...base, displayName: longName }, {
      ingestedAt: "2026-04-18T00:00:00.000Z",
      ingestRunId: "r",
    });
    expect(out.displayName.length).toBe(256);
    expect(out.displayName.endsWith("…")).toBe(true);
  });

  it("throws on malformed id (reject-not-truncate)", () => {
    expect(() =>
      parseIncident({ ...base, id: "a/b" }, {
        ingestedAt: "2026-04-18T00:00:00.000Z",
        ingestRunId: "r",
      }),
    ).toThrow(IncidentIdRejectedError);
  });

  it("caps customTags/systemTags serialisation at 4KB", () => {
    const manyTags = Array.from({ length: 2000 }, (_, i) => `tag_${i}_${"x".repeat(32)}`);
    const out = parseIncident({ ...base, customTags: manyTags }, {
      ingestedAt: "2026-04-18T00:00:00.000Z",
      ingestRunId: "r",
    });
    const size = Buffer.byteLength(JSON.stringify(out.customTags), "utf-8");
    expect(size).toBeLessThanOrEqual(4096);
  });

  it("sets hasRedirect when redirectIncidentId is present", () => {
    const out = parseIncident(
      { ...base, redirectIncidentId: "99" },
      { ingestedAt: "2026-04-18T00:00:00.000Z", ingestRunId: "r" },
    );
    expect(out.hasRedirect).toBe(true);
    expect(out.redirectIncidentId).toBe("99");
  });
});
