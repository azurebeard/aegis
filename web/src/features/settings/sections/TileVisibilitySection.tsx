// Tile visibility section (ADR-0025) — Aegis UI Phase 4 redesign.
// Surface: design-system `admin-section` (eyebrow + title + intro + Save
// row) + `setrow` rows (label/hint + custom `.switch` markup with
// licence-required badge inline).

import { useEffect, useMemo, useState } from "react";
import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useUpdateTileVisibility } from "../queries";
import {
  TILE_KEYS,
  TILE_LABELS,
  TILE_LICENCE_LEARN_MORE,
  type TenantSettings,
  type TileCapability,
  type TileKey,
  type TileVisibility,
} from "../types";

const TILE_HINTS: Readonly<Record<TileKey, string>> = {
  brief: "AI narrative · runs once per day",
  posture: "AI narrative · runs once per ISO week",
  secureScore: "Number + 90-day trend",
  incidents: "Severity breakdown + most-recent",
  riskyUsers: "Risk-level breakdown · requires Entra ID P2",
  stack: "Operator-curated software/hardware inventory (ADR-0031)",
  kev: "CISA Known Exploited Vulnerabilities cross-reference (ADR-0032)",
  userDormancy: "Accounts unused for >N days · requires Entra ID P1",
  signIns: "Sign-ins with geo-fence cross-reference · requires Entra ID P1",
  conditionalAccess: "CA policy state + drift detection (ADR-0034 §3.3)",
  azureSecureScore: "Defender for Cloud Secure Score · Azure resource posture (ADR-0036)",
  ransomwareIntel: "Ransomware.live PRO threat intel · per-country victims + press (ADR-0037)",
};

export function TileVisibilitySection({ settings }: { settings: TenantSettings }) {
  const update = useUpdateTileVisibility();
  const [draft, setDraft] = useState<TileVisibility>(settings.tileVisibility);

  useEffect(() => {
    setDraft(settings.tileVisibility);
  }, [settings.tileVisibility]);

  const dirty = useMemo(
    () => TILE_KEYS.some((k) => settings.tileVisibility[k] !== draft[k]),
    [settings.tileVisibility, draft],
  );

  const diff = useMemo<Partial<TileVisibility>>(() => {
    const out: Partial<TileVisibility> = {};
    for (const k of TILE_KEYS) {
      if (settings.tileVisibility[k] !== draft[k]) out[k] = draft[k];
    }
    return out;
  }, [settings.tileVisibility, draft]);

  return (
    <section className="admin-section">
      <div className="admin-section__head">
        <div>
          <p className="t-eyebrow">Section 1 of 4</p>
          <h2 className="t-h2" style={{ marginTop: 4 }}>
            Tile visibility
          </h2>
          <p className="t-body t-body--mute" style={{ marginTop: 6, maxWidth: 540 }}>
            Hide tiles that aren&apos;t relevant to this tenant. A licence-blocked tile auto-hides
            regardless of operator setting.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn--subtle btn--small"
            disabled={!dirty || update.isPending}
            onClick={() => setDraft(settings.tileVisibility)}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={!dirty || update.isPending}
            onClick={() => update.mutate(diff)}
          >
            {update.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div>
        {TILE_KEYS.map((k) => {
          const capability: TileCapability = settings.tileCapabilities?.[k] ?? "unknown";
          const licenceBlocked = capability === "licence_required";
          const learnMore = TILE_LICENCE_LEARN_MORE[k];
          const checked = draft[k] && !licenceBlocked;
          return (
            <div key={k} className="setrow">
              <div className="setrow__label">
                <span className="setrow__label-name">{TILE_LABELS[k]}</span>
                <span className="setrow__label-hint">{TILE_HINTS[k]}</span>
                {licenceBlocked && learnMore && (
                  <span className="setrow__label-hint">
                    Auto-hidden — toggle has no effect until the underlying licence is present.{" "}
                    <a href={learnMore} target="_blank" rel="noreferrer noopener">
                      Learn more
                    </a>
                    .
                  </span>
                )}
              </div>
              <div
                className="setrow__control"
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <SwitchControl
                  on={checked}
                  disabled={licenceBlocked || update.isPending}
                  onChange={() => setDraft((prev) => ({ ...prev, [k]: !prev[k] }))}
                  label={checked ? "Visible" : "Hidden"}
                />
                {capabilityBadge(capability)}
              </div>
            </div>
          );
        })}
      </div>

      {update.isSuccess && (
        <MessageBar intent="success">
          <MessageBarBody>Tile visibility saved.</MessageBarBody>
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

function SwitchControl({
  on,
  disabled,
  onChange,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`switch ${on ? "switch--on" : ""}`}
      onClick={onChange}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      style={{
        background: "transparent",
        border: 0,
        padding: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
      <span style={{ color: disabled ? "var(--fg-3)" : "var(--fg-1)" }}>{label}</span>
    </button>
  );
}

function capabilityBadge(c: TileCapability): React.ReactNode {
  if (c === "present") return <span className="badge badge--success">Available</span>;
  if (c === "licence_required")
    return <span className="badge badge--warning">Licence required</span>;
  return <span className="badge badge--info">Not probed yet</span>;
}
