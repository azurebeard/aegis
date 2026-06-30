// ADR-0037 Option B — operator self-service rotation
// of the ransomware.live PRO API key from the SPA admin section.
//
// Replaces (NOT removes) the operator-CLI path
// `scripts/provision-ransomware-live-api-key.ps1 -Mode Rotate` for the
// common-case "operator pastes a new key into the admin form". The PS1
// path stays available for: (a) initial provisioning (KV ABAC denies
// FA-side writes until the first secret version exists), (b) offline
// rotations when ransomware.live is unavailable for the `/validate`
// round-trip, (c) headless / CI deploys.
//
// The FA writes via the api-reader MI which has `Key Vault Secrets
// Officer` ABAC-scoped to ONLY `ransomware-live-api-key`
// (`infra/modules/keyvault.bicep:apiReaderKvRansomwareKeyOfficer`). Any
// future Officer-role action against a different secret name is denied
// at ARM RBAC.
//
// Trust boundary cost is documented in the Bicep grant comment + the
// HANDOVER ADR-0037 Option B entry.
//
// Sequencing:
//   1. Validate the supplied key against ransomware.live `GET /validate`
//      via the same HTTP path the orchestrator uses. A non-200 fails
//      the rotation BEFORE the KV write — won't store garbage.
//   2. Write the new secret version via SecretClient.setSecret.
//   3. Bust the module-scope cache in ransomwareLiveApiKey.ts so the
//      next Timer / admin-run fire picks up the new key without an
//      FA restart. Same FA process; same memory; no race with the
//      orchestrator since the cache reset is idempotent + atomic.
//
// All failure paths return a typed `RotateOutcome` — the handler maps
// to the appropriate HTTP status.

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import type { InvocationContext } from "@azure/functions";
import { resetRansomwareLiveApiKeyCache } from "./ransomwareLiveApiKey.js";

/** Where to call the ransomware.live API. Match `ransomwareLiveClient.ts`. */
const VALIDATE_URL = "https://api-pro.ransomware.live/validate";

/** Pre-write validation timeout — short, so a slow ransomware.live
 *  doesn't tie up the admin form for minutes. */
const VALIDATE_TIMEOUT_MS = 15_000;

export type RotateFailureKind =
  | "validation_failed" // /validate returned non-2xx OR threw before HTTP
  | "kv_403" // ABAC denied the write — drift from the Bicep ABAC condition
  | "kv_write_failed" // any other KV write error
  | "env_unset"; // KV name / secret name / MI client id missing

export interface RotateOutcome {
  readonly status: "rotated" | "failed";
  readonly kind?: RotateFailureKind;
  /** ISO 8601 timestamp the new version landed in KV. */
  readonly rotatedAt?: string;
  /** New secret version id (KV URL fragment). Useful for ops. */
  readonly version?: string;
  /** Validation HTTP status code, if the /validate round-trip got that far. */
  readonly validateStatus?: number;
  /** Scrubbed diagnostic — class name + status code only, never the key. */
  readonly errorDetail?: string;
}

export interface RotateConfig {
  readonly kvName: string;
  readonly secretName: string;
  readonly apiReaderMiClientId: string;
}

export function resolveRotateConfig(
  env: NodeJS.ProcessEnv = process.env,
): RotateConfig | null {
  const kvName = (env.RANSOMWARE_LIVE_API_KEY_KV_NAME ?? "").trim();
  const secretName = (env.RANSOMWARE_LIVE_API_KEY_KV_SECRET_NAME ?? "").trim();
  const apiReaderMiClientId = (env.API_READER_MI_CLIENT_ID ?? "").trim();
  if (!kvName || !secretName || !apiReaderMiClientId) return null;
  return { kvName, secretName, apiReaderMiClientId };
}

/**
 * Test-only seam: lets vitest stub the SecretClient + fetch implementations.
 * Production callers pass nothing.
 */
export interface RotateDeps {
  readonly fetchImpl?: typeof fetch;
  readonly secretClientFactory?: (vaultUrl: string, credential: DefaultAzureCredential) => Pick<SecretClient, "setSecret">;
}

export async function rotateRansomwareLiveApiKey(
  apiKey: string,
  context: InvocationContext,
  deps: RotateDeps = {},
): Promise<RotateOutcome> {
  const config = resolveRotateConfig();
  if (!config) {
    return { status: "failed", kind: "env_unset" };
  }

  // --- Step 1: validate against ransomware.live BEFORE the KV write ---
  const fetchImpl = deps.fetchImpl ?? fetch;
  let validateStatus: number | undefined;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
    try {
      const resp = await fetchImpl(VALIDATE_URL, {
        method: "GET",
        headers: { "X-API-KEY": apiKey },
        signal: ctrl.signal,
      });
      validateStatus = resp.status;
      if (!resp.ok) {
        // Don't consume the body — some error branches echo the supplied
        // key, and we don't want it landing in logs even by accident.
        return { status: "failed", kind: "validation_failed", validateStatus };
      }
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      status: "failed",
      kind: "validation_failed",
      errorDetail: `${e?.name ?? "Error"}`,
    };
  }

  // --- Step 2: write the new version via api-reader MI ---
  try {
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: config.apiReaderMiClientId,
    });
    const client = deps.secretClientFactory
      ? deps.secretClientFactory(`https://${config.kvName}.vault.azure.net`, credential)
      : new SecretClient(`https://${config.kvName}.vault.azure.net`, credential);
    const set = await client.setSecret(config.secretName, apiKey);
    // --- Step 3: bust module-scope cache so the next ingest picks up the new key ---
    resetRansomwareLiveApiKeyCache();
    const rotatedAt = set.properties.createdOn?.toISOString() ?? new Date().toISOString();
    const result: RotateOutcome = {
      status: "rotated",
      rotatedAt,
      ...(set.properties.version ? { version: set.properties.version } : {}),
      ...(validateStatus !== undefined ? { validateStatus } : {}),
    };
    return result;
  } catch (err) {
    const e = err as { name?: string; statusCode?: number };
    const detail = `${e?.name ?? "Error"}${e?.statusCode ? ` ${e.statusCode}` : ""}`;
    context.error(`ransomwareIntel.key.rotate.kv_write_failed detail=${detail}`);
    if (e?.statusCode === 403) {
      return { status: "failed", kind: "kv_403", errorDetail: detail };
    }
    return { status: "failed", kind: "kv_write_failed", errorDetail: detail };
  }
}
