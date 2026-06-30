// GET /api/reports/current?cadence=weekly|monthly|quarterly
//
// Returns the live envelope for the current period of the given cadence,
// assembled from existing stores. No Table read for the envelope itself —
// this powers the default `/reports` SPA view, which renders "right now".
// Reader-or-admin per ADR-0030 §7.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { resolveIngestConfig } from "../lib/config.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import {
  isReportCadence,
  periodForCadence,
  type ReportCadence,
} from "../lib/reportPeriod.js";
import { assembleLiveEnvelope } from "../lib/reportEnvelope.js";

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

  const cadenceRaw = request.query.get("cadence") ?? "";
  const cadence = parseCadence(cadenceRaw);
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
    return {
      status: 200,
      jsonBody: envelope,
      headers: {
        "cache-control": "private, max-age=30",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`report.current.error ${String((err as Error).message ?? err)}`);
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

export function parseCadence(raw: string): ReportCadence | null {
  return isReportCadence(raw) ? raw : null;
}

app.http("getReportCurrent", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "reports/current",
  handler,
});
