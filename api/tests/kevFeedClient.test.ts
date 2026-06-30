// ADR-0032 §1 + §7 — feed parser + fetcher tests.

import { describe, expect, it } from "vitest";
import {
  fetchKevFeed,
  KevFetchError,
  parseKevFeed,
} from "../src/lib/kevFeedClient.js";

const VALID_FEED = JSON.stringify({
  catalogVersion: "2026.04.28",
  dateReleased: "2026-04-28T13:00:00.000Z",
  count: 2,
  vulnerabilities: [
    {
      cveID: "CVE-2024-12345",
      vendorProject: "Microsoft",
      product: "Windows",
      vulnerabilityName: "Microsoft Windows Privilege Escalation",
      dateAdded: "2024-04-15",
      shortDescription: "Privilege escalation in Windows kernel.",
      requiredAction: "Apply mitigations per vendor instructions.",
      dueDate: "2024-05-06",
      knownRansomwareCampaignUse: "Known",
      notes: "https://msrc.microsoft.com/...",
      cwes: ["CWE-269"],
    },
    {
      cveID: "CVE-2024-67890",
      vendorProject: "Apache",
      product: "Tomcat",
      vulnerabilityName: "Apache Tomcat Path Traversal",
      dateAdded: "2024-06-10",
      shortDescription: "Path traversal flaw in Tomcat.",
      requiredAction: "Upgrade to fixed version.",
      dueDate: "2024-07-01",
      knownRansomwareCampaignUse: "Unknown",
      notes: "",
      cwes: ["CWE-22"],
    },
  ],
});

describe("parseKevFeed", () => {
  it("parses a well-formed feed", () => {
    const r = parseKevFeed(VALID_FEED);
    expect(r.catalogVersion).toBe("2026.04.28");
    expect(r.entries.length).toBe(2);
    expect(r.entries[0]?.cveID).toBe("CVE-2024-12345");
    expect(r.entries[0]?.knownRansomwareCampaignUse).toBe("Known");
    expect(r.entries[1]?.knownRansomwareCampaignUse).toBe("Unknown");
    expect(r.droppedCount).toBe(0);
  });

  it("rejects non-JSON body", () => {
    expect(() => parseKevFeed("not json")).toThrow(KevFetchError);
  });

  it("rejects body missing the vulnerabilities array", () => {
    expect(() =>
      parseKevFeed(JSON.stringify({ catalogVersion: "x", dateReleased: "y", count: 0 })),
    ).toThrow(KevFetchError);
  });

  it("drops malformed CVE entries (missing cveID, bad cveID format, empty vendor/product)", () => {
    const dirty = JSON.stringify({
      catalogVersion: "v1",
      dateReleased: "2026-01-01",
      count: 5,
      vulnerabilities: [
        { cveID: "CVE-2024-12345", vendorProject: "Microsoft", product: "Windows" }, // valid
        { vendorProject: "Microsoft", product: "Office" }, // missing cveID
        { cveID: "BAD-FORMAT", vendorProject: "X", product: "Y" }, // wrong cveID shape
        { cveID: "CVE-2024-99999", vendorProject: "", product: "Y" }, // empty vendor
        { cveID: "CVE-2024-88888", vendorProject: "Z", product: "" }, // empty product
      ],
    });
    const r = parseKevFeed(dirty);
    expect(r.entries.length).toBe(1);
    expect(r.droppedCount).toBe(4);
  });

  it("truncates over-long fields without aborting", () => {
    const huge = "x".repeat(10_000);
    const r = parseKevFeed(
      JSON.stringify({
        catalogVersion: "v1",
        dateReleased: "2026-01-01",
        count: 1,
        vulnerabilities: [
          {
            cveID: "CVE-2024-12345",
            vendorProject: huge,
            product: huge,
            vulnerabilityName: huge,
            shortDescription: huge,
            requiredAction: huge,
            notes: huge,
            cwes: [],
            dateAdded: "2024-01-01",
            dueDate: "2024-02-01",
            knownRansomwareCampaignUse: "Unknown",
          },
        ],
      }),
    );
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]?.vendorProject.length).toBe(256);
    expect(r.entries[0]?.product.length).toBe(256);
    expect(r.entries[0]?.vulnerabilityName.length).toBe(512);
    expect(r.entries[0]?.shortDescription.length).toBe(4096);
  });
});

describe("fetchKevFeed", () => {
  it("returns parsed feed on first-attempt success", async () => {
    const fetchImpl = (async () =>
      new Response(VALID_FEED, { status: 200 })) as unknown as typeof fetch;
    const r = await fetchKevFeed({
      feedUrl: "https://example/feed.json",
      timeoutMs: 5_000,
      maxBytes: 50 * 1024 * 1024,
      fetchImpl,
      sleep: async () => {},
    });
    expect(r.attempts).toBe(1);
    expect(r.httpStatusFinal).toBe(200);
    expect(r.entries.length).toBe(2);
  });

  it("retries on 5xx then succeeds", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n < 2) return new Response("oops", { status: 503 });
      return new Response(VALID_FEED, { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchKevFeed({
      feedUrl: "https://example/feed.json",
      timeoutMs: 5_000,
      maxBytes: 50 * 1024 * 1024,
      fetchImpl,
      sleep: async () => {},
    });
    expect(r.attempts).toBe(2);
  });

  it("does not retry 4xx (except 429)", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(
      fetchKevFeed({
        feedUrl: "https://example/feed.json",
        timeoutMs: 5_000,
        maxBytes: 50 * 1024 * 1024,
        fetchImpl,
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ kind: "4xx", status: 404 });
    expect(n).toBe(1);
  });

  it("rejects bodies past maxBytes (Content-Length-detected)", async () => {
    const fetchImpl = (async () =>
      new Response(VALID_FEED, {
        status: 200,
        headers: { "content-length": "999999999" },
      })) as unknown as typeof fetch;
    await expect(
      fetchKevFeed({
        feedUrl: "https://example/feed.json",
        timeoutMs: 5_000,
        maxBytes: 1024,
        fetchImpl,
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ kind: "size_exceeded" });
  });

  it("rejects bodies past maxBytes (post-read fallback)", async () => {
    const big = "x".repeat(2048);
    const fetchImpl = (async () =>
      new Response(big, { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchKevFeed({
        feedUrl: "https://example/feed.json",
        timeoutMs: 5_000,
        maxBytes: 1024,
        fetchImpl,
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ kind: "size_exceeded" });
  });
});
