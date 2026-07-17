// Branding section (ADR-0029 Phases A + B) — Aegis UI Phase 4 redesign.
// Each control becomes a `setrow`. Theme picker uses design's icon-button
// row; logo upload uses `.logo-preview` + native file input behind a
// styled button. Hex picker pairs a `.swatch` with a mono input.

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { Icon, type IconName } from "@/components/Icon";
import { useDeleteBrandingLogo, useUpdateBranding, useUploadBrandingLogo } from "../queries";
import {
  BRANDING_BOUNDS,
  BRANDING_DEFAULTS,
  DEFAULT_THEMES,
  LOGO_CONTENT_TYPES,
  LOGO_MAX_BYTES,
  type BrandingRecord,
  type DefaultTheme,
  type TenantSettings,
} from "../types";

interface Draft {
  productName: string;
  primaryHex: string;
  footerText: string;
  defaultTheme: DefaultTheme;
}

const THEME_BUTTONS: readonly { id: DefaultTheme; icon: IconName; label: string }[] = [
  { id: "system", icon: "system", label: "Follow system" },
  { id: "light", icon: "sun", label: "Light" },
  { id: "dark", icon: "moon", label: "Dark" },
];

const LOGO_ACCEPT = LOGO_CONTENT_TYPES.join(",");

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function BrandingSection({ settings }: { settings: TenantSettings }) {
  const update = useUpdateBranding();
  const upload = useUploadBrandingLogo();
  const remove = useDeleteBrandingLogo();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const server: BrandingRecord = useMemo(() => {
    const b = settings.branding;
    if (b) return b;
    return {
      ...BRANDING_DEFAULTS,
      logoUrl: null,
      updatedAt: null,
      updatedBy: null,
      source: "default" as const,
    };
  }, [settings.branding]);

  const [draft, setDraft] = useState<Draft>({
    productName: server.productName,
    primaryHex: server.primaryHex,
    footerText: server.footerText,
    defaultTheme: server.defaultTheme,
  });

  useEffect(() => {
    setDraft({
      productName: server.productName,
      primaryHex: server.primaryHex,
      footerText: server.footerText,
      defaultTheme: server.defaultTheme,
    });
  }, [server.productName, server.primaryHex, server.footerText, server.defaultTheme]);

  const hexValid = BRANDING_BOUNDS.primaryHex.pattern.test(draft.primaryHex);
  const productNameValid =
    draft.productName.length > 0 &&
    draft.productName.length <= BRANDING_BOUNDS.productName.maxChars;
  const footerValid = draft.footerText.length <= BRANDING_BOUNDS.footerText.maxChars;
  const allValid = hexValid && productNameValid && footerValid;

  const dirty =
    draft.productName !== server.productName ||
    draft.primaryHex !== server.primaryHex ||
    draft.footerText !== server.footerText ||
    draft.defaultTheme !== server.defaultTheme;

  const diff = useMemo(() => {
    const out: Partial<Draft> = {};
    if (draft.productName !== server.productName) out.productName = draft.productName;
    if (draft.primaryHex !== server.primaryHex) out.primaryHex = draft.primaryHex;
    if (draft.footerText !== server.footerText) out.footerText = draft.footerText;
    if (draft.defaultTheme !== server.defaultTheme) out.defaultTheme = draft.defaultTheme;
    return out;
  }, [draft, server]);

  const onLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setClientError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side guardrails — server re-validates MIME + magic bytes +
    // size authoritatively (ADR-0029 §Decision.5).
    if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setClientError(
        `Unsupported file type. Allowed: ${LOGO_CONTENT_TYPES.join(", ")}. (SVG is deliberately excluded.)`,
      );
      e.target.value = "";
      return;
    }
    if (file.size === 0) {
      setClientError("File is empty.");
      e.target.value = "";
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setClientError(
        `File is ${formatBytes(file.size)} — must be ≤ ${formatBytes(LOGO_MAX_BYTES)}.`,
      );
      e.target.value = "";
      return;
    }
    upload.mutate({ blob: file, contentType: file.type });
    e.target.value = "";
  };

  const hasLogo = server.logoSha256 !== "" && server.logoUrl !== null && server.logoUrl !== "";
  const logoBusy = upload.isPending || remove.isPending;

  return (
    <section className="admin-section">
      <div className="admin-section__head">
        <div>
          <p className="t-eyebrow">Section 4 of 4</p>
          <h2 className="t-h2" style={{ marginTop: 4 }}>
            Branding
          </h2>
          <p className="t-body t-body--mute" style={{ marginTop: 6, maxWidth: 580 }}>
            Tenant-scoped customisation for the dashboard header, accent colour, and default theme.
            Per-user dark/light preference (header toggle) overrides the tenant default.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn--subtle btn--small"
            disabled={!dirty || update.isPending}
            onClick={() =>
              setDraft({
                productName: server.productName,
                primaryHex: server.primaryHex,
                footerText: server.footerText,
                defaultTheme: server.defaultTheme,
              })
            }
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={!dirty || !allValid || update.isPending}
            onClick={() => update.mutate(diff)}
          >
            {update.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div>
        <div className="setrow">
          <div className="setrow__label">
            <span className="setrow__label-name">Product name</span>
            <span className="setrow__label-hint">
              Shown in the dashboard header + browser tab title. Max{" "}
              {BRANDING_BOUNDS.productName.maxChars} characters.
            </span>
          </div>
          <div className="setrow__control" style={{ maxWidth: 360 }}>
            <input
              className="input"
              value={draft.productName}
              onChange={(e) => setDraft((p) => ({ ...p, productName: e.target.value }))}
              disabled={update.isPending}
              maxLength={BRANDING_BOUNDS.productName.maxChars}
              aria-label="Product name"
            />
            <span
              className="t-caption"
              style={{ color: productNameValid ? undefined : "var(--red-fg)" }}
            >
              {draft.productName.length}/{BRANDING_BOUNDS.productName.maxChars} characters
              {productNameValid ? "" : " — required, non-empty"}
            </span>
          </div>
        </div>

        <div className="setrow">
          <div className="setrow__label">
            <span className="setrow__label-name">Primary brand colour</span>
            <span className="setrow__label-hint">
              Seeds the Fluent ramp for both light and dark themes. Hex format <code>#RRGGBB</code>.
            </span>
          </div>
          <div
            className="setrow__control"
            style={{ flexDirection: "row", alignItems: "center", gap: "var(--sp-m)" }}
          >
            <input
              type="color"
              value={hexValid ? draft.primaryHex : BRANDING_DEFAULTS.primaryHex}
              onChange={(e) =>
                setDraft((p) => ({ ...p, primaryHex: e.target.value.toUpperCase() }))
              }
              disabled={update.isPending}
              aria-label="Primary brand colour picker"
              className="swatch"
              style={{ padding: 0, cursor: "pointer" }}
            />
            <input
              className="input input--mono"
              style={{ width: 128, height: 32 }}
              value={draft.primaryHex}
              onChange={(e) => setDraft((p) => ({ ...p, primaryHex: e.target.value }))}
              disabled={update.isPending}
              maxLength={7}
              aria-label="Primary hex"
            />
            {hexValid ? (
              <span className="badge badge--success">Valid hex</span>
            ) : (
              <span className="badge badge--danger">Invalid — #RRGGBB required</span>
            )}
          </div>
        </div>

        <div className="setrow">
          <div className="setrow__label">
            <span className="setrow__label-name">Default theme</span>
            <span className="setrow__label-hint">
              Tenant-wide first-load preference. Individual users can still override via the toggle
              in the header — that choice persists in their browser only.
            </span>
          </div>
          <div
            className="setrow__control"
            style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}
          >
            {THEME_BUTTONS.filter((t) => DEFAULT_THEMES.includes(t.id)).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`btn btn--small ${draft.defaultTheme === t.id ? "btn--primary" : ""}`}
                onClick={() => setDraft((p) => ({ ...p, defaultTheme: t.id }))}
                disabled={update.isPending}
                aria-pressed={draft.defaultTheme === t.id}
              >
                <Icon name={t.icon} size={12} />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setrow">
          <div className="setrow__label">
            <span className="setrow__label-name">Logo</span>
            <span className="setrow__label-hint">
              PNG / WebP / JPEG up to {formatBytes(LOGO_MAX_BYTES)}. SVG is not accepted (XSS
              surface). Uploads commit immediately.
            </span>
          </div>
          <div
            className="setrow__control"
            style={{ flexDirection: "row", alignItems: "center", gap: "var(--sp-l)" }}
          >
            {hasLogo && server.logoUrl ? (
              <img
                src={server.logoUrl}
                alt="Current tenant logo"
                style={{
                  height: 48,
                  width: "auto",
                  maxWidth: 200,
                  objectFit: "contain",
                  border: "1px solid var(--stroke-2)",
                  borderRadius: "var(--r-m)",
                  padding: "var(--sp-s)",
                  background: "var(--bg-1)",
                }}
              />
            ) : (
              <span className="logo-preview">
                {draft.productName.charAt(0).toUpperCase() || "A"}
              </span>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <input
                ref={fileInput}
                type="file"
                accept={LOGO_ACCEPT}
                onChange={onLogoFileChange}
                disabled={logoBusy}
                style={{ display: "none" }}
                aria-label="Select logo file"
              />
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={logoBusy}
                  onClick={() => fileInput.current?.click()}
                >
                  {upload.isPending ? "Uploading…" : hasLogo ? "Replace" : "Upload"}
                </button>
                {hasLogo && (
                  <button
                    type="button"
                    className="btn btn--small btn--subtle"
                    disabled={logoBusy}
                    onClick={() => remove.mutate()}
                  >
                    {remove.isPending ? "Removing…" : "Remove"}
                  </button>
                )}
              </div>
              {hasLogo && (
                <span className="t-caption">
                  {server.logoContentType} · {formatBytes(server.logoSize)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="setrow">
          <div className="setrow__label">
            <span className="setrow__label-name">Footer text</span>
            <span className="setrow__label-hint">
              Optional copyright or disclaimer. Max {BRANDING_BOUNDS.footerText.maxChars}{" "}
              characters.
            </span>
          </div>
          <div className="setrow__control" style={{ maxWidth: 520 }}>
            <textarea
              className="input"
              rows={2}
              value={draft.footerText}
              onChange={(e) => setDraft((p) => ({ ...p, footerText: e.target.value }))}
              disabled={update.isPending}
              maxLength={BRANDING_BOUNDS.footerText.maxChars}
              aria-label="Footer text"
            />
            <span
              className="t-caption"
              style={{ color: footerValid ? undefined : "var(--red-fg)" }}
            >
              {draft.footerText.length}/{BRANDING_BOUNDS.footerText.maxChars} characters
            </span>
          </div>
        </div>
      </div>

      {server.updatedAt && (
        <p className="t-caption">
          Last updated {new Date(server.updatedAt).toLocaleString()}
          {server.updatedBy ? ` by ${server.updatedBy}` : ""}
        </p>
      )}

      {update.isSuccess && (
        <MessageBar intent="success">
          <MessageBarBody>Branding saved. New values take effect immediately.</MessageBarBody>
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
      {clientError && (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>{clientError}</MessageBarBody>
        </MessageBar>
      )}
      {upload.isError && (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>
            Upload failed.{" "}
            {upload.error instanceof ApiError
              ? `(${upload.error.status}) ${upload.error.message}`
              : (upload.error as Error).message}
          </MessageBarBody>
        </MessageBar>
      )}
      {remove.isError && (
        <MessageBar intent="error" role="alert">
          <MessageBarBody>
            Remove failed.{" "}
            {remove.error instanceof ApiError
              ? `(${remove.error.status}) ${remove.error.message}`
              : (remove.error as Error).message}
          </MessageBarBody>
        </MessageBar>
      )}
    </section>
  );
}
