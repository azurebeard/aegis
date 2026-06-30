// ADR-0030 Phase C Slice 1(d)/A — admin email config section.
//
// Recipient list editor (comma-or-newline parsed → chips), enabled toggle,
// subject prefix, allow-external toggle + external domains list. Hidden in
// prod by the §C.18 posture: `allowExternalRecipients` toggle is wrapped in
// `import.meta.env.MODE === "production"` gating below — the production
// build hard-pins it to false, the dev build exposes it.

import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useUpdateReportEmailConfig } from "../queries";
import {
  REPORT_EMAIL_MAX_EXTERNAL_DOMAINS,
  REPORT_EMAIL_MAX_RECIPIENTS,
  REPORT_EMAIL_SUBJECT_PREFIX_MAX,
  type ReportEmailConfigRecord,
  type TenantSettings,
} from "../types";

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DOMAIN_RE = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const DEFAULT_CONFIG: ReportEmailConfigRecord = {
  enabled: false,
  recipients: [],
  allowExternalRecipients: false,
  externalRecipientDomains: [],
  subjectPrefix: null,
  updatedAt: null,
  updatedBy: null,
  source: "default",
};

interface DraftState {
  enabled: boolean;
  recipientsText: string;
  allowExternalRecipients: boolean;
  externalDomainsText: string;
  subjectPrefix: string;
}

function configToDraft(c: ReportEmailConfigRecord): DraftState {
  return {
    enabled: c.enabled,
    recipientsText: c.recipients.join("\n"),
    allowExternalRecipients: c.allowExternalRecipients,
    externalDomainsText: c.externalRecipientDomains.join("\n"),
    subjectPrefix: c.subjectPrefix ?? "",
  };
}

function parseList(text: string): string[] {
  // Dedupe after the normalise step so "Ops@x.com" + " ops@x.com" collapse.
  // Order-preserving (Set iteration follows insertion order) so the input
  // textarea doesn't reshuffle visibly on re-render.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of text.split(/[\s,;]+/)) {
    const s = token.trim().toLowerCase();
    if (s.length === 0 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function ReportEmailSection({ settings }: { settings: TenantSettings }) {
  const update = useUpdateReportEmailConfig();
  const server = settings.reportEmailConfig ?? DEFAULT_CONFIG;
  const [draft, setDraft] = useState<DraftState>(() => configToDraft(server));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(configToDraft(server));
    // Per-field deps are intentional: `server` is re-derived from the query
    // result on every render and would re-fire this effect even when nothing
    // material changed, clobbering an in-flight edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    server.enabled,
    server.recipients,
    server.allowExternalRecipients,
    server.externalRecipientDomains,
    server.subjectPrefix,
  ]);

  const isProd = import.meta.env.MODE === "production";

  const recipients = useMemo(() => parseList(draft.recipientsText), [draft.recipientsText]);
  const externalDomains = useMemo(
    () => parseList(draft.externalDomainsText),
    [draft.externalDomainsText],
  );

  const dirty =
    draft.enabled !== server.enabled ||
    draft.recipientsText !== server.recipients.join("\n") ||
    draft.allowExternalRecipients !== server.allowExternalRecipients ||
    draft.externalDomainsText !== server.externalRecipientDomains.join("\n") ||
    (draft.subjectPrefix ?? "") !== (server.subjectPrefix ?? "");

  // Memoised so the Save-button disabled gate (below) doesn't re-walk the
  // arrays on every keystroke. `null` = valid.
  const validationPreview = useMemo<string | null>(() => {
    if (recipients.length > REPORT_EMAIL_MAX_RECIPIENTS) {
      return `Recipients must be ≤ ${REPORT_EMAIL_MAX_RECIPIENTS}.`;
    }
    for (const r of recipients) {
      if (!EMAIL_RE.test(r)) return `Recipient '${r}' is not a valid email address.`;
    }
    if (externalDomains.length > REPORT_EMAIL_MAX_EXTERNAL_DOMAINS) {
      return `External domains must be ≤ ${REPORT_EMAIL_MAX_EXTERNAL_DOMAINS}.`;
    }
    for (const d of externalDomains) {
      if (!DOMAIN_RE.test(d)) return `External domain '${d}' is not a valid domain.`;
    }
    if (draft.subjectPrefix.trim().length > REPORT_EMAIL_SUBJECT_PREFIX_MAX) {
      return `Subject prefix must be ≤ ${REPORT_EMAIL_SUBJECT_PREFIX_MAX} chars.`;
    }
    if (draft.enabled && recipients.length === 0) {
      return "Enabling requires at least one recipient.";
    }
    return null;
  }, [recipients, externalDomains, draft.subjectPrefix, draft.enabled]);

  const onSave = () => {
    if (validationPreview) {
      setValidationError(validationPreview);
      return;
    }
    setValidationError(null);
    update.mutate({
      enabled: draft.enabled,
      recipients,
      // Production posture: external recipients are hard-pinned to false in
      // the request body regardless of the dev-only toggle state.
      allowExternalRecipients: isProd ? false : draft.allowExternalRecipients,
      externalRecipientDomains: isProd ? [] : externalDomains,
      subjectPrefix: draft.subjectPrefix.trim().length > 0 ? draft.subjectPrefix.trim() : null,
    });
  };

  return (
    <section className="admin-section">
      <div className="admin-section__head">
        <div>
          <p className="t-eyebrow">Reports</p>
          <h2 className="t-h2" style={{ marginTop: 4 }}>
            Report email
          </h2>
          <p className="t-body t-body--mute" style={{ marginTop: 6, maxWidth: 580 }}>
            Send captured snapshots to a board distribution list. Admin-only. Sends are capped at
            10/24h per tenant and every send is recorded in the audit chain. Reviewable in the{" "}
            <RouterLink to="/admin/email/sends">send history</RouterLink>.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn--subtle btn--small"
            disabled={!dirty || update.isPending}
            onClick={() => {
              setDraft(configToDraft(server));
              setValidationError(null);
            }}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            // Disabled when nothing changed, mid-PATCH, or the current draft
            // fails client-side validation — so the operator can't fire a PATCH
            // we know will 400.
            disabled={!dirty || update.isPending || validationPreview !== null}
            title={validationPreview ?? undefined}
            onClick={onSave}
          >
            {update.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-l)" }}>
        {/* Enable toggle.
            eslint-disable-next-line: jsx-a11y/label-has-associated-control fails
            to recurse into the nested <span> for the label text. The label is
            wired to the input via htmlFor/id AND wraps it, and visible text is
            present in <strong> + <span>. Genuinely accessible. */}
        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
        <label
          htmlFor="report-email-enabled"
          className="row"
          style={{ gap: 12, alignItems: "flex-start", cursor: "pointer" }}
        >
          <input
            id="report-email-enabled"
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            style={{ marginTop: 4 }}
            disabled={update.isPending}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <strong>Enable report email</strong>
            <span className="t-body t-body--mute">
              When off, the admin send endpoint returns 503 not_configured.
            </span>
          </span>
        </label>

        {/* Recipients */}
        <div>
          <label htmlFor="report-email-recipients" className="t-body" style={{ fontWeight: 600 }}>
            Recipients
          </label>
          <p className="t-body t-body--mute" style={{ marginTop: 4, marginBottom: 6 }}>
            One per line, or comma/semicolon-separated. Max {REPORT_EMAIL_MAX_RECIPIENTS}.
          </p>
          <textarea
            id="report-email-recipients"
            value={draft.recipientsText}
            onChange={(e) => setDraft({ ...draft, recipientsText: e.target.value })}
            rows={Math.min(Math.max(recipients.length + 1, 3), 10)}
            spellCheck={false}
            disabled={update.isPending}
            style={{
              width: "100%",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: "var(--fs-200)",
              padding: "8px 10px",
              border: "1px solid var(--stroke-2)",
              borderRadius: 4,
              background: "var(--bg-1)",
            }}
            placeholder="alice@example.com&#10;bob@example.com"
          />
          <p className="t-caption" style={{ marginTop: 6 }}>
            {recipients.length} recipient{recipients.length === 1 ? "" : "s"} parsed.
          </p>
        </div>

        {/* Subject prefix */}
        <div>
          <label
            htmlFor="report-email-subject-prefix"
            className="t-body"
            style={{ fontWeight: 600 }}
          >
            Subject prefix (optional)
          </label>
          <p className="t-body t-body--mute" style={{ marginTop: 4, marginBottom: 6 }}>
            Prepended to the auto-generated subject (≤ {REPORT_EMAIL_SUBJECT_PREFIX_MAX} chars).
            Example: <code>[Aegis]</code>.
          </p>
          <input
            id="report-email-subject-prefix"
            type="text"
            value={draft.subjectPrefix}
            onChange={(e) => setDraft({ ...draft, subjectPrefix: e.target.value })}
            maxLength={REPORT_EMAIL_SUBJECT_PREFIX_MAX}
            disabled={update.isPending}
            style={{
              width: 320,
              padding: "8px 10px",
              border: "1px solid var(--stroke-2)",
              borderRadius: 4,
              background: "var(--bg-1)",
            }}
            placeholder="[Aegis]"
          />
        </div>

        {/* External recipients — hidden in prod per §C.18 */}
        {!isProd && (
          <div>
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
            <label
              htmlFor="report-email-allow-external"
              className="row"
              style={{ gap: 12, alignItems: "flex-start", cursor: "pointer" }}
            >
              <input
                id="report-email-allow-external"
                type="checkbox"
                checked={draft.allowExternalRecipients}
                onChange={(e) => setDraft({ ...draft, allowExternalRecipients: e.target.checked })}
                style={{ marginTop: 4 }}
                disabled={update.isPending}
              />
              <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <strong>Allow external recipients (dev only)</strong>
                <span className="t-body t-body--mute">
                  Hidden in production. When on, recipients on the domains below are allowed
                  (sender&rsquo;s own domain is always allowed).
                </span>
              </span>
            </label>
            {draft.allowExternalRecipients && (
              <div style={{ marginTop: 10, marginLeft: 28 }}>
                <label
                  htmlFor="report-email-external-domains"
                  className="t-body"
                  style={{ fontWeight: 600 }}
                >
                  External recipient domains
                </label>
                <p className="t-body t-body--mute" style={{ marginTop: 4, marginBottom: 6 }}>
                  Domain only (no @). One per line. Max {REPORT_EMAIL_MAX_EXTERNAL_DOMAINS}.
                </p>
                <textarea
                  id="report-email-external-domains"
                  value={draft.externalDomainsText}
                  onChange={(e) => setDraft({ ...draft, externalDomainsText: e.target.value })}
                  rows={Math.min(Math.max(externalDomains.length + 1, 3), 6)}
                  spellCheck={false}
                  disabled={update.isPending}
                  style={{
                    width: "100%",
                    fontFamily: "var(--font-mono, ui-monospace, monospace)",
                    fontSize: "var(--fs-200)",
                    padding: "8px 10px",
                    border: "1px solid var(--stroke-2)",
                    borderRadius: 4,
                    background: "var(--bg-1)",
                  }}
                  placeholder="partner.com&#10;contractor.com"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {server.updatedAt && (
        <p className="t-caption">
          Last updated {new Date(server.updatedAt).toLocaleString()}
          {server.updatedBy ? ` by ${server.updatedBy}` : ""}
        </p>
      )}

      {validationError && (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>{validationError}</MessageBarBody>
        </MessageBar>
      )}
      {update.isSuccess && (
        <MessageBar intent="success">
          <MessageBarBody>Email config saved.</MessageBarBody>
        </MessageBar>
      )}
      {update.isError && (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>
            Save failed.{" "}
            {update.error instanceof ApiError
              ? `(${update.error.status}) ${update.error.message}`
              : (update.error as Error).message}
          </MessageBarBody>
        </MessageBar>
      )}
    </section>
  );
}
