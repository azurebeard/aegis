# ADR-0021 — Agent audit-log extension

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0015 defined the per-`(source, tenantId)` hash-chained NDJSON audit log — one line per ingest run, JCS-canonical form + SHA-256, genesis sentinel, `audit.chain.start` boundary marker for forward-only migration, `ingest.audit.repair` on write-gap. Step 4's Incidents ingest uses it; step 3's Secure Score migrated onto it via `scripts/write-audit-chain-boundary.mjs`.

Step 5 adds **agent runs** as a new class of audit event. This ADR extends the audit surface to cover `brief-agent` invocations (and, additively, the step-7 specialists) **without breaking the ADR-0015 chain invariants**: same hash-chain model, same writer-singleton constraint, same forward-only migration.

The concerns this ADR settles:

1. **Chain keying.** Does `agent.aegis.brief` live on the same `(source, tenantId)` chain as `graph.security.incidents`, or does it get its own chain?
2. **Line schema.** What fields go on an `agent.run` audit line beyond ADR-0015's chain primitives — matching ADR-0019 §Decision.5's `AgentFetchError` kinds + ADR-0020's `outputSha256` requirement.
3. **Writer singleton preservation.** ADR-0015 requires the audit MI be the **only** writer to the audit blob. ADR-0017 gave the agent MI its own identity — does the agent MI write directly, or does the audit MI still own the append?
4. **Cost-telemetry fields.** Tokens, duration, model deployment — recording billable metadata on every run for forensic cost analysis.
5. **Verifier coverage.** Does `scripts/verify-audit-chain.mjs` Just Work on agent lines, or does it need an update?
6. **Cache-hit audit semantics.** Agent cache hits (ADR-0022) — audit them or suppress?
7. **Secret-scrubbing.** Ensure no cross-agent secrets leak into the audit line (output hashes not prose, redaction of prompt-injection candidates if they would otherwise appear in an error message).

## Decision

### 1. Chain keying — one chain per `(agent.aegis.<name>, tenantId)`

Each agent gets its **own source string** for the chain: `agent.aegis.brief` for `brief-agent`, future `agent.aegis.posture` / `agent.aegis.incidents` / `agent.aegis.stack` for step 7. The chain is keyed on `(source, tenantId)` exactly as ADR-0015 §4 specifies — reusing the existing primitive, not inventing a new one.

Rationale:

- **ADR-0015 §4 rationale applies directly.** "Two ingest handlers in the same Function App may race appends to the same daily blob. If they shared a chain, the loser of the race would compute `prevLineSha256` against a line the winner has not yet read, producing false-positive mismatches on every concurrent write." Agent runs race against each other AND against ingest runs; per-source chains remove the coupling.
- **Per-agent keying preserves auditor ergonomics.** `verify-audit-chain.mjs --source agent.aegis.brief --tenant <t>` verifies the brief-agent chain independently. An operator investigating the brief-agent's behaviour doesn't have to parse ingest-run lines interleaved in the same chain.
- **`graph.security.*` and `agent.aegis.*` namespacing** reserves `graph.*` for upstream-service origin and `agent.aegis.*` for agent invocations. Future human-originated audit events (e.g. operator manual corrections, secret rotations) would take a third prefix.

**Chain initialisation.** First `agent.aegis.brief` line per tenant starts the chain fresh — `prevLineSha256 = genesisSentinel("agent.aegis.brief", tenantId)`. No `audit.chain.start` boundary marker is required because the chain has no pre-chain (`schemaVersion: 1`) lines to land a boundary between (ADR-0015 §3a's boundary marker is specifically for forward-only migration from v1 to v2 — not needed for sources that are v2 from day one).

**`IngestHealth` row initialisation for new agent sources (WS10 SEC-L discipline).** The orchestrator's `runBriefAgent` path calls the same `getOrInitHealthRow` helper ingest handlers use (ADR-0011 §5a). On first call per `(tenantId, agent.aegis.brief)`, the helper creates a row with `LastAuditSeq = 0`, `LastLineSha256 = ""` — which `resolvePrevLineSha256` correctly maps to the salted genesis sentinel for this source (ADR-0015 §3 + auditChain.ts). No special-case initialisation is needed; the chain bootstraps identically to any new ingest source.

**Audit blob filename for agent sources — `agent-run.ndjson` (WS10 SEC-M-ADR-21-03 resolution).** The existing ingest-side `audit.ts` uses path `<audit-container>/<source>/<yyyy>/<mm>/<dd>/ingest.ndjson`. Agent-run lines MUST NOT land in a file named `ingest.ndjson` — the filename is operator-visible metadata and mislabelling agent writes as "ingest" defeats the single-glance-recognisable audit-surface discipline. Agent sources use **`agent-run.ndjson`** as the terminal filename; the path builder in `api/src/lib/audit.ts` selects the filename based on source prefix: any source starting with `agent.` uses `agent-run.ndjson`; everything else uses `ingest.ndjson` (backwards-compatible with existing ingest chains). The verifier (§Decision.5) discovers either filename on its prefix walk.

### 2. Line schema — `eventType = "agent.run"` extending `AuditLineFields`

A new `eventType` value: `"agent.run"`. The existing v2 `AuditLineFields` interface in `api/src/lib/audit.ts` (ADR-0015) gets additional optional fields that are populated ONLY when `eventType === "agent.run"`. Legacy `ingest.run` lines remain unchanged.

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `2` (unchanged) | |
| `eventType` | `"agent.run"` | Distinct from `ingest.run` / `audit.chain.start` / `ingest.audit.repair`. |
| `source` | `"agent.aegis.brief"` (+ future agents) | Chain-keying source. |
| `seq` | number | Per-chain monotonic (ADR-0015 §5). |
| `runId` | GUID | Orchestrator correlation ID. |
| `tenantId` | string | |
| `startedAt` / `endedAt` | ISO8601 UTC | Wall-clock. |
| `status` | `success \| no_data \| error` | `no_data` when the agent returned an empty-but-successful response. |
| `agentName` | `"brief"` (+ future specialists) | Maps to the adapter module. Enum; validated against a static allow-list in the audit writer. |
| `modelDeployment` | `"aegis-small"` | Always the allow-listed deployment name (ADR-0018 §Decision.1). A value NOT in `["aegis-small"]` triggers chain-verification review (the audit surface is itself the evidence that the forbid-fallback invariant holds — ADR-0018 §Decision.3). |
| `tokensIn` / `tokensOut` | number | Foundry-reported billed counts; `0` on budget-refused or circuit-open paths. |
| `durationMs` | number | Wall-clock duration (includes Foundry time + orchestrator overhead). |
| `retryAttempts` | number | |
| `outputSha256` | string (64 hex chars) \| null | SHA-256 of the persisted brief body (the content written to the `daily-briefs` blob per ADR-0022). `null` on error / refused runs. **Not the same as `lineSha256`** — `outputSha256` commits the brief content for forensic comparison; `lineSha256` commits the audit line's canonical form. **Read-path verification is mandatory (WS10 SEC-M-ADR-21-01 resolution):** `GET /api/brief/latest` MUST SHA-256 the blob body on every read and compare against the chain's recorded `outputSha256` for the latest `(source, tenantId)` `status="success"` or `status="no_data"` `agent.run` line. Mismatch classifies as `AgentReadError(kind: "output_tamper")`, emits a `BriefOutputTamperCandidate` App Insights custom event with `runId`, `expected` hash, `actual` hash, and blob modification time, and responds to the SPA with `status="unavailable"` (per ADR-0018 §Decision.5 ceiling path). Agent MI has `Storage Blob Data Contributor` on `daily-briefs`; a post-write overwrite of a blob whose chain line has already committed would otherwise serve forged content while the audit chain retained the legitimate hash. Read-path verification closes that gap. |
| `cacheOutcome` | `"miss" \| "hit" \| "stale_hit" \| "no_cache" \| null` | See §6 below. |
| `promptInjectionCandidates` | number | Count of denylist matches the prompt sanitiser redacted (ADR-0020 §Decision.4 layer c). 0 on clean runs. |
| `sourceFabrications` | number | Count of sources the model claimed in `sourcesUsed` but the builder did not include (ADR-0020 §Decision.2 subset-check). Non-zero surfaces via `SourceFabricationCandidate` event AND is cross-visible on the audit line. |
| `callerPrincipalMiClientId` | `<audit MI client ID>` | Unchanged from ADR-0015 §1. |
| `error` (optional) | `{ kind: AgentFetchErrorKind, message: string }` | `message` truncated to 2000 chars. `kind` is ADR-0019 §Decision.5 enum. |
| `prevLineSha256` / `lineSha256` | (unchanged ADR-0015 chain primitives) | |

**NOT on the audit line:**

- **Prompt text / model output text.** The agent's actual prompt and response never touch the audit log. Output content lives in the `daily-briefs` blob (ADR-0022); prompt content is ephemeral (re-built deterministically from the ops store on demand). `outputSha256` is the only commit to the output; the audit line is proportional to the run's metadata, not its payload.
- **Upstream prose fields.** No `displayName`, no `description`, no Microsoft-authored text. The audit log is operator-visible and prose leaking into it re-exposes the Microsoft-content rendering surface that the ADR-0012 §5 plain-text-only rule closes at the UI layer.
- **Secrets.** No tokens (MSI or otherwise), no KV references, no client secrets, no Entra object IDs beyond the operator-owned MI client IDs already in app settings.
- **Tenant-user PII.** ADR-0006 audit log is a security-operator-visible surface; tenant-user identifiers (e.g. `assignedTo` from an incident) stay in the operational store + detail blob, not the audit. This ADR reiterates that rule for agent lines.

### 3. Writer-singleton preservation — audit MI remains the sole writer

The **audit MI** (`id-aegis-audit-<env>-<region>`) is the only identity with `Storage Blob Data Contributor` on the `audit` container. The agent MI has NO write access to the audit container.

The `runAgent` orchestrator **calls through the existing `appendAuditLine` helper** in `api/src/lib/audit.ts` — the same code path ingest handlers use today. That helper authenticates as the audit MI via `DefaultAzureCredential({ managedIdentityClientId: config.auditMiClientId })` and performs the append.

**Why preserve the single-writer invariant:** ADR-0015's chain invariants rest on the assumption that "the writer is trusted" (ADR-0015 §Alternatives "HMAC with a shared secret" section). If two identities write to the same chain, then a compromise of either identity can forge lines the verifier cannot distinguish from legitimate. A single-writer audit MI with narrow RBAC (append-only on the audit container) gives the chain a single root of trust; multiple writers undo that.

The agent MI's role is **read-only on upstream** (ops store, Table rows for prompt building) + **read/write on the `daily-briefs` cache container only** (ADR-0022). The audit append is done by the audit MI, acting on behalf of the agent run.

### 4. Cost-telemetry + forensic surface

The `tokensIn` / `tokensOut` / `modelDeployment` fields on every agent line give the operator a per-run cost trail that complements (not duplicates) the Azure-billing-plane view (ADR-0017 §Decision.8.3). An operator investigating a billing anomaly can:

1. KQL against the `audit` blob — list all agent runs in the last 30 days with `tokensIn + tokensOut`, sorted.
2. Compare to the App Insights `AgentRun` custom events emitted in real time by the orchestrator.
3. Compare to the Azure Cost Management billing line for the AI Services account.

A mismatch between the chain (audit line tokens) and the billing plane (Cost Management) is a signal — either an accounting bug or an out-of-orchestrator Foundry call bypassed the chain. Neither is expected; both would be investigated via the chain's `modelDeployment` field + the Azure Policy `aegis-foundry-model-sku-allowlist` (ADR-0018 §Decision.1) restricting what deployments can exist.

### 5. Verifier coverage

`scripts/verify-audit-chain.mjs` is already chain-source-agnostic — it takes `--source` as a parameter and verifies any chain by walking `(source, tenantId)` lines. No verifier change is required for agent lines.

**New verifier assertions for `eventType === "agent.run"` lines — invariant-integrity checks, NOT warnings (WS10 SEC-H-ADR-21-01 resolution):**

- `modelDeployment ∈ ["aegis-small"]` — tampering that flipped this to a gpt-5 SKU would be caught even if the line's hash verified.
- `status ∈ {"success", "no_data", "error"}` — strict enum check.
- `agentName ∈ ["brief"]` (+ future specialists as their ADRs extend this list).
- `error` field present iff `status === "error"`.
- `outputSha256` format: 64-char lowercase hex or null.
- `tokensIn >= 0 && tokensOut >= 0`.

**Verifier exit codes — two-dimensional failure signal:**

- **Exit 0** — chain is clean AND all invariant-integrity assertions above pass.
- **Exit 1** — **chain-integrity** failure (hash mismatch, seq gap, malformed `prevLineSha256`, bad genesis). Same as ADR-0015 §7 semantics.
- **Exit 2** — **invariant-integrity** failure (any of the agent.run assertions above; or a future per-source invariant from another agent's ADR). Chain hashes verify but a line carries content that violates a locked invariant — for `modelDeployment`, this is the audit-side evidence that ADR-0018 §Decision.3's forbid-fallback held. A warning-only verifier would void that evidence against a compromised-writer threat; a hard fail is the correct operator signal.

Both non-zero exit codes are equally severe — the operator investigates either. The split lets runbook KPIs distinguish "someone tampered with the chain" from "someone wrote a line that violates a policy invariant" without conflating them. The verifier extension lands in step 5 Phase 3 code pass as `scripts/verify-audit-chain.mjs` is updated to parse the extended schema AND the per-source invariant list (registered at verifier-init time; expanded via ADR addendum on each future agent).

### 6. Cache-hit audit semantics

Agent cache hits (ADR-0022 cache-read path) are audited with `eventType = "agent.run"` and:

- `status = "success"`
- `tokensIn = 0`, `tokensOut = 0`
- `cacheOutcome = "hit"` (or `"stale_hit"` if the cache was served past freshness but before the staleness ceiling; ADR-0022 defines thresholds)
- `durationMs` = cache-read time
- `outputSha256` = hash of the cached body returned
- `retryAttempts = 0`

**Why audit cache hits** — ADR-0015 §3a rationale: the audit log is the single source of truth for "what the operator saw and when." If a cache hit serves a brief to the SPA, that served brief is what the operator acted on; forensically, we want the audit chain to commit the same `outputSha256` the operator was shown. Suppressing cache hits would create a gap: an operator's memory of "I saw the brief at X" could not be matched to any audit entry.

**Cost of auditing cache hits:** one Table Storage append per cache-serve, which is pennies per month at v1 scale. The chain's growth per day is bounded by SUM of agent runs + cache serves + manual-trigger invocations — a handful of entries per day per tenant. Well below any audit-blob retention concern.

**Cache-miss audit:** when the cache contains nothing (first-ever read, or post-retention-trim), the read endpoint triggers `runBriefAgent` if appropriate. The audit line for the run records `cacheOutcome = "miss"`. A read endpoint that doesn't trigger an agent run (because outside the fresh window + the endpoint is read-only) records `cacheOutcome = "no_cache"` and `status = "no_data"`.

### 7. Secret-scrubbing + PII discipline

Every audit writer call in the agent path passes the candidate line object through a **scrub function** before `computeLineSha256`. The scrub is **prototype-pollution-resistant** (WS10 SEC-M-ADR-21-02 resolution — uses `Object.create(null)` as the output target so inherited Object.prototype properties cannot leak into the chain input; uses `Object.hasOwn` instead of `in` or the unsafe iteration pattern):

```typescript
function scrubAgentLine(line: AgentAuditLineInput): AgentAuditLineInput {
  // Reject any input whose prototype chain is not Object.prototype —
  // a JS Proxy, a prototype-polluted object, or an instance of an
  // arbitrary class would otherwise expose inherited properties.
  const proto = Object.getPrototypeOf(line);
  if (proto !== Object.prototype && proto !== null) {
    throw new ChainError(
      "internal",
      `scrubAgentLine rejected non-plain input (prototype=${proto?.constructor?.name ?? "unknown"})`,
    );
  }
  // Build the output with a null-prototype object — inherited props can't leak.
  const out: Record<string, unknown> = Object.create(null);
  const allowed = new Set<string>([...CHAIN_KEYS, ...AGENT_RUN_KEYS]);
  for (const key of Object.keys(line)) {
    if (!Object.hasOwn(line, key)) continue;   // paranoia: skip inherited
    if (!allowed.has(key)) continue;           // positive-match allow-list
    out[key] = (line as Record<string, unknown>)[key];
  }
  // Truncate error messages + redact credential-pattern leaks (WS10 SEC-L).
  if (isErrorShape(out.error)) {
    let msg = out.error.message ?? "";
    if (msg.length > 2000) msg = msg.slice(0, 2000);
    // Strip common credential patterns that could leak from upstream
    // exception text (connection strings, bearer tokens, SAS signatures).
    msg = msg
      .replace(/AccountKey=[^;]+/gi, "AccountKey=[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/sig=[A-Za-z0-9%_-]+/gi, "sig=[REDACTED]")
      .replace(/(api[-_]?key|password|secret)=[^\s&;]+/gi, "$1=[REDACTED]");
    out.error = { ...out.error, message: msg };
  }
  return out as AgentAuditLineInput;
}
```

The scrub is **positive-match + null-prototype + credential-pattern-redacted** (matches §Decision.1 rationale from ADR-0020): new fields don't silently reach the audit line, prototype pollution cannot smuggle inherited properties, and upstream exceptions that carry credential fragments get redacted before they become immutable chain content. WS10 reviews the `AGENT_RUN_KEYS` set on every future agent ADR.

## Consequences

### Positive

- **ADR-0015 invariants preserved intact.** Same chain-keying pattern, same writer-singleton audit MI, same hash-chain primitives. The verifier works unchanged.
- **Cache-hit auditing** keeps the audit chain as the single source of "what the operator saw," not just "what the LLM did."
- **`outputSha256` on every run** — forensic comparison of the chain to the `daily-briefs` blob content.
- **Positive-match scrub** — schema drift doesn't leak new fields into the audit line silently.
- **Per-agent source keying** — `verify-audit-chain.mjs --source agent.aegis.brief` verifies the agent's chain independently of ingest chains.

### Negative / trade-offs

- **Chain growth per day** increases with agent runs + cache hits. At v1 scale (single-user, daily brief + ~10-30 reads) this is ~30 lines/day per tenant — trivial.
- **No prose on the audit line** means a chain-walker can't reproduce the narrative text — they must cross-reference `outputSha256` to the blob. Accepted: the chain is operational telemetry, not the content store.
- **`promptInjectionCandidates` / `sourceFabrications`** are counters, not redacted field lists. An operator investigating MUST go to App Insights to see the actual redacted content. Accepted: keeping prose off the chain is more important than investigation ergonomics.

### Neutral

- **Future step-7 specialists** extend the `agentName` enum + `AGENT_RUN_KEYS` set. Each specialist's ADR amends this ADR's Decision §2 table (or supersedes a specific row).
- **RFC 8785 JCS library (`json-canonicalize`)** is already locked as the canonicalisation primitive (ADR-0015 §2). No new dependency.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **One big chain across all sources + agents** | Broken by ADR-0015 §4 concurrency rationale (two writers race). Per-`(source, tenantId)` is the right keying. |
| **Agent MI writes directly to the audit container** | Breaks ADR-0015 writer-singleton invariant. A second writer on the chain means the chain's integrity argument weakens from "evidence of a single writer's monotonicity" to "evidence that SOMEONE in a set of writers produced a coherent sequence" — verifier can no longer distinguish tamper from a second legitimate writer. |
| **Include full prompt + response in audit line** | Re-exposes the Microsoft-content rendering surface; bloats the chain; leaks potential PII / secrets from prompt context into a long-retention immutable log. `outputSha256` plus the blob is the right commitment. |
| **Drop cache-hit audit** | Creates the "what did the operator see" gap described in §Decision.6. Small cost; large forensic value. |
| **Separate agent audit blob / container** | Unnecessary complexity. The audit container holds a growing collection of `(source, tenantId)` chains — agent sources are additive. |
| **Verifier changes required for new source** | Not required: the verifier is source-agnostic (ADR-0015 §7). Additional assertions are a step 5 Phase 3 enhancement, not a breaking change. |
| **Store `error.message` verbatim with no truncation** | Upstream exceptions may carry prose + details that re-expose Microsoft content + potentially reach PII in edge cases. 2000-char cap is the same as ADR-0019 §Decision.5 and preserves enough context to diagnose. |

## Related

- `PROJECT_BRIEF.md §4` — Audit log (append-only, retention-governed) — this ADR is the agent-side extension
- `PROJECT_BRIEF.md §9` — Security posture (audit log WORM)
- ADR-0006 — Data stores (audit blob container + WORM in prod)
- ADR-0011 §7 — Audit log pattern (pre-chain surface)
- ADR-0015 — Audit hash chain (primitive) — this ADR extends, does not supersede
- ADR-0017 — Foundry identity + region
- ADR-0018 — Model tiering (deployment-name invariant audited on every line)
- ADR-0019 — Orchestrator + budget (consumes `AgentFetchErrorKind`; ADR-0020 §Decision.6 non-determinism + `outputSha256` are concrete audit-chain consumers)
- ADR-0020 — `brief-agent` contract (consumer of `agent.aegis.brief` source)
- ADR-0022 (pending) — Daily-brief cache + read contract (consumer of §Decision.6 cache audit)
- RFC 8785 — JCS canonicalisation

---

*End of ADR-0021.*
