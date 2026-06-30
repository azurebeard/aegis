// DELETE /api/ingest/branding/logo — admin-gated logo delete
// (ADR-0029 Phase B §Decision.3).
//
// Admin gate at the SWA route rule `/api/ingest/*` → ["admin"]. Idempotent:
// safe to call when no logo exists (returns the same full settings response
// either way). Blob delete is best-effort against 404 — if the row points
// at a blob that's already been swept, we still clear the row's columns so
// the next read surfaces "no logo" cleanly.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, RestError } from "@azure/storage-blob";
import { emitAievent } from "../lib/aievent.js";
import { readClientPrincipal, type ClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import {
  resolveBriefAgentConfig,
  resolveIngestConfig,
  resolveReportSnapshotConfig,
} from "../lib/config.js";
import { brandingLogoBlobPath } from "./uploadBrandingLogo.js";
import { buildFullSettingsResponse } from "../lib/settingsResponse.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import { clearBrandingLogo, readBranding } from "../lib/tenantSettingsStore.js";

const MAX_UPDATED_BY_CHARS = 256;

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);

  const ingestConfig = resolveIngestConfig();
  const briefConfig = resolveBriefAgentConfig();
  const reportConfig = resolveReportSnapshotConfig();
  const updatedBy = deriveUpdatedBy(principal);
  const updatedAt = new Date().toISOString();

  try {
    const settingsTable = getTableClient(
      {
        endpoint: ingestConfig.opsTableEndpoint,
        managedIdentityClientId: ingestConfig.ingestMiClientId,
      },
      OPS_TABLES.TenantSettings,
    );
    const current = await readBranding(settingsTable, ingestConfig.tenantId);

    // Blob delete is best-effort — 404 is treated as already-deleted so
    // the handler stays idempotent across row-points-at-missing-blob edge
    // cases (e.g. operator deleted out-of-band, or a sweep rule ran).
    if (current.logoSha256) {
      const credential = new DefaultAzureCredential({
        managedIdentityClientId: ingestConfig.ingestMiClientId,
      });
      const service = new BlobServiceClient(
        ingestConfig.opsBlobEndpoint,
        credential,
      );
      const containerClient = service.getContainerClient(
        ingestConfig.brandingAssetsContainer,
      );
      const blob = containerClient.getBlockBlobClient(
        brandingLogoBlobPath(ingestConfig.tenantId),
      );
      try {
        await blob.delete();
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) {
          // Blob already gone — fall through to the row clear below.
          context.warn(
            `branding.logo.delete blob already absent tenant=${ingestConfig.tenantId}`,
          );
        } else {
          throw err;
        }
      }
    }

    // Row clear — idempotent. Safe to call even when no logo columns exist.
    await clearBrandingLogo(settingsTable, {
      tenantId: ingestConfig.tenantId,
      updatedBy,
      updatedAt,
    });

    emitAievent(context, "TenantSettingsChange", {
      action: "branding-logo-delete",
      tenantId: ingestConfig.tenantId,
      principal: updatedBy,
      priorSha256: current.logoSha256 || undefined,
      priorSize: current.logoSize || undefined,
    });

    const apiReaderCtx = {
      endpoint: ingestConfig.opsTableEndpoint,
      managedIdentityClientId: ingestConfig.apiReaderMiClientId,
    };
    const body = await buildFullSettingsResponse({
      tenantId: ingestConfig.tenantId,
      settingsTable,
      budgetDefaults: {
        briefManualRunCeiling: briefConfig.briefDailyManualRunCeiling,
        briefDailyTokenBudget: briefConfig.briefDailyTokenBudget,
        postureManualRunCeiling: briefConfig.postureWeeklyManualRunCeiling,
        postureWeeklyTokenBudget: briefConfig.postureWeeklyTokenBudget,
        incidentsAnalysisManualRunCeiling:
          briefConfig.incidentsAnalysisDailyManualRunCeiling,
        incidentsAnalysisDailyTokenBudget:
          briefConfig.incidentsAnalysisDailyTokenBudget,
      },
      schedules: {
        briefTimerCron: briefConfig.briefTimerCron,
        postureTimerCron: briefConfig.postureTimerCron,
        reportSnapshotAutoCaptureCron: reportConfig.autoCaptureCron,
      },
      opsTableCtx: apiReaderCtx,
      aiPlaneEnabled: ingestConfig.deployAiAgents,
    });

    return {
      status: 200,
      jsonBody: body,
      headers: { "cache-control": "no-store" },
    };
  } catch (err) {
    context.error(`branding.logo.delete.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "branding store is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

function deriveUpdatedBy(principal: ClientPrincipal): string {
  const candidate = principal.userDetails && principal.userDetails.trim() !== ""
    ? principal.userDetails
    : principal.userId;
  const cleaned = candidate.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned.slice(0, MAX_UPDATED_BY_CHARS);
}

app.http("deleteBrandingLogo", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "ingest/branding/logo",
  handler,
});

export { handler as deleteBrandingLogoHandler };
