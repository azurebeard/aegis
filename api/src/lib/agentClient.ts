// Thin wrapper over `@azure/ai-projects` for single-turn chat completions
// (ADR-0017 §Decision.1, ADR-0019 §Decision.2 single-turn router).
//
// The Foundry project endpoint exposes Azure OpenAI deployments via the
// AIProjectClient. `getOpenAIClient()` returns an OpenAI-shaped client wired
// to the agent MI's bearer token at the cognitive scope. We use the
// chat.completions API for single-turn deterministic calls (no thread state,
// no tool calls, no streaming) — the brief agent is a pure transformer of
// fixed context to a fixed JSON envelope.
//
// Forbid-fallback (ADR-0017 §3): no retry across regions, no fallback to a
// different model deployment. A failure surfaces immediately as
// AgentFetchError so the orchestrator can record it and trip the breaker.

import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import type { BriefAgentConfig } from "./config.js";
import type { AgentFetchErrorKind } from "./agentHealth.js";

export class AgentFetchError extends Error {
  readonly kind: AgentFetchErrorKind;
  readonly status: number | null;
  constructor(kind: AgentFetchErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "AgentFetchError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Construct an AIProjectClient bound to the agent MI. The endpoint is the
 * Foundry project endpoint of shape `https://<acct>.services.ai.azure.com/api/projects/<proj>`
 * (ADR-0017 §Decision.1).
 */
export function createAgentClient(config: BriefAgentConfig): AIProjectClient {
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: config.agentMiClientId,
  });
  return new AIProjectClient(config.foundryProjectEndpoint, credential);
}

export interface RunSingleTurnParams {
  readonly deploymentName: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface RunSingleTurnResult {
  readonly output: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly finishReason: string;
}

/**
 * Single-turn chat completion. Uses the OpenAI client surfaced by
 * AIProjectClient.getOpenAIClient(). Times out at `timeoutMs` via AbortController
 * so a hung Foundry call cannot pin a timer instance past its lease window.
 */
export async function runSingleTurn(
  client: AIProjectClient,
  params: RunSingleTurnParams,
): Promise<RunSingleTurnResult> {
  const startHr = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const openai = client.getOpenAIClient();
    const completion = await openai.chat.completions.create(
      {
        model: params.deploymentName,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
        max_tokens: params.maxOutputTokens,
        // Deterministic-ish output for envelope compliance.
        temperature: 0,
      },
      { signal: controller.signal },
    );
    const choice = completion.choices?.[0];
    if (!choice) {
      throw new AgentFetchError("output_schema", "no choices in completion", null);
    }
    const finishReason = choice.finish_reason ?? "unknown";
    const message = choice.message?.content ?? "";
    if (finishReason === "content_filter") {
      // Surface as a typed error so the orchestrator records "content_filter".
      throw new AgentFetchError(
        "content_filter",
        "model output blocked by content filter",
        null,
      );
    }
    const usage = completion.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    return {
      output: typeof message === "string" ? message : "",
      tokensIn: usage.prompt_tokens ?? 0,
      tokensOut: usage.completion_tokens ?? 0,
      latencyMs: hrDurationMs(startHr),
      finishReason,
    };
  } catch (err) {
    if (err instanceof AgentFetchError) throw err;
    if (controller.signal.aborted) {
      throw new AgentFetchError("timeout", `Foundry call timed out after ${params.timeoutMs}ms`, null);
    }
    throw mapToAgentFetchError(err);
  } finally {
    clearTimeout(timer);
  }
}

function mapToAgentFetchError(err: unknown): AgentFetchError {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const status = numericField(e, "status") ?? numericField(e, "statusCode");
    const message = typeof e.message === "string" ? e.message : String(err);
    if (status === 401) return new AgentFetchError("unauthorised_401", message, status);
    if (status === 403) return new AgentFetchError("forbidden_403", message, status);
    if (status === 404) return new AgentFetchError("not_found_404", message, status);
    if (status === 408) return new AgentFetchError("timeout", message, status);
    if (status === 429) return new AgentFetchError("throttle_429", message, status);
    if (typeof status === "number" && status >= 500 && status < 600) {
      return new AgentFetchError("bad_gateway", message, status);
    }
    const name = typeof e.name === "string" ? e.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      return new AgentFetchError("timeout", message, null);
    }
    if (
      message.toLowerCase().includes("network") ||
      message.toLowerCase().includes("fetch failed") ||
      message.toLowerCase().includes("econnreset")
    ) {
      return new AgentFetchError("network", message, null);
    }
    return new AgentFetchError("internal", message, status ?? null);
  }
  return new AgentFetchError("other", String(err), null);
}

function numericField(
  e: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = e[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function hrDurationMs(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / 1_000_000n);
}
