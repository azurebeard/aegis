// GET /api/reports/current/html?cadence=weekly|monthly|quarterly
//
// ADR-0030 — derived HTML rendering of the live current-period envelope.
// Mirrors getReportCurrent.ts but returns the rendered standalone HTML
// document instead of the JSON envelope. Reader-or-admin per §7.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { resolveIngestConfig } from "../lib/config.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { periodForCadence } from "../lib/reportPeriod.js";
import { assembleLiveEnvelope } from "../lib/reportEnvelope.js";
import { renderEnvelopeHtml } from "../lib/reportHtml.js";
import { parseCadence } from "./getReportCurrent.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) {
    return {
      status: 401,
      jsonBody: {
        error: {
          code: "unauthenticated",
          message: "authentication required",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const cadence = parseCadence(request.query.get("cadence") ?? "");
  if (!cadence) {
    return {
      status: 400,
      jsonBody: {
        error: {
          code: "bad_request",
          message: "cadence must be one of: weekly, monthly, quarterly",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  try {
    const config = resolveIngestConfig();
    const period = periodForCadence(cadence);
    const envelope = await assembleLiveEnvelope({
      tenantId: config.tenantId,
      capturedBy: principal.userId,
      version: 0, // 0 = live (not persisted)
      capturedAt: new Date().toISOString(),
      period,
    });
    const body = renderEnvelopeHtml(envelope);
    const filename = `aegis-report-${period.periodKey}-live.html`;
    return {
      status: 200,
      body,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "private, max-age=30",
        "x-content-type-options": "nosniff",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`report.current.html.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "report assembly is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("getReportCurrentHtml", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "reports/current/html",
  handler,
});
