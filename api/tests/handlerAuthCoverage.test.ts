// Handler-auth-coverage invariant (§10.66 INFO-1).
//
// Direct lesson from the Phase E regression where 11 read-only handlers
// (getBriefLatest, getNotifications, getPostureLatest, etc.) shipped
// without an in-handler auth gate. They had relied on Easy Auth + the
// SWA `/api/*` catch-all; once Easy Auth was retired, traffic sourced
// from Azure West Europe bypassed authentication entirely. Smoke caught
// it but PR review didn't, because there was no invariant assertion.
//
// This test asserts every `app.http(...)` handler in api/src/functions/
// imports `readClientPrincipal` and calls it. New handlers that ship
// without a gate fail this test loudly at PR time.
//
// If a handler is *intentionally* anonymous (and gates itself some other
// way — e.g. signed-URL verification, IP allow-list at the network layer,
// or genuinely-public health probe), add an entry to ANONYMOUS_ALLOWLIST
// below with a rationale comment alongside it.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = join(here, "..", "src", "functions");

/**
 * Handlers waived from the readClientPrincipal requirement. Each entry
 * MUST include a one-line rationale explaining how the handler is gated
 * (or why no gate is required). CI fails any new handler not listed here
 * and not calling readClientPrincipal.
 */
const ANONYMOUS_ALLOWLIST: Readonly<Record<string, string>> = {
  // ADR-0030 §C.22 (forthcoming) — share-link endpoint. The HMAC-signed
  // token in the URL path IS the auth: `verifyReportShareToken` against
  // the KV-loaded signing key gates every successful response. No
  // `readClientPrincipal` because the audience is email-recipients (board
  // members, directors) who don't have Aegis logins by design.
  "getReportShare.ts":
    "token-IS-the-auth: verifyReportShareToken + KV signing key gate every response",
};

interface HandlerFile {
  readonly filename: string;
  readonly source: string;
}

function listHttpHandlerFiles(): HandlerFile[] {
  const entries = readdirSync(FUNCTIONS_DIR, { withFileTypes: true });
  const out: HandlerFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".ts")) continue;
    if (e.name.endsWith(".d.ts")) continue;
    const source = readFileSync(join(FUNCTIONS_DIR, e.name), "utf-8");
    if (!/\bapp\.http\s*\(/.test(source)) continue;
    out.push({ filename: e.name, source });
  }
  return out;
}

describe("handler auth coverage invariant (§10.66 INFO-1)", () => {
  const handlers = listHttpHandlerFiles();

  it("has discovered at least one HTTP handler (sanity check)", () => {
    // Guards against a file-layout change silently emptying the test set.
    expect(handlers.length).toBeGreaterThan(10);
  });

  for (const { filename, source } of handlers) {
    const allowReason = ANONYMOUS_ALLOWLIST[filename];
    if (allowReason !== undefined) {
      it(`${filename} is on the anonymous allow-list (${allowReason})`, () => {
        expect(allowReason.length).toBeGreaterThan(0);
      });
      continue;
    }

    it(`${filename} imports readClientPrincipal from ../lib/clientPrincipal`, () => {
      const importPresent =
        /import[\s\S]*?\breadClientPrincipal\b[\s\S]*?from\s*['"]\.\.\/lib\/clientPrincipal(?:\.js)?['"]/.test(
          source,
        );
      expect(
        importPresent,
        `${filename} contains app.http() but does not import readClientPrincipal ` +
          `from ../lib/clientPrincipal.js. Every /api/* HTTP handler MUST gate auth ` +
          `via readClientPrincipal(request, context) + unauthenticated(context) at the ` +
          `top. If the handler is intentionally anonymous, add an entry to ` +
          `ANONYMOUS_ALLOWLIST in this test file with a rationale.`,
      ).toBe(true);
    });

    it(`${filename} calls readClientPrincipal()`, () => {
      const callPresent = /\breadClientPrincipal\s*\(/.test(source);
      expect(
        callPresent,
        `${filename} imports readClientPrincipal but never calls it. The import ` +
          `alone doesn't gate auth — the handler must invoke ` +
          `readClientPrincipal(request, context) and return 401/unauthenticated when ` +
          `it resolves to null.`,
      ).toBe(true);
    });
  }
});
