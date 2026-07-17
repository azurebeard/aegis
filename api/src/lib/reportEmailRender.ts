// ADR-0030 §C.6 — email-grade HTML renderer for ReportSnapshotEnvelope.
//
// Discipline (different from `renderEnvelopeHtml` in reportHtml.ts, which
// targets Chromium → window.print()):
//
//  - All styles inline (`style="..."`); no `<style>` block (Gmail strips them).
//  - <table>-based layout with explicit cellpadding/cellspacing/cellborder for
//    Outlook on Windows (Microsoft Word HTML engine — no Grid, no Flexbox).
//  - No CSS Grid, Flexbox, Custom Properties, viewport units, @media.
//  - Web-safe font stack only (Helvetica/Arial fallback).
//  - No SVG, no @import, no <link>; all resources inline or omitted.
//  - Width pinned at 600px (industry-standard email body width).
//  - XHTML 1.0 Transitional DOCTYPE (Outlook 2007+ rendering compatibility).
//  - Auto-generated subject with a hard 78-char RFC 5322 §2.1.1 cap.
//
// Slice 1(b) scope: minimal viable digest. Renders header + period info +
// 3 headline KPIs (when present) + footer.
//
// §C.22 (chunk 3 of the share-link migration): when `opts.shareUrl` is
// supplied the KPI block is REPLACED with a 3-line summary + an
// "Open full report" button + a plain text link. Recipients open the
// signed URL to view the full HTML report (rendered by reportHtml.ts via
// the GET /api/reports/share/{token} endpoint, chunk 2).
//
// Backwards-compatible: when `opts.shareUrl` is undefined or empty
// (signing key unavailable, transient fail-soft window before chunk 4's
// provisioning has run), the renderer falls back to the legacy KPI shape
// so a misconfigured deploy still produces a usable email body.

import type { ReportSnapshotEnvelope } from "./reportSnapshotStore.js";

export interface EmailRenderOptions {
  /** Product name in subject + body header (e.g. "Aegis"). */
  readonly productName: string;
  /** Sender mailbox UPN — shown in the "do not reply" banner. */
  readonly senderMailbox: string;
  /** Optional subject prefix (operator-set). Preserved on truncation. */
  readonly subjectPrefix?: string;
  /** §C.22 — fully-qualified signed share-link URL. When present, the
   *  body's content block becomes "summary + Open full report button +
   *  plain text link". When undefined / empty, falls back to the legacy
   *  KPI rows shape. The orchestrator passes this only after a successful
   *  KV signing-key load (`reportShareSigningKey.ts`). Must already be
   *  HTTPS — caller's responsibility. */
  readonly shareUrl?: string;
}

export interface EmailRenderResult {
  /** Subject line, RFC 5322 §2.1.1-capped at 78 chars. */
  readonly subject: string;
  /** Full HTML body (XHTML 1.0 Transitional). */
  readonly html: string;
}

const SUBJECT_MAX_CHARS = 78;
const BODY_WIDTH_PX = 600;
const FONT_STACK = "Helvetica, Arial, sans-serif";

export function renderEmailHtml(
  envelope: ReportSnapshotEnvelope,
  opts: EmailRenderOptions,
): EmailRenderResult {
  const subject = buildSubject(envelope, opts);
  const html = buildBody(envelope, opts, subject);
  return { subject, html };
}

// ─── Subject ────────────────────────────────────────────────────────────────

function buildSubject(
  envelope: ReportSnapshotEnvelope,
  opts: EmailRenderOptions,
): string {
  const prefix = opts.subjectPrefix?.trim() ?? "";
  // §6.3 email-body batch #2 — reinstate cadence word in the subject so
  // recipients can disambiguate weekly/monthly/quarterly digests at a
  // glance in their inbox list. The original §C.6 rationale ("cadence
  // implicit from periodKey shape") held when only one cadence shipped;
  // multi-cadence reality + recipient-side filter rules (Outlook etc.)
  // benefit from an explicit word. Falls back to the legacy "report"
  // wording when cadence is missing / unknown so the 78-char cap stays
  // tight.
  const cadenceWord = cadenceToWord(envelope.periodCadence);
  const reportNoun = cadenceWord ? `${cadenceWord} report` : "report";
  const base = `${opts.productName} ${reportNoun} — ${envelope.periodKey}`;
  if (prefix.length === 0) {
    return truncateWithEllipsis(base, SUBJECT_MAX_CHARS);
  }
  const full = `${prefix} ${base}`;
  if (full.length <= SUBJECT_MAX_CHARS) {
    return full;
  }
  // Preserve the operator-set prefix; truncate the base portion.
  const room = SUBJECT_MAX_CHARS - prefix.length - 1; // 1 for space
  if (room < 4) {
    // Pathological — prefix alone is too long; truncate the whole thing.
    return truncateWithEllipsis(full, SUBJECT_MAX_CHARS);
  }
  return `${prefix} ${truncateWithEllipsis(base, room)}`;
}

function truncateWithEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

/** Maps the strict envelope.periodCadence enum to the English word used in
 *  the subject line. Returns null on an unrecognised value so the subject
 *  falls back to the legacy "report" wording — never throws. */
function cadenceToWord(cadence: unknown): string | null {
  if (cadence === "weekly") return "weekly";
  if (cadence === "monthly") return "monthly";
  if (cadence === "quarterly") return "quarterly";
  return null;
}

// ─── Body ───────────────────────────────────────────────────────────────────

function buildBody(
  envelope: ReportSnapshotEnvelope,
  opts: EmailRenderOptions,
  subject: string,
): string {
  const periodLabel = `${formatIsoDate(envelope.periodStart)} — ${formatIsoDate(envelope.periodEnd)}`;
  const capturedAt = formatIsoDateTime(envelope.capturedAt);

  const contentRows = opts.shareUrl && opts.shareUrl.length > 0
    ? renderSummaryAndLinkRows(envelope, opts.shareUrl)
    : renderKpiRows(envelope);
  const operatorNote = renderOperatorNoteRow(envelope.operatorNote);

  // Inline styles are repeated literally — DRY via concatenation; emails do
  // not have CSS classes that work cross-client.
  const styles = {
    bodyWrap:
      "margin:0;padding:0;background:#f4f5f7;",
    container:
      `width:${BODY_WIDTH_PX}px;max-width:${BODY_WIDTH_PX}px;margin:0 auto;background:#ffffff;border-collapse:collapse;font-family:${FONT_STACK};color:#1f2937;`,
    bannerCell:
      "padding:10px 16px;background:#1f2937;color:#f9fafb;font-size:12px;font-family:" +
      FONT_STACK +
      ";",
    titleCell:
      "padding:20px 16px 8px 16px;font-family:" +
      FONT_STACK +
      ";font-size:20px;font-weight:bold;color:#0f172a;",
    periodCell:
      "padding:0 16px 16px 16px;font-family:" +
      FONT_STACK +
      ";font-size:13px;color:#4b5563;",
    sectionCell:
      "padding:0 16px 16px 16px;font-family:" +
      FONT_STACK +
      ";font-size:14px;color:#1f2937;",
    greetingCell:
      "padding:8px 16px 4px 16px;font-family:" +
      FONT_STACK +
      ";font-size:14px;color:#1f2937;",
    introCell:
      "padding:0 16px 16px 16px;font-family:" +
      FONT_STACK +
      ";font-size:14px;color:#374151;line-height:1.45;",
    signoffCell:
      "padding:8px 16px 16px 16px;font-family:" +
      FONT_STACK +
      ";font-size:14px;color:#1f2937;line-height:1.4;",
    logoCell:
      "padding:16px 16px 8px 16px;background:#ffffff;",
    logoImg:
      // max-height pinned so over-sized logos render proportionally. Width
      // bounded by max-width — Outlook respects both. Avoids `width:auto`
      // because some clients (Outlook 2007-2019 desktop) compute it to 0.
      "display:block;max-height:48px;max-width:240px;border:0;outline:none;text-decoration:none;",
    footerCell:
      "padding:12px 16px;background:#f3f4f6;font-family:" +
      FONT_STACK +
      ";font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb;",
  };

  return [
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml"><head>',
    '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />',
    `<title>${escapeHtml(subject)}</title>`,
    "</head>",
    `<body style="${styles.bodyWrap}">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${styles.container}">`,

    // Banner
    "<tr>",
    `<td style="${styles.bannerCell}">${escapeHtml(opts.productName)} automated report — do not reply (sender mailbox: ${escapeHtml(opts.senderMailbox)})</td>`,
    "</tr>",

    // Tenant logo (when available). Renders above the title so the
    // recipient sees the customer's brand mark first. Empty string when
    // the envelope has no logo OR the data URI fails the renderer's
    // strict allowlist — falls back to the product-name title block
    // without disruption.
    renderLogoRow(envelope, styles.logoCell, styles.logoImg, opts.productName),

    // Title
    "<tr>",
    `<td style="${styles.titleCell}">${escapeHtml(opts.productName)} report — ${escapeHtml(envelope.periodKey)}</td>`,
    "</tr>",

    // Period info
    "<tr>",
    `<td style="${styles.periodCell}">Period: ${escapeHtml(periodLabel)} · Captured: ${escapeHtml(capturedAt)}</td>`,
    "</tr>",

    // Operator note (when present)
    operatorNote,

    // Greeting + 1-line intro paragraph. Generic-recipient framing —
    // the orchestrator sends via BCC for privacy (no personalised TO
    // header), so there's no recipient name available at render time.
    // The intro text adapts to whether a share-link is wired (chunk 3
    // of the §C.22 share-link migration) or the legacy KPI block is
    // rendering (transient fallback when KV signing key is unavailable).
    "<tr>",
    `<td style="${styles.greetingCell}">Hello,</td>`,
    "</tr>",
    "<tr>",
    `<td style="${styles.introCell}">${escapeHtml(buildIntroLine(envelope, opts))}</td>`,
    "</tr>",

    // Either "summary + Open full report button + plain link" (when
    // shareUrl is set) OR the legacy KPI table (transient fallback).
    contentRows,

    // Sign-off block. Branded against the product name so a
    // multi-product future doesn't have to revisit the renderer.
    "<tr>",
    `<td style="${styles.signoffCell}">Thanks,<br />The ${escapeHtml(opts.productName)} team</td>`,
    "</tr>",

    // Footer
    "<tr>",
    `<td style="${styles.footerCell}">This message was sent automatically — replies are not monitored. Sender: ${escapeHtml(opts.senderMailbox)}. To stop receiving these reports, contact your security administrator.</td>`,
    "</tr>",

    "</table>",
    "</body></html>",
  ].join("");
}

/** §C.22 — share-link replacement for the legacy KPI block. Renders a
 *  styled "Open full report" button + a plain text URL (Outlook strip-
 *  styles fallback). §6.3 batch #3: summary line removed —
 *  the email body now directs recipients straight to the report rather
 *  than duplicating headline numbers between the email and the linked
 *  report. Operator intent: "keep it simple". Caller MUST pass an HTTPS
 *  shareUrl — the URL is escaped twice (href attribute + visible text)
 *  but no scheme check happens here. */
function renderSummaryAndLinkRows(
  _envelope: ReportSnapshotEnvelope,
  shareUrl: string,
): string {
  const safeUrl = escapeHtml(shareUrl);
  return [
    // Styled "Open full report" button. Table-wrapped per the Outlook +
    // Gmail mobile button-rendering precedent (background + padding on
    // the <td>, NOT on the <a> — Outlook ignores <a> background colour).
    "<tr>",
    `<td style="padding:4px 16px 12px 16px;">`,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0">',
    "<tr>",
    `<td style="background:#1f2937;border-radius:4px;">`,
    `<a href="${safeUrl}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-family:${FONT_STACK};font-weight:bold;font-size:14px;">Open full report →</a>`,
    "</td>",
    "</tr>",
    "</table>",
    "</td>",
    "</tr>",

    // Plain text URL — accessibility (screen readers) + Outlook strip-
    // styles fallback. Wraps long URLs; recipients can copy/paste.
    "<tr>",
    `<td style="padding:0 16px 16px 16px;font-family:${FONT_STACK};font-size:11px;color:#6b7280;word-break:break-all;">`,
    `Link: <a href="${safeUrl}" style="color:#2563eb;text-decoration:underline;">${safeUrl}</a>`,
    "</td>",
    "</tr>",
  ].join("");
}

/** One-sentence intro paragraph. Adapts to whether a share-link is wired
 *  (chunk 3 default) or the legacy KPI block is rendering (fallback).
 *  §6.3 batch #3: the share-link intro was tightened — the
 *  summary line was removed below, so the old "headline numbers are
 *  below" wording no longer matched. The new wording directs recipients
 *  straight to the report. The legacy-KPI intro keeps "below" because
 *  the KPI rows ARE below it in that mode. */
function buildIntroLine(
  envelope: ReportSnapshotEnvelope,
  opts: EmailRenderOptions,
): string {
  const periodLabel = `${formatIsoDate(envelope.periodStart)} — ${formatIsoDate(envelope.periodEnd)}`;
  if (opts.shareUrl && opts.shareUrl.length > 0) {
    return `Here is your ${opts.productName} security report for ${periodLabel}. Open the full report below to review this period's security posture and trends.`;
  }
  return `Here is your ${opts.productName} security report for ${periodLabel}. The headline numbers are below.`;
}


/** §6.3 email-body batch #2 — tenant logo row. Reads
 *  `envelope.branding.logoDataUrl` (pre-loaded into the snapshot by
 *  `reportEnvelope.ts:tryFetchLogoDataUrl` at capture time — already
 *  size-capped at LOGO_EMBED_MAX_BYTES) and emits an `<img>` cell.
 *
 *  Defence-in-depth matches `reportHtml.ts:renderLogoBlock` — strict
 *  prefix allowlist (excludes `data:image/svg+xml` per ADR-0029
 *  §Decision.5 since SVG can carry script) + render-time length cap
 *  (200KB) guards against a runaway envelope bypassing the capture-time
 *  cap. Both controls fail to the empty string so the email still
 *  renders, just without the logo.
 *
 *  Returns "" when the envelope has no branding, no logoDataUrl, the
 *  data URI fails the allowlist, or exceeds the length cap. */
function renderLogoRow(
  envelope: ReportSnapshotEnvelope,
  cellStyle: string,
  imgStyle: string,
  productName: string,
): string {
  const url = envelope.branding?.logoDataUrl;
  if (!url) return "";
  // Strict allowlist on the leading bytes — same set as reportHtml.ts.
  // SVG deliberately excluded (ADR-0029 §Decision.5).
  const allowedPrefixes = [
    "data:image/png;base64,",
    "data:image/webp;base64,",
    "data:image/jpeg;base64,",
  ];
  if (!allowedPrefixes.some((p) => url.startsWith(p))) return "";
  // Bound the length at render time — defence against a runaway envelope.
  if (url.length > 200_000) return "";
  return [
    "<tr>",
    `<td style="${cellStyle}">`,
    `<img src="${escapeHtml(url)}" alt="${escapeHtml(productName)} logo" style="${imgStyle}" />`,
    "</td>",
    "</tr>",
  ].join("");
}

function renderOperatorNoteRow(note: string | undefined): string {
  if (!note || note.trim().length === 0) return "";
  return [
    "<tr>",
    `<td style="padding:0 16px 16px 16px;font-family:${FONT_STACK};font-size:13px;color:#374151;background:#fffbeb;border-left:4px solid #f59e0b;">`,
    `<strong>Operator note:</strong> ${escapeHtml(note)}`,
    "</td>",
    "</tr>",
  ].join("");
}

function renderKpiRows(envelope: ReportSnapshotEnvelope): string {
  const kpis: Array<{ label: string; value: string }> = [];

  const secureScorePct = extractSecureScorePercentage(envelope.sections.secureScore);
  if (secureScorePct !== null) {
    kpis.push({ label: "Microsoft Secure Score", value: `${secureScorePct.toFixed(1)}%` });
  }

  const activeIncidents = extractActiveIncidentCount(envelope.sections.incidents);
  if (activeIncidents !== null) {
    kpis.push({ label: "Active incidents", value: String(activeIncidents) });
  }

  const riskyUsers = extractRiskyUsersTotal(envelope.sections.entraRisk);
  if (riskyUsers !== null) {
    kpis.push({ label: "Risky users (total)", value: String(riskyUsers) });
  }

  if (kpis.length === 0) {
    return [
      "<tr>",
      `<td style="padding:0 16px 16px 16px;font-family:${FONT_STACK};font-size:13px;color:#6b7280;font-style:italic;">No headline metrics available in this snapshot.</td>`,
      "</tr>",
    ].join("");
  }

  const kpiRowsHtml = kpis
    .map(
      (k) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;font-family:${FONT_STACK};font-size:13px;color:#4b5563;">${escapeHtml(k.label)}</td><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;font-family:${FONT_STACK};font-size:13px;color:#0f172a;font-weight:bold;text-align:right;">${escapeHtml(k.value)}</td></tr>`,
    )
    .join("");

  return [
    "<tr>",
    `<td style="padding:0 16px 16px 16px;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-family:${FONT_STACK};">`,
    kpiRowsHtml,
    "</table>",
    "</td>",
    "</tr>",
  ].join("");
}

// ─── Safe envelope-section extractors (Slice 1(b) MVP) ──────────────────────
//
// Sections are typed `unknown` in the envelope. The full coerce* machinery
// from reportHtml.ts is private; for Slice 1(b) we extract only the headline
// number via guarded property access. Slice 1(b)+ refactor: share the coerce
// helpers between print + email renderers.

function extractSecureScorePercentage(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const snapshot = raw["snapshot"];
  if (!isRecord(snapshot)) return null;
  const pct = snapshot["percentage"];
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return pct;
}

function extractActiveIncidentCount(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const counts = raw["counts"];
  if (!isRecord(counts)) return null;
  const active = counts["activeCount"];
  if (typeof active !== "number" || !Number.isFinite(active)) return null;
  return active;
}

function extractRiskyUsersTotal(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const counts = raw["counts"];
  if (!isRecord(counts)) return null;
  const total = counts["riskyUsersTotal"];
  if (typeof total === "number" && Number.isFinite(total)) return total;
  const totalAlt = counts["total"];
  if (typeof totalAlt === "number" && Number.isFinite(totalAlt)) return totalAlt;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── Date formatting (no external deps) ─────────────────────────────────────

function formatIsoDate(iso: string): string {
  // ISO 8601 → YYYY-MM-DD (just the date part). Tolerates already-bare dates.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m?.[1] ?? iso;
}

function formatIsoDateTime(iso: string): string {
  // ISO 8601 → "YYYY-MM-DD HH:MM UTC" (rounded to minutes). Tolerates malformed.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  if (!m || !m[1] || !m[2]) return iso;
  return `${m[1]} ${m[2]} UTC`;
}

// ─── HTML escape ────────────────────────────────────────────────────────────

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: unknown): string {
  return String(input).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c);
}
