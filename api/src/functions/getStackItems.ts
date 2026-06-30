// GET /api/stack/items?category=&environment=  — ADR-0031 §4.
// Reader-or-admin. No pagination at v1 (cap of 100, ADR-0031 §6).

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
import {
  isValidStackCategory,
  isValidStackEnvironment,
  listStackItems,
  STACK_ITEMS_CAP,
} from "../lib/stackItemsStore.js";
import {
  applySuppressionsToMatches,
  listKevRows,
  matchesForStackItem,
} from "../lib/kevStore.js";
import {
  indexSuppressions,
  listSuppressions,
} from "../lib/kevSuppressionsStore.js";

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

  const categoryRaw = request.query.get("category");
  const environmentRaw = request.query.get("environment");
  if (categoryRaw !== null && !isValidStackCategory(categoryRaw)) {
    return badRequest(context, "category filter must be a known category");
  }
  if (environmentRaw !== null && !isValidStackEnvironment(environmentRaw)) {
    return badRequest(context, "environment filter must be a known environment");
  }

  try {
    const config = resolveApiConfig();
    const tableCtx = {
      endpoint: config.opsTableEndpoint,
      managedIdentityClientId: config.apiReaderMiClientId,
    };
    const stackTable = getTableClient(tableCtx, OPS_TABLES.StackItems);
    const kevTable = getTableClient(tableCtx, OPS_TABLES.KEV);
    const suppressionsTable = getTableClient(tableCtx, OPS_TABLES.KevSuppressions);
    // Read all three partitions in parallel — KEV is global, StackItems +
    // KevSuppressions are per-tenant; no cross-dependency. ADR-0032 §3
    // read-time match + ADR-0033 §3 status overlay.
    const [items, kevRows, suppressions] = await Promise.all([
      listStackItems(stackTable, config.tenantId, {
        ...(categoryRaw ? { category: categoryRaw } : {}),
        ...(environmentRaw ? { environment: environmentRaw } : {}),
      }),
      listKevRows(kevTable),
      listSuppressions(suppressionsTable, config.tenantId),
    ]);
    const suppressionsByKey = indexSuppressions(suppressions);
    const itemsWithMatches = items.map((it) => ({
      ...it,
      kevMatches: applySuppressionsToMatches(
        it.id,
        matchesForStackItem(kevRows, it),
        suppressionsByKey,
      ),
    }));
    return {
      status: 200,
      jsonBody: {
        schemaVersion: 1,
        items: itemsWithMatches,
        cap: STACK_ITEMS_CAP,
      },
      headers: {
        "cache-control": "private, max-age=30",
        vary: "Cookie, Authorization",
      },
    };
  } catch (err) {
    context.error(`stack.items.list.error ${String((err as Error).message ?? err)}`);
    return {
      status: 503,
      jsonBody: {
        error: {
          code: "dependency_unavailable",
          message: "stack inventory store is temporarily unavailable",
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
      error: { code: "bad_request", message, correlationId: context.invocationId },
    },
    headers: { "cache-control": "no-store" },
  };
}

app.http("getStackItems", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "stack/items",
  handler,
});
