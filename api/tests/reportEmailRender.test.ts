// ADR-0030 Phase C §C.6 — email renderer unit tests.

import { describe, it, expect } from "vitest";
import { renderEmailHtml } from "../src/lib/reportEmailRender.js";
import type { ReportSnapshotEnvelope } from "../src/lib/reportSnapshotStore.js";

function makeEnvelope(overrides: Partial<ReportSnapshotEnvelope> = {}): ReportSnapshotEnvelope {
  return {
    schemaVersion: 1,
    contentType: "application/json",
    tenantId: "tenant-x",
    periodKey: "2026-W19",
    periodCadence: "weekly",
    periodStart: "2026-05-04",
    periodEnd: "2026-05-10",
    capturedAt: "2026-05-11T08:00:00.000Z",
    capturedBy: "admin",
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

describe("renderEmailHtml — subject", () => {
  it("auto-generates subject with prefix and period (cadence word included)", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      subjectPrefix: "[Aegis]",
    });
    // §6.3 email-body batch #2 — cadence word ("weekly") now in the subject
    // (test envelope has periodCadence: "weekly").
    expect(r.subject).toBe("[Aegis] Aegis weekly report — 2026-W19");
  });

  it("omits prefix when empty (cadence word included)", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.subject).toBe("Aegis weekly report — 2026-W19");
  });

  it("caps subject at 78 chars (RFC 5322 §2.1.1)", () => {
    const r = renderEmailHtml(makeEnvelope({ periodKey: "2026-W19" }), {
      productName: "ProductWithAVeryLongNameThatPushesPastTheLimit",
      senderMailbox: "noreply@x.com",
      subjectPrefix: "[Some-Quite-Long-Tenant-Prefix-Marker]",
    });
    expect(r.subject.length).toBeLessThanOrEqual(78);
    expect(r.subject).toContain("[Some-Quite-Long-Tenant-Prefix-Marker]");
    expect(r.subject.endsWith("…")).toBe(true);
  });
});

describe("renderEmailHtml — body", () => {
  it("emits XHTML 1.0 Transitional DOCTYPE", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html.startsWith("<!DOCTYPE html PUBLIC")).toBe(true);
    expect(r.html).toContain("xhtml1-transitional.dtd");
  });

  it("renders KPI rows when sections present", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).toContain("Microsoft Secure Score");
    expect(r.html).toContain("72.3%");
    expect(r.html).toContain("Active incidents");
    expect(r.html).toContain("Risky users (total)");
  });

  it("renders fallback message when no KPIs are available", () => {
    const env = makeEnvelope({
      sections: {
        secureScore: null,
        incidents: null,
        entraRisk: null,
        brief: null,
        posture: null,
        ingestHealth: null,
      },
    });
    const r = renderEmailHtml(env, {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).toContain("No headline metrics available");
  });

  it("renders operator note when present", () => {
    const r = renderEmailHtml(makeEnvelope({ operatorNote: "Notable change this week" }), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).toContain("Operator note");
    expect(r.html).toContain("Notable change this week");
  });

  it("escapes HTML in operator note", () => {
    const r = renderEmailHtml(makeEnvelope({ operatorNote: "<script>alert(1)</script>" }), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).not.toContain("<script>alert");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes HTML in productName and senderMailbox", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "<bad>Aegis</bad>",
      senderMailbox: "no<reply@x.com",
    });
    expect(r.html).not.toContain("<bad>Aegis</bad>");
    expect(r.html).toContain("&lt;bad&gt;Aegis&lt;/bad&gt;");
    expect(r.html).toContain("no&lt;reply@x.com");
  });

  it("uses inline styles only — no <style> blocks", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).not.toMatch(/<style[^>]*>/i);
  });

  it("pins body width at 600px", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).toContain("width:600px");
  });

  it("includes the 'do not reply' banner", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).toContain("do not reply");
    expect(r.html).toContain("noreply@x.com");
  });
});

// §C.22 — share-link rendering: when shareUrl is set, the body switches
// from KPI rows to summary + "Open full report" button + plain URL.
describe("renderEmailHtml — share link (§C.22)", () => {
  const SHARE_URL =
    "https://victorious-smoke-0d6c13a03.7.azurestaticapps.net/api/reports/share/abcdef.ghijkl";

  it("renders the styled 'Open full report' button when shareUrl is set", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: SHARE_URL,
    });
    expect(r.html).toContain("Open full report");
    expect(r.html).toContain(`href="${SHARE_URL}"`);
  });

  it("renders the plain text URL fallback for Outlook strip-styles", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: SHARE_URL,
    });
    expect(r.html).toContain(`Link:`);
    // The URL appears at least twice: button href + plain-text link.
    const matches = r.html.match(new RegExp(SHARE_URL.replace(/\//g, "\\/"), "g"));
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT render a summary line — body directs to the report (§6.3 batch #3)", () => {
    // Operator intent 2026-06-25: "keep it simple, direct users to the
    // report only". The KPI digest used to appear above the button as a
    // "Summary: Secure Score X% · N active incidents · ..." line; it was
    // duplicating content with the linked report. Removed entirely in
    // share-link mode. The legacy KPI-fallback mode (no shareUrl) keeps
    // its KPI table as the safety net when KV is down — covered
    // separately below.
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: SHARE_URL,
    });
    expect(r.html).not.toContain("Summary:");
    // The KPI label strings must not bleed through either.
    expect(r.html).not.toContain("Microsoft Secure Score");
    expect(r.html).not.toContain("Active incidents");
    expect(r.html).not.toContain("Risky users (total)");
    // ...but the button must still be present.
    expect(r.html).toContain("Open full report");
  });

  it("does NOT render a summary fallback line when no KPIs are present", () => {
    // Symmetry with the previous test — the no-KPI variant of the old
    // summary line ("Open the link below to view the full report.") is
    // also gone. The button + plain-text URL carry the recipient to the
    // report.
    const env = makeEnvelope();
    (env as { sections: Record<string, unknown> }).sections = {};
    const r = renderEmailHtml(env, {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: SHARE_URL,
    });
    expect(r.html).not.toContain("Open the link below to view the full report.");
    expect(r.html).toContain("Open full report");
  });

  it("escapes shareUrl in both href and visible text", () => {
    // Defensive: a malformed URL containing `"` or `<` must not break the
    // button markup or be interpreted by the browser. The orchestrator
    // builds the URL from a trusted base + base64url-only token, so the
    // attack surface is theoretical — pin the contract anyway.
    const dirty = "https://example.com/share/abc\"<script>alert(1)</script>";
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: dirty,
    });
    expect(r.html).not.toContain("<script>alert(1)</script>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("falls back to legacy KPI rows when shareUrl is empty string", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: "",
    });
    // Should NOT render the button.
    expect(r.html).not.toContain("Open full report");
    // SHOULD render KPI rows (Secure Score in the label form).
    expect(r.html).toContain("Microsoft Secure Score");
  });

  it("falls back to legacy KPI rows when shareUrl is undefined", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).not.toContain("Open full report");
    expect(r.html).toContain("Microsoft Secure Score");
  });
});

describe("renderEmailHtml — subject cadence word (§6.3 batch #2)", () => {
  it("includes 'monthly' when periodCadence is monthly", () => {
    const r = renderEmailHtml(
      makeEnvelope({ periodCadence: "monthly", periodKey: "2026-05" }),
      { productName: "Aegis", senderMailbox: "noreply@x.com" },
    );
    expect(r.subject).toBe("Aegis monthly report — 2026-05");
  });

  it("includes 'quarterly' when periodCadence is quarterly", () => {
    const r = renderEmailHtml(
      makeEnvelope({ periodCadence: "quarterly", periodKey: "2026-Q2" }),
      { productName: "Aegis", senderMailbox: "noreply@x.com" },
    );
    expect(r.subject).toBe("Aegis quarterly report — 2026-Q2");
  });

  it("falls back to plain 'report' on unknown cadence", () => {
    // Defence-in-depth: unknown cadence values (forward-compat envelope
    // shapes) must not throw — falls back to legacy "report" wording.
    const r = renderEmailHtml(
      // @ts-expect-error — testing forward-compat fallback
      makeEnvelope({ periodCadence: "annual", periodKey: "2026" }),
      { productName: "Aegis", senderMailbox: "noreply@x.com" },
    );
    expect(r.subject).toBe("Aegis report — 2026");
  });
});

describe("renderEmailHtml — tenant logo (§6.3 batch #2)", () => {
  // 1x1 transparent PNG, ~70 bytes when base64. Real envelope logos are
  // 5-50KB but a tiny payload is fine for the contract test.
  const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

  it("renders <img> in the header when envelope.branding.logoDataUrl is a valid PNG data URI", () => {
    const r = renderEmailHtml(
      makeEnvelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#1f2937",
          footerText: "",
          logoDataUrl: TINY_PNG,
        },
      }),
      { productName: "Aegis", senderMailbox: "noreply@x.com" },
    );
    expect(r.html).toContain(`<img src="${TINY_PNG}"`);
    expect(r.html).toContain('alt="Aegis logo"');
  });

  it("renders logo above the title in the structural ordering", () => {
    const r = renderEmailHtml(
      makeEnvelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#1f2937",
          footerText: "",
          logoDataUrl: TINY_PNG,
        },
      }),
      { productName: "Aegis", senderMailbox: "noreply@x.com" },
    );
    const logoIdx = r.html.indexOf(`<img src="${TINY_PNG}"`);
    const titleIdx = r.html.indexOf("Aegis report — 2026-W19");
    expect(logoIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(-1);
    expect(logoIdx).toBeLessThan(titleIdx);
  });

  it("omits the logo when envelope has no branding block", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).not.toContain("data:image/");
  });

  it("omits the logo when branding has no logoDataUrl", () => {
    const r = renderEmailHtml(
      makeEnvelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#1f2937",
          footerText: "",
        },
      }),
      { productName: "Aegis", senderMailbox: "noreply@x.com" },
    );
    expect(r.html).not.toContain("data:image/");
  });

  it("rejects SVG data URIs (ADR-0029 §Decision.5 — SVG can carry script)", () => {
    // Even if a future bug let an SVG data URI flow into the envelope, the
    // renderer's strict prefix allowlist must reject it.
    const svgUrl =
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=";
    const r = renderEmailHtml(
      makeEnvelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#1f2937",
          footerText: "",
          logoDataUrl: svgUrl,
        },
      }),
      { productName: "Aegis", senderMailbox: "noreply@x.com" },
    );
    expect(r.html).not.toContain("svg+xml");
    expect(r.html).not.toContain("<img src");
  });

  it("rejects non-image data URIs (e.g. text/html)", () => {
    const dirty = "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==";
    const r = renderEmailHtml(
      makeEnvelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#1f2937",
          footerText: "",
          logoDataUrl: dirty,
        },
      }),
      { productName: "Aegis", senderMailbox: "noreply@x.com" },
    );
    // The dirty data URI must NOT land in the HTML. `text/html` appears
    // legitimately in the document's <meta Content-Type> so we check the
    // specific data URI body instead.
    expect(r.html).not.toContain(dirty);
    expect(r.html).not.toContain("data:text/html");
    expect(r.html).not.toContain("<img src");
  });

  it("rejects oversized data URIs (>200KB) defensively", () => {
    const oversized = "data:image/png;base64," + "A".repeat(200_001);
    const r = renderEmailHtml(
      makeEnvelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#1f2937",
          footerText: "",
          logoDataUrl: oversized,
        },
      }),
      { productName: "Aegis", senderMailbox: "noreply@x.com" },
    );
    expect(r.html).not.toContain("<img src");
  });

  it("accepts WebP and JPEG image data URIs", () => {
    for (const ct of ["webp", "jpeg"]) {
      const url = `data:image/${ct};base64,AAAA`;
      const r = renderEmailHtml(
        makeEnvelope({
          branding: {
            productName: "Aegis",
            primaryHex: "#1f2937",
            footerText: "",
            logoDataUrl: url,
          },
        }),
        { productName: "Aegis", senderMailbox: "noreply@x.com" },
      );
      expect(r.html).toContain(`<img src="${url}"`);
    }
  });
});

describe("renderEmailHtml — greeting + intro + sign-off (§6.3 email body batch)", () => {
  const SHARE_URL = "https://example.com/api/reports/share/abc123";

  it("renders the generic 'Hello,' greeting under the title", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: SHARE_URL,
    });
    expect(r.html).toContain("Hello,");
  });

  it("renders intro paragraph with productName + period range when shareUrl is set", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: SHARE_URL,
    });
    expect(r.html).toContain("Here is your Aegis security report for 2026-05-04 — 2026-05-10");
    // §6.3 batch #3 — direct to report only; intro wording tightened.
    // Note: apostrophe in source string ("period's") is HTML-escaped to
    // &#39; in the rendered output (defensive escape on every interpolated
    // value), so we split the assertion either side of the apostrophe.
    expect(r.html).toContain("Open the full report below to review this period");
    expect(r.html).toContain("security posture and trends.");
  });

  it("renders shorter intro paragraph when shareUrl is absent (legacy KPI fallback)", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
    });
    expect(r.html).toContain("Here is your Aegis security report for 2026-05-04 — 2026-05-10");
    expect(r.html).toContain("The headline numbers are below.");
    // The "Open the full report below" tail must NOT appear in the
    // fallback shape — there is no link to click.
    expect(r.html).not.toContain("Open the full report below");
  });

  it("renders sign-off block branded to productName", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: SHARE_URL,
    });
    expect(r.html).toContain("Thanks,");
    expect(r.html).toContain("The Aegis team");
  });

  it("escapes productName in greeting + intro + sign-off + footer", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "<bad>Aegis</bad>",
      senderMailbox: "noreply@x.com",
      shareUrl: SHARE_URL,
    });
    expect(r.html).not.toContain("<bad>Aegis</bad>");
    expect(r.html).toContain("&lt;bad&gt;Aegis&lt;/bad&gt;");
    // Intro line uses productName verbatim — the escape must hit there too.
    expect(r.html).toContain("Here is your &lt;bad&gt;Aegis&lt;/bad&gt; security report");
  });

  it("footer drops internal jargon (no 'audit chain' / no '/admin/email')", () => {
    const r = renderEmailHtml(makeEnvelope(), {
      productName: "Aegis",
      senderMailbox: "noreply@x.com",
      shareUrl: SHARE_URL,
    });
    expect(r.html).not.toContain("audit chain");
    expect(r.html).not.toContain("/admin/email");
    expect(r.html).toContain("replies are not monitored");
    expect(r.html).toContain("contact your security administrator");
  });

  it("preserves the structural ordering: title → period → operator-note → greeting → intro → content → sign-off → footer", () => {
    const r = renderEmailHtml(
      makeEnvelope({ operatorNote: "Notable change this week" }),
      {
        productName: "Aegis",
        senderMailbox: "noreply@x.com",
        shareUrl: SHARE_URL,
      },
    );
    const html = r.html;
    const orderMarkers = [
      "Aegis report — 2026-W19", // title
      "Period:", // period line
      "Notable change this week", // operator note
      "Hello,", // greeting
      "Here is your Aegis security report", // intro
      "Open full report", // CTA (content row in shareUrl mode)
      "The Aegis team", // sign-off
      "replies are not monitored", // footer
    ];
    let lastIndex = -1;
    for (const marker of orderMarkers) {
      const idx = html.indexOf(marker);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });
});
