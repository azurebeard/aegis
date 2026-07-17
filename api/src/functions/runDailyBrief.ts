// POST /api/ingest/brief/run — admin-only manual brief run (ADR-0020 §3 trigger:admin).
//
// SWA gates `/api/ingest/*` to ["admin"]; Easy Auth gates the Function App to
// the SWA MI. `authLevel: "anonymous"` per repo convention. The handler
// re-validates the client principal header (defence in depth — ADR-0007).
//
// Route note: the Functions host reserves `/admin/*` for its management API
// (host status, function invocation). User routes must not begin `admin/`
// or the function is rejected with `RoutePatternException: The specified
// route conflicts with one or more built in routes.` — we piggy-back on the
// existing `ingest/*` SWA role gate instead.
//
// Body shape (optional): `{"yyyymmdd":"2026-04-19"}`. If supplied, must be
// strictly `YYYY-MM-DD` and ≤ today (UTC). The brief-agent's manual ceiling
// (BRIEF_DAILY_MANUAL_RUN_CEILING) is enforced inside reserveTokens — a 429
// here means that ceiling is already exhausted.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { runBriefAgent } from "../lib/runBriefAgent.js";

const MAX_BODY_BYTES = 1024;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const runDailyBriefHandler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);

  // the body cap
  // must be enforced POST-buffer-parse, not only on the Content-Length
  // header. A chunked-transfer client may omit Content-Length, which
  // bypasses the header check. We keep the header check as an early-reject
  // for polite clients (saves work) and then re-verify after the body is
  // materialised. `@azure/functions` v4 buffers the body before the handler
  // runs, so `request.text()` returns the full in-memory string.
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
  // Second gate — bytes-in-memory check. Defeats a chunked-encoding sender
  // that omitted Content-Length to bypass the first check.
  if (Buffer.byteLength(rawBody, "utf-8") > MAX_BODY_BYTES) {
    return payloadTooLarge(
      context,
      `request body must be ≤ ${MAX_BODY_BYTES} bytes`,
    );
  }

  let yyyymmdd: string | undefined;
  if (rawBody.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return badRequest(context, "body is not valid JSON");
    }
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (obj.yyyymmdd !== undefined) {
        if (typeof obj.yyyymmdd !== "string" || !DATE_REGEX.test(obj.yyyymmdd)) {
          return badRequest(
            context,
            "body.yyyymmdd must be YYYY-MM-DD",
          );
        }
        const today = isoDate(new Date());
        if (obj.yyyymmdd > today) {
          return badRequest(context, "body.yyyymmdd cannot be in the future");
        }
        yyyymmdd = obj.yyyymmdd;
      }
    }
  }

  try {
    // `trigger` is a budget/telemetry label (consumes manual-run ceiling per
    // ADR-0019 §4) and is decoupled from the URL path — the route is
    // `ingest/brief/run` because the Functions host reserves `admin/*`.
    const result = await runBriefAgent({
      trigger: "admin",
      ...(yyyymmdd ? { yyyymmdd } : {}),
      context,
    });
    if (result.status === "budget_exhausted") {
      return {
        status: 429,
        jsonBody: {
          error: {
            code: "rate_limited",
            message: `manual brief ceiling exceeded: ${result.reason ?? "budget"}`,
            correlationId: context.invocationId,
          },
          briefDate: result.briefDate,
        },
        headers: {
          "retry-after": "3600",
          "cache-control": "no-store",
        },
      };
    }
    if (result.status === "circuit_open") {
      return {
        status: 503,
        jsonBody: {
          error: {
            code: "agent_unavailable",
            message: "brief agent circuit is open",
            correlationId: context.invocationId,
          },
          briefDate: result.briefDate,
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
          briefDate: result.briefDate,
        },
        headers: { "cache-control": "no-store" },
      };
    }
    return {
      status: 202,
      jsonBody: {
        status: result.status,
        briefDate: result.briefDate,
        runId: result.runId,
        ...(result.outputSha256 ? { outputSha256: result.outputSha256 } : {}),
        ...(result.supersedingRunId
          ? { supersedingRunId: result.supersedingRunId }
          : {}),
      },
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`brief.run.error ${(err as Error).message}`);
    return {
      status: 500,
      jsonBody: {
        error: {
          code: "agent_error",
          message: "brief agent run failed",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function badRequest(
  context: InvocationContext,
  message: string,
): HttpResponseInit {
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

app.http("runDailyBrief", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/brief/run",
  handler: runDailyBriefHandler,
});
