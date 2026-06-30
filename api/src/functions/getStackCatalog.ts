// GET /api/stack/catalog — ADR-0031 §2.
//
// Returns the bundled vendor+product catalog. Reader-or-admin via the SWA
// catch-all rule. Cached aggressively — the catalog ships with the deploy
// and only changes on a code release.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { flattenCatalog } from "../lib/stackCatalog.js";

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
  return {
    status: 200,
    jsonBody: {
      schemaVersion: 1,
      pairs: flattenCatalog(),
    },
    headers: {
      "cache-control": "private, max-age=3600",
      vary: "Cookie, Authorization",
    },
  };
};

app.http("getStackCatalog", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "stack/catalog",
  handler,
});
