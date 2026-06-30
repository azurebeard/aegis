// GET /api/branding/{tenantId}/logo?v=<sha> — reader-gated logo serve
// (ADR-0029 Phase B §Decision.3).
//
// Reader gate at the SWA route rule `/api/*` → ["authenticated", "reader"].
// Client-principal presence re-validated in-handler for defence-in-depth.
//
// IDOR check: handler MUST assert that the
// `<tenantId>` URL path parameter matches the caller's authenticated
// principal's tenant (via `resolveApiConfig().tenantId`) BEFORE any blob
// I/O. Mismatch returns 403 per ADR. Single-tenant today; the assertion
// closes the cross-tenant fetch primitive ahead of any multi-tenant future.
//
// The `?v=<sha>` query param is the cache-buster — a logo replacement
// changes `LogoSha256` on the branding row, the SPA's query refetches, and
// the new URL defeats the browser cache entry for the old sha. No server-
// side enforcement of the `v` match is required (the blob always holds
// the current logo; a stale `v` still returns the current logo, which is
// the correct browser-cache behaviour — cache-buster, not integrity gate).

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, RestError } from "@azure/storage-blob";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveApiConfig } from "../lib/config.js";
import { brandingLogoBlobPath } from "./uploadBrandingLogo.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";
import { readBranding } from "../lib/tenantSettingsStore.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);

  const rawTenant = request.params.tenantId;
  const urlTenantId = rawTenant ? decodeURIComponent(rawTenant) : "";
  if (!/^[0-9a-zA-Z_\-]{1,64}$/.test(urlTenantId)) {
    // Sanity shape check — GUID-like input only. Anything else is a malformed
    // request; return 400 before we compare to the authoritative tenantId.
    return badRequest(context, "path parameter `tenantId` is invalid");
  }

  const config = resolveApiConfig();

  // IDOR gate — URL tenantId must match the authoritative tenantId bound
  // into the Function App's config (AZURE_TENANT_ID / WEBSITE_AUTH_TENANT_ID).
  // Mismatch is an authorisation failure, returned BEFORE blob I/O.
  if (urlTenantId !== config.tenantId) {
    return {
      status: 403,
      jsonBody: {
        error: {
          code: "forbidden",
          message: "tenantId mismatch",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  try {
    // Read the row first — this surfaces the declared Content-Type we'll
    // send back, and short-circuits on the no-logo case without attempting
    // a blob read.
    const settingsTable = getTableClient(
      {
        endpoint: config.opsTableEndpoint,
        managedIdentityClientId: config.apiReaderMiClientId,
      },
      OPS_TABLES.TenantSettings,
    );
    const branding = await readBranding(settingsTable, config.tenantId);
    if (!branding.logoSha256 || !branding.logoContentType || branding.logoSize === 0) {
      return notFound(context);
    }

    // SEC-OBS-ADR29-PHASEB-02 — conditional-request 304 short-circuit.
    // If the caller supplies an `If-None-Match` matching the row-declared
    // sha256 ETag, skip the blob download and return 304. RFC 7232 §3.2
    // says the 304 response MUST include the same headers that would have
    // accompanied a 200 with an empty body — we re-emit ETag + Cache-
    // Control but omit Content-Type (the body is empty). Case-insensitive
    // header name lookup is the runtime's responsibility; the ETag value
    // itself is an exact quoted-string match per RFC 7232 §2.3.
    const rowEtag = `"${branding.logoSha256}"`;
    const inm = request.headers.get("if-none-match");
    if (inm !== null && inm === rowEtag) {
      return {
        status: 304,
        headers: {
          etag: rowEtag,
          "cache-control":
            "private, max-age=3600, stale-while-revalidate=86400",
          "x-content-type-options": "nosniff",
        },
      };
    }

    // Blob read via api-reader MI (container-scoped Blob Data Reader).
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: config.apiReaderMiClientId,
    });
    const service = new BlobServiceClient(config.opsBlobEndpoint, credential);
    const containerClient = service.getContainerClient(config.brandingAssetsContainer);
    const blob = containerClient.getBlockBlobClient(
      brandingLogoBlobPath(config.tenantId),
    );

    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await blob.downloadToBuffer();
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 404) {
        // Row points at a blob that's been swept — treat as no-logo.
        return notFound(context);
      }
      throw err;
    }

    return {
      status: 200,
      body: bodyBuffer,
      headers: {
        // Content-Type is the row's value (authoritative), not the blob's
        // — the row is the single source of truth for the triple and a
        // row-blob content-type mismatch (should not happen) yields the
        // row's declaration to the browser, matching the IntegrityCheck
        // fallback on the read path.
        "content-type": branding.logoContentType,
        // X-Content-Type-Options mirrors the SWA globalHeaders setting for
        // defence-in-depth on the Function proxy path; browsers must not
        // MIME-sniff a logo into something it isn't (WS10 Phase B "out-of-
        // scope observation" — re-emit at the handler).
        "x-content-type-options": "nosniff",
        // `private` — never cache on shared middleboxes (tenant-scoped).
        // `max-age=3600` — one hour. `stale-while-revalidate=86400` —
        // serve-stale-and-refresh for a day after expiry. Per ADR-0029.
        "cache-control": "private, max-age=3600, stale-while-revalidate=86400",
        // ETag = the row-declared sha (RFC 7232 §2.3 quoted-string). An
        // `If-None-Match` match short-circuits to 304 above — pre-blob-
        // I/O cheap branch.
        etag: rowEtag,
      },
    };
  } catch (err) {
    context.error(
      `branding.logo.serve.error ${(err as Error).message ?? String(err)}`,
    );
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

function notFound(context: InvocationContext): HttpResponseInit {
  return {
    status: 404,
    jsonBody: {
      error: {
        code: "not_found",
        message: "no logo configured",
        correlationId: context.invocationId,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("getBrandingLogo", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "branding/{tenantId}/logo",
  handler,
});

export { handler as getBrandingLogoHandler };
