// ADR-0030 §C.22 (forthcoming) — Key Vault loader for the HMAC-SHA256
// signing key that mints and verifies report share-link tokens
// (`reportShareToken.ts`).
//
// Mirrors the recipient-hash-pepper loader (`recipientHashPepper.ts`):
//   - Module-scope cache per FA instance.
//   - Fail-soft posture: env-unset / KV-down / empty-secret all return
//     null with a structured `fallbackReason`. Caller decides what to do —
//     the share endpoint maps null to 503 (the feature is offline), the
//     email-issuer maps null to "send the email without a link"
//     (degraded posture with AIEVENT).
//   - errorDetail is the scrubbed classname + statusCode, never the raw
//     KV URL or auth metadata.
//
// Auth: always reads under the api-reader MI (`API_READER_MI_CLIENT_ID`).
// Both the share endpoint (admin-less GET) and the email-issuer (running
// in the mail-sender code path) load through this single MI to keep the
// KV grant surface minimal. The api-reader MI is granted Key Vault Secrets
// User on the signing-key secret in `infra/modules/keyvault.bicep`
// (chunk 4).
//
// Rotation: operator-triggered via the chunk-4 provisioning script. A
// rotation writes a new secret VERSION; the loader reads the latest. New
// tokens minted after the rotation will not verify against the prior key,
// invalidating every outstanding share link. Operator must restart the
// Function App after rotation so the module-scope cache picks up the new
// value.

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

interface KeyConfig {
  readonly kvName: string;
  readonly secretName: string;
  readonly miClientId: string;
}

function readKeyConfig(env: NodeJS.ProcessEnv = process.env): KeyConfig | null {
  const kvName = (env.REPORT_SHARE_SIGNING_KEY_KV_NAME ?? "").trim();
  const secretName = (env.REPORT_SHARE_SIGNING_KEY_KV_SECRET_NAME ?? "").trim();
  const miClientId = (env.API_READER_MI_CLIENT_ID ?? "").trim();
  if (!kvName || !secretName || !miClientId) return null;
  return { kvName, secretName, miClientId };
}

let cachedKey: Buffer | null | undefined = undefined;
let cachedLastError: string | null = null;

export interface LoadShareSigningKeyResult {
  /** 32+ byte HMAC key, or null when unavailable. Buffer (not string) so
   *  the verifier can pass it directly to `crypto.createHmac`. */
  readonly key: Buffer | null;
  readonly fallbackReason?: "env_unset" | "kv_read_failed" | "empty_secret" | "too_short";
  readonly errorDetail?: string;
}

/** Lazy load the share-link signing key from Key Vault. Idempotent +
 *  cached per FA instance for the lifetime of the warm process. */
export async function loadReportShareSigningKey(): Promise<LoadShareSigningKeyResult> {
  if (cachedKey !== undefined) {
    if (cachedKey === null) {
      return {
        key: null,
        fallbackReason: cachedLastError ? "kv_read_failed" : "env_unset",
        ...(cachedLastError ? { errorDetail: cachedLastError } : {}),
      };
    }
    return { key: cachedKey };
  }
  const config = readKeyConfig();
  if (!config) {
    cachedKey = null;
    return { key: null, fallbackReason: "env_unset" };
  }
  try {
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: config.miClientId,
    });
    const client = new SecretClient(`https://${config.kvName}.vault.azure.net`, credential);
    const secret = await client.getSecret(config.secretName);
    const value = (secret.value ?? "").trim();
    if (value.length === 0) {
      cachedKey = null;
      return { key: null, fallbackReason: "empty_secret" };
    }
    // Operator stores the key as base64. Decode and require at least 32
    // bytes (256 bits) — anything shorter is a misconfiguration that
    // shouldn't silently downgrade HMAC strength.
    let decoded: Buffer;
    try {
      decoded = Buffer.from(value, "base64");
    } catch {
      cachedKey = null;
      return { key: null, fallbackReason: "empty_secret" };
    }
    if (decoded.length < 32) {
      cachedKey = null;
      return { key: null, fallbackReason: "too_short" };
    }
    cachedKey = decoded;
    return { key: decoded };
  } catch (err) {
    const e = err as { name?: string; statusCode?: number };
    cachedLastError = `${e?.name ?? "Error"}${e?.statusCode ? ` ${e.statusCode}` : ""}`;
    cachedKey = null;
    return { key: null, fallbackReason: "kv_read_failed", errorDetail: cachedLastError };
  }
}

/** Force a re-read on next call. Used by tests; operator rotation flow is
 *  "restart the FA", not a hot-reload. */
export function resetReportShareSigningKeyCache(): void {
  cachedKey = undefined;
  cachedLastError = null;
}
