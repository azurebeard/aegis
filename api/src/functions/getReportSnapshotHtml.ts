// GET /api/reports/snapshots/<periodKey>/html?version=N
//
// ADR-0030 — derived HTML rendering of a stored snapshot envelope.
// Standalone HTML document (inline CSS, no external assets) suitable for
// download / email-body / browser-print-to-PDF. Reader-or-admin per §7.
//
// Mirrors getReportSnapshot.ts for auth + periodKey/version validation,
// then runs the envelope through `renderEnvelopeHtml`.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { resolveApiConfig } from "../lib/config.js";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import { renderEnvelopeHtml } from "../lib/reportHtml.js";
import { readLatestSnapshot, readVersion } from "../lib/reportSnapshotStore.js";
import { parseVersion } from "./getReportSnapshot.js";

const PERIOD_KEY_RE = /^\d{4}-(?:W\d{2}|\d{2}|Q[1-4])$/;

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

  const periodKey = request.params["periodKey"] ?? "";
  if (!PERIOD_KEY_RE.test(periodKey)) {
    return {
      status: 400,
      jsonBody: {
        error: {
          code: "bad_request",
          message: "periodKey must match YYYY-Www | YYYY-MM | YYYY-Qn",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  const versionRaw = request.query.get("version");
  const versionParsed = parseVersion(versionRaw);
  if (versionParsed.kind === "error") return versionParsed.response;

  try {
    const config = resolveApiConfig();
    const tableCtx = {
      endpoint: config.opsTableEndpoint,
      managedIdentityClientId: config.apiReaderMiClientId,
    };
    const table = getTableClient(tableCtx, OPS_TABLES.ReportSnapshots);
    const envelope =
      versionParsed.value === null
        ? await readLatestSnapshot(table, config.tenantId, periodKey)
        : await readVersion(table, config.tenantId, periodKey, versionParsed.value);

    if (!envelope) {
      return {
        status: 404,
        jsonBody: {
          error: {
            code: "not_found",
            message: `no snapshot for periodKey=${periodKey}${
              versionParsed.value !== null ? ` version=${versionParsed.value}` : ""
            }`,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    }

    const body = renderEnvelopeHtml(envelope);
    const filename = `aegis-report-${periodKey}-v${envelope.version}.html`;
    return {
      status: 200,
      body,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`report.snapshot.html.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "report store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("getReportSnapshotHtml", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "reports/snapshots/{periodKey}/html",
  handler,
});
