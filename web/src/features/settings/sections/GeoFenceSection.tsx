// ADR-0034 §4.1 — admin-page section for the geo-fence policy.
//
// Operator declares an allowed-countries allowlist + IP-range bypass list
// + unknown-location handling + enable toggle. Saving triggers a server-
// side OutOfArea reconciliation against existing SignIns rows so the
// dashboard tile reflects the new policy immediately (mirrors kevBaseline).

import { useEffect, useMemo, useState } from "react";
import { MessageBar, MessageBarBody } from "@fluentui/react-components";
import { ApiError } from "@/api/client";
import { useUpdateGeoFence } from "../queries";
import type { TenantSettings } from "../types";

const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
const CIDR_PATTERN =
  /^(\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$|^[0-9a-fA-F:]+\/(?:1[0-2][0-8]|[1-9]?[0-9])$/;

function dedupeNonEmpty(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    const t = v.trim();
    if (t === "") continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function GeoFenceSection({ settings }: { settings: TenantSettings }) {
  const update = useUpdateGeoFence();
  const server = settings.geoFence ?? {
    enabled: false,
    allowedCountries: [],
    allowedIpRanges: [],
    unknownLocationPolicy: "alert" as const,
    source: "default" as const,
  };

  const [enabled, setEnabled] = useState(server.enabled);
  const [countriesText, setCountriesText] = useState(
    server.allowedCountries.map((c) => c.toUpperCase()).join(", "),
  );
  const [ipRangesText, setIpRangesText] = useState(server.allowedIpRanges.join("\n"));
  const [unknown, setUnknown] = useState<"alert" | "ignore">(server.unknownLocationPolicy);

  useEffect(() => {
    setEnabled(server.enabled);
    setCountriesText(server.allowedCountries.map((c) => c.toUpperCase()).join(", "));
    setIpRangesText(server.allowedIpRanges.join("\n"));
    setUnknown(server.unknownLocationPolicy);
  }, [
    server.enabled,
    server.allowedCountries,
    server.allowedIpRanges,
    server.unknownLocationPolicy,
  ]);

  const parsedCountries = useMemo(
    () => dedupeNonEmpty(countriesText.split(/[\s,]+/)).map((c) => c.toUpperCase()),
    [countriesText],
  );
  const parsedIpRanges = useMemo(() => dedupeNonEmpty(ipRangesText.split(/\n+/)), [ipRangesText]);

  const countriesValid = parsedCountries.every((c) => COUNTRY_PATTERN.test(c));
  const ipRangesValid = parsedIpRanges.every((r) => CIDR_PATTERN.test(r));
  const lengthsValid = parsedCountries.length <= 50 && parsedIpRanges.length <= 100;
  const formValid = countriesValid && ipRangesValid && lengthsValid;

  const dirty =
    enabled !== server.enabled ||
    parsedCountries.join(",").toLowerCase() !== server.allowedCountries.join(",").toLowerCase() ||
    parsedIpRanges.join(",") !== server.allowedIpRanges.join(",") ||
    unknown !== server.unknownLocationPolicy;

  const onSave = (): void => {
    if (!formValid || !dirty) return;
    update.mutate({
      enabled,
      allowedCountries: parsedCountries.map((c) => c.toLowerCase()),
      allowedIpRanges: parsedIpRanges,
      unknownLocationPolicy: unknown,
    });
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-l)" }}>
      <header>
        <h3 className="t-title">Geo-fence policy</h3>
        <p className="t-body t-body--mute">
          Surface sign-ins authenticating outside your declared operating area. Microsoft Defender
          catches the obvious risky-sign-in cases; this allowlist surfaces the long-tail &ldquo;user
          just authenticated from a country we don&rsquo;t operate in&rdquo; signal.
        </p>
      </header>

      <label className="t-body" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      <div>
        <label htmlFor="geofence-countries" className="t-body" style={{ display: "block" }}>
          Allowed countries (ISO 3166-1 alpha-2 codes, comma-separated)
        </label>
        <input
          id="geofence-countries"
          type="text"
          value={countriesText}
          onChange={(e) => setCountriesText(e.target.value)}
          placeholder="GB, IE"
          style={{ width: "100%", padding: 6, fontFamily: "var(--ff-mono)" }}
        />
        <p className="t-caption" style={{ marginTop: 4 }}>
          Parsed: {parsedCountries.length === 0 ? "(none)" : parsedCountries.join(", ")}{" "}
          {parsedCountries.length > 50 && (
            <span style={{ color: "var(--red-fg)" }}>· too many entries (max 50)</span>
          )}
          {!countriesValid && (
            <span style={{ color: "var(--red-fg)" }}>· entries must be 2-letter ISO codes</span>
          )}
        </p>
      </div>

      <div>
        <label htmlFor="geofence-ip" className="t-body" style={{ display: "block" }}>
          Allowed IP ranges (CIDR, one per line) — bypass the country check when source IP matches
        </label>
        <textarea
          id="geofence-ip"
          value={ipRangesText}
          onChange={(e) => setIpRangesText(e.target.value)}
          placeholder={`203.0.113.0/24\n2001:db8::/32`}
          rows={4}
          style={{ width: "100%", padding: 6, fontFamily: "var(--ff-mono)" }}
        />
        <p className="t-caption" style={{ marginTop: 4 }}>
          Parsed: {parsedIpRanges.length} entr{parsedIpRanges.length === 1 ? "y" : "ies"}{" "}
          {parsedIpRanges.length > 100 && (
            <span style={{ color: "var(--red-fg)" }}>· too many entries (max 100)</span>
          )}
          {!ipRangesValid && (
            <span style={{ color: "var(--red-fg)" }}>· one or more entries are not valid CIDR</span>
          )}
        </p>
      </div>

      <fieldset style={{ display: "flex", gap: "var(--sp-m)", padding: 0, border: 0 }}>
        <legend className="t-body" style={{ marginBottom: 4 }}>
          Unknown-location policy (when Microsoft can&rsquo;t enrich the country)
        </legend>
        <label className="t-body" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input
            type="radio"
            name="unknown-location"
            checked={unknown === "alert"}
            onChange={() => setUnknown("alert")}
          />
          Alert
        </label>
        <label className="t-body" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input
            type="radio"
            name="unknown-location"
            checked={unknown === "ignore"}
            onChange={() => setUnknown("ignore")}
          />
          Ignore
        </label>
      </fieldset>

      <div style={{ display: "flex", gap: "var(--sp-m)", alignItems: "center" }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!formValid || !dirty || update.isPending}
          onClick={onSave}
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
        {!dirty && server.source === "default" && (
          <span className="t-caption">Defaults applied (no tenant row saved yet).</span>
        )}
        {!dirty && server.source === "tenant" && <span className="t-caption">Up to date.</span>}
      </div>

      {update.isError && (
        <MessageBar intent="error">
          <MessageBarBody>
            Save failed.{" "}
            {update.error instanceof ApiError
              ? `(${update.error.status}) ${update.error.message}`
              : (update.error as Error).message}
          </MessageBarBody>
        </MessageBar>
      )}
      {update.isSuccess && !dirty && (
        <MessageBar intent="success">
          <MessageBarBody>
            Saved. Existing sign-in rows have been re-flagged against the new policy.
          </MessageBarBody>
        </MessageBar>
      )}
    </section>
  );
}
