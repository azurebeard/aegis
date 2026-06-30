// GET /api/posture/latest — read the latest cached weekly posture narrative
// (ADR-0027 §Decision.5).
//
// Mirrors getBriefLatest: walks back across the lookback window, verifies
// blob sha256 against the row's OutputSha256 (defence-in-depth —
// ADR-0021/0022), classifies freshness, and returns the structured envelope
// (parsed from the markdown body). `Cache-Control: private, max-age=300`
// per ADR-0027 §Decision.5 (weekly cadence tolerates 5-min staleness).

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
  POSTURE_CACHE_TABLE_NAME,
} from "../lib/postureCache.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { isoWeekOf } from "../lib/posturePromptBuilder.js";
import { getTableClient } from "../lib/tables.js";

const READ_BACK_WEEKS = 3; // fresh(7d)+stale_serviceable(14d) + 1 buffer week.

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
  const cacheTable = getTableClient(opsCtx, POSTURE_CACHE_TABLE_NAME);

  try {
    const now = new Date();
    const thisWeek = isoWeekOf(now);
    const stepBack = (weeksBack: number): string =>
      isoWeekOf(new Date(now.getTime() - weeksBack * 7 * 86_400_000));
    const row = await readLatestCache(
      cacheTable,
      config.tenantId,
      thisWeek,
      READ_BACK_WEEKS,
      stepBack,
    );
    if (!row) {
      return {
        status: 200,
        jsonBody: {
          schemaVersion: 1,
          posture: null,
          health: { status: "awaiting_first_run" },
        },
        headers: {
          "cache-control": "private, max-age=60",
          vary: "Cookie, Authorization",
        },
      };
    }

    const body = await readCacheBody(
      config.opsBlobEndpoint,
      config.apiReaderMiClientId,
      config.postureCacheContainer,
      row.blobPath,
    );
    if (body.sha256 !== row.outputSha256) {
      await emitIntegrityAudit(
        config,
        context,
        row.runId,
        body.sha256,
        row.outputSha256,
        row.isoWeek,
        row.blobPath,
      );
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "posture_store_integrity_violation",
            message:
              "posture blob sha256 does not match cache row outputSha256 — refusing to serve",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }

    const freshness = classifyFreshness(
      row,
      now,
      config.postureStalenessFreshDays,
      config.postureStalenessCeilingDays,
    );
    const rendered = parseMarkdownEnvelope(body.body);
    const responseBody: Record<string, unknown> = {
      schemaVersion: 1,
      isoWeek: row.isoWeek,
      headline: rendered.headline,
      severity: rendered.severity,
      sections: rendered.sections,
      runId: row.runId,
      generatedAt: row.generatedAt,
      outputSha256: row.outputSha256,
      modelDeployment: row.modelDeployment,
      freshness,
    };
    if (freshness === "stale_unservable") {
      responseBody.retryHintSeconds = 86400;
    }

    return {
      status: 200,
      jsonBody: responseBody,
      headers: {
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`posture.latest.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "posture store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

export interface ParsedPosture {
  readonly headline: string;
  readonly severity: "informational" | "notable" | "urgent" | "unknown";
  readonly sections: {
    currentPosture: string;
    recentMovement: string;
    priorityActions: string;
  };
}

/** Re-parse the markdown body back into an envelope-shaped response. */
export function parseMarkdownEnvelope(md: string): ParsedPosture {
  const lines = md.split(/\r?\n/);
  let headline = "";
  let severity: ParsedPosture["severity"] = "unknown";
  const sections = {
    currentPosture: "",
    recentMovement: "",
    priorityActions: "",
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
    "current posture": "currentPosture",
    "recent movement": "recentMovement",
    "priority actions": "priorityActions",
  };
  for (const line of lines) {
    const h2 = /^## (.+)$/.exec(line);
    if (h2 && headline === "" && h2[1]) {
      headline = h2[1].trim();
      continue;
    }
    const sev = /^_severity:\s*(informational|notable|urgent)_$/.exec(line);
    if (sev && sev[1]) {
      severity = sev[1] as ParsedPosture["severity"];
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
  runId: string,
  observedSha: string,
  expectedSha: string,
  isoWeek: string,
  blobPath: string,
): Promise<void> {
  const payload = {
    event: "PostureCacheIntegrityViolation",
    eventSource: "posture.integrity_violation",
    schemaVersion: 1,
    tenantId: config.tenantId,
    isoWeek,
    runId,
    expectedSha256: expectedSha,
    actualSha256: observedSha,
    blobPath,
    postureCacheContainer: config.postureCacheContainer,
    modelDeployment: config.briefModelDeployment,
    callerPrincipalMiClientId: config.apiReaderMiClientId,
    timestamp: new Date().toISOString(),
    correlationId: context.invocationId,
  };
  context.error(JSON.stringify(payload));
}

app.http("getPostureLatest", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "posture/latest",
  handler,
});
