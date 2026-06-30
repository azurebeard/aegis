// ADR-0030 Phase A — admin-page section for report cadence.
// Mirrors the user-identifier-strategy radio-card pattern.

import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useUpdateReportCadence } from "../queries";
import {
  REPORT_CADENCES,
  type ReportCadence,
  type ReportCadenceRecord,
  type TenantSettings,
} from "../types";

const TITLES: Readonly<Record<ReportCadence, ReactNode>> = {
  weekly: (
    <>
      <strong>Weekly</strong> — ISO-8601 week (Mon–Sun)
    </>
  ),
  monthly: (
    <>
      <strong>Monthly</strong> — calendar month{" "}
      <span className="badge badge--success" style={{ marginLeft: 4 }}>
        Default
      </span>
    </>
  ),
  quarterly: (
    <>
      <strong>Quarterly</strong> — calendar Q1/Q2/Q3/Q4
    </>
  ),
};

const HINTS: Readonly<Record<ReportCadence, ReactNode>> = {
  weekly: "Best for active operations — captures one report per ISO week.",
  monthly: "Most common for board-level reporting. Period key like 2026-04.",
  quarterly: "Lowest cadence — captures one snapshot per calendar quarter.",
};

export function ReportCadenceSection({ settings }: { settings: TenantSettings }) {
  const update = useUpdateReportCadence();
  const server: ReportCadenceRecord = settings.reportCadence ?? {
    cadence: "monthly",
    updatedAt: null,
    updatedBy: null,
    source: "default",
  };
  const [draft, setDraft] = useState<ReportCadence>(server.cadence);

  useEffect(() => {
    setDraft(server.cadence);
  }, [server.cadence]);

  const dirty = draft !== server.cadence;

  return (
    <section className="admin-section">
      <div className="admin-section__head">
        <div>
          <p className="t-eyebrow">Reports</p>
          <h2 className="t-h2" style={{ marginTop: 4 }}>
            Report cadence
          </h2>
          <p className="t-body t-body--mute" style={{ marginTop: 6, maxWidth: 580 }}>
            How often the <Link to="/reports">/reports</Link> view groups a captured snapshot.
            Changing cadence does not delete prior captures — historical reports remain addressable
            by their period key.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn--subtle btn--small"
            disabled={!dirty || update.isPending}
            onClick={() => setDraft(server.cadence)}
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

      <div role="radiogroup" aria-label="Report cadence">
        {REPORT_CADENCES.map((c) => {
          const selected = draft === c;
          return (
            <button
              key={c}
              type="button"
              className={`radio ${selected ? "is-selected" : ""}`}
              onClick={() => setDraft(c)}
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
                <span className="radio__title">{TITLES[c]}</span>
                <span className="radio__hint">{HINTS[c]}</span>
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
            Report cadence saved. New captures use the updated period key shape.
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
