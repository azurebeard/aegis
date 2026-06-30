// ADR-0037 — ransomware.live PRO API key loader.
//
// Reads the operator-seeded API key from Key Vault via the threatIntel
// user-assigned MI. Lazy-init module-scope cache mirrors
// `recipientHashPepper.ts` — FA instance lifetime, restart-to-rotate.
//
// Fail-soft posture (default): when the KV config is incomplete OR the read
// fails, the loader returns `{ key: null, fallbackReason: ... }`. The
// orchestrator (Layer 3c) treats `key === null` as "ingest path disabled"
// and sticky-sets the IngestHealth status to `not_configured`. No agent or
// dashboard call is gated on the key being live.
//
// Failure-mode reasons map to ADR-0037 §6:
//   - `env_unset`        — KV name, secret name, or MI client ID missing.
//                          Surfaced when the Bicep is deployed but the
//                          operator hasn't run the provision script yet.
//   - `secret_unavailable` — KV returned an empty value (rotation-window
//                          race or operator wiped the secret).
//   - `kv_403`           — KV ABAC denied the read. Indicates the per-secret
//                          role assignment drifted (SEC-L-L12-04 drift guard).
//   - `kv_timeout`       — Network/transport error before HTTP. Treated as
//                          transient by the orchestrator (retry next tick).
//   - `kv_read_failed`   — Any other KV error (catch-all, scrubbed detail).

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

interface ApiKeyConfig {
  readonly kvName: string;
  readonly secretName: string;
  readonly miClientId: string;
}

function readApiKeyConfig(env: NodeJS.ProcessEnv = process.env): ApiKeyConfig | null {
  const kvName = (env.RANSOMWARE_LIVE_API_KEY_KV_NAME ?? "").trim();
  const secretName = (env.RANSOMWARE_LIVE_API_KEY_KV_SECRET_NAME ?? "").trim();
  const miClientId = (env.THREAT_INTEL_MI_CLIENT_ID ?? "").trim();
  if (!kvName || !secretName || !miClientId) return null;
  return { kvName, secretName, miClientId };
}

// `undefined` = not attempted; `null` = attempted + unavailable; string = the
// live key. Rotation requires `az functionapp restart` to pick up — same
// contract as the pepper loader.
let cachedKey: string | null | undefined = undefined;
let cachedFallbackReason: LoadApiKeyResult["fallbackReason"] | null = null;
let cachedErrorDetail: string | null = null;

export type ApiKeyFallbackReason =
  | "env_unset"
  | "secret_unavailable"
  | "kv_403"
  | "kv_timeout"
  | "kv_read_failed";

export interface LoadApiKeyResult {
  readonly key: string | null;
  /** Reason the key is null, if any. Surfaced via AIEVENT for ops. */
  readonly fallbackReason?: ApiKeyFallbackReason;
  /** Diagnostic message (scrubbed — class name + statusCode only). */
  readonly errorDetail?: string;
}

/** Lazy load the ransomware.live PRO API key from Key Vault. Idempotent
 *  + cached per FA instance for the lifetime of the warm process. */
export async function loadRansomwareLiveApiKey(): Promise<LoadApiKeyResult> {
  if (cachedKey !== undefined) {
    if (cachedKey === null) {
      return {
        key: null,
        ...(cachedFallbackReason ? { fallbackReason: cachedFallbackReason } : {}),
        ...(cachedErrorDetail ? { errorDetail: cachedErrorDetail } : {}),
      };
    }
    return { key: cachedKey };
  }
  const config = readApiKeyConfig();
  if (!config) {
    cachedKey = null;
    cachedFallbackReason = "env_unset";
    return { key: null, fallbackReason: "env_unset" };
  }
  try {
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: config.miClientId,
    });
    const client = new SecretClient(
      `https://${config.kvName}.vault.azure.net`,
      credential,
    );
    const secret = await client.getSecret(config.secretName);
    const value = (secret.value ?? "").trim();
    if (value.length === 0) {
      cachedKey = null;
      cachedFallbackReason = "secret_unavailable";
      return { key: null, fallbackReason: "secret_unavailable" };
    }
    cachedKey = value;
    cachedFallbackReason = null;
    cachedErrorDetail = null;
    return { key: value };
  } catch (err) {
    const e = err as { name?: string; statusCode?: number; code?: string };
    const detail = `${e?.name ?? "Error"}${e?.statusCode ? ` ${e.statusCode}` : ""}`;
    let reason: ApiKeyFallbackReason;
    if (e?.statusCode === 403) {
      reason = "kv_403";
    } else if (
      e?.name === "AbortError" ||
      e?.code === "ETIMEDOUT" ||
      e?.name === "TimeoutError"
    ) {
      reason = "kv_timeout";
    } else {
      reason = "kv_read_failed";
    }
    cachedKey = null;
    cachedFallbackReason = reason;
    cachedErrorDetail = detail;
    return { key: null, fallbackReason: reason, errorDetail: detail };
  }
}

/** Force a re-read on next call. Used by tests; not wired to a runtime
 *  endpoint — operator rotation flow is "restart the FA". */
export function resetRansomwareLiveApiKeyCache(): void {
  cachedKey = undefined;
  cachedFallbackReason = null;
  cachedErrorDetail = null;
}
