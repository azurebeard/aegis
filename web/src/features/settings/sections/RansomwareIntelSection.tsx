// ADR-0037 Layer 5 — admin-page section for ransomware.live PRO ingest.
//
// Option A scope (per the 2026-06-25 design call): config-only view.
//   - Country filter   → DISPLAY-ONLY in v1. Sourced from the same env
//                        var the ingest reads (`THREAT_INTEL_COUNTRY`),
//                        surfaced via the summary endpoint's `country`
//                        field. Editable via the deferred Option B work
//                        (admin-UI key + country management).
//   - Freshness        → IngestHealth status + lastSuccessAt.
//   - "Run now" button → POSTs /api/ingest/ransomware-intel/run. Admin-
//                        gated at the SWA layer; the button is defence-
//                        in-depth (only rendered for admin principals).
//
// Option B: in-product API-key
// rotation. The "Rotate API key" form below pastes a new key into a
// `<input type="password">`, POSTs to /api/ingest/ransomware-intel/key/
// rotate. The handler validates against ransomware.live `/validate`
// BEFORE writing to KV, so an invalid paste never corrupts the secret.
// Backed by the api-reader MI with per-secret ABAC. Operator-CLI path
// (`scripts/provision-ransomware-live-api-key.ps1`) stays available for
// initial provisioning + offline rotations.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { ApiError, api } from "@/api/client";
import {
  RANSOMWARE_INTEL_LIST_KEY,
  RANSOMWARE_INTEL_SUMMARY_KEY,
  useRansomwareIntelSummary,
} from "@/features/ransomware/queries";

interface RotateResponse {
  readonly schemaVersion: 1;
  readonly status: "rotated";
  readonly rotatedAt: string;
  readonly version?: string;
}

export function RansomwareIntelSection() {
  const qc = useQueryClient();
  const summaryQ = useRansomwareIntelSummary();
  const runNow = useMutation<unknown, Error, void>({
    mutationFn: () => api.post("/api/ingest/ransomware-intel/run"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: RANSOMWARE_INTEL_SUMMARY_KEY });
      void qc.invalidateQueries({ queryKey: RANSOMWARE_INTEL_LIST_KEY });
    },
  });

  // Local form state. The key value is held briefly in component state,
  // wiped on mutation success / form close. Never persisted to the
  // query cache or any storage. The input is `type="password"` so the
  // browser doesn't autocomplete or surface the value in form-fill UIs.
  const [showRotate, setShowRotate] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const rotateKey = useMutation<RotateResponse, Error, string>({
    mutationFn: (key) =>
      api.post<RotateResponse>("/api/ingest/ransomware-intel/key/rotate", { apiKey: key }),
    onSuccess: () => {
      // Wipe state immediately on success — no key material lingers.
      setApiKey("");
      // The next ingest run will use the new key; bust the summary so
      // freshness updates when the operator clicks "Run ingest now".
      void qc.invalidateQueries({ queryKey: RANSOMWARE_INTEL_SUMMARY_KEY });
    },
  });

  return (
    <section className="admin-section">
      <p className="admin-section__eyebrow">ADR-0037</p>
      <h2 className="admin-section__title">Ransomware intel</h2>
      <p className="admin-section__intro">
        Hourly Timer pulls per-country victims + press coverage from{" "}
        <strong>ransomware.live PRO</strong>. The country filter is set via the Function App&apos;s{" "}
        <code>THREAT_INTEL_COUNTRY</code> app setting (Bicep-managed; change with{" "}
        <code>azd env set AZURE_THREAT_INTEL_COUNTRY &lt;ISO-3166-1 alpha-2&gt;</code>
        ). API-key rotation is in-product (below) or via{" "}
        <code>scripts/provision-ransomware-live-api-key.ps1</code> for offline rotations.
      </p>

      <div className="admin-section__body" style={{ display: "grid", gap: "var(--sp-m)" }}>
        {summaryQ.isPending && <p className="t-body t-body--mute">Loading freshness…</p>}
        {summaryQ.isError && (
          <MessageBar intent="error">
            <MessageBarBody>
              Could not load freshness.{" "}
              {summaryQ.error instanceof ApiError
                ? `(${summaryQ.error.status}) ${summaryQ.error.message}`
                : (summaryQ.error as Error).message}
            </MessageBarBody>
          </MessageBar>
        )}
        {summaryQ.data && (
          <dl className="setrow" style={{ display: "grid", gap: "var(--sp-s)" }}>
            <div>
              <dt className="t-caption">Country filter</dt>
              <dd>
                <strong>{summaryQ.data.country}</strong>
              </dd>
            </div>
            <div>
              <dt className="t-caption">Ingest status</dt>
              <dd>
                <span className={`badge badge--${badgeTone(summaryQ.data.health.status)}`}>
                  {summaryQ.data.health.status}
                </span>
                {summaryQ.data.health.consecutiveFailures > 0 && (
                  <span className="t-caption" style={{ marginLeft: "var(--sp-s)" }}>
                    {summaryQ.data.health.consecutiveFailures} consecutive failure
                    {summaryQ.data.health.consecutiveFailures === 1 ? "" : "s"}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="t-caption">Last successful run</dt>
              <dd>
                {summaryQ.data.health.lastSuccessAt
                  ? new Date(summaryQ.data.health.lastSuccessAt).toLocaleString()
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="t-caption">Counts this month</dt>
              <dd>
                {summaryQ.data.counts.victimsThisMonth} victim
                {summaryQ.data.counts.victimsThisMonth === 1 ? "" : "s"} ·{" "}
                {summaryQ.data.counts.pressThisMonth} press article
                {summaryQ.data.counts.pressThisMonth === 1 ? "" : "s"} · across{" "}
                {summaryQ.data.counts.distinctGroupsThisMonth} group
                {summaryQ.data.counts.distinctGroupsThisMonth === 1 ? "" : "s"}
              </dd>
            </div>
          </dl>
        )}

        <div className="row" style={{ gap: "var(--sp-s)", alignItems: "center" }}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            aria-label="Run ransomware intel ingest now"
          >
            {runNow.isPending ? "Running…" : "Run ingest now"}
          </button>
          <span className="t-caption">
            Admin-only · 30/day per tenant (shared cross-vertical budget)
          </span>
        </div>

        {runNow.isSuccess && (
          <MessageBar intent="success">
            <MessageBarBody>
              Ingest completed. The dashboard tile + drilldown will refresh.
            </MessageBarBody>
          </MessageBar>
        )}
        {runNow.isError && (
          <MessageBar intent="error">
            <MessageBarBody>
              Run failed.{" "}
              {runNow.error instanceof ApiError
                ? `(${runNow.error.status}) ${runNow.error.message}`
                : (runNow.error as Error).message}
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Option B — API-key rotation. Collapsed by default so the form
            doesn't draw the eye unless the operator is intentionally
            rotating. Pre-validates the supplied key against ransomware.live
            before writing to KV; failure modes surface inline. */}
        <details
          className="admin-section__details"
          open={showRotate}
          onToggle={(e) => setShowRotate((e.target as HTMLDetailsElement).open)}
          style={{ marginTop: "var(--sp-m)" }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Rotate API key</summary>
          <p className="t-body t-body--mute" style={{ marginTop: "var(--sp-s)" }}>
            Paste a freshly-issued ransomware.live PRO API key. The handler validates the key
            against ransomware.live <code>/validate</code> before writing to Key Vault — an invalid
            key never overwrites the current secret. Rate limit: 5/day per tenant.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (apiKey.trim().length === 0) return;
              rotateKey.mutate(apiKey.trim());
            }}
            style={{ display: "grid", gap: "var(--sp-s)", marginTop: "var(--sp-s)" }}
          >
            <label className="t-caption" htmlFor="ransomware-key-input">
              New API key
            </label>
            <input
              id="ransomware-key-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              maxLength={256}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={rotateKey.isPending}
              aria-label="New ransomware.live API key"
              style={{ padding: "var(--sp-xs) var(--sp-s)" }}
            />
            <div className="row" style={{ gap: "var(--sp-s)", alignItems: "center" }}>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={rotateKey.isPending || apiKey.trim().length === 0}
                aria-label="Validate and rotate the ransomware.live API key"
              >
                {rotateKey.isPending ? "Validating + rotating…" : "Validate + rotate"}
              </button>
              <span className="t-caption">Admin-only · validated before write</span>
            </div>
          </form>
          {rotateKey.isSuccess && (
            <MessageBar intent="success" style={{ marginTop: "var(--sp-s)" }}>
              <MessageBarBody>
                Key rotated.{" "}
                {rotateKey.data.version ? `New version: ${rotateKey.data.version}. ` : ""}
                The next ingest run uses the new key automatically.
              </MessageBarBody>
            </MessageBar>
          )}
          {rotateKey.isError && (
            <MessageBar intent="error" style={{ marginTop: "var(--sp-s)" }}>
              <MessageBarBody>
                Rotation failed.{" "}
                {rotateKey.error instanceof ApiError
                  ? `(${rotateKey.error.status}) ${rotateKey.error.message}`
                  : (rotateKey.error as Error).message}
              </MessageBarBody>
            </MessageBar>
          )}
        </details>
      </div>
    </section>
  );
}

function badgeTone(status: string): "success" | "warning" | "danger" | "mute" {
  switch (status) {
    case "healthy":
      return "success";
    case "degrading":
      return "warning";
    case "failing":
    case "licence_required":
      return "danger";
    default:
      return "mute";
  }
}
