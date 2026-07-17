// GET /api/secure-score/control-profiles
//
// Returns every cached secureScoreControlProfile for the tenant (read-
// only, no Graph call from the read path). Powers the
// `/secure-score/controls` SPA page's enrichment — joining the profile
// catalogue against the daily snapshot's `controlScores[]` lets the
// page render maxScore / tier / remediation per row.
//
// Reader-or-admin via the existing `/api/secure-score/*` SWA gate.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";
import { resolveApiConfig } from "../lib/config.js";
import { unauthenticated } from "../lib/httpAuthResponses.js";
import { listControlProfiles } from "../lib/secureScoreControlProfileStore.js";
import { getTableClient, OPS_TABLES } from "../lib/tables.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  // §10.66 Phase E follow-up — Bearer required (Easy Auth retired).
  const principal = await readClientPrincipal(request, context);
  if (!principal) return unauthenticated(context);
  const config = resolveApiConfig();
  const opsCtx = {
    endpoint: config.opsTableEndpoint,
    managedIdentityClientId: config.apiReaderMiClientId,
  };
  const table = getTableClient(opsCtx, OPS_TABLES.SecureScore);

  try {
    const profiles = await listControlProfiles(table);
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        items: profiles,
        count: profiles.length,
      },
      headers: {
        // 5 minutes — the catalogue refreshes daily so a 5-min cache is
        // generous enough to amortise the SPA fan-out without holding
        // genuinely-stale data.
        "cache-control": "private, max-age=300",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`secureScore.controlProfiles.error ${(err as Error).message}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "control profile cache is temporarily unavailable",
          correlationId: context.invocationId,
        },
      },
      headers: { "cache-control": "no-store" },
    };
  }
};

app.http("getSecureScoreControlProfiles", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "secure-score/control-profiles",
  handler,
});
