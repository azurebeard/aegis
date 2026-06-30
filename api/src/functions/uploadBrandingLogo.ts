// POST /api/ingest/branding/logo — admin-gated binary logo upload
// (ADR-0029 Phase B §Decision.3).
//
// Admin gate at the SWA route rule `/api/ingest/*` → ["admin"] plus Easy Auth
// binding to the SWA MI. This handler re-validates only the client-principal
// presence check (ADR-0007 §Backend protection); no in-handler role check
// per the patchSettings precedent (duplicating tempts future refactors to
// skip the SWA rule).
//
// Three-check upload hygiene (ADR-0029 §Decision.5):
//
//   1. `Content-Length` ≤ 1 MB → 413.
//   2. `Content-Type` ∈ {image/png, image/webp, image/jpeg} → 415.
//   3. Magic bytes match declared Content-Type → 415.
//
// Post-buffer byte-count re-checked under chunked encoding. The three gates
// layer so no blob I/O happens for a rejected request.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { createHash } from "node:crypto";
import { emitAievent } from "../lib/aievent.js";
import { readClientPrincipal, type ClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import {
  isAllowedLogoContentType,
  isWithinLogoSizeCap,
  validateLogoMagicBytes,
} from "../lib/brandingLogo.js";
import {
  resolveBriefAgentConfig,
  resolveIngestConfig,
  resolveReportSnapshotConfig,
} from "../lib/config.js";
import {
  ADMIN_RUN_DAILY_CEILING,
  SlidingWindowRateLimiter,
} from "../lib/rateLimit.js";
import { buildFullSettingsResponse } from "../lib/settingsResponse.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import {
  LOGO_MAX_BYTES,
  upsertBrandingLogo,
  type LogoContentType,
} from "../lib/tenantSettingsStore.js";

const MAX_UPDATED_BY_CHARS = 256;
const LOGO_BLOB_NAME = "logo";

// 30/day per tenant (same ceiling as other admin-write endpoints). Separate
// instance from patchSettings' limiter so settings-PATCH and logo-upload
// don't share a counter (WS10 informational — "distinct instances with the
// same ceiling is the correct pattern").
const logoUploadRateLimiter = new SlidingWindowRateLimiter(
  ADMIN_RUN_DAILY_CEILING,
  24 * 60 * 60_000,
);

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);

  // Gate 1: Content-Length polite-client reject. Chunked-encoding clients
  // that omit the header will be caught by the post-buffer check below.
  const lenHeader = request.headers.get("content-length");
  if (lenHeader !== null) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > LOGO_MAX_BYTES) {
      return payloadTooLarge(context);
    }
  }

  // Gate 2: Content-Type MIME allowlist. Parsed before body read so a
  // misdeclared request fails fast.
  const rawContentType = request.headers.get("content-type") ?? "";
  // Strip any `; charset=...` / `; boundary=...` suffix for the allowlist
  // check. The three allowed image MIME types don't carry parameters in
  // their canonical form, but a permissive upload client may still emit
  // them.
  const declaredContentType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isAllowedLogoContentType(declaredContentType)) {
    return unsupportedMediaType(
      context,
      `Content-Type must be one of image/png, image/webp, image/jpeg (received: ${declaredContentType || "<absent>"})`,
    );
  }

  // Read body. Azure Functions v4 returns ArrayBuffer from .arrayBuffer().
  let buf: Buffer;
  try {
    const ab = await request.arrayBuffer();
    buf = Buffer.from(ab);
  } catch {
    return badRequest(context, "unable to read request body");
  }

  // Post-buffer size check — covers chunked-encoding clients that omit
  // Content-Length. Zero-length is also rejected (empty body is never a
  // valid logo).
  if (!isWithinLogoSizeCap(buf.byteLength)) {
    if (buf.byteLength === 0) {
      return badRequest(context, "request body is empty");
    }
    return payloadTooLarge(context);
  }

  // Gate 3: magic-byte check. Authoritative content-type validator — a
  // client claiming image/png but shipping JPEG bytes (or arbitrary binary,
  // or an SVG with `<script>`) fails here and is rejected before any blob
  // I/O or row write.
  if (!validateLogoMagicBytes(buf, declaredContentType as LogoContentType)) {
    return unsupportedMediaType(
      context,
      `uploaded body does not match declared Content-Type ${declaredContentType}; magic bytes rejected`,
    );
  }

  const ingestConfig = resolveIngestConfig();
  const briefConfig = resolveBriefAgentConfig();
  const reportConfig = resolveReportSnapshotConfig();

  const rate = logoUploadRateLimiter.check(ingestConfig.tenantId);
  if (!rate.allowed) {
    return {
      status: 429,
      jsonBody: {
        error: {
          code: "rate_limit_endpoint",
          message: `branding-logo-upload budget exhausted: ${ADMIN_RUN_DAILY_CEILING}/day per tenant`,
          correlationId: context.invocationId,
        },
      },
      headers: {
        "retry-after": Math.ceil(rate.retryAfterMs / 1000).toString(),
        "cache-control": "no-store",
      },
    };
  }

  const updatedBy = deriveUpdatedBy(principal);
  const updatedAt = new Date().toISOString();
  const sha256Hex = createHash("sha256").update(buf).digest("hex");
  const blobPath = brandingLogoBlobPath(ingestConfig.tenantId);

  // Track blob-write success so we can compensate (delete the orphan)
  // if the row-write fails. SEC-OBS-ADR29-PHASEB-01 resolution: a blob
  // whose pointer never lands in TenantSettings is orphaned under
  // branding-assets. `readBranding`'s triple-coherence defence-in-depth
  // means the orphan is unreachable via the API, but it still accrues
  // cost + forensic noise. Compensating delete keeps the two writes
  // roughly atomic-on-success / rolled-back-on-partial-commit.
  let blobWritten = false;
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: ingestConfig.ingestMiClientId,
  });
  const service = new BlobServiceClient(ingestConfig.opsBlobEndpoint, credential);
  const containerClient = service.getContainerClient(
    ingestConfig.brandingAssetsContainer,
  );
  const blob = containerClient.getBlockBlobClient(blobPath);

  try {
    // Step 1: write blob via ingest MI. Overwrite-on-upload is correct
    // (ADR-0029 §Decision.2) — audit trail of prior versions lives on
    // the branding row's UpdatedAt + LogoSha256 + blob versioning (account-
    // level 7-day retention on superseded blobs; funcDeployments lifecycle
    // also covers branding-assets for version pruning per §Decision.2).
    await blob.uploadData(buf, {
      blobHTTPHeaders: {
        blobContentType: declaredContentType,
        // Let the serve handler re-set Cache-Control at response time so a
        // future change to the cache policy doesn't require a re-upload.
        blobCacheControl: "no-store",
      },
    });
    blobWritten = true;

    // Step 2: update branding row with the triple. A row-write failure
    // AFTER the blob-write triggers a compensating blob-delete in the
    // catch below. Single-writer invariant is
    // preserved — no race with a concurrent upload on the same tenant
    // since admin PATCH endpoints share the `ADMIN_RUN_DAILY_CEILING`
    // ceiling and the handler runs under a single Function invocation.
    const settingsTable = getTableClient(
      {
        endpoint: ingestConfig.opsTableEndpoint,
        managedIdentityClientId: ingestConfig.ingestMiClientId,
      },
      OPS_TABLES.TenantSettings,
    );
    await upsertBrandingLogo(settingsTable, {
      tenantId: ingestConfig.tenantId,
      logoSha256: sha256Hex,
      logoContentType: declaredContentType as LogoContentType,
      logoSize: buf.byteLength,
      updatedBy,
      updatedAt,
    });

    emitAievent(context, "TenantSettingsChange", {
      action: "branding-logo-upload",
      tenantId: ingestConfig.tenantId,
      principal: updatedBy,
      sha256: sha256Hex,
      contentType: declaredContentType,
      size: buf.byteLength,
    });

    // Build and return the full settings response so the SPA can
    // setQueryData in one pass (same pattern as PATCH /api/ingest/settings).
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
    context.error(`branding.logo.upload.error ${(err as Error).message}`);
    // SEC-OBS-ADR29-PHASEB-01 — compensating blob-delete when the row
    // write fails AFTER a successful blob write. Best-effort: a failure
    // here is logged (operator can retry the upload; the next write
    // overwrites the orphan via blob versioning). We deliberately do
    // NOT change the response status — the caller still sees 503.
    if (blobWritten) {
      try {
        await blob.delete();
        context.warn(
          `branding.logo.upload.compensated tenant=${ingestConfig.tenantId} sha=${sha256Hex}` +
            ` — row-write failed after blob-write, orphan blob deleted`,
        );
      } catch (compErr) {
        context.error(
          `branding.logo.upload.orphan tenant=${ingestConfig.tenantId} sha=${sha256Hex}` +
            ` — compensating blob-delete failed: ${(compErr as Error).message}`,
        );
      }
    }
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

/**
 * Blob path — `<tenantId>/logo`. Fixed filename (no operator-supplied
 * name) per ADR-0029 §Decision.5. TenantId is path-sanitised so a
 * malformed env var can't introduce a path-traversal primitive.
 *
 * Allowlist `[A-Za-z0-9_-]` (no dot). WS10-verdict-2026-04-21-adr-0029-
 * phase-b F1 Phase B resolution: kept identical to the serve-path regex
 * in `getBrandingLogo.ts` so the two allowlists cannot diverge. Azure
 * Blob Storage treats the key as a literal string (no filesystem
 * resolution), but defence-in-depth against a future refactor keeps
 * `.` / `..` / empty segments unreachable at this layer too.
 */
export function brandingLogoBlobPath(tenantId: string): string {
  const safeTenant = tenantId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${safeTenant}/${LOGO_BLOB_NAME}`;
}

function deriveUpdatedBy(principal: ClientPrincipal): string {
  // Same derivation as patchSettings — length-bounded, C0/DEL stripped.
  const candidate = principal.userDetails && principal.userDetails.trim() !== ""
    ? principal.userDetails
    : principal.userId;
  const cleaned = candidate.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned.slice(0, MAX_UPDATED_BY_CHARS);
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

function payloadTooLarge(context: InvocationContext): HttpResponseInit {
  return {
    status: 413,
    jsonBody: {
      error: {
        code: "payload_too_large",
        message: `logo upload must be ≤ ${LOGO_MAX_BYTES} bytes`,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

function unsupportedMediaType(
  context: InvocationContext,
  message: string,
): HttpResponseInit {
  return {
    status: 415,
    jsonBody: {
      error: {
        code: "unsupported_media_type",
        message,
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("uploadBrandingLogo", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/branding/logo",
  handler,
});

// Export for unit tests — the handler itself is the primary test surface.
export { handler as uploadBrandingLogoHandler };
