// User-identifier-strategy section (ADR-0025 §9.6) — Aegis UI Phase 4
// redesign. Uses the design's `.radio` cards (selected ring + tinted bg)
// inside an `admin-section` shell. objectId is privacy-by-default
// (GUID only, matches ADR-0020 Step-6).

import { useEffect, useState, type ReactNode } from "react";
import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useUpdateUserIdentifierStrategy } from "../queries";
import {
  USER_IDENTIFIER_STRATEGIES,
  type TenantSettings,
  type UserIdentifierStrategy,
  type UserIdentifierStrategyRecord,
} from "../types";

const STRATEGY_TITLES: Readonly<Record<UserIdentifierStrategy, ReactNode>> = {
  objectId: (
    <>
      <strong>objectId</strong> — Entra GUID only{" "}
      <span className="badge badge--success" style={{ marginLeft: 4 }}>
        Default
      </span>
    </>
  ),
  partial_mask: (
    <>
      <strong>partial_mask</strong> — first letter + asterisks
    </>
  ),
  display_name: (
    <>
      <strong>display_name</strong> — full Entra <code>userDisplayName</code>
    </>
  ),
};

const STRATEGY_HINTS: Readonly<Record<UserIdentifierStrategy, ReactNode>> = {
  objectId: "No PII enters the prompt or audit chain. Safest; recommended for production tenants.",
  partial_mask: (
    <>
      Reader-friendly briefs (<code>A___ E*****</code>) without full-name PII exposure to the LLM
      plane.
    </>
  ),
  display_name:
    "Maximum readability; full PII enters the prompt. Use only for SMB tenants where the operator knows every user.",
};

export function UserIdentifierStrategySection({ settings }: { settings: TenantSettings }) {
  const update = useUpdateUserIdentifierStrategy();
  const server: UserIdentifierStrategyRecord = settings.userIdentifierStrategy ?? {
    strategy: "objectId",
    updatedAt: null,
    updatedBy: null,
    source: "default",
  };
  const [draft, setDraft] = useState<UserIdentifierStrategy>(server.strategy);

  useEffect(() => {
    setDraft(server.strategy);
  }, [server.strategy]);

  const dirty = draft !== server.strategy;

  return (
    <section className="admin-section">
      <div className="admin-section__head">
        <div>
          <p className="t-eyebrow">Section 3 of 4</p>
          <h2 className="t-h2" style={{ marginTop: 4 }}>
            User identifier strategy
          </h2>
          <p className="t-body t-body--mute" style={{ marginTop: 6, maxWidth: 580 }}>
            How user identifiers appear inside AI prompts. Default is GUIDs only — no names reach
            the model. Takes effect on the next brief run.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn--subtle btn--small"
            disabled={!dirty || update.isPending}
            onClick={() => setDraft(server.strategy)}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={!dirty || update.isPending}
            onClick={() => update.mutate(draft)}
          >
            {update.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div role="radiogroup" aria-label="User identifier strategy">
        {USER_IDENTIFIER_STRATEGIES.map((s) => {
          const selected = draft === s;
          return (
            <button
              key={s}
              type="button"
              className={`radio ${selected ? "is-selected" : ""}`}
              onClick={() => setDraft(s)}
              role="radio"
              aria-checked={selected}
              disabled={update.isPending}
              style={{
                width: "100%",
                textAlign: "left",
                font: "inherit",
                color: "inherit",
              }}
            >
              <span className="radio__circle" />
              <span className="radio__main">
                <span className="radio__title">{STRATEGY_TITLES[s]}</span>
                <span className="radio__hint">{STRATEGY_HINTS[s]}</span>
              </span>
            </button>
          );
        })}
      </div>

      {server.updatedAt && (
        <p className="t-caption">
          Last updated {new Date(server.updatedAt).toLocaleString()}
          {server.updatedBy ? ` by ${server.updatedBy}` : ""}
        </p>
      )}

      {update.isSuccess && (
        <MessageBar intent="success">
          <MessageBarBody>
            User identifier strategy saved. Next brief run will use the new projection.
          </MessageBarBody>
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
