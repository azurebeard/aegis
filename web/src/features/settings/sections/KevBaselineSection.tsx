// ADR-0033 Phase 2.5 — admin-page section for KEV deployment-baseline mode.
//
// Two modes:
//   - historic   — every match starts as Open (default for the existing
//                  dev tenant; preserves today's behaviour).
//   - from-deploy — operator picks a baseline date; on save, every CVE
//                  with KEV `dateAdded < baselineDate` and no existing
//                  suppression row is auto-acknowledged. Operator
//                  decisions are NEVER clobbered.
//
// The bulk-acknowledge sweep runs server-side as part of the same PATCH
// /api/ingest/settings call. The /api/stack/items + /api/kev/summary
// caches are invalidated by the mutation hook so /kev rerenders with the
// fresh acknowledged cohort.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useUpdateKevBaseline } from "../queries";
import {
  KEV_BASELINE_MODES,
  type KevBaselineMode,
  type KevBaselineRecord,
  type TenantSettings,
} from "../types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function todayUtcYyyyMmDd(): string {
  const d = new Date();
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function KevBaselineSection({ settings }: { settings: TenantSettings }) {
  const update = useUpdateKevBaseline();
  const server: KevBaselineRecord = settings.kevBaseline ?? {
    mode: "historic",
    baselineDate: "",
    updatedAt: null,
    updatedBy: null,
    source: "default",
  };

  const [mode, setMode] = useState<KevBaselineMode>(server.mode);
  const [baselineDate, setBaselineDate] = useState<string>(
    server.baselineDate || todayUtcYyyyMmDd(),
  );

  // Re-sync the form when the server-side record changes (e.g. another
  // admin saves while this page is open).
  useEffect(() => {
    setMode(server.mode);
    if (server.baselineDate) setBaselineDate(server.baselineDate);
  }, [server.mode, server.baselineDate]);

  const dateValid = useMemo(() => DATE_PATTERN.test(baselineDate), [baselineDate]);
  const dirty =
    mode !== server.mode || (mode === "from-deploy" && baselineDate !== server.baselineDate);
  const canSave = dirty && (mode === "historic" || (mode === "from-deploy" && dateValid));

  function onSave() {
    if (!canSave) return;
    if (mode === "historic") {
      update.mutate({ mode: "historic", baselineDate: "" });
    } else {
      update.mutate({ mode: "from-deploy", baselineDate });
    }
  }

  function onDiscard() {
    setMode(server.mode);
    setBaselineDate(server.baselineDate || todayUtcYyyyMmDd());
  }

  return (
    <section className="admin-section">
      <div className="admin-section__head">
        <div>
          <p className="t-eyebrow">KEV exposure</p>
          <h2 className="t-h2" style={{ marginTop: 4 }}>
            Deployment baseline
          </h2>
          <p className="t-body t-body--mute" style={{ marginTop: 6, maxWidth: 620 }}>
            On a fresh tenant the <Link to="/kev">/kev</Link> view can light up with dozens of{" "}
            <em>Open</em> matches against your existing stack. Setting <strong>From deploy</strong>{" "}
            auto-acknowledges every match against CVEs added to the CISA KEV catalogue{" "}
            <strong>before</strong> your chosen baseline date — so day-1 triage focuses only on new
            work after that line. Operator-set statuses are never overwritten.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn--subtle btn--small"
            disabled={!dirty || update.isPending}
            onClick={onDiscard}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={!canSave || update.isPending}
            onClick={onSave}
          >
            {update.isPending ? "Applying…" : "Save"}
          </button>
        </div>
      </div>

      <div role="radiogroup" aria-label="KEV deployment-baseline mode">
        {KEV_BASELINE_MODES.map((m) => {
          const selected = mode === m;
          return (
            <button
              key={m}
              type="button"
              className={`radio ${selected ? "is-selected" : ""}`}
              onClick={() => setMode(m)}
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
                <span className="radio__title">
                  {m === "historic" ? (
                    <>
                      <strong>Historic</strong> — every match starts as Open{" "}
                      <span className="badge badge--success" style={{ marginLeft: 4 }}>
                        Default
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>From deploy</strong> — auto-acknowledge pre-baseline CVEs
                    </>
                  )}
                </span>
                <span className="radio__hint">
                  {m === "historic"
                    ? "Full triage queue. Choose this if you want to manually review every legacy match."
                    : "Recommended for fresh tenants. CVEs added to KEV before the date below are bulk-acknowledged."}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {mode === "from-deploy" && (
        <div style={{ marginTop: 12, maxWidth: 320 }}>
          <label
            htmlFor="kev-baseline-date"
            className="t-caption"
            style={{ display: "block", marginBottom: 4 }}
          >
            Baseline date (UTC)
          </label>
          <input
            id="kev-baseline-date"
            type="date"
            className="input"
            value={baselineDate}
            onChange={(e) => setBaselineDate(e.target.value)}
            max={todayUtcYyyyMmDd()}
            disabled={update.isPending}
            aria-invalid={!dateValid}
          />
          {!dateValid && baselineDate !== "" && (
            <p className="t-caption" style={{ color: "var(--red-fg)" }}>
              Pick a valid date in YYYY-MM-DD format.
            </p>
          )}
          <p className="t-caption" style={{ marginTop: 6 }}>
            Tip: most operators pick today&apos;s date. CVEs added to KEV on or after this date stay{" "}
            <em>Open</em> for triage.
          </p>
        </div>
      )}

      {server.updatedAt && (
        <p className="t-caption">
          Baseline last set {new Date(server.updatedAt).toLocaleString()}
          {server.updatedBy ? ` by ${server.updatedBy}` : ""}
          {server.mode === "from-deploy" && server.baselineDate
            ? ` (cutoff ${server.baselineDate})`
            : ""}
          .
        </p>
      )}

      {update.isSuccess && (
        <MessageBar intent="success">
          <MessageBarBody>
            Baseline saved. Pre-baseline matches were bulk-acknowledged; visit{" "}
            <Link to="/kev">/kev</Link> to see the refreshed Open queue.
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
