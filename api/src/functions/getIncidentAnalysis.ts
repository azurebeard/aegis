// GET /api/incidents/{id}/analysis — read the latest cached incidents-agent
// analysis envelope (ADR-0028 §Decision.5).
//
// Returns the parsed envelope + the AnalysedIncidentLastUpdateDateTime so
// the SPA can render "analysis is based on the incident as of <time>;
// incident has been updated — re-analyse" affordances. No blanket time-
// based staleness — staleness is event-driven via two-axis content hash.
//
// Defence-in-depth sha256 verification against the cache row (ADR-0021/0022).
// Mismatch returns 503 + structured "PostureCacheIntegrityViolation"-style
// telemetry under `IncidentAnalysisCacheIntegrityViolation`.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import {
  INCIDENT_ID_REGEX,
  IncidentIdRejectedError,
  validateIncidentId,
} from "../lib/incidentsParser.js";
import {
  INCIDENT_ANALYSIS_CACHE_TABLE_NAME,
  isRedactionLockActive,
  readCache,
  readCacheBody,
} from "../lib/incidentAnalysisCache.js";
import { getTableClient } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E follow-up — Bearer required (Easy Auth retired).
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const config = resolveBriefAgentConfig();
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };

  // Validate incident ID path param.
  const rawId = request.params.id;
  const decodedId = rawId ? decodeURIComponent(rawId) : "";
  try {
    validateIncidentId(decodedId);
  } catch (err) {
    if (err instanceof IncidentIdRejectedError) {
      return badRequest(
        context,
        `path parameter \`id\` does not match ${INCIDENT_ID_REGEX.source}: ${err.reason}`,
      );
    }
    return badRequest(context, "path parameter `id` is invalid");
  }

  const cacheTable = getTableClient(opsCtx, INCIDENT_ANALYSIS_CACHE_TABLE_NAME);

  try {
    const now = new Date();
    const row = await readCache(cacheTable, config.tenantId, decodedId);
    if (!row) {
      return {
        status: 200,
        jsonBody: {
          schemaVersion: 1,
          analysis: null,
          health: { status: "awaiting_first_run" },
        },
        headers: {
          // HANDOVER §6.2.16 pattern — `max-age` on this endpoint poisons
          // the post-`POST /analyse` refresh: the browser HTTP cache
          // serves a stale `awaiting_first_run` body for the cache
          // window even when React Query's `invalidateQueries` triggers
          // a refetch. Result: button reappears with no content. The
          // endpoint is fast (~20-50ms) and React Query owns the client-
          // side cache anyway, so `no-store` is correct here.
          "cache-control": "no-store",
          vary: "Cookie, Authorization",
        },
      };
    }

    const body = await readCacheBody(
      config.opsBlobEndpoint,
      config.apiReaderMiClientId,
      config.incidentsAnalysisCacheContainer,
      row.blobPath,
    );
    if (body.sha256 !== row.outputSha256) {
      await emitIntegrityAudit(config, context, decodedId, row.runId, body.sha256, row.outputSha256, row.blobPath);
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "incident_analysis_store_integrity_violation",
            message:
              "incident analysis blob sha256 does not match cache row outputSha256 — refusing to serve",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }

    const rendered = parseMarkdownEnvelope(body.body);
    const responseBody: Record<string, unknown> = {
      schemaVersion: 1,
      incidentId: decodedId,
      headline: rendered.headline,
      severity: rendered.severity,
      sections: rendered.sections,
      runId: row.runId,
      generatedAt: row.generatedAt,
      outputSha256: row.outputSha256,
      modelDeployment: row.modelDeployment,
      analysedIncidentLastUpdateDateTime: row.analysedIncidentLastUpdateDateTime,
      redactionLock: {
        active: isRedactionLockActive(row, now),
        until: row.redactionLockUntil,
      },
    };

    return {
      status: 200,
      jsonBody: responseBody,
      headers: {
        // See note at the awaiting_first_run branch above — `max-age` here
        // creates the same post-`POST /analyse` browser-cache stale-body
        // problem on subsequent re-analyses. `no-store` is the correct
        // choice for this endpoint.
        "cache-control": "no-store",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`incidents.analysis.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "incidents analysis store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

export interface ParsedIncidentAnalysis {
  readonly headline: string;
  readonly severity: "informational" | "notable" | "urgent" | "unknown";
  readonly sections: {
    attackNarrative: string;
    impactAssessment: string;
    suggestedNextSteps: string;
  };
}

/** Re-parse the markdown body into the structured envelope. */
export function parseMarkdownEnvelope(md: string): ParsedIncidentAnalysis {
  const lines = md.split(/\r?\n/);
  let headline = "";
  let severity: ParsedIncidentAnalysis["severity"] = "unknown";
  const sections = {
    attackNarrative: "",
    impactAssessment: "",
    suggestedNextSteps: "",
  };
  let currentKey: keyof typeof sections | null = null;
  const buffer: string[] = [];
  const flush = (): void => {
    if (currentKey !== null) {
      sections[currentKey] = buffer.join("\n").trim();
    }
    buffer.length = 0;
  };
  const headingMap: Record<string, keyof typeof sections> = {
    "attack narrative": "attackNarrative",
    "impact assessment": "impactAssessment",
    "suggested next steps": "suggestedNextSteps",
  };
  for (const line of lines) {
    const h2 = /^## (.+)$/.exec(line);
    if (h2 && headline === "" && h2[1]) {
      headline = h2[1].trim();
      continue;
    }
    const sev = /^_severity:\s*(informational|notable|urgent)_$/.exec(line);
    if (sev && sev[1]) {
      severity = sev[1] as ParsedIncidentAnalysis["severity"];
      continue;
    }
    const h3 = /^### (.+)$/.exec(line);
    if (h3 && h3[1]) {
      flush();
      const key = headingMap[h3[1].trim().toLowerCase()];
      currentKey = key ?? null;
      continue;
    }
    if (currentKey !== null) buffer.push(line);
  }
  flush();
  return { headline, severity, sections };
}

async function emitIntegrityAudit(
  config: ReturnType<typeof resolveBriefAgentConfig>,
  context: InvocationContext,
  incidentId: string,
  runId: string,
  observedSha: string,
  expectedSha: string,
  blobPath: string,
): Promise<void> {
  const payload = {
    event: "IncidentAnalysisCacheIntegrityViolation",
    eventSource: "incidents.analysis.integrity_violation",
    schemaVersion: 1,
    tenantId: config.tenantId,
    incidentId,
    runId,
    expectedSha256: expectedSha,
    actualSha256: observedSha,
    blobPath,
    callerPrincipalMiClientId: config.apiReaderMiClientId,
    timestamp: new Date().toISOString(),
    correlationId: context.invocationId,
  };
  context.error(JSON.stringify(payload));
}

function badRequest(context: InvocationContext, message: string): HttpResponseInit {
  return {
    status: 400,
    jsonBody: {
      error: {
        code: "bad_request",
        message,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("getIncidentAnalysis", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "incidents/{id}/analysis",
  handler,
});
