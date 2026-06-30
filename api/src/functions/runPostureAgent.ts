// POST /api/ingest/posture/run — admin-only manual posture run
// (ADR-0027 §Decision.4 admin-manual-trigger).
//
// SWA gates `/api/ingest/*` to ["admin"] (reliable across deploys per
// HANDOVER §6.2 pitfall 25); Easy Auth gates the Function App to the SWA
// MI. `authLevel: "anonymous"` per repo convention. Body shape (optional):
// `{"isoWeek":"2026-W17"}`. If supplied, must be strictly `yyyy-Www` and
// target the current or a past week (no future weeks).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveBriefAgentConfig } from "../lib/config.js";
import { isoWeekOf } from "../lib/posturePromptBuilder.js";
import { runPostureAgent } from "../lib/runPostureAgent.js";

const MAX_BODY_BYTES = 1024;
const ISO_WEEK_REGEX = /^\d{4}-W\d{2}$/;

export const runPostureAgentHandler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);

  const lenHeader = request.headers.get("content-length");
  if (lenHeader !== null) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return payloadTooLarge(
        context,
        `request body must be ≤ ${MAX_BODY_BYTES} bytes`,
      );
    }
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return badRequest(context, "unable to read request body");
  }
  if (Buffer.byteLength(rawBody, "utf-8") > MAX_BODY_BYTES) {
    return payloadTooLarge(
      context,
      `request body must be ≤ ${MAX_BODY_BYTES} bytes`,
    );
  }

  let isoWeek: string | undefined;
  if (rawBody.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return badRequest(context, "body is not valid JSON");
    }
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (obj.isoWeek !== undefined) {
        if (typeof obj.isoWeek !== "string" || !ISO_WEEK_REGEX.test(obj.isoWeek)) {
          return badRequest(context, "body.isoWeek must be yyyy-Www (e.g. 2026-W17)");
        }
        const now = new Date();
        const currentWeek = isoWeekOf(now);
        if (obj.isoWeek > currentWeek) {
          return badRequest(context, "body.isoWeek cannot be in the future");
        }
        // SEC-L-B2-02 — bound the past-week look-back to the staleness
        // ceiling. The reader's `readLatestCache` walks back at most 3
        // weeks; targeting `1970-W01` would write a row no read path
        // ever reaches, wasting tokens. Use 2× the ceiling-day window
        // as the cap (round up to whole weeks).
        const config = resolveBriefAgentConfig();
        const maxLookbackWeeks = Math.max(
          1,
          Math.ceil((2 * config.postureStalenessCeilingDays) / 7),
        );
        const earliestAllowedWeek = isoWeekOf(
          new Date(now.getTime() - maxLookbackWeeks * 7 * 86_400_000),
        );
        if (obj.isoWeek < earliestAllowedWeek) {
          return badRequest(
            context,
            `body.isoWeek cannot be older than ${earliestAllowedWeek} (max ${maxLookbackWeeks} weeks back from current)`,
          );
        }
        isoWeek = obj.isoWeek;
      }
    }
  }

  try {
    const result = await runPostureAgent({
      trigger: "admin",
      ...(isoWeek ? { isoWeek } : {}),
      context,
    });
    if (result.status === "budget_exhausted") {
      return {
        status: 429,
        jsonBody: {
          error: {
            code: "rate_limited",
            message: `manual posture ceiling exceeded: ${result.reason ?? "budget"}`,
            correlationId: context.invocationId,
          },
          isoWeek: result.isoWeek,
        },
        headers: { "retry-after": "3600", "cache-control": "no-store" },
      };
    }
    if (result.status === "circuit_open") {
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "agent_unavailable",
            message: "posture agent circuit is open",
            correlationId: context.invocationId,
          },
          isoWeek: result.isoWeek,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    if (result.status === "error") {
      return {
        status: 500,
        jsonBody: {
          error: {
            code: "agent_error",
            message: result.reason ?? "agent run failed",
            correlationId: context.invocationId,
          },
          isoWeek: result.isoWeek,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    return {
      status: 202,
      jsonBody: {
        status: result.status,
        isoWeek: result.isoWeek,
        runId: result.runId,
        ...(result.outputSha256 ? { outputSha256: result.outputSha256 } : {}),
        ...(result.supersedingRunId
          ? { supersedingRunId: result.supersedingRunId }
          : {}),
        ...(result.degraded ? { degraded: true } : {}),
      },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`posture.run.error ${(err as Error).message}`);
    return {
      status: 500,
      jsonBody: {
        error: {
          code: "agent_error",
          message: "posture agent run failed",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

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

function payloadTooLarge(
  context: InvocationContext,
  message: string,
): HttpResponseInit {
  return {
    status: 413,
    jsonBody: {
      error: {
        code: "payload_too_large",
        message,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("runPostureAgent", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/posture/run",
  handler: runPostureAgentHandler,
});
