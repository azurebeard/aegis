// Single source of truth for the Ingest Diagnostics page's per-source cards.
//
// Before this registry, three places had to be updated together for every
// new ingest source — and they drifted (ADR-0037 Layer 5 hit it: the new
// `ransomware-intel` source landed in the API + dashboard tile but missed
// the diagnostics card because the constant lived web-side). This module
// hosts:
//
//   - The URL-segment key (`secure-score`, etc.) used in the
//     `?source=` query param on `/api/agents/observability/ingest-runs`.
//   - The audit-chain source string (`graph.security.secureScores`, etc.)
//     that the orchestrator writes audit lines under. This is what the
//     run-history walker grep-keys on.
//   - The UI metadata (label, iconName, description) that
//     `/api/agents/observability/ingest-sources` returns to the SPA.
//
// Pattern matches the existing single-source-of-truth modules:
//   - `ingestSources.ts` — audit-chain source catalogue (ADR-0036 §F1).
//   - `tables.ts` — ops Table name → MI-routing map.
// Add a new vertical → one edit here covers the API parser, the resolver,
// AND the SPA card. The companion test asserts the registry is internally
// consistent (no duplicate keys, no duplicate audit sources, every
// auditSource is in the `ingestSources.ts` catalogue).
//
// `iconName` is sent as an opaque string in the API response; the SPA
// validates it against its own `IconName` union at parse time and falls
// back to a default if a future server pushes a name the SPA doesn't
// know. That keeps the API → SPA contract loose enough that one side
// can ship before the other.

export interface DiagnosticsSourceConfig {
  /** URL-segment key. Stable contract — never rename a shipped one. */
  readonly key: string;
  /** Audit-chain source string the orchestrator emits. Maps 1:1 to
   *  an entry in `ingestSources.ts:ALL_INGEST_SOURCES`. */
  readonly auditSource: string;
  /** Card title in the SPA. */
  readonly label: string;
  /** Opaque icon-name string. The SPA validates against its own
   *  `IconName` union; an unknown value falls back to a default. */
  readonly iconName: string;
  /** Card body description. Plain-text only (no markdown). */
  readonly description: string;
}

export const DIAGNOSTICS_SOURCES: readonly DiagnosticsSourceConfig[] = [
  {
    key: "secure-score",
    auditSource: "graph.security.secureScores",
    label: "Microsoft Secure Score",
    iconName: "shield",
    description: "Daily Microsoft Graph /security/secureScores snapshot.",
  },
  {
    key: "incidents",
    auditSource: "graph.security.incidents",
    label: "Incidents",
    iconName: "alert",
    description: "15-minute Microsoft Graph /security/incidents poll.",
  },
  {
    key: "entra-risk",
    auditSource: "graph.security.riskyUsers",
    label: "Risky users (Entra ID)",
    iconName: "user",
    description: "4-hour Microsoft Graph /identityProtection/riskyUsers poll.",
  },
  {
    key: "kev",
    auditSource: "cisa.kev",
    label: "KEV catalogue",
    iconName: "doc",
    description: "Daily CISA Known Exploited Vulnerabilities feed refresh.",
  },
  {
    key: "user-dormancy",
    auditSource: "graph.users.dormancy",
    label: "User dormancy",
    iconName: "user",
    description:
      "Daily Microsoft Graph /users walk for signInActivity (ADR-0034 §3.1).",
  },
  {
    key: "sign-ins",
    auditSource: "graph.auditLogs.signIns",
    label: "Sign-ins",
    iconName: "user",
    description:
      "15-minute Microsoft Graph /auditLogs/signIns poll with geo-fence cross-reference (ADR-0034 §3.2).",
  },
  {
    key: "conditional-access",
    auditSource: "graph.identity.conditionalAccess.policies",
    label: "Conditional Access",
    iconName: "shield",
    description:
      "Hourly Microsoft Graph /identity/conditionalAccess/policies snapshot + diff detection (ADR-0034 §3.3).",
  },
  {
    key: "azure-secure-score",
    auditSource: "azure.security.defenderForCloud.secureScores",
    label: "Defender for Cloud Secure Score",
    iconName: "shield",
    description:
      "Daily ARM /providers/Microsoft.Security/secureScores snapshot per tracked subscription (ADR-0036 Phase A).",
  },
  {
    key: "ransomware-intel",
    auditSource: "external.ransomware.live",
    label: "Ransomware.live PRO threat intel",
    iconName: "alert",
    description:
      "Hourly per-country victim + press pull from ransomware.live PRO (ADR-0037). KV-seeded API key gates the ingest; auth_unavailable surfaces as the latest audit line's error.kind.",
  },
] as const;

const KEYS_SET = new Set<string>(DIAGNOSTICS_SOURCES.map((s) => s.key));

/** True iff `key` is a registered URL-segment for the run-history endpoint. */
export function isDiagnosticsSourceKey(key: string): boolean {
  return KEYS_SET.has(key);
}

/** Look up the audit-chain source string for a registered URL-segment.
 *  Returns null when the key isn't registered. */
export function auditSourceForKey(key: string): string | null {
  const entry = DIAGNOSTICS_SOURCES.find((s) => s.key === key);
  return entry?.auditSource ?? null;
}

/** Subset of fields safe to return to the SPA. The `auditSource` is
 *  server-internal (its shape is the audit-chain naming convention; not
 *  meaningful to operator-facing UI) and is deliberately omitted. */
export interface PublicDiagnosticsSource {
  readonly key: string;
  readonly label: string;
  readonly iconName: string;
  readonly description: string;
}

export function toPublicSources(): readonly PublicDiagnosticsSource[] {
  return DIAGNOSTICS_SOURCES.map(({ key, label, iconName, description }) => ({
    key,
    label,
    iconName,
    description,
  }));
}
