// POST /api/reports/snapshots
//
// ADR-0030 §7 capture endpoint. Admin-gated. Body: { cadence, periodKey? }.
// When periodKey is omitted, server derives the current period for the
// cadence. Response: { periodKey, version, capturedAt, snapshotUrl }.
//
// Phase B refactor: capture-core extracted to `runReportCaptureOnce` so
// both this HTTP handler and the daily auto-capture Timer share a single
// pathway. This handler is now a thin parse-validate-translate shell.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden } from "../lib/httpAuthResponses.js";
import {
  resolveIngestConfig,
  resolveReportSnapshotConfig,
} from "../lib/config.js";
import {
  isReportCadence,
  isValidPeriodKey,
  type ReportCadence,
} from "../lib/reportPeriod.js";
import { runReportCaptureOnce } from "../lib/runReportCapture.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal || !principal.userRoles.includes("admin")) {
    return forbidden(context, "report capture requires the admin role");
  }

  let parsed: {
    cadence: ReportCadence;
    explicitPeriodKey: string | null;
    operatorNote: string | undefined;
  };
  try {
    parsed = await parseBody(request);
  } catch (err) {
    return badRequest(context, (err as Error).message);
  }

  const ingestConfig = resolveIngestConfig();
  const reportConfig = resolveReportSnapshotConfig();

  const result = await runReportCaptureOnce({
    cadence: parsed.cadence,
    explicitPeriodKey: parsed.explicitPeriodKey,
    capturedBy: principal.userId,
    skipIfPeriodHasVersions: false,
    ...(parsed.operatorNote ? { operatorNote: parsed.operatorNote } : {}),
    ingestConfig,
    reportConfig,
    logger: context,
  });

  switch (result.status) {
    case "invalid_period":
      return badRequest(
        context,
        result.errorMessage ?? `periodKey is invalid for cadence=${parsed.cadence}`,
      );
    case "lease_contended":
      return {
        status: 409,
        jsonBody: {
          error: {
            code: "lease_contended",
            message: "another capture for this tenant is in progress; retry shortly",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    case "size_exceeded":
      return {
        status: 413,
        jsonBody: {
          error: {
            code: "envelope_too_large",
            message: `compressed envelope exceeded ${result.envelopeBytes} bytes; phase B blob fallback required`,
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    case "error":
      return {
        status: 500,
        jsonBody: {
          error: {
            code: "internal_error",
            message: "report capture failed; see audit chain for details",
            correlationId: context.invocationId,
          },
        },
        headers: { "cache-control": "no-store" },
      };
    case "success":
      return {
        status: 200,
        jsonBody: {
          schemaVersion: 1,
          periodKey: result.periodKey,
          cadence: result.cadence,
          version: result.version,
          capturedAt: result.capturedAt,
          retentionRowsDeleted: result.retentionRowsDeleted,
          snapshotUrl: `/api/reports/snapshots/${result.periodKey}?version=${result.version}`,
        },
        headers: { "cache-control": "no-store" },
      };
    case "skipped_already_captured":
      // Not reachable from this handler — `skipIfPeriodHasVersions: false`
      // above. Defensive fall-through: report 200 with the existing-version
      // count so the operator sees something coherent rather than a 500.
      return {
        status: 200,
        jsonBody: {
          schemaVersion: 1,
          periodKey: result.periodKey,
          cadence: result.cadence,
          version: 0,
          capturedAt: result.capturedAt,
          retentionRowsDeleted: 0,
          skipped: true,
          existingVersions: result.existingVersions ?? 0,
        },
        headers: { "cache-control": "no-store" },
      };
  }
};

/** Operator-note bounds — same hygiene as ADR-0033 suppression notes
 *  + ADR-0029 footerText: control-char-strip + length-cap to keep the
 *  envelope size + downstream rendering predictable. */
export const OPERATOR_NOTE_MAX_CHARS = 1000;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // C0 + DEL except \t \n \r

async function parseBody(
  request: HttpRequest,
): Promise<{
  cadence: ReportCadence;
  explicitPeriodKey: string | null;
  operatorNote: string | undefined;
}> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new Error("body must be valid JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const cadence = obj["cadence"];
  if (!isReportCadence(cadence)) {
    throw new Error("cadence must be one of: weekly, monthly, quarterly");
  }
  const periodKey = obj["periodKey"];
  let explicitPeriodKey: string | null = null;
  if (periodKey !== undefined && periodKey !== null && periodKey !== "") {
    if (typeof periodKey !== "string") {
      throw new Error("periodKey must be a string");
    }
    if (!isValidPeriodKey(cadence, periodKey)) {
      throw new Error(`periodKey ${periodKey} does not match cadence ${cadence}`);
    }
    explicitPeriodKey = periodKey;
  }

  let operatorNote: string | undefined;
  const noteRaw = obj["notes"];
  if (noteRaw !== undefined && noteRaw !== null && noteRaw !== "") {
    if (typeof noteRaw !== "string") {
      throw new Error("notes must be a string");
    }
    // C0/DEL strip BEFORE length-cap so the cap reflects the rendered length.
    const sanitised = noteRaw.replace(CONTROL_CHARS_RE, "").trim();
    if (sanitised.length > OPERATOR_NOTE_MAX_CHARS) {
      throw new Error(`notes must be ≤ ${OPERATOR_NOTE_MAX_CHARS} chars`);
    }
    if (sanitised.length > 0) operatorNote = sanitised;
  }

  return { cadence, explicitPeriodKey, operatorNote };
}

function badRequest(context: InvocationContext, message: string): HttpResponseInit {
  return {
    status: 400,
    jsonBody: {
      error: { code: "bad_request", message, correlationId: context.invocationId },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("captureReportSnapshot", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "reports/snapshots",
  handler,
});
