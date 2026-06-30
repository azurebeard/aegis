# ADR-0005 — Agent orchestration

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

XDR Hub is agent-assisted: a small set of role-specialised LLM agents summarise and explain XDR / Entra / Sentinel signals, with an orchestrator routing user queries and coordinating specialists (brief §6, §7). The agent runtime must:

- **Run natively in Azure** so the whole deployment lives in the user's own subscription with no external agent-platform dependency.
- **Provide thread and session memory** out of the box (brief §4 item 3) so v1 does not need to build a bespoke conversation store.
- **Support tool use** (function calling) against the project's own Azure Functions, so the orchestrator can invoke specialist agents and each specialist can read from the operational store defined in ADR-0006.
- **Support multiple models per project** so model tiering — "cheapest capable model per task" (brief §5) — is enforceable at configuration time.
- **Interoperate with Managed Identity and Key Vault** so the keyless-auth posture in brief §9 extends to inference.
- **Have a cost profile** that a deployer can observe via Azure cost tools and the dashboard cost tile (brief §11).

The brief (§3, §6, §7, §14 item 3) commits to Foundry Agent Service with a multi-agent orchestrator pattern. This ADR ratifies that commitment and defines the topology, tool-contract, and uncertainty-handling conventions the build depends on.

## Decision

### Platform

**Microsoft AI Foundry — Agent Service.** One Foundry project per deployment.

- Project name: `aif-aegis-<env>-<region>` per ADR-0001.
- Agents are defined as code under `/agents/<agent-name>/` with prompts, tool schemas, and test fixtures versioned alongside the code (brief §16: prompts are code).
- Inference endpoints are accessed via Managed Identity; no inference API keys in config or Key Vault.

### Topology

Multi-agent under a single orchestrator.

| Agent | Role | Model tier (v1 default) |
|---|---|---|
| `orchestrator` | Routes user queries, selects specialists, enforces token budgets | Small (gpt-4o-mini class) |
| `posture-agent` | Secure Score, CA coverage, Entra risk summarisation | Small |
| `incidents-agent` | Defender XDR incident summarisation and triage narrative | Medium / large for synthesis |
| `stack-agent` | Tech-stack ↔ CVE / KEV correlation and explanation | Small for routing, medium for explanation |
| `brief-agent` | Daily and weekly narrative brief generation | Medium / large for synthesis |

**Not in v1:** `hunter-agent` (KQL generation), `responder-agent` (actions), `reporter-agent` (board output). All roadmap.

Specific model identifiers are chosen at Foundry project deploy time via Bicep parameters, not hard-coded in agent definitions. Model upgrades are a configuration change, not a code change; ADR-0005 does not re-open when a specific model is retired or upgraded.

### Tool contract

- Specialists expose themselves to the orchestrator as Foundry tools with typed input and output schemas stored under `/agents/<agent-name>/tools.json`.
- Specialists call back into Azure Functions to read from the operational store (ADR-0006). Functions are the tool-execution surface; **specialists never hit Graph / Defender / Sentinel APIs directly at agent-runtime** — that violates the deterministic-first rule (brief §5) and would make token spend unpredictable.
- The orchestrator enforces a per-agent per-day token budget. On breach: return a cached response if one exists, otherwise a refusal with a dashboard alert (brief §11). Budgets are parameterised per deployment.

### Memory

- **Short-term per-session** — Foundry threads, native. No custom conversation store in v1.
- **Long-term / RAG** — Azure AI Search is roadmap; v1 uses blob + flat JSON knowledge index (brief §4 item 2). Indexing is an ingestion concern, not an agent-runtime concern; RAG retrieval is a tool call the specialist makes, not a native thread feature.

### Input handling and prompt-injection defence

Agents ingest signals whose content is attacker-influenceable: incident filenames and command lines, sign-in risk descriptions, tech-stack fields, threat-feed entries. All such content crosses into the agent as **untrusted input** and is handled under the following rules.

- **System-prompt isolation.** System prompts live at `/agents/<agent-name>/prompts/system.md` and are never composed from untrusted content. Ingested signals are passed as user-role or data-role content only.
- **Content framing.** Untrusted content is passed to the model inside a delimited, labelled region with a randomised identifier and a preamble instructing the model that the enclosed content is data, not instructions. Prompt templates that implement this framing are versioned under `/agents/<agent-name>/prompts/`.
- **Output constraints.** Specialist outputs that will be written to the operational store or rendered in the dashboard are validated against a schema. Free-text fields that will be rendered as HTML are escaped by the SPA at render time; markdown rendering uses a safe-list renderer.
- **Content Safety.** Azure AI Foundry Content Safety is enabled on the project with jailbreak detection on, prompt-shield (indirect prompt-injection detection) on, and output moderation on for harmful categories. Content Safety is treated as a filter in depth — it does not replace the rules above.
- **Tool-call authorisation separation.** Every Function exposed as an agent tool independently verifies the caller's authorisation using the Easy Auth identity propagated via the agent invocation context. The agent's selection of a tool is never treated as authorisation to perform it. See ADR-0002 — authorisation enforcement stays in the primary TypeScript Function App.
- **Refusal on suspicion.** An agent that detects an apparent injection attempt — delimiter breakouts, instruction-override patterns, exfil-via-URL, attempts to exfiltrate the system prompt — follows the Uncertainty handling rule below: refuse to write, route to Approvals, emit an audit event tagged `suspected-injection` with the adversarial snippet preserved (brief §9 audit rules).
- **Regression fixtures.** Each agent carries test fixtures under `/agents/<agent-name>/tests/` covering a minimum set of adversarial inputs: IGNORE/OVERRIDE directives, system-prompt extraction attempts, delimiter escape, exfil-via-URL, and tool-misuse prompts. Fixtures run in CI on every PR that touches `/agents/**`.

References: OWASP LLM Top 10 2025 — LLM01 (Prompt Injection), LLM02 (Sensitive Information Disclosure), LLM05 (Improper Output Handling), LLM06 (Excessive Agency), LLM07 (System Prompt Leakage); Azure AI Foundry Content Filtering documentation.

### Uncertainty handling

Agents that are uncertain about a claim must not auto-surface it as definitive. Instead, they:

1. Refuse to write the claim to the operational store.
2. Create a high-priority item on the dashboard Approvals page for human adjudication.
3. Write the reasoning and evidence to the audit log (ADR-0006) with the standard event schema.

This is the behavioural rule; implementation lives in each agent's system prompt and is test-covered with fixtures that assert refusals on known-ambiguous inputs.

### Observability

- Every agent invocation emits a custom App Insights event with: agent name, tool calls made, prompt tokens, completion tokens, duration, user correlation ID, thread ID.
- Foundry's native evaluation harness is used for regression tests on prompt changes; the harness runs in CI on every PR that touches `/agents/**`.
- The dashboard cost tile (brief §11) aggregates per-agent spend from these events.

## Consequences

### Positive

- **Native Azure runtime** — no external agent-platform dependency; the whole deployment remains in the user's subscription.
- **Thread memory out of the box** — v1 does not build or operate a conversation store.
- **Managed Identity to inference** — matches the rest of the security posture; no inference-key rotation burden.
- **Model tiering is a parameter** — "cheapest capable model per task" is enforceable at deploy time without code changes, directly supporting the < £25/month cost target.
- **Foundry tracing and evaluation** are first-class, reducing the custom telemetry and regression-testing we would otherwise build.

### Negative / trade-offs

- **Foundry Agent Service is younger than self-hosted frameworks.** API and SDK surfaces may move during v1's build window; churn is accepted in exchange for a zero-operator agent runtime.
- **Portability cost.** Moving to a self-hosted agent framework later (LangGraph, Semantic Kernel, AutoGen) would be a non-trivial migration — prompts and tool schemas port cleanly, orchestration glue does not. Accepted trade-off against v1 delivery speed.
- **Per-tenant Foundry project baseline cost** counts against the < £25/month target. Measured and documented in `/docs/costs.md` after the first real deploy.

### Neutral

- The orchestrator-plus-specialists topology is an implementation choice. Moving to a flatter agent topology, or to a hierarchical orchestrator, is a superseding ADR rather than a platform change.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| Direct Azure OpenAI calls with custom orchestration | Pushes conversation store, tool routing, and tracing into the application. Feasible but duplicates what Foundry provides for no offsetting benefit in v1. |
| Semantic Kernel (self-hosted) | Lower-level; requires building the session store, tool registry, and tracing that Foundry provides. Appropriate only if portability was a v1 requirement — it is not. |
| LangChain / LangGraph | OSS and portable, but self-hosted: we would own the agent runtime, its upgrades, its secrets, and its observability. Excess operational surface for a community deployment. |
| AutoGen | Research-oriented; API stability and production posture are weaker than Foundry Agent Service at v1 scope. |
| Single-agent (no orchestrator) | Simpler, but collapses role boundaries — the brief deliberately splits roles for prompt hygiene and model-tier economics (§5, §7). Rejected on grounds the brief already addresses. |

## Related

- `PROJECT_BRIEF.md` §3 — Architecture decisions (Agent orchestration, Agent pattern rows)
- `PROJECT_BRIEF.md` §4 — Data and memory model (agent memory is Foundry threads)
- `PROJECT_BRIEF.md` §5 — Deterministic first, LLM last (governs when agents are invoked)
- `PROJECT_BRIEF.md` §6 — Autonomy model (uncertainty handling rule)
- `PROJECT_BRIEF.md` §7 — Agent roster (v1)
- `PROJECT_BRIEF.md` §11 — Observability and cost controls (token budgets, cost tile)
- `PROJECT_BRIEF.md` §14 item 3 — Open decision: small model benchmark
- ADR-0001 — Codename and repo identity (cloud role names, Foundry project naming)
- ADR-0002 — API runtime language (orchestration glue runs in the primary TypeScript Function App)
- ADR-0006 — Data stores (agents read the ops store via Function-backed tools; audit events recorded to WORM blob)
