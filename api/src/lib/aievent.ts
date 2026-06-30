// Centralised AIEVENT custom-event wrapper.
//
// The handlers across this codebase emit operational telemetry via:
//   context.log(`AIEVENT <Name> ${JSON.stringify(properties)}`);
//
// That works — the line lands in `FunctionAppLogs` and is grep-able — but
// it does NOT write into App Insights' `customEvents` table, so KQL
// dashboards and alerts can't index against the event name. This module
// keeps the existing log line (preserving every operator's existing
// FunctionAppLogs query) AND adds a `trackEvent` call so the same event
// surfaces in `customEvents` for queryable dashboards / alert rules.
//
// Init is lazy + idempotent + fail-soft. We DO NOT call `appInsights.setup()`
// (which would auto-instrument Node — the Functions host already does that).
// Instead we build a bare `TelemetryClient` from the connection string the
// Function App's APPLICATIONINSIGHTS_CONNECTION_STRING app setting provides.
// When the connection string is absent (local dev, vitest) we silently
// no-op — the structured log line is still emitted.
//
// The `trackEvent` call itself is wrapped in try/catch so a transient
// telemetry failure (network, queue full) cannot fault the calling
// handler. AIEVENT is observability, not business logic.

import type { InvocationContext } from "@azure/functions";

/**
 * Lazy module-level singleton. `null` once we've decided the SDK is
 * unavailable (no connection string, or the import / construct path
 * threw). Re-evaluated only on the first call.
 */
let telemetryClientInit:
  | { kind: "uninitialised" }
  | { kind: "ready"; client: TelemetryClientLike }
  | { kind: "disabled" } = { kind: "uninitialised" };

interface TelemetryClientLike {
  trackEvent(args: { name: string; properties?: Record<string, unknown> }): void;
}

async function getTelemetryClient(): Promise<TelemetryClientLike | null> {
  if (telemetryClientInit.kind === "ready") return telemetryClientInit.client;
  if (telemetryClientInit.kind === "disabled") return null;

  const connStr = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ?? "";
  if (!connStr) {
    telemetryClientInit = { kind: "disabled" };
    return null;
  }
  try {
    // Dynamic import — keeps the SDK out of the cold-start cost when no
    // event has fired yet, and means a missing dep at build time only
    // affects the first emit, not module load.
    const mod = (await import("applicationinsights")) as unknown as {
      TelemetryClient: new (connStr: string) => TelemetryClientLike;
    };
    const client = new mod.TelemetryClient(connStr);
    telemetryClientInit = { kind: "ready", client };
    return client;
  } catch {
    telemetryClientInit = { kind: "disabled" };
    return null;
  }
}

/**
 * Stringify property values that aren't already JSON-friendly so the App
 * Insights customEvent payload doesn't drop nested objects.
 *
 * App Insights `customDimensions` accepts string keys with string values;
 * the SDK serialises objects via `String(...)` which yields `[object Object]`
 * unless we normalise first. Numbers, booleans, and `null` survive as-is
 * via the SDK; nested objects get JSON-stringified.
 */
function normaliseProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Emit a structured AIEVENT — keeps the existing context.log line
 * (FunctionAppLogs grep) AND writes into `customEvents` (queryable KQL).
 *
 * The customEvent name is prefixed `AIEVENT.` so KQL queries can filter
 * the whole AIEVENT family with `customEvents | where name startswith
 * "AIEVENT."`.
 *
 * Telemetry failures never bubble up to the caller — observability paths
 * are best-effort.
 */
export function emitAievent(
  context: Pick<InvocationContext, "log">,
  name: string,
  properties: Record<string, unknown>,
): void {
  // 1. Existing FunctionAppLogs grep line — operators may already alert
  //    on this format. Don't break it.
  context.log(`AIEVENT ${name} ${JSON.stringify(properties)}`);

  // 2. customEvents — fire-and-forget. We don't await the client init
  //    promise because the caller is sync and we don't want to block
  //    the handler on telemetry. Silent-no-op on disabled / missing
  //    connection string.
  void (async () => {
    try {
      const client = await getTelemetryClient();
      if (!client) return;
      client.trackEvent({
        name: `AIEVENT.${name}`,
        properties: normaliseProperties(properties),
      });
    } catch {
      // Swallow — see module-level comment.
    }
  })();
}

/**
 * Test-only — reset the module-level cache so a vitest run can stub
 * the SDK / env without bleeding state across cases.
 */
export const __test__ = {
  reset(): void {
    telemetryClientInit = { kind: "uninitialised" };
  },
  state(): "uninitialised" | "ready" | "disabled" {
    return telemetryClientInit.kind;
  },
  normaliseProperties,
};
