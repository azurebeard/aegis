// GET /api/brief/latest — read the latest cached brief (ADR-0022 §read-path).
//
// Reads the BriefCache row, then the cache blob, then verifies sha256 of the
// blob matches the row's OutputSha256 (defence-in-depth — ADR-0021/0022).
// On mismatch, returns 503 and emits a structured App Insights error-level
// trace (`event:"CacheIntegrityViolation"`) — this is a READ-path signal and
// intentionally does NOT extend the agent.run audit chain (see SEC-H-STEP5-
// CODE-01 in WS10-verdict-2026-04-19-step5-code.md: read-path MIs must not
// hold chain-write rights, per ADR-0015 §single-writer invariant).
//
// `awaiting_first_run` is the no-row state. `stale_unservable` returns the
// cached body with `freshness:"stale_unservable"` + `retryHintSeconds`.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import {
  classifyFreshness,
  readCacheBody,
  readLatestCache,
  BRIEF_CACHE_TABLE_NAME,
} from "../lib/briefCache.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { getTableClient } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E follow-up — pre-Phase-E this read-only handler relied on
  // Easy Auth + the SWA `/api/*` route gate. With Easy Auth retired, the
  // FA is no longer platform-gated; every handler must validate the Bearer
  // in-process.
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const config = resolveBriefAgentConfig();
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const cacheTable = getTableClient(opsCtx, BRIEF_CACHE_TABLE_NAME);

  try {
    const now = new Date();
    const row = await readLatestCache(cacheTable, config.tenantId, now);
    if (!row) {
      return {
        status: 200,
        jsonBody: {
          schemaVersion: 1,
          brief: null,
          health: { status: "awaiting_first_run" },
        },
        headers: {
          "cache-control": "private, max-age=30",
          vary: "Cookie, Authorization",
        },
      };
    }

    const body = await readCacheBody(
      config.opsBlobEndpoint,
      config.apiReaderMiClientId,
      config.briefCacheContainer,
      row.blobPath,
    );
    if (body.sha256 !== row.outputSha256) {
      // Defence-in-depth violation per ADR-0021/0022.
      await emitIntegrityAudit(
        config,
        context,
        row.runId,
        body.sha256,
        row.outputSha256,
        row.briefDate,
        row.blobPath,
      );
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "brief_store_integrity_violation",
            message:
              "brief blob sha256 does not match cache row outputSha256 — refusing to serve",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }

    const freshness = classifyFreshness(
      row,
      now,
      config.briefStalenessFreshHours,
      config.briefStalenessCeilingHours,
    );
    const renderedSections = parseMarkdownSections(body.body);
    const responseBody: Record<string, unknown> = {
      schemaVersion: 1,
      briefDate: row.briefDate,
      headline: renderedSections.headline,
      sections: renderedSections.sections,
      runId: row.runId,
      generatedAt: row.generatedAt,
      outputSha256: row.outputSha256,
      modelDeployment: row.modelDeployment,
      freshness,
    };
    if (freshness === "stale_unservable") {
      // Hint clients to back off — next timer fire is at most 24h away.
      responseBody.retryHintSeconds = 3600;
    }

    return {
      status: 200,
      jsonBody: responseBody,
      headers: {
        "cache-control": "private, max-age=60",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`brief.latest.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "brief store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

interface ParsedBrief {
  readonly headline: string;
  readonly sections: readonly { heading: string; bullets: readonly string[] }[];
}

/**
 * Re-parse the cached markdown back into headline + sections so the wire
 * shape is consistent with the JSON envelope. The cache stores markdown
 * (the canonical hashed form), but the API contract is structured.
 */
export function parseMarkdownSections(md: string): ParsedBrief {
  const lines = md.split(/\r?\n/);
  let headline = "";
  const sections: { heading: string; bullets: string[] }[] = [];
  let current: { heading: string; bullets: string[] } | null = null;
  for (const line of lines) {
    const h2 = /^## (.+)$/.exec(line);
    if (h2 && headline === "" && h2[1]) {
      headline = h2[1].trim();
      continue;
    }
    const h3 = /^### (.+)$/.exec(line);
    if (h3 && h3[1]) {
      current = { heading: h3[1].trim(), bullets: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^- (.+)$/.exec(line);
    if (bullet && current && bullet[1]) {
      current.bullets.push(bullet[1].trim());
    }
  }
  return { headline, sections };
}

async function emitIntegrityAudit(
  config: ReturnType<typeof resolveBriefAgentConfig>,
  context: InvocationContext,
  runId: string,
  observedSha: string,
  expectedSha: string,
  briefDate: string,
  blobPath: string,
): Promise<void> {
  // Read-path integrity signal (ADR-0021/0022 §outputSha256 verification).
  //
  // this is a READ-path signal. Extending the agent.run audit chain from a
  // read-path handler requires giving a read-only MI write capability, which
  // loosens the MI-per-plane separation the overall design targets
  // (ADR-0015 §single-writer invariant). Instead, surface the event as a
  // structured App Insights customEvent — `context.log.error` auto-ingests
  // into App Insights as a structured trace.
  //
  // TODO(step-5.3): add an operator-authored scheduled-query alert rule in
  // alerts.bicep paralleling `agentRunAlert` but filtering on
  // `customDimensions.event == "CacheIntegrityViolation"` with
  // severity-1 / autoMitigate:false. The existing AgentRun alert only catches
  // token-anomaly; CacheIntegrityViolation is a separate signal with its own
  // retention/alerting contract and should NOT be folded into that rule. For
  // this pass we only EMIT the structured event — the Bicep alert follows.
  const payload = {
    event: "CacheIntegrityViolation",
    eventSource: "brief.integrity_violation",
    schemaVersion: 1,
    tenantId: config.tenantId,
    briefDate,
    runId,
    expectedSha256: expectedSha,
    actualSha256: observedSha,
    blobPath,
    briefCacheContainer: config.briefCacheContainer,
    modelDeployment: config.briefModelDeployment,
    callerPrincipalMiClientId: config.apiReaderMiClientId,
    timestamp: new Date().toISOString(),
    correlationId: context.invocationId,
  };
  // Azure Functions v4 pipes `context.error` into App Insights as
  // severity-level "Error" traces; the JSON body becomes queryable via the
  // `message` field (or parsed customDimensions if the ingestion path extracts
  // JSON). The `event` name inside the JSON is the correlation key for the
  // forthcoming operator-authored alert rule.
  context.error(JSON.stringify(payload));
}

app.http("getBriefLatest", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "brief/latest",
  handler,
});
