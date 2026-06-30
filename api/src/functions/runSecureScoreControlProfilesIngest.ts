// POST /api/ingest/secure-score/control-profiles/run — admin-only manual
// trigger for the catalogue refresh. Mirrors the snapshot ingest's HTTP
// trigger pattern but skips the rate-limiter (the upsert is bounded to
// ~150 rows + the underlying call is idempotent and read-bound on Graph).
//
// SEC-H-INGEST-AUTH-MIGRATION — post ADR-0035 Phase D2 the SWA route gate
// `/api/ingest/* → ["admin"]` is gone. Auth enforced server-side: 401 on
// missing principal, 403 on non-admin.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { forbidden, unauthenticated } from "../lib/httpAuthResponses.js";
import { resolveIngestConfig } from "../lib/config.js";
import { runSecureScoreControlProfilesIngestOnce } from "../lib/runSecureScoreControlProfilesIngest.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  if (!principal.userRoles.includes("admin")) {
    return forbidden(context, "secure-score control-profiles ingest requires the admin role");
  }
  const config = resolveIngestConfig();
  const outcome = await runSecureScoreControlProfilesIngestOnce(config, context);
  return {
    status: outcome.status === "error" ? 500 : 200,
    jsonBody: { outcome },
    headers: { "cache-control": "no-store" },
  };
};

app.http("runSecureScoreControlProfilesIngest", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "ingest/secure-score/control-profiles/run",
  handler,
});
