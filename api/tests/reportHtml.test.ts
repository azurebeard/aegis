// ADR-0030 — envelope-to-HTML renderer tests.
//
// Three behaviour pillars:
//   1. Output is a valid standalone HTML document
//   2. Every interpolation is HTML-escaped — no operator/Microsoft prose
//      ever survives as live markup (XSS-safe by construction)
//   3. Coercion paths produce a degraded-but-safe document on malformed
//      sections, never throwing

import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  html,
  raw,
  renderEnvelopeHtml,
} from "../src/lib/reportHtml.js";
import type { ReportSnapshotEnvelope } from "../src/lib/reportSnapshotStore.js";

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function envelope(overrides: Partial<ReportSnapshotEnvelope> = {}): ReportSnapshotEnvelope {
  return {
    schemaVersion: 1,
    contentType: "application/json",
    tenantId: "tenant-1",
    periodKey: "2026-04",
    periodCadence: "monthly",
    periodStart: "2026-04-01T00:00:00.000Z",
    periodEnd: "2026-04-30T23:59:59.999Z",
    capturedAt: "2026-04-29T10:00:00.000Z",
    capturedBy: "operator-oid",
    version: 1,
    sections: {
      secureScore: null,
      incidents: null,
      entraRisk: null,
      brief: null,
      posture: null,
      ingestHealth: [],
    },
    derived: {},
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml('<>&"\'')).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("returns empty string for null/undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("stringifies non-string values before escaping", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(true)).toBe("true");
  });
});

describe("html tagged template", () => {
  it("auto-escapes interpolated values", () => {
    const out = html`<p>${HOSTILE}</p>`;
    expect(out).not.toContain("<img src=x");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;img src=x");
  });

  it("preserves raw() values verbatim", () => {
    const inner = html`<em>${"x"}</em>`;
    const outer = html`<p>${raw(inner)}</p>`;
    expect(outer).toBe("<p><em>x</em></p>");
  });

  it("escapes raw text but not surrounding template literals", () => {
    const out = html`<a href="${"javascript:alert(1)"}">click</a>`;
    expect(out).toContain('href="javascript:alert(1)"' satisfies string);
    // Note: escape-on-content prevents `<` injection into the HREF VALUE,
    // which is what matters for HTML structure. URL-scheme filtering is
    // a separate concern for any caller that takes operator-supplied URLs;
    // this template never does.
  });
});

describe("renderEnvelopeHtml — structure", () => {
  it("returns a complete HTML5 document", () => {
    const out = renderEnvelopeHtml(envelope());
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<html lang=\"en\">");
    expect(out).toContain("</html>");
    // Period prose replaces the old `monthly · 2026-04` form.
    expect(out).toContain("<title>Aegis report — April 2026</title>");
  });

  it("renders empty-state messages when sections are absent", () => {
    const out = renderEnvelopeHtml(envelope());
    expect(out).toContain("No Microsoft Secure Score snapshot was available");
    expect(out).toContain("No incident data was available");
    expect(out).toContain("No brief was available");
    expect(out).toContain("No posture narrative was available");
    // §10.62 — new sections also empty-state when absent from the envelope
    // (forward-compat path: snapshots captured before §10.62 omit them).
    expect(out).toContain("No Defender for Cloud Secure Score snapshot was available");
    expect(out).toContain("No Conditional Access policy data was available");
    expect(out).toContain("No dormancy data was available");
    expect(out).toContain("No sign-in data was available");
  });

  it("does not include any <script> tags or external <link>s", () => {
    const out = renderEnvelopeHtml(envelope());
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<link rel");
  });

  it("translates `system.timer` capturedBy to a friendly label", () => {
    const out = renderEnvelopeHtml(envelope({ capturedBy: "system.timer" }));
    expect(out).toContain("auto-capture (Timer)");
  });
});

describe("renderEnvelopeHtml — XSS-safe by construction", () => {
  it("escapes hostile envelope.tenantId", () => {
    const out = renderEnvelopeHtml(envelope({ tenantId: HOSTILE + "0123" }));
    expect(out).not.toContain("<img src=x onerror");
    expect(out).not.toContain("<script>alert(2)");
  });

  it("escapes hostile capturedBy", () => {
    const out = renderEnvelopeHtml(envelope({ capturedBy: HOSTILE }));
    expect(out).not.toContain("<img src=x onerror");
  });

  it("escapes hostile brief body (ADR-0012 §5 plain-text invariant)", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: null,
          entraRisk: null,
          brief: { briefDate: "2026-04-29", body: HOSTILE, modelDeployment: "gpt-4" },
          posture: null,
          ingestHealth: [],
        },
      }),
    );
    expect(out).not.toContain("<img src=x onerror");
    expect(out).not.toContain("<script>alert(2)");
    expect(out).toContain("&lt;img src=x");
  });

  it("escapes hostile incident displayName", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: {
            counts: { activeCount: 1, highSeverityCount: 0 },
            preview: [
              {
                id: "i-1",
                displayName: HOSTILE,
                severity: "high",
                status: "active",
                classification: "unknown",
                determination: "",
                priorityScore: null,
                assignedTo: null,
                createdDateTime: "2026-04-29T00:00:00Z",
                lastUpdateDateTime: "2026-04-29T00:00:00Z",
                alertCount: 1,
                customTags: [],
                systemTags: [],
                incidentWebUrl: "",
                hasRedirect: false,
              },
            ],
          },
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
      }),
    );
    expect(out).not.toContain("<img src=x onerror");
  });

  it("escapes hostile ingest-health source field", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: null,
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [
            {
              tenantId: "t",
              source: HOSTILE,
              status: "healthy",
              lastSuccessAt: "2026-04-29T00:00:00Z",
              lastFailureAt: null,
              consecutiveFailureCount: 0,
              lastRunId: null,
              lastAuditSeq: 0,
              lastLineSha256: null,
              etag: "",
            },
          ],
        },
      }),
    );
    expect(out).not.toContain("<img src=x onerror");
  });
});

describe("renderEnvelopeHtml — secure-score sparkline", () => {
  it("renders an inline SVG path when trend has 2+ points", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: {
            snapshot: {
              snapshotDate: "2026-04-29",
              createdDateTime: "2026-04-29T00:00:00Z",
              ingestedAt: "2026-04-29T00:00:00Z",
              currentScore: 47,
              maxScore: 100,
              percentage: 47.0,
              activeUserCount: 100,
              licensedUserCount: 100,
              enabledServices: [],
              averageComparativeScores: [],
              controlScores: [],
              graphId: "g",
              ingestRunId: "r",
            },
            trend: [
              { date: "2026-01-29", percentage: 44.0 },
              { date: "2026-04-29", percentage: 47.0 },
            ],
          },
          incidents: null,
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
      }),
    );
    expect(out).toContain("<svg");
    expect(out).toContain('d="M ');
    // Path coordinates are numeric (no string interpolation into d="...")
    expect(out).toMatch(/d="M [\d. ,L]+ ?"/);
    // 90-day delta surfaces in the kvTable
    expect(out).toContain("+3.0 pp");
  });

  it("omits the sparkline when fewer than 2 trend points exist", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: {
            snapshot: {
              snapshotDate: "2026-04-29",
              createdDateTime: "2026-04-29T00:00:00Z",
              ingestedAt: "2026-04-29T00:00:00Z",
              currentScore: 47,
              maxScore: 100,
              percentage: 47.0,
              activeUserCount: 100,
              licensedUserCount: 100,
              enabledServices: [],
              averageComparativeScores: [],
              controlScores: [],
              graphId: "g",
              ingestRunId: "r",
            },
            trend: [{ date: "2026-04-29", percentage: 47.0 }],
          },
          incidents: null,
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
      }),
    );
    expect(out).not.toContain("<svg");
  });
});

describe("renderEnvelopeHtml — branding propagation", () => {
  it("renders the operator's productName in title + header eyebrow", () => {
    const out = renderEnvelopeHtml(
      envelope({
        branding: { productName: "Acme Security", primaryHex: "#7c3aed", footerText: "" },
      }),
    );
    expect(out).toContain("<title>Acme Security report — April 2026</title>");
    expect(out).toContain("Acme Security security report");
  });

  it("uses primaryHex as the accent in header border + sparkline stroke", () => {
    const out = renderEnvelopeHtml(
      envelope({
        branding: { productName: "Aegis", primaryHex: "#7c3aed", footerText: "" },
        sections: {
          secureScore: {
            snapshot: {
              snapshotDate: "2026-04-29",
              createdDateTime: "2026-04-29T00:00:00Z",
              ingestedAt: "2026-04-29T00:00:00Z",
              currentScore: 47,
              maxScore: 100,
              percentage: 47.0,
              activeUserCount: 0,
              licensedUserCount: 0,
              enabledServices: [],
              averageComparativeScores: [],
              controlScores: [],
              graphId: "g",
              ingestRunId: "r",
            },
            trend: [
              { date: "2026-01-29", percentage: 44.0 },
              { date: "2026-04-29", percentage: 47.0 },
            ],
          },
          incidents: null,
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
      }),
    );
    expect(out).toContain("border-bottom:4px solid #7c3aed");
    expect(out).toContain('stroke="#7c3aed"');
  });

  it("renders branding.footerText when set", () => {
    const out = renderEnvelopeHtml(
      envelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#0078D4",
          footerText: "Confidential — board distribution only",
        },
      }),
    );
    expect(out).toContain("Confidential — board distribution only");
  });

  it("falls back to default branding when envelope.branding is absent", () => {
    const out = renderEnvelopeHtml(envelope({ branding: undefined }));
    expect(out).toContain("Aegis security report");
    expect(out).toContain("border-bottom:4px solid #0078D4");
  });

  it("rejects an invalid primaryHex (CSS-injection guard)", () => {
    const out = renderEnvelopeHtml(
      envelope({
        branding: {
          productName: "Aegis",
          // Not a valid hex — sanitiseBranding falls back to default.
          primaryHex: "red; background:url(javascript:alert(1))",
          footerText: "",
        },
      }),
    );
    expect(out).not.toContain("javascript:");
    expect(out).toContain("border-bottom:4px solid #0078D4");
  });

  it("escapes hostile productName + footerText (XSS-safe by construction)", () => {
    const out = renderEnvelopeHtml(
      envelope({
        branding: {
          productName: HOSTILE,
          primaryHex: "#0078D4",
          footerText: HOSTILE,
        },
      }),
    );
    expect(out).not.toContain("<img src=x onerror");
    expect(out).not.toContain("<script>alert(2)");
  });
});

describe("renderEnvelopeHtml — period prose", () => {
  it("renders monthly periods as `Month YYYY`", () => {
    const out = renderEnvelopeHtml(
      envelope({
        periodCadence: "monthly",
        periodKey: "2026-04",
        periodStart: "2026-04-01T00:00:00.000Z",
        periodEnd: "2026-04-30T23:59:59.999Z",
      }),
    );
    expect(out).toContain("April 2026");
    expect(out).not.toContain("monthly · 2026-04");
  });

  it("renders quarterly periods as `Qn YYYY (Month–Month)`", () => {
    const out = renderEnvelopeHtml(
      envelope({
        periodCadence: "quarterly",
        periodKey: "2026-Q2",
        periodStart: "2026-04-01T00:00:00.000Z",
        periodEnd: "2026-06-30T23:59:59.999Z",
      }),
    );
    expect(out).toContain("Q2 2026 (April–June)");
  });

  it("renders weekly periods as `Week N of YYYY (range)`", () => {
    const out = renderEnvelopeHtml(
      envelope({
        periodCadence: "weekly",
        periodKey: "2026-W17",
        periodStart: "2026-04-20T00:00:00.000Z",
        periodEnd: "2026-04-26T23:59:59.999Z",
      }),
    );
    expect(out).toContain("Week 17 of 2026 (20–26 April)");
  });

  it("falls back to periodKey on malformed period dates", () => {
    const out = renderEnvelopeHtml(
      envelope({
        periodStart: "not-a-date",
        periodEnd: "also-not-a-date",
      }),
    );
    expect(out).toContain("2026-04");
  });
});

describe("renderEnvelopeHtml — executive summary", () => {
  it("renders the Secure Score / Incidents / KEV three-line summary when data present", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: {
            snapshot: {
              snapshotDate: "2026-04-29",
              createdDateTime: "2026-04-29T00:00:00Z",
              ingestedAt: "2026-04-29T00:00:00Z",
              currentScore: 47,
              maxScore: 100,
              percentage: 47.0,
              activeUserCount: 0,
              licensedUserCount: 0,
              enabledServices: [],
              averageComparativeScores: [],
              controlScores: [],
              graphId: "g",
              ingestRunId: "r",
            },
            trend: [
              { date: "2026-01-29", percentage: 44.0 },
              { date: "2026-04-29", percentage: 47.0 },
            ],
          },
          incidents: {
            counts: { activeCount: 12, highSeverityCount: 3 },
            preview: [],
          },
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
          stackKevExposure: {
            totalStackItems: 47,
            totalMatches: 50,
            openMatches: 47,
            dueThisWeek: 5,
            ransomwareLinkedOpen: 2,
            topExposures: [],
          },
        },
      }),
    );
    expect(out).toContain("Executive summary");
    expect(out).toContain("47.0%");
    expect(out).toContain("(+3.0 pp 90d)");
    expect(out).toContain("12</strong> active incidents, 3 high-severity");
    expect(out).toContain("47</strong> open KEV match");
    expect(out).toContain("2 ransomware-linked");
  });

  it("omits the executive summary when no data sources are present", () => {
    const out = renderEnvelopeHtml(envelope());
    expect(out).not.toContain("Executive summary");
  });
});

describe("renderEnvelopeHtml — KEV exposure section", () => {
  it("renders the hero figure + top-exposures table", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: null,
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
          stackKevExposure: {
            totalStackItems: 5,
            totalMatches: 8,
            openMatches: 7,
            dueThisWeek: 2,
            ransomwareLinkedOpen: 1,
            topExposures: [
              {
                stackItemId: "id-1",
                vendor: "Microsoft",
                product: "Windows Server 2022",
                version: "21H2",
                openMatches: 3,
                totalMatches: 4,
                ransomwareLinked: true,
              },
              {
                stackItemId: "id-2",
                vendor: "VMware",
                product: "ESXi",
                version: "",
                openMatches: 2,
                totalMatches: 2,
                ransomwareLinked: false,
              },
            ],
          },
        },
      }),
    );
    expect(out).toContain("KEV exposure");
    expect(out).toContain(">7</p>"); // hero figure
    expect(out).toContain("5 stack items · 2 due this week · 1 ransomware-linked");
    expect(out).toContain("Microsoft");
    expect(out).toContain("Windows Server 2022");
    expect(out).toContain("VMware");
    expect(out).toContain(">ransomware<"); // ransomware badge
  });

  it("renders empty-state when no stack inventory has been registered", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: null,
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
          stackKevExposure: {
            totalStackItems: 0,
            totalMatches: 0,
            openMatches: 0,
            dueThisWeek: 0,
            ransomwareLinkedOpen: 0,
            topExposures: [],
          },
        },
      }),
    );
    expect(out).toContain("No stack inventory has been registered");
  });

  it("escapes hostile vendor / product strings in the KEV table (XSS-safe)", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: null,
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
          stackKevExposure: {
            totalStackItems: 1,
            totalMatches: 1,
            openMatches: 1,
            dueThisWeek: 0,
            ransomwareLinkedOpen: 0,
            topExposures: [
              {
                stackItemId: "id-1",
                vendor: HOSTILE,
                product: HOSTILE,
                version: HOSTILE,
                openMatches: 1,
                totalMatches: 1,
                ransomwareLinked: false,
              },
            ],
          },
        },
      }),
    );
    expect(out).not.toContain("<img src=x onerror");
    expect(out).not.toContain("<script>alert(2)");
  });
});

describe("renderEnvelopeHtml — logo embed", () => {
  const TINY_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("renders an inline <img> with the data URL when branding.logoDataUrl is set", () => {
    const out = renderEnvelopeHtml(
      envelope({
        branding: {
          productName: "Acme",
          primaryHex: "#0078D4",
          footerText: "",
          logoDataUrl: `data:image/png;base64,${TINY_PNG_B64}`,
        },
      }),
    );
    expect(out).toContain(`<img src="data:image/png;base64,${TINY_PNG_B64}"`);
    expect(out).toContain('alt="Acme logo"');
  });

  it("rejects a hostile non-image data URI (defence in depth)", () => {
    const out = renderEnvelopeHtml(
      envelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#0078D4",
          footerText: "",
          // SVG can carry script — deliberately rejected per ADR-0029 §Decision.5
          logoDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        },
      }),
    );
    expect(out).not.toContain("data:image/svg+xml");
  });

  it("rejects a data URL impersonator (text/html)", () => {
    const out = renderEnvelopeHtml(
      envelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#0078D4",
          footerText: "",
          logoDataUrl: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        },
      }),
    );
    expect(out).not.toContain("data:text/html");
    expect(out).not.toContain("<script>alert(1)</script>");
  });

  it("rejects an oversized data URL at render time (envelope-cap belt-and-braces)", () => {
    const huge = "A".repeat(300_000);
    const out = renderEnvelopeHtml(
      envelope({
        branding: {
          productName: "Aegis",
          primaryHex: "#0078D4",
          footerText: "",
          logoDataUrl: `data:image/png;base64,${huge}`,
        },
      }),
    );
    expect(out).not.toContain(huge);
  });

  it("omits the <img> entirely when logoDataUrl is absent", () => {
    const out = renderEnvelopeHtml(envelope({ branding: undefined }));
    expect(out).not.toContain("<img ");
  });
});

describe("renderEnvelopeHtml — comparative period", () => {
  interface SsOverrides {
    readonly currentPct: number;
    readonly comparison?: {
      readonly priorPeriodKey: string;
      readonly priorSecureScorePercentage: number | null;
      readonly priorCapturedAt: string;
    };
  }
  function ssEnvelope(overrides: SsOverrides) {
    return envelope({
      sections: {
        secureScore: {
          snapshot: {
            snapshotDate: "2026-04-29",
            createdDateTime: "2026-04-29T00:00:00Z",
            ingestedAt: "2026-04-29T00:00:00Z",
            currentScore: Math.round(overrides.currentPct),
            maxScore: 100,
            percentage: overrides.currentPct,
            activeUserCount: 0,
            licensedUserCount: 0,
            enabledServices: [],
            averageComparativeScores: [],
            controlScores: [],
            graphId: "g",
            ingestRunId: "r",
          },
          trend: [],
        },
        incidents: null,
        entraRisk: null,
        brief: null,
        posture: null,
        ingestHealth: [],
      },
      ...(overrides.comparison ? { comparison: overrides.comparison } : {}),
    });
  }

  it("renders an UP suffix when current > prior", () => {
    const out = renderEnvelopeHtml(
      ssEnvelope({
        currentPct: 47,
        comparison: {
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: 44,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      }),
    );
    expect(out).toContain("UP</strong> from 44.0% last period");
  });

  it("renders a DOWN suffix when current < prior", () => {
    const out = renderEnvelopeHtml(
      ssEnvelope({
        currentPct: 41,
        comparison: {
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: 44,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      }),
    );
    expect(out).toContain("DOWN</strong> from 44.0% last period");
  });

  it("renders a flat suffix when current ≈ prior (within 0.05pp)", () => {
    const out = renderEnvelopeHtml(
      ssEnvelope({
        currentPct: 44.02,
        comparison: {
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: 44.0,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      }),
    );
    expect(out).toContain("flat vs prior period (44.0%)");
  });

  it("omits the suffix when no comparison field is present", () => {
    const out = renderEnvelopeHtml(ssEnvelope({ currentPct: 47 }));
    expect(out).not.toContain("UP</strong>");
    expect(out).not.toContain("DOWN</strong>");
    expect(out).not.toContain("flat vs prior");
  });

  it("omits the suffix when comparison.priorSecureScorePercentage is null", () => {
    const out = renderEnvelopeHtml(
      ssEnvelope({
        currentPct: 47,
        comparison: {
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: null,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      }),
    );
    expect(out).not.toContain("UP</strong>");
    expect(out).not.toContain("DOWN</strong>");
  });
});

describe("renderEnvelopeHtml — operator note", () => {
  it("renders an Operator note callout when envelope.operatorNote is set", () => {
    const out = renderEnvelopeHtml(
      envelope({
        operatorNote: "Onboarded customer X this month. Deprecated server Y.",
      }),
    );
    expect(out).toContain("Operator note");
    expect(out).toContain("Onboarded customer X this month");
    expect(out).toContain("Deprecated server Y");
  });

  it("escapes hostile operator note content", () => {
    const out = renderEnvelopeHtml(
      envelope({ operatorNote: HOSTILE }),
    );
    expect(out).not.toContain("<img src=x onerror");
    expect(out).not.toContain("<script>alert(2)");
  });

  it("omits the callout when operatorNote is empty / absent", () => {
    expect(renderEnvelopeHtml(envelope())).not.toContain("Operator note");
    expect(renderEnvelopeHtml(envelope({ operatorNote: "" }))).not.toContain(
      "Operator note",
    );
  });

  it("splits multi-paragraph notes on blank lines", () => {
    const out = renderEnvelopeHtml(
      envelope({ operatorNote: "First paragraph.\n\nSecond paragraph." }),
    );
    expect(out.match(/Operator note/g)?.length).toBe(1);
    // Two <p> rendered for the two paragraphs.
    expect(out).toContain("First paragraph.");
    expect(out).toContain("Second paragraph.");
  });
});

describe("renderEnvelopeHtml — chain-of-custody footer", () => {
  it("includes schemaVersion + capturedAt + tenant prefix + period key + version", () => {
    const out = renderEnvelopeHtml(envelope());
    expect(out).toContain("tenant-1");
    expect(out).toContain("2026-04");
    expect(out).toContain("schema v1");
    expect(out).toContain("2026-04-29T10:00:00.000Z");
  });

  it("includes the captureRunId prefix when set", () => {
    const out = renderEnvelopeHtml(
      envelope({ captureRunId: "550e8400-e29b-41d4-a716-446655440000" }),
    );
    expect(out).toContain("run <code>550e8400…</code>");
  });

  it("omits the run line when captureRunId is absent", () => {
    const out = renderEnvelopeHtml(envelope());
    expect(out).not.toContain("run <code>");
  });

  it("links to the audit-chain source", () => {
    const out = renderEnvelopeHtml(envelope());
    expect(out).toContain("source <code>report.snapshot</code>");
  });
});

describe("renderEnvelopeHtml — incident trend sparkline", () => {
  it("renders a second SVG when incident trend has 2+ days", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: {
            counts: { activeCount: 5, highSeverityCount: 1 },
            preview: [],
            trend: [
              { day: "2026-04-01", total: 3 },
              { day: "2026-04-15", total: 5 },
              { day: "2026-04-29", total: 5 },
            ],
          },
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
      }),
    );
    // Should have an SVG inside the Incidents section.
    expect(out).toContain("<svg");
    expect(out).toContain("3-day trend below");
  });

  it("omits the sparkline when trend has fewer than 2 days", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: {
            counts: { activeCount: 5, highSeverityCount: 1 },
            preview: [],
            trend: [{ day: "2026-04-29", total: 5 }],
          },
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
      }),
    );
    // No SVG anywhere (no SecureScore + 1-point incident trend = no sparkline).
    expect(out).not.toContain("<svg");
  });
});

describe("renderEnvelopeHtml — print-page-break hints", () => {
  it("includes @media print page-break-before: always for sections", () => {
    const out = renderEnvelopeHtml(envelope());
    expect(out).toContain("@media print");
    expect(out).toContain("page-break-before: always");
    expect(out).toContain("break-before: page");
  });
});

describe("renderEnvelopeHtml — defensive coercion", () => {
  it("does not throw on completely-malformed sections", () => {
    expect(() =>
      renderEnvelopeHtml(
        envelope({
          sections: {
            // @ts-expect-error — testing defensive coercion against bogus input
            secureScore: "not-an-object",
            // @ts-expect-error — testing defensive coercion
            incidents: 42,
            entraRisk: null,
            // @ts-expect-error — testing defensive coercion
            brief: [],
            posture: null,
            // @ts-expect-error — testing defensive coercion
            ingestHealth: "rows-go-here",
          },
        }),
      ),
    ).not.toThrow();
  });

  it("does not throw on partially-malformed sections", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          // @ts-expect-error — missing snapshot key
          secureScore: { trend: "not-an-array" },
          // @ts-expect-error — missing counts
          incidents: { preview: [] },
          entraRisk: null,
          // @ts-expect-error — non-string body
          brief: { body: 42 },
          posture: null,
          ingestHealth: [],
        },
      }),
    );
    expect(out).toContain("<!doctype html>");
  });
});

describe("renderEnvelopeHtml — EntraRisk section", () => {
  function entraRiskEnvelope(entraRisk: unknown, comparison?: ReportSnapshotEnvelope["comparison"]) {
    return envelope({
      sections: {
        secureScore: null,
        incidents: null,
        entraRisk,
        brief: null,
        posture: null,
        ingestHealth: [],
      },
      ...(comparison ? { comparison } : {}),
    });
  }

  it("renders hero figure + risk-level + risk-state tables when populated", () => {
    const out = renderEnvelopeHtml(
      entraRiskEnvelope({
        counts: {
          total: 12,
          byRiskLevel: { high: 2, medium: 3, low: 7, hidden: 0, none: 0, unknown: 0 },
          byRiskState: { atRisk: 4, confirmedCompromised: 1, remediated: 5, confirmedSafe: 0, dismissed: 2, none: 0, unknown: 0 },
          processing: 0,
          softDeleted: 0,
          mostRecent: null,
          latestIngestedAt: null,
        },
      }),
    );
    expect(out).toContain("Risky users (Entra ID Protection)");
    expect(out).toContain(">12<"); // hero figure
    expect(out).toContain("By risk level");
    expect(out).toContain("By risk state");
    // Level rows render in priority order — high first.
    const highIdx = out.indexOf(">high<");
    const mediumIdx = out.indexOf(">medium<");
    expect(highIdx).toBeGreaterThan(0);
    expect(highIdx).toBeLessThan(mediumIdx);
    // State rows: atRisk listed.
    expect(out).toContain(">atRisk<");
    expect(out).toContain("4 currently at-risk");
  });

  it("drops zero-count rows from breakdown tables", () => {
    const out = renderEnvelopeHtml(
      entraRiskEnvelope({
        counts: {
          total: 5,
          byRiskLevel: { high: 0, medium: 0, low: 5, hidden: 0, none: 0, unknown: 0 },
          byRiskState: { atRisk: 0, confirmedCompromised: 0, remediated: 5, confirmedSafe: 0, dismissed: 0, none: 0, unknown: 0 },
          processing: 0,
          softDeleted: 0,
          mostRecent: null,
          latestIngestedAt: null,
        },
      }),
    );
    expect(out).toContain(">low<");
    expect(out).toContain(">remediated<");
    expect(out).not.toContain(">high<");
    expect(out).not.toContain(">atRisk<");
    expect(out).not.toContain(">unknown<");
  });

  it("renders licence_required short-circuit message", () => {
    const out = renderEnvelopeHtml(
      entraRiskEnvelope({ counts: { licenceState: "licence_required" } }),
    );
    expect(out).toContain("Risky users (Entra ID Protection)");
    expect(out).toContain("Entra ID P2");
    // No hero figure / breakdown tables for licence_required.
    expect(out).not.toContain("By risk level");
    expect(out).not.toContain("By risk state");
  });

  it("renders generic empty-state when entraRisk section is null", () => {
    const out = renderEnvelopeHtml(entraRiskEnvelope(null));
    expect(out).toContain("Risky users (Entra ID Protection)");
    expect(out).toContain("No risky-user data was available");
  });

  it("uses red hero accent when atRisk count > 0", () => {
    const out = renderEnvelopeHtml(
      entraRiskEnvelope({
        counts: {
          total: 1,
          byRiskLevel: { high: 1, medium: 0, low: 0, hidden: 0, none: 0, unknown: 0 },
          byRiskState: { atRisk: 1, confirmedCompromised: 0, remediated: 0, confirmedSafe: 0, dismissed: 0, none: 0, unknown: 0 },
          processing: 0,
          softDeleted: 0,
          mostRecent: null,
          latestIngestedAt: null,
        },
      }),
    );
    // Hero accent flips to #b91c1c when atRisk > 0.
    expect(out).toContain("#b91c1c");
  });

  it("uses brand accent when no users at-risk", () => {
    const out = renderEnvelopeHtml(
      entraRiskEnvelope({
        counts: {
          total: 1,
          byRiskLevel: { high: 0, medium: 0, low: 1, hidden: 0, none: 0, unknown: 0 },
          byRiskState: { atRisk: 0, confirmedCompromised: 0, remediated: 1, confirmedSafe: 0, dismissed: 0, none: 0, unknown: 0 },
          processing: 0,
          softDeleted: 0,
          mostRecent: null,
          latestIngestedAt: null,
        },
      }),
    );
    expect(out).not.toContain("#b91c1c");
  });

  it("renders a prior-period delta suffix when comparison.priorRiskyUsersTotal is set", () => {
    const out = renderEnvelopeHtml(
      entraRiskEnvelope(
        {
          counts: {
            total: 8,
            byRiskLevel: { high: 0, medium: 2, low: 6, hidden: 0, none: 0, unknown: 0 },
            byRiskState: { atRisk: 2, confirmedCompromised: 0, remediated: 6, confirmedSafe: 0, dismissed: 0, none: 0, unknown: 0 },
            processing: 0,
            softDeleted: 0,
            mostRecent: null,
            latestIngestedAt: null,
          },
        },
        {
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: null,
          priorRiskyUsersTotal: 12,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      ),
    );
    // Lower count is better — DOWN should be coloured green (#14532d).
    expect(out).toContain("DOWN</strong> from 12 last period");
    expect(out).toContain("#14532d");
  });

  it("drops prototype-pollution keys in count records (defence in depth)", () => {
    // JSON.parse never produces real __proto__ keys, but a malformed
    // envelope or attacker-crafted JSON could. Ensure we discard them.
    const hostile = {
      counts: {
        total: 0,
        // `__proto__` only sneaks past JSON.parse via {"__proto__": ...} —
        // real-world envelope shouldn't contain this; the sanitiser is
        // a belt-and-braces guarantee. Use Object.assign so vitest doesn't
        // strip it as a literal.
        byRiskLevel: Object.assign(Object.create(null) as Record<string, number>, {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          __proto__: 99,
          high: 0,
          low: 0,
        }),
        byRiskState: { atRisk: 0 },
        processing: 0,
        softDeleted: 0,
        mostRecent: null,
        latestIngestedAt: null,
      },
    };
    const out = renderEnvelopeHtml(entraRiskEnvelope(hostile));
    expect(() => out).not.toThrow();
    expect(out).not.toContain(">__proto__<");
  });

  it("escapes hostile values in coerced count records (XSS-safe)", () => {
    // counts.total being a non-number falls through to null counts; this
    // tests that hostile prose can't sneak into the section even if the
    // shape is malformed.
    const out = renderEnvelopeHtml(
      entraRiskEnvelope({
        counts: {
          total: 1,
          byRiskLevel: { high: 1, medium: 0, low: 0 },
          byRiskState: { atRisk: 1 },
          processing: 0,
          softDeleted: 0,
          mostRecent: { id: HOSTILE, riskLevel: "high" },
          latestIngestedAt: null,
        },
      }),
    );
    expect(out).not.toContain("<script>alert");
    expect(out).not.toContain("<img src=x onerror");
  });
});

describe("renderEnvelopeHtml — Secure Score control-scores sub-table", () => {
  function ssEnvWithControls(
    controlScores: ReadonlyArray<{
      readonly controlCategory: string;
      readonly controlName: string;
      readonly description: string;
      readonly score: number;
    }>,
  ) {
    return envelope({
      sections: {
        secureScore: {
          snapshot: {
            snapshotDate: "2026-04-29",
            createdDateTime: "2026-04-29T00:00:00Z",
            ingestedAt: "2026-04-29T00:00:00Z",
            currentScore: 47,
            maxScore: 100,
            percentage: 47.0,
            activeUserCount: 0,
            licensedUserCount: 0,
            enabledServices: [],
            averageComparativeScores: [],
            controlScores,
            graphId: "g",
            ingestRunId: "r",
          },
          trend: [],
        },
        incidents: null,
        entraRisk: null,
        brief: null,
        posture: null,
        ingestHealth: [],
      },
    });
  }

  it("renders the bottom-N control scores when present (largest gaps first)", () => {
    const out = renderEnvelopeHtml(
      ssEnvWithControls([
        { controlCategory: "Identity", controlName: "MFA on admins", description: "", score: 1.5 },
        { controlCategory: "Apps", controlName: "App registration restrictions", description: "", score: 7.0 },
        { controlCategory: "Identity", controlName: "Phish-resistant auth", description: "", score: 0.5 },
        { controlCategory: "Data", controlName: "DLP policies", description: "", score: 3.0 },
        { controlCategory: "Device", controlName: "Endpoint compliance", description: "", score: 6.0 },
        { controlCategory: "Email", controlName: "Anti-phishing", description: "", score: 8.0 },
      ]),
    );
    expect(out).toContain("Top remediation opportunities");
    // Lowest score should appear first in the table body.
    const phishIdx = out.indexOf("Phish-resistant auth");
    const mfaIdx = out.indexOf("MFA on admins");
    expect(phishIdx).toBeGreaterThan(0);
    expect(phishIdx).toBeLessThan(mfaIdx);
    // Top-N=5 cap drops the highest-scoring entry.
    expect(out).not.toContain("Anti-phishing");
  });

  it("omits the sub-table when controlScores is empty", () => {
    const out = renderEnvelopeHtml(ssEnvWithControls([]));
    expect(out).not.toContain("Top remediation opportunities");
  });

  it("escapes hostile control names + categories (XSS-safe)", () => {
    const out = renderEnvelopeHtml(
      ssEnvWithControls([
        {
          controlCategory: HOSTILE,
          controlName: HOSTILE,
          description: HOSTILE,
          score: 0.0,
        },
      ]),
    );
    expect(out).toContain("Top remediation opportunities");
    expect(out).not.toContain("<script>alert(2)");
    expect(out).not.toContain("<img src=x onerror");
  });

  it("drops malformed entries (missing score) without throwing", () => {
    const out = renderEnvelopeHtml(
      ssEnvWithControls([
        // @ts-expect-error — testing defensive coercion against bogus input
        { controlCategory: "X", controlName: "Bad row", description: "", score: "not-a-number" },
        { controlCategory: "Identity", controlName: "Good row", description: "", score: 2.0 },
      ]),
    );
    expect(out).toContain("Good row");
    expect(out).not.toContain("Bad row");
  });

  it("prefers Microsoft `title` over the raw controlName slug when joined from the profile cache", () => {
    const out = renderEnvelopeHtml(
      ssEnvWithControls([
        {
          controlCategory: "Identity",
          controlName: "AdminMFAV2",
          description: "",
          score: 1.0,
          title: "Require MFA for administrative roles",
        },
      ]),
    );
    expect(out).toContain("Require MFA for administrative roles");
    // Raw slug should not appear in the cell when the friendly title is set.
    // (It may still appear elsewhere in the doc; assert against the table cell shape.)
    expect(out).not.toContain("<strong>AdminMFAV2</strong>");
  });

  it("falls back to controlName when title is missing, empty, whitespace, or non-string", () => {
    const out = renderEnvelopeHtml(
      ssEnvWithControls([
        { controlCategory: "Identity", controlName: "NoTitleHere", description: "", score: 1.0 },
        { controlCategory: "Identity", controlName: "EmptyTitle", description: "", score: 2.0, title: "" },
        { controlCategory: "Identity", controlName: "WhitespaceTitle", description: "", score: 3.0, title: "   " },
        // @ts-expect-error — guard against producer mis-typing the field
        { controlCategory: "Identity", controlName: "NumericTitle", description: "", score: 4.0, title: 123 },
      ]),
    );
    expect(out).toContain("<strong>NoTitleHere</strong>");
    expect(out).toContain("<strong>EmptyTitle</strong>");
    expect(out).toContain("<strong>WhitespaceTitle</strong>");
    expect(out).toContain("<strong>NumericTitle</strong>");
  });

  it("escapes hostile `title` strings (XSS-safe even on the friendly-name path)", () => {
    const out = renderEnvelopeHtml(
      ssEnvWithControls([
        {
          controlCategory: "Identity",
          controlName: "ControlSlug",
          description: "",
          score: 0.5,
          title: HOSTILE,
        },
      ]),
    );
    expect(out).toContain("Top remediation opportunities");
    expect(out).not.toContain("<script>alert(2)");
    expect(out).not.toContain("<img src=x onerror");
  });
});

describe("renderEnvelopeHtml — per-tile prior-period deltas", () => {
  it("renders DOWN-from-prior on the incidents hero subtitle (lower-is-better)", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: {
            counts: { activeCount: 3, highSeverityCount: 0 },
            preview: [],
            trend: [],
          },
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
        comparison: {
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: null,
          priorIncidentsActive: 7,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      }),
    );
    // Incidents fell — DOWN is good — should be green.
    expect(out).toContain("DOWN</strong> from 7 last period");
    expect(out).toContain("#14532d");
  });

  it("renders UP-from-prior on incidents in red (lower-is-better inverted)", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: {
            counts: { activeCount: 9, highSeverityCount: 1 },
            preview: [],
            trend: [],
          },
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
        comparison: {
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: null,
          priorIncidentsActive: 3,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      }),
    );
    expect(out).toContain("UP</strong> from 3 last period");
    expect(out).toContain("#991b1b");
  });

  it("renders flat suffix when prior matches current", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: {
            counts: { activeCount: 5, highSeverityCount: 0 },
            preview: [],
            trend: [],
          },
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
        comparison: {
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: null,
          priorIncidentsActive: 5,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      }),
    );
    expect(out).toContain("flat vs prior period (5)");
  });

  it("omits the suffix when comparison.priorIncidentsActive is null", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: {
            counts: { activeCount: 3, highSeverityCount: 0 },
            preview: [],
            trend: [],
          },
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
        comparison: {
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: null,
          priorIncidentsActive: null,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      }),
    );
    expect(out).not.toContain("UP</strong>");
    expect(out).not.toContain("DOWN</strong>");
    expect(out).not.toContain("flat vs prior");
  });

  it("omits the suffix when comparison.priorIncidentsActive field is absent (Phase A snapshot)", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          secureScore: null,
          incidents: {
            counts: { activeCount: 3, highSeverityCount: 0 },
            preview: [],
            trend: [],
          },
          entraRisk: null,
          brief: null,
          posture: null,
          ingestHealth: [],
        },
        comparison: {
          // Phase A shape — no priorIncidentsActive field at all.
          priorPeriodKey: "2026-03",
          priorSecureScorePercentage: 44,
          priorCapturedAt: "2026-03-31T10:00:00Z",
        },
      }),
    );
    // No incidents-subtitle delta when the field is absent. (Phase A
    // forwards-compat — older snapshots parse cleanly with `undefined`
    // and surface no per-tile suffix.)
    const incidentsBlock = out.slice(
      out.indexOf("Incidents</h2>"),
      out.indexOf("</section>", out.indexOf("Incidents</h2>")),
    );
    expect(incidentsBlock).not.toContain("UP</strong>");
    expect(incidentsBlock).not.toContain("DOWN</strong>");
    expect(incidentsBlock).not.toContain("flat vs prior");
  });
});

describe("renderEnvelopeHtml — §10.62 sections", () => {
  it("renders the userDormancy section with hero count + cohort breakdown", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          userDormancy: {
            licenceState: "ok",
            summary: {
              total: 120,
              dormant: 7,
              enabledDormant: 5,
              disabledDormant: 2,
              excluded: 3,
              thresholdDays: 30,
              oldestDormantUpn: "stale.user@example.com",
              oldestDormantLastSignIn: "2025-12-01T08:00:00.000Z",
            },
            policy: { thresholdDays: 30, includeDisabledAccounts: false },
          },
        },
      }),
    );
    expect(out).toContain("User dormancy");
    expect(out).toContain(">7</p>"); // hero
    expect(out).toContain("dormant of 120 tracked");
    expect(out).toContain("Enabled and dormant");
    expect(out).toContain("Disabled and dormant");
    expect(out).toContain("Excluded by policy");
    expect(out).toContain("stale.user@example.com");
    expect(out).toContain("Threshold 30 days");
  });

  it("userDormancy section escapes hostile UPN", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          userDormancy: {
            licenceState: "ok",
            summary: {
              total: 1,
              dormant: 1,
              enabledDormant: 1,
              disabledDormant: 0,
              excluded: 0,
              thresholdDays: 30,
              oldestDormantUpn: HOSTILE,
              oldestDormantLastSignIn: "2025-12-01T08:00:00.000Z",
            },
            policy: { thresholdDays: 30, includeDisabledAccounts: false },
          },
        },
      }),
    );
    expect(out).not.toContain("<script>alert(2)</script>");
    expect(out).not.toContain('onerror="alert(1)"');
    expect(out).toContain("&lt;script&gt;");
  });

  it("userDormancy section short-circuits on licence_required", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          userDormancy: {
            licenceState: "licence_required",
            summary: null,
            policy: null,
          },
        },
      }),
    );
    expect(out).toContain("requires Entra ID P1");
  });

  it("renders the signIns section with hero count + recent out-of-area sample", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          signIns: {
            licenceState: "ok",
            summary: {
              totalToday: 432,
              outOfAreaToday: 3,
              caFailuresToday: 1,
              mostRecent: null,
              mostRecentOutOfArea: {
                userPrincipalName: "alice@example.com",
                country: "ru",
                createdDateTime: "2026-04-29T08:30:00.000Z",
              },
            },
            policy: {
              enabled: true,
              allowedCountries: ["gb", "ie"],
              unknownLocationPolicy: "alert",
            },
          },
        },
      }),
    );
    expect(out).toContain("Sign-ins (last 24 hours)");
    expect(out).toContain(">432</p>");
    expect(out).toContain("3 out-of-area");
    expect(out).toContain("1 CA failures");
    expect(out).toContain("alice@example.com");
    expect(out).toContain("RU"); // country uppercased
    expect(out).toContain("Geo-fence active");
    expect(out).toContain("GB, IE");
  });

  it("signIns section escapes hostile mostRecentOutOfArea fields", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          signIns: {
            licenceState: "ok",
            summary: {
              totalToday: 1,
              outOfAreaToday: 1,
              caFailuresToday: 0,
              mostRecent: null,
              mostRecentOutOfArea: {
                userPrincipalName: HOSTILE,
                country: "us",
                createdDateTime: "2026-04-29T08:30:00.000Z",
              },
            },
            policy: null,
          },
        },
      }),
    );
    expect(out).not.toContain("<script>alert(2)</script>");
    expect(out).not.toContain('onerror="alert(1)"');
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders the conditionalAccess section with state breakdown table", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          conditionalAccess: {
            counts: { total: 11, enabled: 8, disabled: 1, reportOnly: 2 },
          },
        },
      }),
    );
    expect(out).toContain("Conditional Access</h2>");
    expect(out).toContain(">11</p>"); // total hero
    expect(out).toContain("policies tracked");
    expect(out).toContain("Enabled");
    expect(out).toContain("Disabled");
    expect(out).toContain("Report-only");
  });

  it("renders azureSecureScore single-subscription with sparkline", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          azureSecureScore: {
            subscriptions: [
              {
                subscriptionId: "sub-1",
                subscriptionName: "Production",
                latest: {
                  snapshotDate: "2026-04-29",
                  currentScore: 82.5,
                  maxScore: 100,
                  percentage: 82.5,
                },
                trend: [
                  { snapshotDate: "2026-04-27", percentage: 80 },
                  { snapshotDate: "2026-04-28", percentage: 81.2 },
                  { snapshotDate: "2026-04-29", percentage: 82.5 },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(out).toContain("Defender for Cloud Secure Score");
    expect(out).toContain("82.5%");
    expect(out).toContain("Production"); // sub name
    expect(out).toContain("snapshot 2026-04-29");
    expect(out).toContain("82.5 of 100 points");
    expect(out).toContain("<svg"); // sparkline mounts because trend.length >= 2
    // pp-delta: 82.5 - 80 = 2.5
    expect(out).toContain("+2.5 pp over 3 snapshots");
  });

  it("renders azureSecureScore multi-subscription as a table", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          azureSecureScore: {
            subscriptions: [
              {
                subscriptionId: "sub-1",
                subscriptionName: "Production",
                latest: {
                  snapshotDate: "2026-04-29",
                  currentScore: 82.5,
                  maxScore: 100,
                  percentage: 82.5,
                },
                trend: [],
              },
              {
                subscriptionId: "sub-2",
                subscriptionName: "Staging",
                latest: {
                  snapshotDate: "2026-04-29",
                  currentScore: 65,
                  maxScore: 100,
                  percentage: 65,
                },
                trend: [],
              },
            ],
          },
        },
      }),
    );
    expect(out).toContain("Defender for Cloud Secure Score");
    expect(out).toContain("2 tracked subscriptions");
    expect(out).toContain("Production");
    expect(out).toContain("Staging");
    expect(out).toContain("82.5%");
    expect(out).toContain("65.0%");
  });

  it("azureSecureScore section escapes hostile subscriptionName", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          azureSecureScore: {
            subscriptions: [
              {
                subscriptionId: "sub-1",
                subscriptionName: HOSTILE,
                latest: {
                  snapshotDate: "2026-04-29",
                  currentScore: 50,
                  maxScore: 100,
                  percentage: 50,
                },
                trend: [],
              },
            ],
          },
        },
      }),
    );
    expect(out).not.toContain("<script>alert(2)</script>");
    expect(out).not.toContain('onerror="alert(1)"');
    expect(out).toContain("&lt;script&gt;");
  });

  // §10.62 WS10 INFO follow-tracks — pin the remaining defensive paths so
  // a future refactor can't quietly drop them.

  it("signIns section escapes hostile `country` + `allowedCountries`", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          signIns: {
            licenceState: "ok",
            summary: {
              totalToday: 1,
              outOfAreaToday: 1,
              caFailuresToday: 0,
              mostRecent: null,
              mostRecentOutOfArea: {
                userPrincipalName: "alice@example.com",
                country: HOSTILE, // non-ISO; renderer must escape
                createdDateTime: "2026-04-29T08:30:00.000Z",
              },
            },
            policy: {
              enabled: true,
              allowedCountries: [HOSTILE], // operator-injected
              unknownLocationPolicy: "alert",
            },
          },
        },
      }),
    );
    expect(out).not.toContain("<script>alert(2)</script>");
    expect(out).not.toContain('onerror="alert(1)"');
  });

  it("conditionalAccess coerces malformed counts to empty-state", () => {
    // String counts (vs number) → coerce returns null → empty-state.
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          conditionalAccess: {
            counts: {
              total: "11" as unknown as number,
              enabled: 8,
              disabled: 1,
              reportOnly: 2,
            },
          },
        },
      }),
    );
    expect(out).toContain("No Conditional Access policy data was available");
  });

  it("azureSecureScore with non-string subscriptionName renders without crashing", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          azureSecureScore: {
            subscriptions: [
              {
                subscriptionId: "sub-1",
                subscriptionName: 42 as unknown as string,
                latest: {
                  snapshotDate: "2026-04-29",
                  currentScore: 82.5,
                  maxScore: 100,
                  percentage: 82.5,
                },
                trend: [],
              },
            ],
          },
        },
      }),
    );
    // Falls through to empty-string subscriptionName, snapshot prose retained.
    expect(out).toContain("Defender for Cloud Secure Score");
    expect(out).toContain("snapshot 2026-04-29");
    expect(out).toContain("82.5%");
  });

  it("section order in the document matches dashboard tile order", () => {
    const out = renderEnvelopeHtml(
      envelope({
        sections: {
          ...envelope().sections,
          azureSecureScore: { subscriptions: [] },
          conditionalAccess: { counts: { total: 0, enabled: 0, disabled: 0, reportOnly: 0 } },
          userDormancy: { licenceState: "ok", summary: null, policy: null },
          signIns: { licenceState: "ok", summary: null, policy: null },
        },
      }),
    );
    // Confirm rendering order: Microsoft Secure Score → Defender for Cloud
    // → Incidents → Risky users → Conditional Access → User dormancy → Sign-ins
    // → KEV (stack-exposure) → Brief → Posture → Ingest health
    const positions = [
      ["Microsoft Secure Score", out.indexOf("Microsoft Secure Score</h2>")],
      ["Defender for Cloud Secure Score", out.indexOf("Defender for Cloud Secure Score</h2>")],
      ["Incidents", out.indexOf(">Incidents</h2>")],
      ["Conditional Access", out.indexOf(">Conditional Access</h2>")],
      ["User dormancy", out.indexOf(">User dormancy</h2>")],
      ["Sign-ins", out.indexOf(">Sign-ins (last 24 hours)</h2>")],
      ["Daily Brief", out.indexOf(">Daily Brief</h2>")],
      ["Weekly Posture", out.indexOf(">Weekly Posture</h2>")],
    ] as const;
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1]!;
      const cur = positions[i]!;
      expect(cur[1]).toBeGreaterThan(prev[1]);
    }
  });
});
