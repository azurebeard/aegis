// ADR-0036 v1.3 follow-track (§10.71 F1) — single-source-of-truth catalog
// of every ingest source the system knows about.
//
// The freshness-row routing in `ingestHealth.ts` / `tables.ts` is prefix-
// based: `azure.*` → `ArmIngestHealth`, everything else → `IngestHealth`.
// That works today because the source-string convention is enforced by
// convention only. This catalog promotes the convention to the type
// system: a future contributor accidentally naming a Graph vertical
// `azure.something` either has to add it to `ARM_INGEST_SOURCES` (in
// which case it correctly routes to `ArmIngestHealth` and gets the
// arm-ingest MI grant) OR the source string fails the `IngestSource`
// union check at call sites that adopt the type.
//
// Companion invariant test in `api/tests/ingestSourcesCatalog.test.ts`
// asserts every literal in `ARM_INGEST_SOURCES` starts with `azure.`,
// no literal in the other category arrays starts with `azure.`, and
// the four category arrays are disjoint.
//
// This file is a registry — adding a new ingest source requires
// touching it. The narrow signal is intentional.

/** ARM data-plane sources. Freshness rows live in `ArmIngestHealth`;
 *  written by the `armIngest` MI. */
export const ARM_INGEST_SOURCES = [
  "azure.security.defenderForCloud.secureScores",
] as const;
export type ArmIngestSource = (typeof ARM_INGEST_SOURCES)[number];

/** Microsoft Graph data-plane sources. Freshness rows live in
 *  `IngestHealth`; written by the `ingest` MI. */
export const GRAPH_INGEST_SOURCES = [
  "graph.security.secureScores",
  "graph.security.secureScoreControlProfiles",
  "graph.security.incidents",
  "graph.security.riskyUsers",
  "graph.users.dormancy",
  "graph.auditLogs.signIns",
  "graph.identity.conditionalAccess.policies",
] as const;
export type GraphIngestSource = (typeof GRAPH_INGEST_SOURCES)[number];

/** Aegis-agent audit-chain sources. Freshness rows live in `IngestHealth`;
 *  written by the runner identities (`agent` for brief/posture writes,
 *  `ingest` for the incidents-analysis trigger). */
export const AGENT_INGEST_SOURCES = [
  "agent.aegis.brief",
  "agent.aegis.posture",
  "agent.aegis.incidents",
] as const;
export type AgentIngestSource = (typeof AGENT_INGEST_SOURCES)[number];

/** Sources outside the data-plane taxonomy: external feeds (CISA KEV),
 *  operator-curated state (stack inventory), internal capture operations
 *  (report snapshot). Freshness rows live in `IngestHealth`. */
export const OTHER_INGEST_SOURCES = [
  "cisa.kev",
  "operator.stack",
  "report.snapshot",
  // ADR-0037 — ransomware.live PRO threat-intel feed. External HTTP source,
  // freshness row lives in `IngestHealth`, written by the `threatIntel` MI
  // under its per-secret KV ABAC + per-table Storage Table grant.
  "external.ransomware.live",
] as const;
export type OtherIngestSource = (typeof OTHER_INGEST_SOURCES)[number];

/** ADR-0030 Phase C — audit-chain sources for the email send orchestrator.
 *  Two partitions per §C.7: `report.email.intent` (pre-send fingerprint) and
 *  `report.email.sent` (host for both success + failure outcome variants).
 *  Registered here so the audit-chain verifier (Slice 1(c)/B) keys off the
 *  same catalog every other source uses. */
export const REPORT_EMAIL_INGEST_SOURCES = [
  "report.email.intent",
  "report.email.sent",
] as const;
export type ReportEmailIngestSource = (typeof REPORT_EMAIL_INGEST_SOURCES)[number];

/** ADR-0030 §C.22 — audit-chain source for the share-link read endpoint
 *  (GET /api/reports/share/{token}). One chained line per successful 200
 *  read; failed verification paths are NOT audited (they reveal nothing
 *  about a snapshot). Best-effort emission: a write failure on the
 *  user-facing read path logs a warn breadcrumb but does not 500 the
 *  reader. Freshness row lives in IngestHealth, keyed off
 *  `report.html.share`; written by the ingest MI under the same
 *  `Storage Table Data Contributor` grant the other audit-only chains
 *  already hold (no Bicep change needed). */
export const REPORT_HTML_INGEST_SOURCES = [
  "report.html.share",
] as const;
export type ReportHtmlIngestSource = (typeof REPORT_HTML_INGEST_SOURCES)[number];

/** Union of every known ingest source. Callers that pass this type to
 *  `ingestHealthTableNameForSource` get compile-time confidence the
 *  source resolves to the intended table. */
export type IngestSource =
  | ArmIngestSource
  | GraphIngestSource
  | AgentIngestSource
  | OtherIngestSource
  | ReportEmailIngestSource
  | ReportHtmlIngestSource;

/** Flat catalog for iteration (drift checks, registry lookups, etc.). */
export const ALL_INGEST_SOURCES = [
  ...ARM_INGEST_SOURCES,
  ...GRAPH_INGEST_SOURCES,
  ...AGENT_INGEST_SOURCES,
  ...OTHER_INGEST_SOURCES,
  ...REPORT_EMAIL_INGEST_SOURCES,
  ...REPORT_HTML_INGEST_SOURCES,
] as const;

const ALL_INGEST_SOURCES_SET = new Set<string>(ALL_INGEST_SOURCES);

/** Runtime narrowing for legacy code paths that still pass raw `string`.
 *  Returns true iff `s` is one of the catalogued sources. */
export function isKnownIngestSource(s: string): s is IngestSource {
  return ALL_INGEST_SOURCES_SET.has(s);
}
