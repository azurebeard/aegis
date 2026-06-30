# ADR-0019 — Agent orchestrator pattern and token-budget enforcement

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0017 locked the Foundry project shape and a dedicated agent MI. ADR-0018 locked the default small-model SKU (`gpt-4.1-mini` as `aegis-small`) and the forbid-fallback posture. This ADR settles **how the orchestrator composes agents, how it bounds cost, how it handles failure**, and **how each agent invocation is routed, timed out, and attributed to a budget**.

Step 5's scope introduces a single specialist (`brief-agent`, ADR-0020) behind an orchestrator. Step 7 adds three more specialists (`posture-agent`, `incidents-agent`, `stack-agent`). The orchestrator must be small and boring — a router with guards — not a place where business logic accumulates.

The concerns this ADR settles:

1. **Router shape** — how the orchestrator receives a request, picks a specialist, and returns a response.
2. **Budget enforcement** — per-agent per-day token budget under an optimistic lease, matching the `IngestHealth` ETag pattern (ADR-0011 §5a).
3. **Budget breach as a security control** — how the three-plane forbid-fallback enforcement (ADR-0018 §Decision.3) is concretely wired into the client.
4. **Timeout, retry, circuit-breaker** — per-call ceilings aligned with the Flex Consumption 10-minute max + Timer cadence.
5. **Error classification** — `AgentFetchError` kind enum, audit-line schema, and App Insights custom-event shape.
6. **Where the orchestrator DOESN'T route** — explicit non-surfaces that v1 won't touch (cross-agent delegation, tool-calling beyond ops-store reads, multi-turn conversational memory beyond Foundry thread defaults).

## Decision

### 1. Thin-router pattern — three concrete functions

The orchestrator is a handful of pure + thin wrapper functions in `api/src/lib/agentClient.ts` and `api/src/lib/runAgent.ts`. No plug-in system, no dynamic registry, no reflection.

- `agentClient.ts` owns the Foundry SDK glue + budget check + retry + classification. Pure TypeScript with one `@azure/ai-projects` dependency. No business logic.
- `runAgent.ts` is the orchestration layer: given a registered agent config, builds a thread, submits the prompt, polls the run, returns a `AgentRunOutcome`. Pure TypeScript; no I/O beyond the Foundry calls and the budget-row read/write.
- Each specialist has its own **adapter** module (e.g. `api/src/lib/runBriefAgent.ts`) that builds the prompt deterministically, calls `runAgent.ts`, and persists results. This is the Mission-handler pattern — one adapter per vertical.

No "plug-in specialists at runtime" — all registered statically at module load. No dynamic `import()` of agent configs. A new specialist means a new adapter module + an ADR; no config-driven agent spawning.

Rationale:

- **Blast radius.** A router that only knows about statically-registered specialists cannot be induced (via prompt injection or config drift) to invoke an unknown agent or escalate to a larger model.
- **Audit visibility.** Each adapter emits an audit-line with a fixed `eventType` per specialist (ADR-0021). A dynamic registry would force the audit parser to allow unknown event types — a straightforward way for a compromised writer to smuggle unclassifiable lines into the chain.
- **Deterministic first.** `PROJECT_BRIEF.md §5` rules: agents run only when (a) user asks, (b) a scheduled job fires, or (c) a high-priority signal needs enrichment. The three triggers are all ADR-specified code paths — no generic "user sent the orchestrator a prompt, please decide what to do with it" surface.

### 2. Budget enforcement — `AgentBudget` table row, ETag lease

**Two-plane cost control** (WS10 SEC-L-ADR-19-02 resolution — framed explicitly for the next operator):

- This ADR's `AgentBudget` row is the **code-plane** bound — refuses agent calls BEFORE they hit Foundry.
- ADR-0017 §Decision.8 pre-commits the **Azure-billing-plane** bounds — subscription-scope Cost Management budget (§.8.1), RG-scope Azure Policy deny on non-Standard SKUs (§.8.2), App Insights anomaly alert at 3× daily budget over 1h (§.8.3). These bound cost AFTER calls land on the billing surface.

Both planes are load-bearing. A bug in this ADR's reservation logic that over-releases tokens to the budget would still be caught by the Azure-plane 3× anomaly alert. Conversely, a Foundry-side accounting bug that under-reports tokens to the Azure-billing plane is still bounded by the code-plane budget refusal.

A new Table `AgentBudget` on the ops storage account, per `(tenantId, yyyy-mm-dd)` row:

| Column | Type | Notes |
|---|---|---|
| `PartitionKey` | `<tenantId>` | |
| `RowKey` | `<yyyy-mm-dd>` (UTC) | Per-day bucket. |
| `TokensInToday` | int | Sum of `tokensIn` across all agent runs for the day. |
| `TokensOutToday` | int | Sum of `tokensOut` across all agent runs for the day. |
| `TokensBudget` | int | Per-day ceiling (default 50,000; env-configurable via `BRIEF_DAILY_TOKEN_BUDGET`). |
| `RunsDailyCeiling` | int | Per-day maximum run count (default 200; env-configurable via `BRIEF_DAILY_RUN_CEILING`) — complements the token budget so a successful-prompt-injection max-tokens grind is bounded on both the token AND the call count axis. WS10 SEC-M-ADR-19-04 resolution. |
| `RunsAttempted` | int | All attempts, including failures. |
| `RunsSucceeded` | int | |
| `RunsFailedBudget` | int | Attempts refused due to budget exceeded. |
| `RunsFailedContentFilter` | int | Attempts refused by Foundry content filter. |
| `RunsFailedRateLimit` | int | Attempts refused due to `RunsDailyCeiling` (WS10 SEC-M-ADR-19-04). |
| `ReservationTokensIn` | int | Provisional reservation from the current in-flight run's pre-call write (§Decision.2 step 3). Set at reserve; cleared by reconcile. |
| `ReservationTokensOut` | int | Provisional reservation (ditto). |
| `ReservationRunId` | string \| null | `LastRunId`-equivalent for the reservation; null when no reservation outstanding. |
| `ReservationExpiresAt` | ISO8601 UTC \| null | TTL of the outstanding reservation. Default: `reservedAt + 10min` (covers Flex Consumption's max function timeout). A reconcile arriving after this deadline MUST NOT overwrite the row; a later call whose reserve-step sees a stale reservation (past `ReservationExpiresAt`) treats it as abandoned and sweeps the leaked tokens back. WS10 SEC-M-ADR-19-01 resolution. |
| `LastRunId` | string | For correlation in audit log. |
| `UpdatedAt` | ISO8601 UTC | |

**Commit-then-call lease pattern** (mirrors ADR-0011 §5a IngestHealth, with reservation-TTL sweep added per WS10 SEC-M-ADR-19-01):

1. `runAgent` reads the day's row under ETag (creates on first call). Determine `reservationRowKey = <yyyy-mm-dd at runStartUtc>` — this value is **pinned on the run context** and used for BOTH the reserve and the reconcile (WS10 SEC-M-ADR-19-02 resolution). If UTC midnight rolls during the run, the reconcile still lands on the original day's row; a separate compensating entry credits the new day's row with `0` (recording the split for auditability without double-charging).
2. **Reservation sweep on read.** If the row has a non-null `ReservationExpiresAt` and `now > ReservationExpiresAt`, treat the outstanding reservation as abandoned (process-death / SIGKILL / connection-reset between reserve and reconcile). Subtract `ReservationTokensIn` + `ReservationTokensOut` from `TokensInToday` / `TokensOutToday`, clear the three `Reservation*` columns, and emit `AgentReservationSwept` (App Insights custom event with the abandoned `runId`). Then proceed to the budget check.
3. If `(TokensInToday + TokensOutToday + estTokens) > TokensBudget`, **refuse** with `AgentFetchError(kind: "budget_exceeded")`. If `RunsAttempted >= RunsDailyCeiling`, refuse with `AgentFetchError(kind: "rate_limit_daily")` (WS10 SEC-M-ADR-19-04 resolution). No Foundry call, no thread creation.
4. If within budget, compute a **provisional reservation** `reservedIn = estInTokens`, `reservedOut = maxOutTokens`. Write back the row with `TokensInToday += reservedIn`, `TokensOutToday += reservedOut`, `ReservationTokensIn = reservedIn`, `ReservationTokensOut = reservedOut`, `ReservationRunId = runId`, `ReservationExpiresAt = now + 10min` under `IfMatch`. 412 → another instance raced us → retry the whole sequence once; second 412 → refuse with `AgentFetchError(kind: "lease_contended")`.
5. Issue the Foundry call.
6. On response, **reconcile against `reservationRowKey`** (NOT a fresh "today" lookup): read the row again (fresh ETag), replace the reservation with actuals (`TokensInToday = previous + actualIn - reservedIn`, same for out), clear the three `Reservation*` columns (set `ReservationExpiresAt = null`). `IfMatch`. 412 → log + best-effort merge (a concurrent reservation from another agent may have advanced the counter; merge preserves monotonicity).

The **pessimistic reservation + TTL sweep** closes two races together: (a) the concurrent-call double-dip that pure-optimistic allows; (b) the process-death leak where a reserved-but-never-reconciled call would permanently encumber the budget.

**Pre-call estimation heuristic.** `estInTokens = prompt.length / 3.5` (English-text heuristic); `maxOutTokens` is passed as the Foundry `max_completion_tokens` field (hard-capped at a per-adapter constant, e.g. 2,000 for `brief-agent`). The Foundry SDK rejects any configuration that would allow an open-ended response.

**Budget source of truth.** `BRIEF_DAILY_TOKEN_BUDGET` app setting sets `TokensBudget` at row-creation time (write-once). An operator who wants to raise the budget mid-day must either (a) wait until tomorrow (new row on new UTC date), or (b) explicitly edit the Table row (auditable via the audit chain per ADR-0021).

### 3. Three-plane forbid-fallback enforcement (ADR-0018 §Decision.3)

Three independent gates; ADR-0019 wires (b) and (c):

- **(a) Azure Policy `aegis-foundry-model-sku-allowlist`** — enforced by the Azure control plane. Declared in `infra/modules/ai-foundry.bicep` (step 5 Phase 2). Covered by ADR-0017 §Decision.8 + ADR-0018 §Decision.1.

- **(b) `agentClient.ts` boot-time assertion** — this ADR's scope. On first `AgentClient` construction (at Function App cold-start), the client validates every registered adapter's `modelDeployment`:

  ```typescript
  const ALLOWED_DEPLOYMENTS: readonly string[] = ["aegis-small"];

  if (!ALLOWED_DEPLOYMENTS.includes(config.briefModelDeployment)) {
    throw new ConfigError(
      `forbidden model deployment: ${config.briefModelDeployment}`,
    );
  }
  ```

  Surface: 503 on the first read endpoint fire + failed Timer invocation, visible in App Insights. The allow-list extends by **explicit ADR amendment** as each new specialist lands — no runtime registration.

- **(c) Per-invocation check inside `runAgent`** — this ADR's scope. Before `client.agents.createAgent({ model: <name>, ... })`:

  ```typescript
  if (!ALLOWED_DEPLOYMENTS.includes(params.modelDeployment)) {
    throw new AgentFetchError(
      "forbidden_deployment",
      `forbidden deployment in runAgent: ${params.modelDeployment.slice(0, 64)}`,
    );
  }
  ```

  Surface: `AgentFetchError(kind: "forbidden_deployment")` — a dedicated kind (§Decision.5) so audit review can distinguish this security-control refusal from ordinary `internal` errors (WS10 SEC-L-ADR-19-01 resolution). The full deployment name is truncated to 64 chars and logged via `context.log` (string-interpolation injection hygiene — the deployment name is operator-controlled config, but truncation + no shell/SQL contexts makes this a hygiene check, not a vulnerability).

The two layers are independent: (b) catches misconfiguration at boot; (c) catches in-flight adapter mistakes where a specialist-level config drifts or is mutated. A deploy that bypasses one still faces the other.

### 4. Timeout, retry, circuit-breaker

**Timeout hierarchy** (outer to inner):

- **Function App invocation** — Flex Consumption default 10 min. `host.json` `functionTimeout` left at default for `runBriefAgent` Timer; the orchestrator's job is to finish well inside this.
- **Single agent run wall-clock** — per-adapter constant, default 180 s for `brief-agent`. Enforced via `setTimeout` around the `pollRun` loop; on expiry the client emits `AgentFetchError(kind: "timeout")` and cancels the run via `client.agents.runs.cancel()` (Foundry-side cancellation; best-effort, don't wait on it).
- **Single Foundry HTTP call** — SDK default (30 s); not overridden.
- **Graph call** — not applicable; the agent does not call Graph.

**Retry policy** — aligned with `graphClient.ts` (ADR-0011 §5):

- 3 attempts maximum.
- Full-jitter exponential backoff (base 2 s, cap 30 s).
- Retry on: `throttle` (429), `5xx`, `network`, `timeout`.
- Non-retry: `4xx` (except 429), `content_filter`, `budget_exceeded`, `forbidden deployment` (§3 point c).
- `Retry-After` honoured + clamped to the smaller of (outer-wall-clock remaining − 5 s) and 30 s.

**Circuit breaker** — persisted on a **new `AgentHealth` table**, NOT on the per-day `AgentBudget` row (WS10 SEC-M-ADR-19-03 resolution: UTC-day reset on the budget row would re-arm the circuit every midnight, giving a persistent-outage + low-rate-attacker a free daily retry). `AgentHealth` schema:

| Column | Type | Notes |
|---|---|---|
| `PartitionKey` | `<tenantId>` | |
| `RowKey` | `<agentName>` | e.g. `brief` — ONE row per agent, spanning all days. |
| `State` | `closed \| open \| half_open` | Circuit state. |
| `ConsecutiveFailureCount` | int | Rolling; not reset by day-roll. |
| `OpenedAt` | ISO8601 UTC \| null | When the breaker last opened. |
| `CoolDownUntil` | ISO8601 UTC \| null | Earliest time the breaker becomes `half_open`. Default 10 min after `OpenedAt`. |
| `LastProbeAt` | ISO8601 UTC \| null | Last `half_open` probe attempt. |
| `LastSuccessAt` | ISO8601 UTC \| null | Closes the circuit on success. |

**State transitions:**

- `closed` → `open` when `ConsecutiveFailureCount >= 5`. Record `OpenedAt`, `CoolDownUntil = OpenedAt + 10min`. Emit `AgentCircuitOpened`.
- `open` → `half_open` when `now >= CoolDownUntil`. Record `LastProbeAt = now`. Allow **one** Foundry call through (the probe); any additional call during `half_open` is rejected with `AgentFetchError(kind: "circuit_open")`.
- `half_open` → `closed` on probe success. Record `LastSuccessAt`, clear `ConsecutiveFailureCount`, `OpenedAt`, `CoolDownUntil`, `LastProbeAt`.
- `half_open` → `open` on probe failure. Increment `ConsecutiveFailureCount`, set new `OpenedAt` + `CoolDownUntil` with exponential back-off (cap at 4 hours).

The breaker now outlives UTC day-rolls: a genuine Foundry outage that spans midnight stays open until the cooldown elapses AND a probe succeeds. A persistent attacker who brute-forces the breaker to re-open is surfaced via the `AgentCircuitOpened` App Insights alert + the exponential back-off, which moves the cost of re-attack up geometrically. At v1 scale the runbook response is manual — no auto-recovery step past the probe.

### 5. Error classification + audit schema

**`AgentFetchError` kind enum:**

```typescript
export type AgentFetchErrorKind =
  | "timeout"              // wall-clock expiry; retryable
  | "throttle"             // Foundry 429; retryable
  | "content_filter"       // Foundry content filter; non-retryable
  | "budget_exceeded"      // §2 token budget check refused the call
  | "rate_limit_daily"     // §2 RunsDailyCeiling refused the call (WS10 SEC-M-ADR-19-04)
  | "lease_contended"      // ETag 412 twice on budget row
  | "circuit_open"         // §4 circuit breaker refused
  | "authorization"        // Foundry 401/403 for MI-auth failure (distinct from 4xx); non-retryable (WS10 SEC-L-ADR-19-01)
  | "4xx"                  // Foundry 400 / other-non-auth 4xx; non-retryable
  | "5xx"                  // Foundry 500/502/503/504 after retries
  | "network"              // connection / DNS / abort; non-retryable after 3 tries
  | "dependency_unavailable" // Foundry project unreachable (preceding category applied)
  | "forbidden_deployment" // §3 point c refused; dedicated kind for security-control audit
  | "internal";            // catch-all; MUST be accompanied by a structured log line
```

`authorization` is carved out of the generic `4xx` kind because MI-auth failures have a distinct operator runbook (check MI role assignments, restart Function App to flush IMDS cache — HANDOVER §6.2 pitfall 21) and shouldn't be conflated with model-request malformations (400) or content-filter refusals (distinct kind above).

**Audit-line schema extension** (ADR-0021's concrete surface): `eventType = "agent.run"` with the following fields beyond the ADR-0015 chain primitives:

| Field | Source | Notes |
|---|---|---|
| `agentName` | `brief`, `posture`, `incidents`, `stack` | Enum; matches the adapter module. |
| `modelDeployment` | `"aegis-small"` | Always the allow-listed name. |
| `tokensIn` / `tokensOut` | Foundry response | `0` on budget-refused / circuit-open. |
| `durationMs` | Wall-clock | Includes Foundry time + orchestrator overhead. |
| `retryAttempts` | From retry loop | |
| `status` | `success \| no_data \| error` | `no_data` when the specialist returned an empty-but-successful response. |
| `error` (optional) | `{ kind, message }` | Message truncated to 2000 chars. |
| `threadId` | Foundry thread ID | Carried to correlate with Foundry-side telemetry if needed. |
| `runId` | GUID | Orchestrator-local correlation. |

### 6. Non-surfaces — what v1 explicitly does NOT do

Listed so the next ADR author doesn't have to re-derive:

1. **Cross-agent delegation.** A specialist cannot invoke another specialist. The orchestrator is the only caller; specialists return results.
2. **Tool-calling beyond ops-store reads.** The `brief-agent` prompt includes pre-formatted ops-store snippets as context; the agent does NOT get tool-call permission to query Graph/Defender/Sentinel at run time. Adding tool-call support is an ADR-gated step that requires a separate data-residency + budget re-evaluation.
3. **Multi-turn conversation memory beyond Foundry thread defaults.** `brief-agent` is a single-shot generator; its thread is created, used once, discarded. A future chatbot-style feature would land as a new ADR with its own memory model (per-user conversation thread, explicit TTL, separate audit surface).
4. **Streaming responses.** Foundry supports streaming via SSE; the v1 orchestrator polls `runs.get` until terminal. Streaming is a future optimisation, not a correctness requirement.
5. **Orchestrator exposing a general `/api/agent/ask` endpoint.** Every agent invocation is through a specific adapter-backed endpoint (e.g. `/api/brief/latest`, `/api/ingest/brief/run`). No "raw prompt" surface.
6. **Cross-tenant agent state.** `AgentBudget` and `AgentHealth` rows are always partitioned on `<tenantId>`. No cross-tenant sharing of thread metadata, reservation state, or circuit state. An MSP multi-tenant flavour is an ADR-gated extension; v1 cannot be opted-in to cross-tenant sharing via config.
7. **Foundry vector store / file attachments.** `brief-agent` does NOT attach files, code interpreter blobs, or vector-store references to its threads. The prompt context is the deterministic context builder's output (ADR-0020), nothing more. A future RAG agent that wants vector-store attachments lands as its own ADR — vector stores are a persistence surface that ADR-0021's audit chain does not currently cover (adding them silently would break the audit-coverage invariant).
8. **Code Interpreter / tool executions inside Foundry.** The Foundry Agent Service supports an in-thread code-interpreter tool that executes Python against the prompt context. Explicitly OFF for every v1 agent — re-enables the arbitrary-compute surface that `PROJECT_BRIEF.md §5` "deterministic first, LLM last" is built to avoid. ADR-gated if a future agent has a genuine case.

## Consequences

### Positive

- **Static registration + allow-list** closes the attack surface where a compromised config could induce the orchestrator to invoke an unknown agent.
- **Pessimistic token reservation** closes the race where concurrent calls over-run the budget.
- **Circuit breaker** bounds cost of a persistent outage without requiring human intervention.
- **`AgentFetchError` kind enum** is small and audit-friendly — every kind maps to a specific operator response.
- **Non-surfaces enumerated** — future ADR authors know what to ADR-gate rather than quietly add.

### Negative / trade-offs

- **Reservation math is estimated.** `prompt.length / 3.5` undercounts on non-English / heavily-tokenised content; reconcile step merges the delta. Worst case: a single run exceeds the pre-call estimate by 2–3×, the reconcile reports the actuals, and the next run's budget check sees the updated total. Never exceeds the day's budget by more than one run's maximum output — acceptable at v1 scale.
- **Circuit breaker reset at UTC day-roll is coarse.** A genuine Foundry outage that spans a day-roll re-opens the circuit the next day even though the cause persists. Operator must check the App Insights alert; the breaker isn't self-diagnosing.
- **Budget row contention** at sustained high volume (multiple agents + multiple tenants) would serialise on the ETag lease. At single-user scale this is non-issue; at multi-user scale the row's partition/key scheme revisits in the multi-tenant ADR.

### Neutral

- **Retry policy alignment** with `graphClient.ts` keeps the ingest path and the agent path behaving similarly; operator runbooks for ingest apply to agents with minor translation.
- **Foundry thread cancellation on timeout** is best-effort; billed tokens up to the cancellation point are already in the reconcile. The audit line records the attempt regardless.
- **`content_filter` is non-retryable.** An agent that repeatedly trips content filter (e.g. because upstream Microsoft-authored prose contains text that matches a policy) falls through to cache-serve per ADR-0022's staleness ceiling; the `brief-agent` contract (ADR-0020) specifies how the prompt sanitiser minimises false-positives.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **Optimistic budget ("fire, reconcile after")** | Documented race where concurrent calls double-dip the budget. Pessimistic reservation is strictly safer; cost is one extra Table write per call. |
| **Budget stored on IngestHealth row per source** | Two axes (per-source per-day) complicate the lease pattern. A dedicated `AgentBudget` table with per-day rows is simpler and keeps the ingest-health surface for its current purpose. |
| **Budget in memory, reconciled to Table on interval** | Loses state across instance restarts + cold-start on Flex Consumption; no durable budget = the primary cost control becomes "hope". |
| **Single monolithic agent (no orchestrator)** | Loses the per-specialist budget attribution + fails `PROJECT_BRIEF.md §7` agent roster. Step 7 needs four agents. |
| **Dynamic plug-in registry loaded from config** | Makes the allow-list surface (§3 point b) a writable string in config rather than a compile-time constant. Widens the attack surface without benefit at v1. |
| **Streaming responses** | Complicates budget reconcile (tokens counted as they stream); revisit when UX demands it. |
| **Unbounded retries on `5xx`** | Defeats budget and cost controls; 3 attempts with full-jitter backoff is the same policy `graphClient.ts` uses. |
| **Circuit breaker spanning days** | Requires cross-day state + complicates row schema. UTC-day reset + App Insights alert covers the real-world Foundry-outage shape. |

## Related

- `PROJECT_BRIEF.md §5` — Deterministic first, LLM last (upstream cost principle)
- `PROJECT_BRIEF.md §7` — Agent roster (step 5 = orchestrator + brief-agent; step 7 = three more specialists)
- `PROJECT_BRIEF.md §11` — Cost target (<£25/mo single-user; this ADR's budget math lives inside that envelope)
- ADR-0011 §5a — IngestHealth ETag lease pattern (reused here)
- ADR-0015 — Audit hash chain (ADR-0021 extends for agent lines)
- ADR-0017 — Foundry identity + region (upstream constraint)
- ADR-0018 — Model tiering + forbid-fallback (three-plane enforcement wired here)
- ADR-0020 (pending) — `brief-agent` contract (consumer of this ADR's orchestrator)
- ADR-0021 (pending) — Agent audit-log extension (consumes §Decision.5 audit schema)
- ADR-0022 (pending) — Daily-brief caching + read contract (consumes §Decision.4 fallback behaviour)

---

*End of ADR-0019.*
