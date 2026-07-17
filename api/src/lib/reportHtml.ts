// ADR-0030 — envelope → standalone HTML render.
//
// Produces a self-contained HTML document (inline CSS, no external assets,
// no scripts) suitable for:
//   1. Direct download via GET /api/reports/snapshots/.../html
//   2. Future Phase C email delivery — inline styles survive email-client
//      <style>-stripping; the document body IS the email body
//   3. Browser open + Print-to-PDF for board pack output
//
// Security model:
//   - Tagged template `html` helper escapes EVERY interpolation by default.
//     Concatenating untrusted strings without `html\`...\`` is a code error
//     (no operator-controlled string ever reaches the document raw).
//   - SVG sparkline path values are computed from numbers only — never
//     interpolate strings into `d=""`.
//   - ADR-0012 §5 plain-text-only invariant on Microsoft-authored prose
//     (brief / posture narratives) is preserved by escapeHtml on the body.

import type {
  ReportEnvelopeBranding,
  ReportSnapshotEnvelope,
} from "./reportSnapshotStore.js";
import type {
  IncidentSummary,
  IngestHealthRow,
  SecureScoreSnapshot,
} from "./types.js";

const DEFAULT_BRANDING: ReportEnvelopeBranding = {
  productName: "Aegis",
  primaryHex: "#0078D4",
  footerText: "",
};

// --- Escape primitives ----------------------------------------------------

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) return "";
  const str = typeof input === "string" ? input : String(input);
  return str.replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPE_MAP[c] ?? c);
}

/**
 * Tagged template literal for HTML. Every interpolation passes through
 * `escapeHtml` automatically. Use raw string concatenation ONLY when you
 * are interpolating ALREADY-escaped HTML (e.g. composing nested template
 * outputs); pass via the `raw()` marker so the intent is explicit.
 *
 * Example:
 *   html`<p>Hello, ${userName}</p>`
 *   html`<div>${raw(htmlChunk)}</div>`
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v && typeof v === "object" && (v as { __raw?: boolean }).__raw === true) {
      out += (v as { value: string }).value;
    } else {
      out += escapeHtml(v);
    }
    out += strings[i + 1] ?? "";
  }
  return out;
}

interface RawHtml {
  readonly __raw: true;
  readonly value: string;
}

export function raw(value: string): RawHtml {
  return { __raw: true, value };
}

// --- Public entry point ---------------------------------------------------

/**
 * Render the full standalone HTML document for an envelope. Self-contained:
 * no <script>, no <link>, no remote images. The output is byte-identical
 * for byte-identical envelopes — caller can hash for cache validation.
 */
export function renderEnvelopeHtml(envelope: ReportSnapshotEnvelope): string {
  const branding = sanitiseBranding(envelope.branding);
  const periodLabel = formatPeriodProse(envelope);
  const capturedAtLocal = formatTimestamp(envelope.capturedAt);
  const accent = branding.primaryHex;

  // §10.62 — section order tracks the dashboard tile order so a reader who
  // also looks at the live UI maps mental model to printout. New verticals
  // (azureSecureScore, conditionalAccess, userDormancy, signIns) sit
  // alongside their thematic neighbours: Defender for Cloud right after
  // Microsoft Secure Score, CA + identity-lifecycle right after the risky-
  // user surface, KEV before the AI narratives.
  const sections = [
    renderSecureScoreSection(envelope.sections.secureScore, accent),
    renderAzureSecureScoreSection(envelope.sections.azureSecureScore, accent),
    renderIncidentsSection(envelope.sections.incidents, accent, envelope.comparison),
    renderEntraRiskSection(envelope.sections.entraRisk, accent, envelope.comparison),
    renderConditionalAccessSection(envelope.sections.conditionalAccess, accent),
    renderUserDormancySection(envelope.sections.userDormancy, accent),
    renderSignInsSection(envelope.sections.signIns, accent),
    renderStackKevSection(envelope.sections.stackKevExposure, accent),
    renderBriefSection(envelope.sections.brief),
    renderPostureSection(envelope.sections.posture),
    renderIngestHealthSection(envelope.sections.ingestHealth),
  ];

  const exec = renderExecutiveSummary(envelope, accent);
  const printStyles = `@media print { section { page-break-before: always; break-before: page; } header { page-break-after: avoid; } @page { margin: 16mm; } }`;
  const footerLine = branding.footerText
    ? html`<p style="${raw(STYLES.footerProse)}">${branding.footerText}</p>`
    : "";

  const logoBlock = renderLogoBlock(branding);
  const operatorNoteBlock = renderOperatorNote(envelope, accent);
  const chainBlock = renderChainOfCustodyFooter(envelope);

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${branding.productName} report — ${periodLabel}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>${raw(printStyles)}</style>
</head>
<body style="${raw(STYLES.body)}">
<div style="${raw(STYLES.shell)}">
  <header style="${raw(headerStyles(accent))}">
    ${raw(logoBlock)}
    <p style="${raw(STYLES.eyebrow)}">${branding.productName} security report</p>
    <h1 style="${raw(STYLES.h1)}">${periodLabel}</h1>
    <p style="${raw(STYLES.headerSub)}">
      Captured ${capturedAtLocal} (v${String(envelope.version)})
      · by ${formatCapturedBy(envelope.capturedBy)}
    </p>
  </header>
  ${raw(exec)}
  ${raw(operatorNoteBlock)}
  ${raw(sections.join("\n"))}
  <footer style="${raw(STYLES.footer)}">
    ${raw(footerLine)}
    ${raw(chainBlock)}
  </footer>
</div>
</body>
</html>`;
}

/** Render the inline logo `<img>` from the captured `data:` URI. Defends
 *  against a malformed envelope: the URI must start with `data:image/`
 *  and the MIME type must be one of the allowlisted image types. Anything
 *  else (e.g. data:text/html, data:image/svg+xml — SVG can carry script,
 *  deliberately excluded per ADR-0029 §Decision.5) falls through to the
 *  text-only header. */
function renderLogoBlock(branding: ReportEnvelopeBranding): string {
  const url = branding.logoDataUrl;
  if (!url) return "";
  // Strict allowlist on the leading bytes — defence against a future bug
  // that lets a non-image data URI flow into the envelope.
  const allowedPrefixes = [
    "data:image/png;base64,",
    "data:image/webp;base64,",
    "data:image/jpeg;base64,",
  ];
  if (!allowedPrefixes.some((p) => url.startsWith(p))) return "";
  // Bound the size at render time too — prevents a runaway envelope from
  // producing an 8 MB document if the cap was bypassed somehow.
  if (url.length > 200_000) return "";
  return html`<img src="${url}" alt="${branding.productName} logo" style="${raw(STYLES.logo)}" />`;
}

function renderOperatorNote(
  envelope: ReportSnapshotEnvelope,
  accent: string,
): string {
  const note = envelope.operatorNote;
  if (typeof note !== "string" || note.trim() === "") return "";
  // Operator note may include line breaks — split into paragraphs same as
  // brief / posture. Every paragraph escapes via the html template.
  const paragraphs = note
    .split(/\n{2,}/)
    .map((p) => html`<p style="${raw(STYLES.operatorNoteP)}">${p.trim()}</p>`)
    .join("\n");
  return html`<section style="${raw(operatorNoteStyles(accent))}">
  <p style="${raw(STYLES.eyebrowAccent(accent))}">Operator note</p>
  ${raw(paragraphs)}
</section>`;
}

function operatorNoteStyles(accent: string): string {
  return `margin:16px 0;padding:14px 16px;border-left:4px solid ${accent};background:#fffbeb;`;
}

/** Forensic chain-of-custody footer — surfaces the audit-chain anchor so
 *  a board reader (or auditor) can verify the snapshot wasn't tampered
 *  with. Renders schemaVersion + capturedAt + runId + tenant prefix +
 *  prose pointer to the verify endpoint. */
function renderChainOfCustodyFooter(envelope: ReportSnapshotEnvelope): string {
  const tenantPrefix = envelope.tenantId.slice(0, 8);
  const runIdShort =
    typeof envelope.captureRunId === "string" && envelope.captureRunId !== ""
      ? envelope.captureRunId.slice(0, 8)
      : "";
  const runLine = runIdShort
    ? html` · run <code>${runIdShort}…</code>`
    : "";
  return html`<p style="${raw(STYLES.chainProse)}">
  Snapshot envelope <code>${tenantPrefix}…/${envelope.periodKey}/v${String(envelope.version)}</code>
  · schema v${String(envelope.schemaVersion)}
  · captured ${envelope.capturedAt}${raw(runLine)}.
  Plain-text rendering of Microsoft-authored prose per ADR-0012 §5.
  Audit chain integrity verifiable at the source <code>report.snapshot</code>.
</p>`;
}

function sanitiseBranding(b: ReportEnvelopeBranding | undefined): ReportEnvelopeBranding {
  if (!b) return DEFAULT_BRANDING;
  // Defence-in-depth — primaryHex must match #RRGGBB (defends against
  // CSS-injection via crafted branding rows). Length-cap textual fields
  // even though tenantSettingsStore validates them at write time.
  const primaryHex = /^#[0-9a-fA-F]{6}$/.test(b.primaryHex)
    ? b.primaryHex
    : DEFAULT_BRANDING.primaryHex;
  const productName =
    typeof b.productName === "string" && b.productName.trim() !== ""
      ? b.productName.slice(0, 64)
      : DEFAULT_BRANDING.productName;
  const footerText =
    typeof b.footerText === "string" ? b.footerText.slice(0, 128) : "";
  // logoDataUrl passes through unchanged — renderLogoBlock applies the
  // strict allowlist on the data: prefix + size cap.
  const logoDataUrl =
    typeof b.logoDataUrl === "string" ? b.logoDataUrl : undefined;
  return {
    productName,
    primaryHex,
    footerText,
    ...(logoDataUrl ? { logoDataUrl } : {}),
  };
}

function headerStyles(accent: string): string {
  // accent already validated as hex-only by sanitiseBranding — safe to
  // interpolate into a CSS value. (No string concat with operator content.)
  return `margin-bottom:16px;border-bottom:4px solid ${accent};padding:16px 0 12px;`;
}

function renderExecutiveSummary(envelope: ReportSnapshotEnvelope, accent: string): string {
  const ss = coerceSecureScore(envelope.sections.secureScore);
  const inc = coerceIncidents(envelope.sections.incidents);
  const stackKev = coerceStackKevExposure(envelope.sections.stackKevExposure);
  const lines: string[] = [];

  if (ss?.snapshot) {
    const delta = computeTrendDelta(ss.trend);
    const trendSuffix =
      delta === null
        ? ""
        : ` (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pp 90d)`;
    const priorPct = envelope.comparison?.priorSecureScorePercentage;
    const periodSuffix =
      typeof priorPct === "number" && Number.isFinite(priorPct)
        ? renderComparisonSuffix(ss.snapshot.percentage, priorPct)
        : "";
    lines.push(
      html`Secure Score <strong>${ss.snapshot.percentage.toFixed(1)}%</strong>${trendSuffix}${raw(periodSuffix)}.`,
    );
  }
  if (inc) {
    const high = inc.counts.highSeverityCount;
    const total = inc.counts.activeCount;
    lines.push(
      html`<strong>${String(total)}</strong> active incident${total === 1 ? "" : "s"}${high > 0 ? `, ${String(high)} high-severity` : ""}.`,
    );
  }
  if (stackKev && stackKev.totalStackItems > 0) {
    const kevText =
      stackKev.openMatches === 0
        ? html`No open KEV matches across <strong>${String(stackKev.totalStackItems)}</strong> registered stack item${stackKev.totalStackItems === 1 ? "" : "s"}.`
        : html`<strong>${String(stackKev.openMatches)}</strong> open KEV match${stackKev.openMatches === 1 ? "" : "es"} across registered stack${stackKev.ransomwareLinkedOpen > 0 ? `, ${String(stackKev.ransomwareLinkedOpen)} ransomware-linked` : ""}.`;
    lines.push(kevText);
  }
  if (lines.length === 0) {
    return "";
  }
  const items = lines.map((l) => html`<li style="${raw(STYLES.execLi)}">${raw(l)}</li>`).join("");
  return html`<section style="${raw(execSectionStyles(accent))}">
  <p style="${raw(STYLES.eyebrowAccent(accent))}">Executive summary</p>
  <ul style="${raw(STYLES.execUl)}">${raw(items)}</ul>
</section>`;
}

function execSectionStyles(accent: string): string {
  return `margin:16px 0;padding:14px 16px;border-left:4px solid ${accent};background:#f9fafb;`;
}

/** Render a comparative-period suffix like " · UP from 44.0% last period"
 *  or " · DOWN from 51.0% last period". Direction word is bold-coloured.
 *  Numeric prior; renderer caller has already verified `priorPct` is a
 *  finite number. */
function renderComparisonSuffix(currentPct: number, priorPct: number): string {
  const delta = currentPct - priorPct;
  // Round to 0.05pp so jitter doesn't flip "UP" / "FLAT" / "DOWN".
  if (Math.abs(delta) < 0.05) {
    return html` · flat vs prior period (${priorPct.toFixed(1)}%)`;
  }
  const word = delta > 0 ? "UP" : "DOWN";
  const colour = delta > 0 ? "#14532d" : "#991b1b";
  return html` · <strong style="color:${colour};">${word}</strong> from ${priorPct.toFixed(1)}% last period`;
}

// --- Per-section renderers ------------------------------------------------

function renderSecureScoreSection(raw_: unknown, accent: string): string {
  const ss = coerceSecureScore(raw_);
  if (!ss || !ss.snapshot) {
    return renderEmptySection(
      "Microsoft Secure Score",
      "No Microsoft Secure Score snapshot was available at capture time.",
    );
  }
  const { snapshot, trend } = ss;
  const sparkline = trend.length >= 2 ? renderSparkline(trend, accent) : "";
  const trendDelta = computeTrendDelta(trend);
  const deltaLine =
    trendDelta === null
      ? raw("")
      : raw(
          html`<p style="${raw(STYLES.heroSub)}">${trendDelta >= 0 ? "+" : ""}${trendDelta.toFixed(1)} pp over 90 days</p>`,
        );
  const controlScoresBlock = renderControlScores(snapshot.controlScores ?? []);
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Microsoft Secure Score</h2>
  <div style="${raw(STYLES.heroRow)}">
    <div>
      <p style="${raw(STYLES.heroFigure(accent))}">${snapshot.percentage.toFixed(1)}%</p>
      <p style="${raw(STYLES.heroSub)}">${String(snapshot.currentScore)} of ${String(snapshot.maxScore)} points · snapshot ${snapshot.snapshotDate}</p>
      ${deltaLine}
    </div>
    <div>${raw(sparkline)}</div>
  </div>
  ${raw(controlScoresBlock)}
</section>`;
}

/** Surface the bottom-N control scores (largest gaps) as a board-readable
 *  table. Source field types from the SDK: `controlCategory`, `controlName`,
 *  `description`, `score` (number). `title` is the Microsoft-supplied
 *  friendly name joined from the secureScoreControlProfiles cache at
 *  envelope-assembly time (reportEnvelope.assembleSecureScore); when present
 *  and non-empty it replaces the raw `controlName` slug in the rendered cell.
 *  All operator/Microsoft prose passes through the html template — XSS-safe
 *  by construction. */
const CONTROL_SCORES_TOP_N = 5;
function renderControlScores(
  controlScores: ReadonlyArray<{
    readonly controlCategory: string;
    readonly controlName: string;
    readonly description: string;
    readonly score: number;
    readonly title?: string;
  }>,
): string {
  if (!Array.isArray(controlScores) || controlScores.length === 0) return "";
  // Filter to entries with a valid score, sort ascending (smallest = biggest
  // gap), cap at top-N. Defensive coercion: skip malformed rows entirely.
  const valid = controlScores.filter(
    (c) =>
      c &&
      typeof c.controlName === "string" &&
      typeof c.controlCategory === "string" &&
      typeof c.score === "number" &&
      Number.isFinite(c.score),
  );
  if (valid.length === 0) return "";
  const sorted = [...valid].sort((a, b) => a.score - b.score).slice(0, CONTROL_SCORES_TOP_N);
  const rows = sorted
    .map((c) => {
      // Microsoft friendly title preferred when present (e.g. "Require MFA
      // for admin roles"); fall back to the raw controlName slug (e.g.
      // "AdminMFA") when the profile join missed — old snapshots, fresh
      // tenants without a profile ingest, or controls Microsoft hasn't
      // published a title for. Type guard handles non-string `title` values
      // that could slip through if a future producer mis-types the field.
      const titleStr = typeof c.title === "string" ? c.title.trim() : "";
      const label = titleStr.length > 0 ? titleStr : c.controlName;
      return html`<tr><td style="${raw(STYLES.td)}"><strong>${label}</strong></td><td style="${raw(STYLES.td)}">${c.controlCategory}</td><td style="${raw(STYLES.td)}">${c.score.toFixed(1)}</td></tr>`;
    })
    .join("\n");
  return html`<h3 style="${raw(STYLES.h3)}">Top remediation opportunities (lowest scores)</h3>
<table style="${raw(STYLES.dataTable)}">
  <thead>
    <tr><th style="${raw(STYLES.thRow)}">Control</th><th style="${raw(STYLES.thRow)}">Category</th><th style="${raw(STYLES.thRow)}">Score</th></tr>
  </thead>
  <tbody>${raw(rows)}</tbody>
</table>`;
}

function renderIncidentsSection(
  raw_: unknown,
  accent: string,
  comparison: ReportSnapshotEnvelope["comparison"],
): string {
  const inc = coerceIncidents(raw_);
  if (!inc) {
    return renderEmptySection(
      "Incidents",
      "No incident data was available at capture time.",
    );
  }
  const { counts, preview, trend } = inc;
  const previewRows =
    preview.length === 0
      ? html`<tr><td colspan="4" style="${raw(STYLES.td)} text-align:center;color:#6b7280;">No active incidents.</td></tr>`
      : preview
          .map(
            (i) =>
              html`<tr><td style="${raw(STYLES.td)}">${raw(severityBadge(i.severity))}</td><td style="${raw(STYLES.td)}">${i.displayName}</td><td style="${raw(STYLES.td)}">${i.status}</td><td style="${raw(STYLES.td)}">${formatTimestamp(i.lastUpdateDateTime ?? "")}</td></tr>`,
          )
          .join("\n");
  const trendBlock = trend.length >= 2 ? renderIncidentTrendSparkline(trend, accent) : "";
  // Per-tile prior-period delta. For incident counts, lower is better, so
  // colour DOWN green / UP red — opposite of Secure Score percentage.
  const prior = comparison?.priorIncidentsActive;
  const deltaSuffix =
    typeof prior === "number" && Number.isFinite(prior)
      ? renderCountDeltaSuffix(counts.activeCount, prior, /*lowerIsBetter*/ true)
      : "";
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Incidents</h2>
  <div style="${raw(STYLES.heroRow)}">
    <div>
      <p style="${raw(STYLES.heroFigure(accent))}">${String(counts.activeCount)}</p>
      <p style="${raw(STYLES.heroSub)}">active${counts.highSeverityCount > 0 ? html` · ${String(counts.highSeverityCount)} high-severity` : ""}${trend.length >= 2 ? html` · ${String(trend.length)}-day trend below` : ""}${raw(deltaSuffix)}</p>
    </div>
    <div>${raw(trendBlock)}</div>
  </div>
  <h3 style="${raw(STYLES.h3)}">Recent (top ${String(preview.length)})</h3>
  <table style="${raw(STYLES.dataTable)}">
    <thead>
      <tr><th style="${raw(STYLES.thRow)}">Severity</th><th style="${raw(STYLES.thRow)}">Title</th><th style="${raw(STYLES.thRow)}">Status</th><th style="${raw(STYLES.thRow)}">Updated</th></tr>
    </thead>
    <tbody>${raw(previewRows)}</tbody>
  </table>
</section>`;
}

/** Per-tile count delta suffix mirroring renderComparisonSuffix but for
 *  whole-number count fields (incidents, risky users). `lowerIsBetter`
 *  inverts the colour mapping — for incident / risky-user counts, going
 *  DOWN is good (green); for Secure Score percentage, UP is good. Returns
 *  empty when delta is exactly 0 (no change to surface). */
function renderCountDeltaSuffix(
  current: number,
  prior: number,
  lowerIsBetter: boolean,
): string {
  const delta = current - prior;
  if (delta === 0) {
    return html` · flat vs prior period (${String(prior)})`;
  }
  const word = delta > 0 ? "UP" : "DOWN";
  const isImprovement = lowerIsBetter ? delta < 0 : delta > 0;
  const colour = isImprovement ? "#14532d" : "#991b1b";
  return html` · <strong style="color:${colour};">${word}</strong> from ${String(prior)} last period`;
}

/** SVG sparkline for the 30-day incident trend. Path coords numeric only.
 *  Mirror of renderSparkline but driven from `total` (per-day count). */
function renderIncidentTrendSparkline(
  trend: ReadonlyArray<{ day: string; total: number }>,
  accent: string,
): string {
  const W = 320;
  const H = 60;
  const pad = 4;
  const xs = trend.map((_, i) => i / Math.max(1, trend.length - 1));
  const ys = trend.map((p) => p.total);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const range = Math.max(1, maxY - minY);
  const points = xs.map((x, i) => {
    const px = pad + x * (W - 2 * pad);
    const py = H - pad - ((ys[i]! - minY) / range) * (H - 2 * pad);
    return `${px.toFixed(2)},${py.toFixed(2)}`;
  });
  const d = `M ${points.join(" L ")}`;
  return html`<svg width="${String(W)}" height="${String(H)}" viewBox="0 0 ${String(W)} ${String(H)}" style="margin-top:8px;display:block;">
  <path d="${d}" fill="none" stroke="${accent}" stroke-width="1.5" />
</svg>`;
}

function renderStackKevSection(raw_: unknown, accent: string): string {
  const sk = coerceStackKevExposure(raw_);
  if (!sk || sk.totalStackItems === 0) {
    return renderEmptySection(
      "KEV exposure",
      "No stack inventory has been registered. Add items via Admin → Stack inventory to see KEV cross-references.",
    );
  }
  const subParts: string[] = [];
  subParts.push(`${sk.totalStackItems} stack item${sk.totalStackItems === 1 ? "" : "s"}`);
  if (sk.dueThisWeek > 0) {
    subParts.push(`${sk.dueThisWeek} due this week`);
  }
  if (sk.ransomwareLinkedOpen > 0) {
    subParts.push(`${sk.ransomwareLinkedOpen} ransomware-linked`);
  }
  const sub = subParts.join(" · ");
  const tableRows =
    sk.topExposures.length === 0
      ? html`<tr><td colspan="4" style="${raw(STYLES.td)} text-align:center;color:#6b7280;">No open KEV matches against your registered stack.</td></tr>`
      : sk.topExposures
          .map(
            (e) =>
              html`<tr><td style="${raw(STYLES.td)}"><strong>${e.vendor}</strong> · ${e.product}${e.version ? html` · ${e.version}` : ""}</td><td style="${raw(STYLES.td)}">${String(e.openMatches)}</td><td style="${raw(STYLES.td)}">${String(e.totalMatches)}</td><td style="${raw(STYLES.td)}">${e.ransomwareLinked ? raw(severityBadge("high", "ransomware")) : ""}</td></tr>`,
          )
          .join("\n");
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">KEV exposure</h2>
  <div style="${raw(STYLES.heroRow)}">
    <div>
      <p style="${raw(STYLES.heroFigure(sk.openMatches > 0 ? "#b91c1c" : accent))}">${String(sk.openMatches)}</p>
      <p style="${raw(STYLES.heroSub)}">open match${sk.openMatches === 1 ? "" : "es"} · ${sub}</p>
    </div>
  </div>
  <h3 style="${raw(STYLES.h3)}">Top exposures</h3>
  <table style="${raw(STYLES.dataTable)}">
    <thead>
      <tr><th style="${raw(STYLES.thRow)}">Stack item</th><th style="${raw(STYLES.thRow)}">Open</th><th style="${raw(STYLES.thRow)}">Total</th><th style="${raw(STYLES.thRow)}">&nbsp;</th></tr>
    </thead>
    <tbody>${raw(tableRows)}</tbody>
  </table>
</section>`;
}

function severityBadge(
  severity: string,
  label?: string,
): string {
  const sev = severity.toLowerCase();
  let bg = "#e5e7eb";
  let fg = "#1f2937";
  if (sev === "high") {
    bg = "#fee2e2";
    fg = "#991b1b";
  } else if (sev === "medium") {
    bg = "#fef3c7";
    fg = "#92400e";
  } else if (sev === "low") {
    bg = "#dcfce7";
    fg = "#14532d";
  } else if (sev === "informational" || sev === "info") {
    bg = "#dbeafe";
    fg = "#1e40af";
  }
  return html`<span style="display:inline-block;padding:1px 8px;border-radius:8px;background:${bg};color:${fg};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">${label ?? severity}</span>`;
}

/** Render the EntraRisk section: total risky users + breakdown by risk
 *  level + breakdown by risk state. Three terminal states:
 *    1. licence_required — surface a static empty-state explaining the
 *       Entra ID P2 licence requirement. No counts available.
 *    2. populated counts — hero figure (total) + two breakdown tables.
 *    3. null / no_data — generic empty-state.
 *
 *  Comparison: per-tile delta on the total against the prior period's
 *  envelope. Skipped when prior was licence_required (no comparable
 *  data point) or absent. */
function renderEntraRiskSection(
  raw_: unknown,
  accent: string,
  comparison: ReportSnapshotEnvelope["comparison"],
): string {
  const er = coerceEntraRisk(raw_);
  if (!er) {
    return renderEmptySection(
      "Risky users (Entra ID Protection)",
      "No risky-user data was available at capture time.",
    );
  }
  if (er.licenceState === "licence_required") {
    return renderEmptySection(
      "Risky users (Entra ID Protection)",
      "This source requires Entra ID P2 (or equivalent). The current licence does not include risk-detection access.",
    );
  }
  if (!er.counts) {
    return renderEmptySection(
      "Risky users (Entra ID Protection)",
      "No risky-user data was available at capture time.",
    );
  }
  const { total, byRiskLevel, byRiskState } = er.counts;
  const prior = comparison?.priorRiskyUsersTotal;
  const deltaSuffix =
    typeof prior === "number" && Number.isFinite(prior)
      ? renderCountDeltaSuffix(total, prior, /*lowerIsBetter*/ true)
      : "";
  const levelOrder: ReadonlyArray<string> = ["high", "medium", "low", "hidden", "none", "unknown"];
  const stateOrder: ReadonlyArray<string> = [
    "atRisk",
    "confirmedCompromised",
    "remediated",
    "confirmedSafe",
    "dismissed",
    "none",
    "unknown",
  ];
  const levelRows = renderRiskBreakdownRows(byRiskLevel, levelOrder);
  const stateRows = renderRiskBreakdownRows(byRiskState, stateOrder);
  // Hero accent: orange/red when there are risky users at risk; otherwise
  // the brand accent (matches KEV section's two-colour pattern).
  const atRiskCount =
    typeof byRiskState["atRisk"] === "number" ? byRiskState["atRisk"] : 0;
  const heroAccent = atRiskCount > 0 ? "#b91c1c" : accent;
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Risky users (Entra ID Protection)</h2>
  <div style="${raw(STYLES.heroRow)}">
    <div>
      <p style="${raw(STYLES.heroFigure(heroAccent))}">${String(total)}</p>
      <p style="${raw(STYLES.heroSub)}">tracked${atRiskCount > 0 ? html` · ${String(atRiskCount)} currently at-risk` : ""}${raw(deltaSuffix)}</p>
    </div>
  </div>
  <h3 style="${raw(STYLES.h3)}">By risk level</h3>
  <table style="${raw(STYLES.dataTable)}">
    <thead><tr><th style="${raw(STYLES.thRow)}">Level</th><th style="${raw(STYLES.thRow)}">Count</th></tr></thead>
    <tbody>${raw(levelRows)}</tbody>
  </table>
  <h3 style="${raw(STYLES.h3)}">By risk state</h3>
  <table style="${raw(STYLES.dataTable)}">
    <thead><tr><th style="${raw(STYLES.thRow)}">State</th><th style="${raw(STYLES.thRow)}">Count</th></tr></thead>
    <tbody>${raw(stateRows)}</tbody>
  </table>
</section>`;
}

/** Render the breakdown-table body. Drops zero-count rows to keep the
 *  table focused on what's actually present. Order is caller-supplied so
 *  level / state tables share the helper. */
function renderRiskBreakdownRows(
  counts: Readonly<Record<string, number>>,
  order: readonly string[],
): string {
  const rows = order
    .filter((k) => typeof counts[k] === "number" && (counts[k] ?? 0) > 0)
    .map(
      (k) =>
        html`<tr><td style="${raw(STYLES.td)}">${k}</td><td style="${raw(STYLES.td)}">${String(counts[k])}</td></tr>`,
    )
    .join("\n");
  if (rows === "") {
    return html`<tr><td colspan="2" style="${raw(STYLES.td)} text-align:center;color:#6b7280;">No risky users tracked.</td></tr>`;
  }
  return rows;
}

function renderBriefSection(raw_: unknown): string {
  const b = coerceBrief(raw_);
  if (!b || !b.body) {
    return renderEmptySection(
      "Daily Brief",
      "No brief was available at capture time.",
    );
  }
  // ADR-0012 §5 plain-text-only — preserve newlines, escape everything.
  // Convert blank-line-separated paragraphs to <p>; everything inside is
  // escaped via the html helper.
  const paragraphs = b.body
    .split(/\n{2,}/)
    .map((p) => html`<p style="${raw(STYLES.briefP)}">${p.trim()}</p>`)
    .join("\n");
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Daily Brief</h2>
  <p style="${raw(STYLES.meta)}">
    ${b.briefDate ?? "no date"}${b.modelDeployment ? html` · ${b.modelDeployment}` : ""}
  </p>
  ${raw(paragraphs)}
</section>`;
}

function renderPostureSection(raw_: unknown): string {
  const p = coercePosture(raw_);
  if (!p || !p.body) {
    return renderEmptySection(
      "Weekly Posture",
      "No posture narrative was available at capture time.",
    );
  }
  const paragraphs = p.body
    .split(/\n{2,}/)
    .map((para) => html`<p style="${raw(STYLES.briefP)}">${para.trim()}</p>`)
    .join("\n");
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Weekly Posture</h2>
  <p style="${raw(STYLES.meta)}">
    ${p.isoWeek ?? "no week"}${p.modelDeployment ? html` · ${p.modelDeployment}` : ""}
  </p>
  ${raw(paragraphs)}
</section>`;
}

function renderIngestHealthSection(raw_: unknown): string {
  const rows = coerceIngestHealth(raw_);
  if (rows.length === 0) {
    return renderEmptySection(
      "Ingest health",
      "No ingest-health rows were recorded at capture time.",
    );
  }
  const tbody = rows
    .map(
      (r) =>
        html`<tr><td style="${raw(STYLES.td)}">${r.source}</td><td style="${raw(STYLES.td)}">${r.status}</td><td style="${raw(STYLES.td)}">${formatTimestamp(r.lastSuccessAt ?? "")}</td><td style="${raw(STYLES.td)}">${String(r.consecutiveFailureCount)}</td></tr>`,
    )
    .join("\n");
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Ingest health</h2>
  <table style="${raw(STYLES.dataTable)}">
    <thead>
      <tr><th style="${raw(STYLES.thRow)}">Source</th><th style="${raw(STYLES.thRow)}">Status</th><th style="${raw(STYLES.thRow)}">Last success</th><th style="${raw(STYLES.thRow)}">Consecutive failures</th></tr>
    </thead>
    <tbody>${raw(tbody)}</tbody>
  </table>
</section>`;
}

// §10.62 sections ------------------------------------------------------------

interface UserDormancyShape {
  readonly licenceState: "ok" | "licence_required";
  readonly summary: {
    readonly total: number;
    readonly dormant: number;
    readonly enabledDormant: number;
    readonly disabledDormant: number;
    readonly excluded: number;
    readonly thresholdDays: number;
    readonly oldestDormantUpn: string | null;
    readonly oldestDormantLastSignIn: string | null;
  } | null;
  readonly policy: {
    readonly thresholdDays: number;
    readonly includeDisabledAccounts: boolean;
  } | null;
}

function coerceUserDormancy(raw_: unknown): UserDormancyShape | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const o = raw_ as Record<string, unknown>;
  const licenceState = o.licenceState === "licence_required" ? "licence_required" : "ok";
  const s = (o.summary ?? null) as Record<string, unknown> | null;
  const summary =
    s &&
    typeof s.total === "number" &&
    typeof s.dormant === "number" &&
    typeof s.enabledDormant === "number" &&
    typeof s.disabledDormant === "number" &&
    typeof s.excluded === "number" &&
    typeof s.thresholdDays === "number"
      ? {
          total: s.total,
          dormant: s.dormant,
          enabledDormant: s.enabledDormant,
          disabledDormant: s.disabledDormant,
          excluded: s.excluded,
          thresholdDays: s.thresholdDays,
          oldestDormantUpn: typeof s.oldestDormantUpn === "string" ? s.oldestDormantUpn : null,
          oldestDormantLastSignIn:
            typeof s.oldestDormantLastSignIn === "string" ? s.oldestDormantLastSignIn : null,
        }
      : null;
  const p = (o.policy ?? null) as Record<string, unknown> | null;
  const policy =
    p &&
    typeof p.thresholdDays === "number" &&
    typeof p.includeDisabledAccounts === "boolean"
      ? {
          thresholdDays: p.thresholdDays,
          includeDisabledAccounts: p.includeDisabledAccounts,
        }
      : null;
  return { licenceState, summary, policy };
}

function renderUserDormancySection(raw_: unknown, accent: string): string {
  const ud = coerceUserDormancy(raw_);
  if (!ud) {
    return renderEmptySection(
      "User dormancy",
      "No dormancy data was available at capture time.",
    );
  }
  if (ud.licenceState === "licence_required") {
    return renderEmptySection(
      "User dormancy",
      "This source requires Entra ID P1 (or equivalent). The current licence does not include the signInActivity property.",
    );
  }
  const s = ud.summary;
  if (!s) {
    return renderEmptySection(
      "User dormancy",
      "No dormancy data was available at capture time.",
    );
  }
  const heroAccent = s.dormant > 0 ? "#b45309" : accent;
  const oldestLine =
    s.oldestDormantUpn && s.oldestDormantLastSignIn
      ? html`<p style="${raw(STYLES.heroSub)}">Oldest dormant: <strong>${s.oldestDormantUpn}</strong> · last sign-in ${formatTimestamp(s.oldestDormantLastSignIn)}</p>`
      : html`<p style="${raw(STYLES.heroSub)}">No dormant accounts above threshold.</p>`;
  const policyLine = ud.policy
    ? html`<p style="${raw(STYLES.meta)}">Threshold ${String(ud.policy.thresholdDays)} days · ${ud.policy.includeDisabledAccounts ? "includes" : "excludes"} disabled accounts.</p>`
    : "";
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">User dormancy</h2>
  ${raw(policyLine)}
  <div style="${raw(STYLES.heroRow)}">
    <div>
      <p style="${raw(STYLES.heroFigure(heroAccent))}">${String(s.dormant)}</p>
      <p style="${raw(STYLES.heroSub)}">dormant of ${String(s.total)} tracked${s.excluded > 0 ? html` · ${String(s.excluded)} excluded by policy` : ""}</p>
      ${raw(oldestLine)}
    </div>
  </div>
  <table style="${raw(STYLES.dataTable)}">
    <thead>
      <tr><th style="${raw(STYLES.thRow)}">Cohort</th><th style="${raw(STYLES.thRow)}">Count</th></tr>
    </thead>
    <tbody>
      <tr><td style="${raw(STYLES.td)}">Enabled and dormant</td><td style="${raw(STYLES.td)}">${String(s.enabledDormant)}</td></tr>
      <tr><td style="${raw(STYLES.td)}">Disabled and dormant</td><td style="${raw(STYLES.td)}">${String(s.disabledDormant)}</td></tr>
      <tr><td style="${raw(STYLES.td)}">Excluded by policy</td><td style="${raw(STYLES.td)}">${String(s.excluded)}</td></tr>
    </tbody>
  </table>
</section>`;
}

interface SignInsShape {
  readonly licenceState: "ok" | "licence_required";
  readonly summary: {
    readonly totalToday: number;
    readonly outOfAreaToday: number;
    readonly caFailuresToday: number;
    readonly mostRecentOutOfArea: {
      readonly userPrincipalName: string;
      readonly country: string;
      readonly createdDateTime: string;
    } | null;
  } | null;
  readonly policy: {
    readonly enabled: boolean;
    readonly allowedCountries: readonly string[];
    readonly unknownLocationPolicy: "alert" | "ignore";
  } | null;
}

function coerceSignIns(raw_: unknown): SignInsShape | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const o = raw_ as Record<string, unknown>;
  const licenceState = o.licenceState === "licence_required" ? "licence_required" : "ok";
  const s = (o.summary ?? null) as Record<string, unknown> | null;
  const m =
    s && s.mostRecentOutOfArea && typeof s.mostRecentOutOfArea === "object"
      ? (s.mostRecentOutOfArea as Record<string, unknown>)
      : null;
  const mostRecentOutOfArea =
    m &&
    typeof m.userPrincipalName === "string" &&
    typeof m.country === "string" &&
    typeof m.createdDateTime === "string"
      ? {
          userPrincipalName: m.userPrincipalName,
          country: m.country,
          createdDateTime: m.createdDateTime,
        }
      : null;
  const summary =
    s &&
    typeof s.totalToday === "number" &&
    typeof s.outOfAreaToday === "number" &&
    typeof s.caFailuresToday === "number"
      ? {
          totalToday: s.totalToday,
          outOfAreaToday: s.outOfAreaToday,
          caFailuresToday: s.caFailuresToday,
          mostRecentOutOfArea,
        }
      : null;
  const p = (o.policy ?? null) as Record<string, unknown> | null;
  const allowed = Array.isArray(p?.allowedCountries) ? (p?.allowedCountries as unknown[]) : [];
  const policy =
    p && typeof p.enabled === "boolean"
      ? {
          enabled: p.enabled,
          allowedCountries: allowed.filter((c): c is string => typeof c === "string"),
          unknownLocationPolicy:
            p.unknownLocationPolicy === "ignore" ? ("ignore" as const) : ("alert" as const),
        }
      : null;
  return { licenceState, summary, policy };
}

function renderSignInsSection(raw_: unknown, accent: string): string {
  const si = coerceSignIns(raw_);
  if (!si) {
    return renderEmptySection(
      "Sign-ins (last 24 hours)",
      "No sign-in data was available at capture time.",
    );
  }
  if (si.licenceState === "licence_required") {
    return renderEmptySection(
      "Sign-ins (last 24 hours)",
      "This source requires Entra ID P1 (or equivalent). Sign-in audit logs are not retained on the current licence.",
    );
  }
  const s = si.summary;
  if (!s) {
    return renderEmptySection(
      "Sign-ins (last 24 hours)",
      "No sign-in data was available at capture time.",
    );
  }
  const heroAccent = s.outOfAreaToday > 0 || s.caFailuresToday > 0 ? "#b45309" : accent;
  const policyLine = si.policy?.enabled
    ? html`<p style="${raw(STYLES.meta)}">Geo-fence active · allowed countries: ${si.policy.allowedCountries.length > 0 ? si.policy.allowedCountries.join(", ").toUpperCase() : "(none configured)"} · unknown locations ${si.policy.unknownLocationPolicy}.</p>`
    : html`<p style="${raw(STYLES.meta)}">Geo-fence inactive.</p>`;
  const recentBlock = s.mostRecentOutOfArea
    ? html`<p style="${raw(STYLES.heroSub)}">Most recent out-of-area: <strong>${s.mostRecentOutOfArea.userPrincipalName}</strong> from ${s.mostRecentOutOfArea.country.toUpperCase()} at ${formatTimestamp(s.mostRecentOutOfArea.createdDateTime)}.</p>`
    : "";
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Sign-ins (last 24 hours)</h2>
  ${raw(policyLine)}
  <div style="${raw(STYLES.heroRow)}">
    <div>
      <p style="${raw(STYLES.heroFigure(heroAccent))}">${String(s.totalToday)}</p>
      <p style="${raw(STYLES.heroSub)}">total · ${String(s.outOfAreaToday)} out-of-area · ${String(s.caFailuresToday)} CA failures</p>
      ${raw(recentBlock)}
    </div>
  </div>
</section>`;
}

interface ConditionalAccessShape {
  readonly counts: {
    readonly total: number;
    readonly enabled: number;
    readonly disabled: number;
    readonly reportOnly: number;
  };
}

function coerceConditionalAccess(raw_: unknown): ConditionalAccessShape | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const o = raw_ as Record<string, unknown>;
  const c = (o.counts ?? null) as Record<string, unknown> | null;
  if (
    !c ||
    typeof c.total !== "number" ||
    typeof c.enabled !== "number" ||
    typeof c.disabled !== "number" ||
    typeof c.reportOnly !== "number"
  ) {
    return null;
  }
  return {
    counts: {
      total: c.total,
      enabled: c.enabled,
      disabled: c.disabled,
      reportOnly: c.reportOnly,
    },
  };
}

function renderConditionalAccessSection(raw_: unknown, accent: string): string {
  const ca = coerceConditionalAccess(raw_);
  if (!ca) {
    return renderEmptySection(
      "Conditional Access",
      "No Conditional Access policy data was available at capture time.",
    );
  }
  const c = ca.counts;
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Conditional Access</h2>
  <div style="${raw(STYLES.heroRow)}">
    <div>
      <p style="${raw(STYLES.heroFigure(accent))}">${String(c.total)}</p>
      <p style="${raw(STYLES.heroSub)}">policies tracked</p>
    </div>
  </div>
  <table style="${raw(STYLES.dataTable)}">
    <thead>
      <tr><th style="${raw(STYLES.thRow)}">State</th><th style="${raw(STYLES.thRow)}">Count</th></tr>
    </thead>
    <tbody>
      <tr><td style="${raw(STYLES.td)}">Enabled</td><td style="${raw(STYLES.td)}">${String(c.enabled)}</td></tr>
      <tr><td style="${raw(STYLES.td)}">Disabled</td><td style="${raw(STYLES.td)}">${String(c.disabled)}</td></tr>
      <tr><td style="${raw(STYLES.td)}">Report-only</td><td style="${raw(STYLES.td)}">${String(c.reportOnly)}</td></tr>
    </tbody>
  </table>
</section>`;
}

interface AzureSecureScoreShape {
  readonly subscriptions: ReadonlyArray<{
    readonly subscriptionId: string;
    readonly subscriptionName: string;
    readonly latest: {
      readonly snapshotDate: string;
      readonly currentScore: number;
      readonly maxScore: number;
      readonly percentage: number;
    };
    readonly trend: ReadonlyArray<{
      readonly snapshotDate: string;
      readonly percentage: number;
    }>;
  }>;
}

function coerceAzureSecureScore(raw_: unknown): AzureSecureScoreShape | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const o = raw_ as Record<string, unknown>;
  const subsRaw = Array.isArray(o.subscriptions) ? (o.subscriptions as unknown[]) : null;
  if (!subsRaw) return null;
  const subscriptions: Array<AzureSecureScoreShape["subscriptions"][number]> = [];
  for (const e of subsRaw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const lat = (r.latest ?? null) as Record<string, unknown> | null;
    if (
      !lat ||
      typeof lat.snapshotDate !== "string" ||
      typeof lat.currentScore !== "number" ||
      typeof lat.maxScore !== "number" ||
      typeof lat.percentage !== "number"
    ) {
      continue;
    }
    const trendRaw = Array.isArray(r.trend) ? (r.trend as unknown[]) : [];
    const trend: Array<{ snapshotDate: string; percentage: number }> = [];
    for (const t of trendRaw) {
      if (!t || typeof t !== "object") continue;
      const tr = t as Record<string, unknown>;
      if (typeof tr.snapshotDate === "string" && typeof tr.percentage === "number") {
        trend.push({ snapshotDate: tr.snapshotDate, percentage: tr.percentage });
      }
    }
    subscriptions.push({
      subscriptionId: typeof r.subscriptionId === "string" ? r.subscriptionId : "",
      subscriptionName: typeof r.subscriptionName === "string" ? r.subscriptionName : "",
      latest: {
        snapshotDate: lat.snapshotDate,
        currentScore: lat.currentScore,
        maxScore: lat.maxScore,
        percentage: lat.percentage,
      },
      trend,
    });
  }
  return { subscriptions };
}

function renderAzureSecureScoreSection(raw_: unknown, accent: string): string {
  const az = coerceAzureSecureScore(raw_);
  if (!az || az.subscriptions.length === 0) {
    return renderEmptySection(
      "Defender for Cloud Secure Score",
      "No Defender for Cloud Secure Score snapshot was available at capture time.",
    );
  }
  // Single-sub layout (ADR-0036 Phase A v1) — promote the only sub to the
  // hero figure, drop the per-sub table. Multi-sub falls back to a table of
  // subs so it scales naturally when Phase B lands.
  if (az.subscriptions.length === 1) {
    const sub = az.subscriptions[0]!;
    // renderSparkline takes TrendPoint[] = { date, percentage }; the Azure
    // trend uses snapshotDate as the temporal key. Map the field name across.
    const trendShape: ReadonlyArray<{ readonly date: string; readonly percentage: number }> =
      sub.trend.map((t) => ({ date: t.snapshotDate, percentage: t.percentage }));
    const sparkline = trendShape.length >= 2 ? renderSparkline(trendShape, accent) : "";
    const trendDelta = computeTrendDelta(trendShape);
    const deltaLine =
      trendDelta === null
        ? raw("")
        : raw(
            html`<p style="${raw(STYLES.heroSub)}">${trendDelta >= 0 ? "+" : ""}${trendDelta.toFixed(1)} pp over ${String(sub.trend.length)} snapshots</p>`,
          );
    return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Defender for Cloud Secure Score</h2>
  <p style="${raw(STYLES.meta)}">${sub.subscriptionName} · snapshot ${sub.latest.snapshotDate}</p>
  <div style="${raw(STYLES.heroRow)}">
    <div>
      <p style="${raw(STYLES.heroFigure(accent))}">${sub.latest.percentage.toFixed(1)}%</p>
      <p style="${raw(STYLES.heroSub)}">${sub.latest.currentScore.toFixed(1)} of ${String(sub.latest.maxScore)} points</p>
      ${deltaLine}
    </div>
    <div>${raw(sparkline)}</div>
  </div>
</section>`;
  }
  const rows = az.subscriptions
    .map(
      (sub) =>
        html`<tr><td style="${raw(STYLES.td)}"><strong>${sub.subscriptionName}</strong></td><td style="${raw(STYLES.td)}">${sub.latest.percentage.toFixed(1)}%</td><td style="${raw(STYLES.td)}">${sub.latest.currentScore.toFixed(1)} of ${String(sub.latest.maxScore)}</td><td style="${raw(STYLES.td)}">${sub.latest.snapshotDate}</td></tr>`,
    )
    .join("\n");
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">Defender for Cloud Secure Score</h2>
  <p style="${raw(STYLES.meta)}">${String(az.subscriptions.length)} tracked subscriptions.</p>
  <table style="${raw(STYLES.dataTable)}">
    <thead>
      <tr><th style="${raw(STYLES.thRow)}">Subscription</th><th style="${raw(STYLES.thRow)}">Score</th><th style="${raw(STYLES.thRow)}">Points</th><th style="${raw(STYLES.thRow)}">Snapshot</th></tr>
    </thead>
    <tbody>${raw(rows)}</tbody>
  </table>
</section>`;
}

function renderEmptySection(title: string, message: string): string {
  return html`<section style="${raw(STYLES.section)}">
  <h2 style="${raw(STYLES.h2)}">${title}</h2>
  <p style="${raw(STYLES.empty)}">${message}</p>
</section>`;
}

// --- Sparkline (numbers-only path computation) ----------------------------

interface TrendPoint {
  readonly date: string;
  readonly percentage: number;
}

/**
 * Render a 90-day Secure Score trend as inline SVG. All path coordinates
 * computed from numbers — strings never reach `d="..."`. Width / height
 * fixed to keep the layout email-stable.
 */
function renderSparkline(trend: readonly TrendPoint[], accent: string): string {
  const W = 320;
  const H = 60;
  const pad = 4;
  const xs = trend.map((_, i) => i / Math.max(1, trend.length - 1));
  const ys = trend.map((p) => p.percentage);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const range = Math.max(0.1, maxY - minY);
  const points = xs.map((x, i) => {
    const px = pad + x * (W - 2 * pad);
    const py = H - pad - ((ys[i]! - minY) / range) * (H - 2 * pad);
    return `${px.toFixed(2)},${py.toFixed(2)}`;
  });
  const d = `M ${points.join(" L ")}`;
  // d is built from numbers + literal " L " — no string interpolation.
  // accent is hex-validated by sanitiseBranding upstream.
  return html`<svg width="${String(W)}" height="${String(H)}" viewBox="0 0 ${String(W)} ${String(H)}" style="margin-top:8px;display:block;">
  <path d="${d}" fill="none" stroke="${accent}" stroke-width="1.5" />
</svg>`;
}

function computeTrendDelta(trend: readonly TrendPoint[]): number | null {
  if (trend.length < 2) return null;
  const first = trend[0]!.percentage;
  const last = trend[trend.length - 1]!.percentage;
  return last - first;
}

// --- Coercion helpers — defensive readers for envelope.sections.* (unknown)

function coerceSecureScore(
  raw_: unknown,
): { snapshot: SecureScoreSnapshot | null; trend: readonly TrendPoint[] } | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const obj = raw_ as Record<string, unknown>;
  const snapshot = (obj.snapshot ?? null) as SecureScoreSnapshot | null;
  const rawTrend = Array.isArray(obj.trend) ? (obj.trend as unknown[]) : [];
  const trend: TrendPoint[] = [];
  for (const t of rawTrend) {
    if (
      t &&
      typeof t === "object" &&
      typeof (t as { date?: unknown }).date === "string" &&
      typeof (t as { percentage?: unknown }).percentage === "number"
    ) {
      const tp = t as { date: string; percentage: number };
      trend.push({ date: tp.date, percentage: tp.percentage });
    }
  }
  return { snapshot, trend };
}

function coerceIncidents(
  raw_: unknown,
): {
  counts: { activeCount: number; highSeverityCount: number };
  preview: readonly IncidentSummary[];
  trend: ReadonlyArray<{ day: string; total: number }>;
} | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const obj = raw_ as Record<string, unknown>;
  const counts = (obj.counts ?? null) as Record<string, unknown> | null;
  const preview = Array.isArray(obj.preview) ? (obj.preview as IncidentSummary[]) : [];
  const rawTrend = Array.isArray(obj.trend) ? (obj.trend as unknown[]) : [];
  const trend: Array<{ day: string; total: number }> = [];
  for (const t of rawTrend) {
    if (
      t &&
      typeof t === "object" &&
      typeof (t as { day?: unknown }).day === "string" &&
      typeof (t as { total?: unknown }).total === "number"
    ) {
      const tp = t as { day: string; total: number };
      trend.push({ day: tp.day, total: tp.total });
    }
  }
  return {
    counts: {
      activeCount: typeof counts?.activeCount === "number" ? counts.activeCount : 0,
      highSeverityCount:
        typeof counts?.highSeverityCount === "number" ? counts.highSeverityCount : 0,
    },
    preview,
    trend,
  };
}

interface BriefShape {
  readonly briefDate: string | null;
  readonly body: string | null;
  readonly modelDeployment: string | null;
}

function coerceBrief(raw_: unknown): BriefShape | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const o = raw_ as Record<string, unknown>;
  return {
    briefDate: typeof o.briefDate === "string" ? o.briefDate : null,
    body: typeof o.body === "string" ? o.body : null,
    modelDeployment: typeof o.modelDeployment === "string" ? o.modelDeployment : null,
  };
}

interface PostureShape {
  readonly isoWeek: string | null;
  readonly body: string | null;
  readonly modelDeployment: string | null;
}

function coercePosture(raw_: unknown): PostureShape | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const o = raw_ as Record<string, unknown>;
  return {
    isoWeek: typeof o.isoWeek === "string" ? o.isoWeek : null,
    body: typeof o.body === "string" ? o.body : null,
    modelDeployment: typeof o.modelDeployment === "string" ? o.modelDeployment : null,
  };
}

function coerceIngestHealth(raw_: unknown): readonly IngestHealthRow[] {
  return Array.isArray(raw_) ? (raw_ as IngestHealthRow[]) : [];
}

interface EntraRiskShape {
  readonly licenceState: "licence_required" | null;
  readonly counts: {
    readonly total: number;
    readonly byRiskLevel: Readonly<Record<string, number>>;
    readonly byRiskState: Readonly<Record<string, number>>;
  } | null;
}

/** Coerce the entraRisk envelope section. Three valid input shapes:
 *    1. { counts: { licenceState: "licence_required" } } — short-circuit
 *    2. { counts: { total, byRiskLevel, byRiskState, ... } } — populated
 *    3. null / undefined / malformed — null
 *
 *  The byRiskLevel / byRiskState records are filtered to numeric values
 *  only — defends against an envelope row whose adapter wrote a string
 *  count somehow (no upstream change should produce this; belt-and-braces). */
function coerceEntraRisk(raw_: unknown): EntraRiskShape | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const o = raw_ as Record<string, unknown>;
  const counts = (o.counts ?? null) as Record<string, unknown> | null;
  if (!counts) return null;
  if (counts.licenceState === "licence_required") {
    return { licenceState: "licence_required", counts: null };
  }
  if (typeof counts.total !== "number") return null;
  const byRiskLevel = sanitiseCountRecord(counts.byRiskLevel);
  const byRiskState = sanitiseCountRecord(counts.byRiskState);
  return {
    licenceState: null,
    counts: {
      total: counts.total,
      byRiskLevel,
      byRiskState,
    },
  };
}

/** Drop non-numeric values and prototype-pollution keys from a count
 *  record. Defensive — the envelope assembler always writes the full
 *  Record<EntraRiskLevel, number> / Record<EntraRiskState, number>,
 *  but the renderer never trusts its input. */
function sanitiseCountRecord(input: unknown): Readonly<Record<string, number>> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

interface StackKevExposureShape {
  readonly totalStackItems: number;
  readonly totalMatches: number;
  readonly openMatches: number;
  readonly dueThisWeek: number;
  readonly ransomwareLinkedOpen: number;
  readonly topExposures: ReadonlyArray<{
    readonly stackItemId: string;
    readonly vendor: string;
    readonly product: string;
    readonly version: string;
    readonly openMatches: number;
    readonly totalMatches: number;
    readonly ransomwareLinked: boolean;
  }>;
}

function coerceStackKevExposure(raw_: unknown): StackKevExposureShape | null {
  if (!raw_ || typeof raw_ !== "object") return null;
  const o = raw_ as Record<string, unknown>;
  const top = Array.isArray(o.topExposures) ? (o.topExposures as unknown[]) : [];
  const exposures: StackKevExposureShape["topExposures"] = top
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      stackItemId: typeof e.stackItemId === "string" ? e.stackItemId : "",
      vendor: typeof e.vendor === "string" ? e.vendor : "",
      product: typeof e.product === "string" ? e.product : "",
      version: typeof e.version === "string" ? e.version : "",
      openMatches: typeof e.openMatches === "number" ? e.openMatches : 0,
      totalMatches: typeof e.totalMatches === "number" ? e.totalMatches : 0,
      ransomwareLinked: e.ransomwareLinked === true,
    }));
  return {
    totalStackItems: typeof o.totalStackItems === "number" ? o.totalStackItems : 0,
    totalMatches: typeof o.totalMatches === "number" ? o.totalMatches : 0,
    openMatches: typeof o.openMatches === "number" ? o.openMatches : 0,
    dueThisWeek: typeof o.dueThisWeek === "number" ? o.dueThisWeek : 0,
    ransomwareLinkedOpen:
      typeof o.ransomwareLinkedOpen === "number" ? o.ransomwareLinkedOpen : 0,
    topExposures: exposures,
  };
}

// --- Formatting helpers ---------------------------------------------------

/**
 * Render the period as readable prose for the report header.
 *   weekly:    "Week 17 of 2026 (20–26 April)"
 *   monthly:   "April 2026"
 *   quarterly: "Q2 2026 (April–June)"
 *
 * Falls back to the periodKey if the period dates fail to parse — never
 * throws on a malformed envelope.
 */
function formatPeriodProse(envelope: ReportSnapshotEnvelope): string {
  const start = new Date(envelope.periodStart);
  const end = new Date(envelope.periodEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return envelope.periodKey;
  }
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const startMonth = monthNames[start.getUTCMonth()] ?? "";
  const startDay = start.getUTCDate();
  const endMonth = monthNames[end.getUTCMonth()] ?? "";
  const endDay = end.getUTCDate();
  const year = start.getUTCFullYear();
  switch (envelope.periodCadence) {
    case "monthly":
      return `${startMonth} ${year}`;
    case "quarterly": {
      const m = envelope.periodKey.match(/^(\d{4})-Q([1-4])$/);
      if (m) {
        const q = m[2];
        return `Q${q} ${year} (${startMonth}–${endMonth})`;
      }
      return `${startMonth}–${endMonth} ${year}`;
    }
    case "weekly": {
      const m = envelope.periodKey.match(/^(\d{4})-W(\d{2})$/);
      const weekNum = m ? Number.parseInt(m[2] ?? "0", 10) : 0;
      const sameMonth = startMonth === endMonth;
      const range = sameMonth
        ? `${String(startDay)}–${String(endDay)} ${endMonth}`
        : `${String(startDay)} ${startMonth}–${String(endDay)} ${endMonth}`;
      return `Week ${String(weekNum)} of ${year} (${range})`;
    }
  }
}

function formatTimestamp(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatCapturedBy(capturedBy: string): string {
  if (capturedBy === "system.timer") return "auto-capture (Timer)";
  if (capturedBy.length > 12) return `${capturedBy.slice(0, 8)}…`;
  return capturedBy;
}

// --- Inline styles --------------------------------------------------------
//
// Inline-only — email clients strip <style> blocks, so every visible
// element gets its `style="..."` attribute. Kept as a flat object so the
// renderer interpolations stay readable.

const STYLES = Object.freeze({
  body: "margin:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;",
  shell: "max-width:780px;margin:24px auto;background:#ffffff;padding:32px;border:1px solid #e5e7eb;",
  // Header is now branding-aware — see headerStyles(accent) for the live form.
  header: "margin-bottom:16px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;",
  eyebrow: "margin:0;color:#6b7280;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;",
  eyebrowAccent: (accent: string) =>
    `margin:0;color:${accent};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;`,
  h1: "margin:6px 0 0;font-size:24px;font-weight:700;letter-spacing:-0.01em;",
  headerSub: "margin:8px 0 0;color:#374151;font-size:13px;",
  headerMeta: "margin:4px 0 0;color:#6b7280;font-size:12px;",
  section: "margin:16px 0;padding:16px;border:1px solid #e5e7eb;",
  h2: "margin:0 0 12px;font-size:18px;font-weight:600;",
  h3: "margin:16px 0 8px;font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.04em;",
  meta: "margin:0 0 8px;color:#6b7280;font-size:12px;",
  empty: "margin:0;color:#6b7280;font-size:13px;",
  kvTable: "border-collapse:collapse;width:100%;font-size:13px;",
  dataTable: "border-collapse:collapse;width:100%;font-size:13px;margin-top:6px;",
  th: "text-align:left;padding:4px 6px;width:40%;color:#6b7280;font-weight:500;border-bottom:1px solid #f3f4f6;",
  thRow: "text-align:left;padding:4px 6px;color:#6b7280;font-weight:500;border-bottom:1px solid #d1d5db;",
  td: "padding:4px 6px;border-bottom:1px solid #f3f4f6;",
  briefP: "margin:6px 0;font-size:14px;line-height:1.55;",
  footer: "margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px;",
  footerProse: "margin:0 0 6px;color:#6b7280;font-size:12px;font-style:italic;",
  // Hero figure — large display number for the headline metric of each section.
  heroRow: "display:flex;gap:16px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;",
  heroFigure: (accent: string) =>
    `margin:0;font-size:42px;font-weight:700;line-height:1;color:${accent};letter-spacing:-0.02em;`,
  heroSub: "margin:4px 0 0;color:#6b7280;font-size:13px;",
  // Executive summary block.
  execUl: "margin:8px 0 0;padding-left:18px;",
  execLi: "margin:4px 0;font-size:14px;line-height:1.5;color:#1f2937;",
  // Inline logo block — sits above the eyebrow line in the header.
  logo: "max-height:48px;max-width:240px;display:block;margin-bottom:8px;",
  // Operator note callout — accent-tinted left border, soft amber bg.
  operatorNoteP: "margin:6px 0;font-size:14px;line-height:1.55;color:#1f2937;",
  // Forensic footer prose.
  chainProse: "margin:6px 0 0;color:#9ca3af;font-size:11px;line-height:1.5;",
});
