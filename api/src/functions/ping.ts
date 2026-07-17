// GET /api/ping — returns the authenticated caller's principal summary.
// Proves the SWA → Function App auth wire end to end.

import {
  app,
  type HttpHandler,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { readClientPrincipal } from "../lib/clientPrincipal.js";

const handler: HttpHandler = async (
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> => {
  const principal = await readClientPrincipal(request, context);
  context.log(
    `ping invoked; userId=${principal?.userId ?? "unknown"} roles=${principal?.userRoles.join(",") ?? "none"}`,
  );
  if (!principal) {
    return {
      status: 401,
      jsonBody: { error: "no_client_principal" },
    };
  }
  return {
    status: 200,
    jsonBody: {
      ok: true,
      identityProvider: principal.identityProvider,
      userId: principal.userId,
      userDetails: principal.userDetails,
      roles: principal.userRoles,
      ts: new Date().toISOString(),
    },
  };
};

app.http("ping", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "ping",
  handler,
});
