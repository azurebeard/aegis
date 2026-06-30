// Append-blob audit log writer (ADR-0011 §7, ADR-0015 chain extension,
// ADR-0021 agent-chain extension).
//
// One NDJSON line per run. Path: audit/<source>/<yyyy>/<mm>/<dd>/<filename>
// under the audit container. Filename is per-source:
//   - ingest sources (graph.security.*)   → `ingest.ndjson`
//   - agent sources  (agent.aegis.*)      → `agent-run.ndjson`  (ADR-0021)
// The audit MI (AUDIT_MI_CLIENT_ID) is the only identity that writes here.
//
// From ADR-0015 schemaVersion:2 onwards every line carries `prevLineSha256`
// and `lineSha256`. This module accepts a pre-computed line object (the
// orchestrator is responsible for computing the hash via
// `auditChain.computeLineSha256`) and appends the NDJSON unchanged. Keeping
// the hash computation in the caller preserves the single-source-of-truth
// rule: if any future line shape gains/drops fields, the caller updates the
// canonicalisation input and the hash input together.

import { DefaultAzureCredential } from "@azure/identity";
import {
  AppendBlobClient,
  BlobServiceClient,
  RestError,
} from "@azure/storage-blob";

/**
 * ADR-0011 §7 + ADR-0014 §6 v2-shaped ingest.run line. Every field that
 * feeds the hash input is included; `lineSha256` is the only field omitted
 * from the canonical form (per ADR-0015 §2).
 *
 * Fields that only appear for some sources (e.g. `snapshotDate` for
 * Secure Score; `cursorBefore` for Incidents) are modelled as optional
 * index properties — the orchestrator serialises only the fields that
 * apply. `Record<string, unknown>` would be looser but loses the guidance
 * for the legacy Secure Score shape.
 */
export interface AuditLineFields {
  readonly schemaVersion: 2;
  readonly eventType:
    | "ingest.run"
    | "audit.chain.start"
    | "ingest.audit.repair"
    | "agent.run" // ADR-0021 §Decision.1
    | "audit.report.capture" // ADR-0030 §6
    | "ca.policy.changed" // ADR-0034 §3.3 + §10 (Phase 8D) — CA policy diff
    | "report.email.intent" // ADR-0030 §C.7 — pre-send audit line
    | "report.email.sent" // ADR-0030 §C.7 — post-Graph-202 success outcome
    | "report.email.failed" // ADR-0030 §C.7 — post-Graph-error failure outcome
    | "report.html.share.read"; // ADR-0030 §C.22 — share-link 200 read
  readonly source: string;
  readonly seq: number;
  readonly runId?: string;
  readonly tenantId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status?:
    | "success"
    | "no_data"
    | "error"
    | "budget_exhausted" // ADR-0019 §6
    | "circuit_open" // ADR-0019 §6
    | "cache_hit" // ADR-0022 §5 — run short-circuited by fresh cache
    | "degraded" // ADR-0027 §Decision.7 + ADR-0028 §Decision.9 — run completed with a known-minimal input set (e.g. upstream ingest failing or detail-blob redacted)
    | "size_exceeded"; // ADR-0030 §4 — capture envelope exceeded compressed cap
  readonly rowsWritten?: number;
  readonly retentionRowsDeleted?: number;
  readonly graphAttempts?: number;
  // Secure Score
  readonly snapshotDate?: string;
  readonly currentScore?: number;
  readonly maxScore?: number;
  // Incidents (ADR-0014 §6)
  readonly cursorBefore?: string | null;
  readonly cursorAfter?: string | null;
  readonly pagesFetched?: number;
  readonly incidentsIngested?: number;
  readonly incidentsSkipped?: number;
  readonly detailBlobsWritten?: number;
  readonly alertsIngested?: number;
  // EntraRisk (ADR-0023 §10)
  readonly riskyUsersIngested?: number;
  readonly riskyUsersSkipped?: number;
  readonly riskyUsersProcessing?: number;
  readonly licenceState?: "present" | "licence_required" | "unknown";
  // Repair
  readonly reason?: string;
  readonly priorLineCount?: number;
  readonly priorOnDiskLineSha256?: string;
  readonly expectedLineSha256?: string;
  // Agent (ADR-0021 §Decision.1)
  readonly modelDeployment?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly latencyMs?: number;
  readonly outputSha256?: string; // sha256 of the published brief body (post-sanitise)
  readonly sourcesUsed?: readonly string[]; // subset of allowed context keys
  readonly briefDate?: string; // yyyy-mm-dd
  readonly trigger?: "timer" | "admin" | "superseded"; // ADR-0020 §3
  readonly supersedingRunId?: string; // ADR-0022 cache-race reconciliation
  readonly runOutcome?: "committed" | "discarded"; // ADR-0022 §3
  /** ADR-0028 §Decision.7c — set of adversary-influenceable fields the
   *  prompt builder dropped via the denylist on this run. SOC operators
   *  alert on sustained populated values via the audit-chain verifier
   *  or scheduled queries. Kept as a plain string[] so the chain hash
   *  is stable regardless of element order; the builder emits in a
   *  fixed iteration order. */
  readonly redactedFields?: readonly string[];
  // Reports (ADR-0030 §6)
  readonly periodKey?: string;
  readonly cadence?: "weekly" | "monthly" | "quarterly";
  readonly capturedBy?: string; // AAD object ID of capturing admin
  readonly version?: number;
  readonly envelopeBytes?: number; // post-compression
  readonly contentType?: string;
  readonly trimmedVersions?: readonly number[]; // ADR-0030 §6 — versions deleted by inline trim; omitted when retentionRowsDeleted === 0
  // ADR-0036 — Defender for Cloud Secure Score ingest (Phase A single-sub).
  // Added now (v1) to keep audit-line provenance unambiguous when Phase B
  // ships multi-subscription support; readers can already join runs to
  // their target subscription without a Table lookup.
  readonly subscriptionId?: string;
  // Conditional Access policy diff (ADR-0034 §3.3 + §10)
  readonly policyId?: string;
  readonly displayName?: string;
  readonly diffKind?: "created" | "modified" | "deleted";
  /** Hash-only fingerprint of the prior policy version. Null on `created`.
   *  Conditions / GrantControls / SessionControls are NEVER embedded
   *  (potentially kilobytes); reviewers compare by hash and inspect the
   *  full bodies via the table snapshot if needed. */
  readonly policyBefore?: {
    readonly state: "enabled" | "disabled" | "enabledForReportingButNotEnforced";
    readonly modifiedDateTime: string | null;
    readonly conditionsSha256: string;
    readonly grantControlsSha256: string;
    readonly sessionControlsSha256: string | null;
  } | null;
  readonly policyAfter?: {
    readonly state: "enabled" | "disabled" | "enabledForReportingButNotEnforced";
    readonly modifiedDateTime: string | null;
    readonly conditionsSha256: string;
    readonly grantControlsSha256: string;
    readonly sessionControlsSha256: string | null;
  } | null;
  // Report email (ADR-0030 §C.7) — intent line (pre-send).
  readonly capturedAtOfSnapshot?: string;
  readonly renderedAt?: string;
  readonly senderMailbox?: string;
  readonly recipientCount?: number;
  readonly externalRecipientCount?: number;
  /** Pre-pepper (legacy) recipient fingerprint: sha256(tenantId : recipients).
   *  Emitted by intent lines from FAs without a Key Vault pepper configured.
   *  Mutually exclusive with `recipientHashSaltedV2` — the orchestrator picks
   *  exactly one based on `recipientHashPepper.loadRecipientHashPepper()`.
   *  See ADR-0030 §C.20 / §C.21 for the migration + rotation contract. */
  readonly recipientHashSalted?: string;
  /** Peppered (post-Key-Vault) recipient fingerprint:
   *  sha256(pepper : tenantId : recipients). Emitted when the FA's
   *  `RECIPIENT_HASH_PEPPER_KV_NAME` + `_SECRET_NAME` env vars are set and
   *  the latest KV secret version is readable by the `mailSender` MI.
   *  Mutually exclusive with `recipientHashSalted`. */
  readonly recipientHashSaltedV2?: string;
  readonly bodySha256?: string;
  readonly bodyBytes?: number;
  readonly subjectSha256?: string;
  readonly triggeredBy?: "admin" | "auto";
  readonly operatorPrincipal?: string;
  readonly idempotencyKey?: string;
  readonly intentAt?: string;
  // Report email outcome (sent + failed share the source partition).
  readonly intentLineSeq?: number; // back-reference from outcome to intent
  readonly graphMessageId?: string;
  readonly graphClientRequestId?: string;
  readonly internetMessageId?: string;
  readonly sentAt?: string;
  readonly errorKind?: "throttle" | "4xx" | "5xx" | "internal" | "ambiguous" | "network" | "timeout";
  readonly errorMessage?: string;
  readonly attempt?: number;
  readonly failedAt?: string;
  // Report HTML share read (ADR-0030 §C.22). The signed-token JTI is the
  // per-link unique identifier — opaque random bytes minted at issue
  // time, NOT user data. Landing it on the audit line lets a SOC pivot
  // from a reported abuse case ("recipient @example.com forwarded the
  // link") back to the specific token (and from there, via Exchange
  // message trace + report-email send-history, to the original send).
  readonly tokenJti?: string;
  // Common
  readonly callerPrincipalMiClientId: string;
  readonly error?: {
    readonly kind: string;
    readonly message: string;
  };
  // ADR-0015 chain fields. Always present on schemaVersion:2 lines.
  readonly prevLineSha256: string;
  readonly lineSha256: string;
}

/** Default NDJSON filename per event type (ADR-0021 §Decision.2 + ADR-0030 §6).
 *
 *  Keep in sync with the JS twin at `scripts/verify-audit-chain.mjs`
 *  `filenameForSource`. Drift between the two surfaces silently as a
 *  verifier reading zero lines and exiting 0 ("no lines for ..."),
 *  masking a real chain-walk failure. Two sources of truth is the cost
 *  of a pure-JS offline verifier; the dispatch is the entire API. */
export function auditFilenameForSource(source: string): string {
  if (source.startsWith("agent.")) return "agent-run.ndjson";
  if (source === "report.snapshot") return "report.ndjson";
  if (source === "report.email.intent") return "report-email-intent.ndjson";
  if (source === "report.email.sent") return "report-email-sent.ndjson"; // includes failure variants per §C.7
  if (source === "report.html.share") return "report-html-share.ndjson"; // ADR-0030 §C.22
  return "ingest.ndjson";
}

export interface AuditContext {
  readonly blobEndpoint: string; // https://<acct>.blob.core.windows.net
  readonly auditContainerName: string; // "audit"
  readonly managedIdentityClientId: string; // AUDIT_MI client ID
}

/**
 * Append a single NDJSON line to the day-partitioned audit blob. Creates the
 * blob on first-write-of-day. Fails loud — callers should wrap with their own
 * try/catch if they want the ingest to proceed on audit-write failure (v1 does
 * NOT: audit failure fails the whole run, consistent with brief §9 — audit is
 * a required byproduct, not optional).
 */
export async function appendAuditLine(
  ctx: AuditContext,
  line: AuditLineFields,
): Promise<void> {
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: ctx.managedIdentityClientId,
  });
  const service = new BlobServiceClient(ctx.blobEndpoint, credential);
  const container = service.getContainerClient(ctx.auditContainerName);

  const path = auditBlobPath(line.source, line.startedAt, auditFilenameForSource(line.source));
  const blob = new AppendBlobClient(
    `${ctx.blobEndpoint}/${ctx.auditContainerName}/${path}`,
    credential,
  );
  // Suppress unused var warning under strict mode — the instance is retained
  // if a future version wants to enumerate sibling blobs.
  void container;

  await ensureAppendBlob(blob);

  const body = JSON.stringify(line) + "\n";
  await blob.appendBlock(body, Buffer.byteLength(body, "utf-8"));
}

export function auditBlobPath(
  source: string,
  startedAt: string,
  filename: string = "ingest.ndjson",
): string {
  const d = new Date(startedAt);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  // Path-sanitise source + filename — both are trusted internal constants
  // today, but defence-in-depth keeps future refactors safe.
  const safeSource = source.replace(/[^A-Za-z0-9._-]/g, "_");
  const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safeSource}/${y}/${m}/${day}/${safeFilename}`;
}

/**
 * Read the last NDJSON line on disk for a given (source, startedAt). Used on
 * ingest start to cross-check against `IngestHealth.LastLineSha256` — if they
 * don't match, the orchestrator emits an `ingest.audit.repair` line before
 * the next `ingest.run` (ADR-0015 §Negative "audit-write-gap"). Returns
 * `null` when no blob exists for the day yet.
 *
 * The read walks back at most `lookbackDays` days to find the most recent
 * non-empty day blob — a quiet weekend on Secure Score produces multiple
 * no-op days before the next line.
 */
export interface LastLineReadResult {
  readonly lineSha256: string;
  readonly seq: number;
  readonly source: string;
  readonly tenantId: string;
  readonly day: string; // yyyy-mm-dd
}

/**
 * Read up to `limit` most-recent NDJSON lines for a given (source, tenantId)
 * across the last `lookbackDays` UTC day-blobs. Returns lines newest-first.
 *
 * Used by the admin observability endpoint to surface agent-plane run
 * history (status, tokens, error.kind) — caller renders metadata only;
 * chain SHAs are dropped at the projection layer to avoid leaking a
 * verifier-side surface.
 *
 * Read-only against the audit blob — caller's MI must hold Storage Blob
 * Data Reader on the audit container. Lines are filtered by `source`
 * and `tenantId` for defence-in-depth: agent-run.ndjson today carries
 * exactly one source/tenant pair per file, but the filter keeps the
 * helper safe if a future shape ever multiplexes.
 *
 * Walking strategy: try today's blob, then yesterday's, etc. A 404 on
 * any day-blob is normal (no run that day) and we continue. Other
 * errors propagate to the caller.
 */
export interface AuditLineRead extends AuditLineFields {
  readonly day: string; // yyyy-mm-dd of the source blob
}

export async function readRecentAuditLines(
  ctx: AuditContext,
  source: string,
  tenantId: string,
  limit: number,
  lookbackDays: number = 14,
  asOf: string = new Date().toISOString(),
): Promise<readonly AuditLineRead[]> {
  if (limit <= 0) return [];
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: ctx.managedIdentityClientId,
  });
  const safeSource = source.replace(/[^A-Za-z0-9._-]/g, "_");
  const filename = auditFilenameForSource(source);
  const asOfDate = new Date(asOf);
  const out: AuditLineRead[] = [];

  for (let i = 0; i <= lookbackDays && out.length < limit; i++) {
    const probe = new Date(asOfDate.getTime() - i * 86_400_000);
    const y = probe.getUTCFullYear().toString().padStart(4, "0");
    const m = (probe.getUTCMonth() + 1).toString().padStart(2, "0");
    const dayPart = probe.getUTCDate().toString().padStart(2, "0");
    const day = `${y}-${m}-${dayPart}`;
    const path = `${safeSource}/${y}/${m}/${dayPart}/${filename}`;
    const blob = new AppendBlobClient(
      `${ctx.blobEndpoint}/${ctx.auditContainerName}/${path}`,
      credential,
    );
    let text: string;
    try {
      const buffer = await blob.downloadToBuffer();
      text = buffer.toString("utf-8");
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 404) continue;
      throw err;
    }
    // Newest line is the LAST line in the file (append-blob append order).
    // Iterate in reverse so we stop hitting `limit` without parsing the
    // earlier lines.
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    for (let j = lines.length - 1; j >= 0 && out.length < limit; j--) {
      const raw = lines[j];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Partial<AuditLineFields>;
        // Defensive filter — a future multi-tenant blob shape would land
        // mixed lines here; current shape is single-tenant so this is a
        // belt-and-braces check.
        if (parsed.source !== source) continue;
        if (parsed.tenantId !== tenantId) continue;
        // The chain-SHA fields are required on schemaVersion:2 lines, but
        // we don't enforce here — the caller projects them out before
        // returning to the SPA. Keep the read tolerant.
        out.push({ ...(parsed as AuditLineFields), day });
      } catch {
        // Malformed line — surface via the verifier; don't block reads.
      }
    }
  }
  return out;
}

export async function readLastOnDiskAuditLine(
  ctx: AuditContext,
  source: string,
  tenantId: string,
  asOf: string = new Date().toISOString(),
  lookbackDays: number = 14,
): Promise<LastLineReadResult | null> {
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: ctx.managedIdentityClientId,
  });
  const safeSource = source.replace(/[^A-Za-z0-9._-]/g, "_");
  const asOfDate = new Date(asOf);
  for (let i = 0; i <= lookbackDays; i++) {
    const probe = new Date(asOfDate.getTime() - i * 86_400_000);
    const y = probe.getUTCFullYear().toString().padStart(4, "0");
    const m = (probe.getUTCMonth() + 1).toString().padStart(2, "0");
    const day = probe.getUTCDate().toString().padStart(2, "0");
    const filename = auditFilenameForSource(source);
    const path = `${safeSource}/${y}/${m}/${day}/${filename}`;
    const blob = new AppendBlobClient(
      `${ctx.blobEndpoint}/${ctx.auditContainerName}/${path}`,
      credential,
    );
    try {
      const buffer = await blob.downloadToBuffer();
      const text = buffer.toString("utf-8");
      const lastNewline = text.lastIndexOf("\n", text.length - 2);
      const lastLine = text.slice(lastNewline + 1).trim();
      if (lastLine === "") continue;
      try {
        const parsed = JSON.parse(lastLine) as {
          lineSha256?: unknown;
          seq?: unknown;
          source?: unknown;
          tenantId?: unknown;
        };
        if (
          typeof parsed.lineSha256 === "string" &&
          typeof parsed.seq === "number" &&
          typeof parsed.source === "string" &&
          typeof parsed.tenantId === "string" &&
          parsed.source === source &&
          parsed.tenantId === tenantId
        ) {
          return {
            lineSha256: parsed.lineSha256,
            seq: parsed.seq,
            source: parsed.source,
            tenantId: parsed.tenantId,
            day: `${y}-${m}-${day}`,
          };
        }
        // Line belongs to another tenant in the same blob → skip; there is
        // no multi-tenant audit blob in v1 but the check is cheap.
      } catch {
        // Malformed trailing line — continue walk back; surface via the
        // verifier rather than blocking ingest.
      }
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 404) continue;
      throw err;
    }
  }
  return null;
}

/**
 * Redact a candidate agent-run audit line (ADR-0021 §Decision.4).
 *
 * Defence: the line shape is assembled from multiple sources including model
 * output (`outputSha256`) and caller-supplied prompt context (`sourcesUsed`).
 * Although those fields are narrowly typed, a regression or prototype-pollution
 * bug could land a credential-bearing string in an unexpected key. This helper:
 *   1. Clones onto a null-prototype object so `__proto__` / `constructor` keys
 *      can't be exploited by a later consumer.
 *   2. Strips any non-allowlisted key so a future code bug can only leak fields
 *      the audit schema already declares.
 *   3. Replaces any string value matching obvious credential patterns (`eyJ*`
 *      JWT prefix, `Bearer `, 32+ hex, pem-block markers) with `[REDACTED]`.
 *
 * Returns a plain-JSON-safe object suitable for `JSON.stringify`. The hash
 * chain computation MUST use the scrubbed object as its canonicalisation
 * input (or the verifier would otherwise re-compute a different hash from the
 * on-disk bytes).
 */
const AGENT_LINE_ALLOWED_KEYS = new Set<string>([
  "schemaVersion",
  "eventType",
  "source",
  "seq",
  "runId",
  "tenantId",
  "startedAt",
  "endedAt",
  "status",
  "modelDeployment",
  "tokensIn",
  "tokensOut",
  "latencyMs",
  "outputSha256",
  "sourcesUsed",
  "briefDate",
  "trigger",
  "supersedingRunId",
  "runOutcome",
  "reason",
  "redactedFields", // ADR-0028 §Decision.7c (incidents-agent denylist trail)
  "callerPrincipalMiClientId",
  "error",
  "prevLineSha256",
  "lineSha256",
  // Repair-line fields (ADR-0015 §Negative "audit-write-gap" — `eventType:
  // "ingest.audit.repair"`). Added 2026-04-21 PM per SEC-OBS-AUDIT-CHAIN-02
  // so `scrubAgentLine` is idempotently safe on repair lines too — no
  // silent field-drop if a future refactor routes repair lines through
  // the scrubber. `priorOnDiskLineSha256` + `expectedLineSha256` are
  // simultaneously added to `CHAIN_INTEGRITY_KEYS` below so the credential
  // regex doesn't redact the two SHA-256 payloads.
  "priorLineCount",
  "priorOnDiskLineSha256",
  "expectedLineSha256",
]);

// Credential-shaped strings. Matching patterns replace the whole value.
const CREDENTIAL_REGEXES: readonly RegExp[] = [
  /^eyJ[A-Za-z0-9_-]{10,}\./, // JWT
  /^Bearer\s+\S+/i,
  /-----BEGIN [A-Z ]+-----/,
  /^[a-f0-9]{32,}$/i, // long hex — covers account-keys, SAS signatures
];

/**
 * Chain-integrity fields whose values are always SHA-256 hashes (64 hex
 * chars) produced by our own code — not incoming data. Without the
 * allowlist, the long-hex credential regex above matches every SHA-256
 * and rewrites the value to `[REDACTED]` on disk. Per-line integrity still
 * verifies (the hash is computed AFTER scrub), but cross-line chain walks
 * in `scripts/verify-audit-chain.mjs` then compare line-N's stored
 * `prevLineSha256` (`"[REDACTED]"`) against line-(N-1)'s stored
 * `lineSha256` (real hex) — always mismatches. Allowlisting these keys
 * lets the chain fields pass through verbatim so the offline verifier
 * walks cleanly. (SEC-FD-AUDIT-CHAIN-01.)
 *
 * Repair-line SHA-256 fields (`priorOnDiskLineSha256`, `expectedLineSha256`)
 * added 2026-04-21 PM per SEC-OBS-AUDIT-CHAIN-02 — the ingest-repair
 * line shape (`eventType: "ingest.audit.repair"`, ADR-0015 §Negative
 * "audit-write-gap") does NOT currently route through `scrubAgentLine`
 * (repair lines are emitted by the ingest path via a different code
 * path), but the preventive allowlist means a future refactor that
 * DOES route them through won't reintroduce the SEC-FD-AUDIT-CHAIN-01
 * bug for the repair chain.
 */
const CHAIN_INTEGRITY_KEYS: ReadonlySet<string> = new Set([
  "prevLineSha256",
  "lineSha256",
  "outputSha256",
  "priorOnDiskLineSha256",
  "expectedLineSha256",
]);

export function scrubAgentLine(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(input)) {
    if (!AGENT_LINE_ALLOWED_KEYS.has(key)) continue;
    out[key] = redactValue(input[key], key);
  }
  return out;
}

/**
 * Shape-gate for adapter-supplied `extraAuditFields` (SEC-OBS-B4-02
 * resolution). `runAgent.emitAudit` spreads `opts.extraAuditFields`
 * into the audit line; the allowlist in `scrubAgentLine` drops unknown
 * keys, but for KNOWN-allowed keys it doesn't validate the shape —
 * so an adapter passing `{ redactedFields: "not an array" }` would
 * land a malformed value in the audit chain.
 *
 * This function is the per-key type-check that runs BEFORE the spread.
 * Keys with the wrong shape are DROPPED (not rewritten to an empty
 * value) so the downstream line carries an absent-field rather than
 * a wrong-type field. Drops are silent — observability is via the
 * verifier's strict-shape assertions; a future enhancement could emit
 * an `AIEVENT AuditExtraFieldDropped` telemetry on drop, but the
 * current surface (one caller, one key) doesn't justify it.
 *
 * Extend when `AGENT_LINE_ALLOWED_KEYS` gains a new adapter-supplied
 * entry — the default branch drops anything not explicitly handled,
 * which is the correct fail-closed posture for a new allowlist key
 * that ships without an accompanying shape rule.
 */
export function sanitiseExtraAuditFields(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!extra) return {};
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(extra)) {
    if (!AGENT_LINE_ALLOWED_KEYS.has(key)) continue;
    switch (key) {
      case "redactedFields": {
        // ADR-0028 §Decision.7c — readonly string[] of field names the
        // prompt builder redacted. Order is canonicalised at the call
        // site (lex-sorted) for chain-hash determinism; we don't
        // re-sort here, only type-check.
        if (
          Array.isArray(value) &&
          value.every((x) => typeof x === "string" && x.length > 0)
        ) {
          out[key] = value;
        }
        break;
      }
      // Add future adapter-supplied keys here, each with an inline
      // shape rule. The default branch drops — a new allowlisted key
      // shipped without a case falls through safely.
      default:
        break;
    }
  }
  return out;
}

function redactValue(v: unknown, key?: string): unknown {
  if (typeof v === "string") {
    // Chain-integrity fields hold our own SHA-256 outputs; skip credential
    // matching. See CHAIN_INTEGRITY_KEYS above for the rationale.
    if (key !== undefined && CHAIN_INTEGRITY_KEYS.has(key)) {
      return v;
    }
    for (const re of CREDENTIAL_REGEXES) {
      if (re.test(v)) return "[REDACTED]";
    }
    return v;
  }
  if (Array.isArray(v)) {
    // Array elements inherit no key context — a hostile value nested
    // inside `sourcesUsed` (for example) still gets scanned.
    return v.map((item) => redactValue(item));
  }
  if (v && typeof v === "object") {
    const inner: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as Record<string, unknown>)) {
      inner[k] = redactValue((v as Record<string, unknown>)[k], k);
    }
    return inner;
  }
  return v;
}

async function ensureAppendBlob(blob: AppendBlobClient): Promise<void> {
  try {
    await blob.createIfNotExists();
  } catch (err) {
    // createIfNotExists can race; tolerate "already exists" as success.
    if (err instanceof RestError && err.statusCode === 409) return;
    throw err;
  }
}
