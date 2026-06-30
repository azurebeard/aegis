// GET /api/agents/observability/ingest-sources
//
// Returns the canonical list of Ingest Diagnostics sources from
// `diagnosticsSources.ts` — the single source of truth that the
// run-history handler (`getIngestRunHistory`) also consumes. The SPA's
// Diagnostics page reads this at mount time instead of carrying its own
// hardcoded array, so adding/removing a source becomes a one-file edit
// on the server.
//
// Sibling of `getIngestRunHistory`; same auth gate (admin-only) since
// the source list itself is part of the admin diagnostics surface. The
// list IS public-ish (just names + descriptions, no secrets), but
// gating it on admin role keeps the contract symmetric with the
// run-history endpoint and matches WS10's defence-in-depth posture for
// the `/api/agents/observability/*` namespace.
//
// Cached `private, max-age=300` — the list changes per-deploy only;
// per-principal cache is fine.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { toPublicSources } from "../lib/diagnosticsSources.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  const roles = principal?.userRoles ?? [];
  if (!roles.includes("admin")) {
    return {
      status: 403,
      jsonBody: {
        error: {
          code: "forbidden",
          message: "ingest sources require the admin role",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }

  return {
    status: 200,
    jsonBody: {
      schemaVersion: 1,
      sources: toPublicSources(),
    },
    headers: {
      "cache-control": "private, max-age=300",
      vary: "Cookie, Authorization",
    },
  };
};

app.http("getIngestSources", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "agents/observability/ingest-sources",
  handler,
});

export { handler as getIngestSourcesHandler };
