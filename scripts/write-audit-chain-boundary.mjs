#!/usr/bin/env node
// One-off migration helper — writes the `audit.chain.start` boundary marker
// per (source, tenantId) pair after ADR-0015 lands. Idempotent: re-running
// after the boundary exists is a no-op. See ADR-0015 §3a.
//
// Usage:
//   node scripts/write-audit-chain-boundary.mjs \
//     --source graph.security.secureScores \
//     --tenant <tenantId> \
//     --ingest-mi-client-id <guid> \
//     --audit-mi-client-id <guid> \
//     --ops-table-endpoint https://<acct>.table.core.windows.net \
//     --audit-blob-endpoint https://<acct>.blob.core.windows.net \
//     [--audit-container audit]
//
// Must be run with an Azure-CLI-authenticated identity that the managed
// identities trust (or directly using the MIs via federated credentials).
// In the typical path this script runs from the `azd` postprovision hook
// right after step-4 bicep merges — the postprovision step resolves the
// MI credentials via environment variables and invokes this script.
//
// The script is deliberately written in MJS + vanilla @azure SDK to keep
// it runnable from the bare `azd` host without depending on the compiled
// api bundle.

import { canonicalize } from "json-canonicalize";
import { createHash } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { TableClient } from "@azure/data-tables";
import { AppendBlobClient, RestError } from "@azure/storage-blob";

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      "Usage: write-audit-chain-boundary.mjs [flags]",
      "  --source <string>                 e.g. graph.security.secureScores",
      "  --tenant <guid>                   tenantId (audit-chain keying)",
      "  --ingest-mi-client-id <guid>      MI for reading IngestHealth table",
      "  --audit-mi-client-id <guid>       MI for appending to audit blob",
      "  --ops-table-endpoint <url>        https://<acct>.table.core.windows.net",
      "  --audit-blob-endpoint <url>       https://<acct>.blob.core.windows.net",
      "  --audit-container <name>          default 'audit'",
      "  --dry-run                         log the planned write; do not execute",
    ].join("\n"),
  );
  process.exit(msg ? 2 : 0);
}

const args = parseArgs(process.argv.slice(2));
if (!args.source || !args.tenant) usage("--source and --tenant are required");
if (!args["ingest-mi-client-id"]) usage("--ingest-mi-client-id is required");
if (!args["audit-mi-client-id"]) usage("--audit-mi-client-id is required");
if (!args["ops-table-endpoint"]) usage("--ops-table-endpoint is required");
if (!args["audit-blob-endpoint"]) usage("--audit-blob-endpoint is required");
const auditContainer = args["audit-container"] ?? "audit";
const dryRun = Boolean(args["dry-run"]);
const source = args.source;
const tenantId = args.tenant;

const CHAIN_SALT_VERSION = "v2";

const salted = `aegis:audit-chain:${CHAIN_SALT_VERSION}:${source}:${tenantId}:genesis`;
const genesisSentinel = sha256Hex(Buffer.from(salted, "utf-8"));
console.log(
  `[migrate] source=${source} tenantId=${tenantId} genesisSentinel=${genesisSentinel}`,
);

// Read IngestHealth row to get the next seq.
const ingestCredential = new DefaultAzureCredential({
  managedIdentityClientId: args["ingest-mi-client-id"],
});
const healthTable = new TableClient(
  args["ops-table-endpoint"],
  "IngestHealth",
  ingestCredential,
);
let prevSeq = 0;
let priorLineCount = 0;
let existingLineSha256 = "";
try {
  const row = await healthTable.getEntity(tenantId, source);
  prevSeq = typeof row.LastAuditSeq === "number" ? row.LastAuditSeq : 0;
  priorLineCount = prevSeq; // best-effort count; pre-chain lines = LastAuditSeq
  existingLineSha256 = typeof row.LastLineSha256 === "string" ? row.LastLineSha256 : "";
} catch (err) {
  if (err instanceof RestError && err.statusCode === 404) {
    console.log(`[migrate] no IngestHealth row for (${source}, ${tenantId}); boundary will seed fresh`);
  } else {
    throw err;
  }
}

if (existingLineSha256 !== "") {
  console.log(
    `[migrate] IngestHealth row already carries LastLineSha256=${existingLineSha256} — chain is initialised; nothing to do.`,
  );
  process.exit(0);
}

const startedAt = new Date().toISOString();
const seq = prevSeq + 1;

const boundary = {
  schemaVersion: 2,
  eventType: "audit.chain.start",
  source,
  tenantId,
  seq,
  startedAt,
  reason: "chain-introduced",
  priorLineCount,
  callerPrincipalMiClientId: args["audit-mi-client-id"],
  prevLineSha256: genesisSentinel,
};
const lineSha256 = sha256Hex(Buffer.from(canonicalize(boundary), "utf-8"));
const fullLine = { ...boundary, lineSha256 };
const ndjson = JSON.stringify(fullLine) + "\n";

const blobPath = auditBlobPath(source, startedAt);
console.log(`[migrate] planned write: ${blobPath} seq=${seq} lineSha256=${lineSha256}`);
if (dryRun) {
  console.log(`[migrate] dry-run: ${ndjson}`);
  process.exit(0);
}

const auditCredential = new DefaultAzureCredential({
  managedIdentityClientId: args["audit-mi-client-id"],
});
const blob = new AppendBlobClient(
  `${args["audit-blob-endpoint"]}/${auditContainer}/${blobPath}`,
  auditCredential,
);
try {
  await blob.createIfNotExists();
} catch (err) {
  if (err instanceof RestError && err.statusCode !== 409) throw err;
}
await blob.appendBlock(ndjson, Buffer.byteLength(ndjson, "utf-8"));
console.log(`[migrate] appended boundary marker to ${blobPath}`);

// Update IngestHealth so the next ingest.run sees the chain initialised.
try {
  await healthTable.updateEntity(
    {
      partitionKey: tenantId,
      rowKey: source,
      LastAuditSeq: seq,
      LastLineSha256: lineSha256,
      UpdatedAt: startedAt,
    },
    "Merge",
  );
  console.log(`[migrate] IngestHealth updated: LastAuditSeq=${seq} LastLineSha256=${lineSha256}`);
} catch (err) {
  if (err instanceof RestError && err.statusCode === 404) {
    await healthTable.createEntity({
      partitionKey: tenantId,
      rowKey: source,
      Status: "healthy",
      LastSuccessAt: null,
      LastFailureAt: null,
      ConsecutiveFailureCount: 0,
      LastRunId: null,
      LastAuditSeq: seq,
      LastLineSha256: lineSha256,
      LastCursor: "",
      UpdatedAt: startedAt,
    });
    console.log(`[migrate] IngestHealth row created with LastAuditSeq=${seq}`);
  } else {
    throw err;
  }
}

console.log(`[migrate] done.`);
process.exit(0);

// --- helpers ----------------------------------------------------------------

function auditBlobPath(src, iso) {
  const d = new Date(iso);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const safe = src.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}/${y}/${m}/${day}/ingest.ndjson`;
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}
