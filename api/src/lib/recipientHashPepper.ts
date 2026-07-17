// ADR-0030 §C.20 / WS10 Slice 1(b) MED #1 follow-up — recipient-hash pepper.
//
// Defends the `recipientHashSalted` audit-line fingerprint against rainbow-
// table attacks on an audit-blob leak. Pre-pepper, the hash was
// `sha256(tenantId : canonical-recipients)` — tenant-bound but not protected
// against an attacker who guesses recipient emails (board distribution lists
// tend to be predictable). Peppered, the hash is
// `sha256(pepper : tenantId : canonical-recipients)` where `pepper` is a
// 256-bit random secret in Key Vault, not present in the audit blob.
//
// Field migration (operator decision §10.74 carry-forward L12):
//   - Pre-pepper intent lines carry `recipientHashSalted` (legacy).
//   - Post-pepper intent lines carry `recipientHashSaltedV2` (pepper-based),
//     and DO NOT emit the legacy field — chain readers branch on
//     field presence to know which scheme they're reading.
//   - Historical chain integrity is preserved (no re-hashing).
//
// Rotation (operator decision §10.74 carry-forward L12):
//   - On-demand only via `scripts/rotate-recipient-hash-pepper.ps1`. The
//     script writes a new secret VERSION; the loader reads the latest
//     version. New intents from that point use the new pepper. Old intent
//     lines remain valid (the hash is a fingerprint, not a signature —
//     forensic replay just needs to know "this hash was peppered with the
//     pepper of the day").
//   - No scheduled auto-rotation. Pepper rotation is an operator action.
//
// Fail-soft posture (default): if KV configuration is incomplete OR a KV
// read fails, the loader returns `null` and the orchestrator falls back to
// the legacy (non-peppered) hash. Pepper is defense-in-depth — a send must
// never be gated on KV availability. The fallback path emits an `AIEVENT`
// so the operator's telemetry surfaces the degraded posture.
//
// Hard-fail posture: when `RECIPIENT_HASH_PEPPER_REQUIRED` is
// the literal string `"true"` (case-insensitive, whitespace-trimmed), the
// loader throws `RecipientHashPepperRequiredError` instead of returning a
// null pepper. Intended for prod after pepper provisioning has been
// confirmed live — converts a silent fail-soft posture into a loud 502 so
// the operator finds out about KV regressions before the audit chain drifts
// back to the legacy field. Default off; dev keeps the fail-soft flow for
// KV-down developer workflow.

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

interface PepperConfig {
  readonly kvName: string;
  readonly secretName: string;
  readonly miClientId: string;
}

function readPepperConfig(env: NodeJS.ProcessEnv = process.env): PepperConfig | null {
  const kvName = (env.RECIPIENT_HASH_PEPPER_KV_NAME ?? "").trim();
  const secretName = (env.RECIPIENT_HASH_PEPPER_KV_SECRET_NAME ?? "").trim();
  const miClientId = (env.MAIL_SENDER_MI_CLIENT_ID ?? "").trim();
  if (!kvName || !secretName || !miClientId) return null;
  return { kvName, secretName, miClientId };
}

// Module-scope cache. `undefined` = not yet attempted; `null` = attempted +
// unavailable (env unset OR KV read failed); string = the live pepper.
// FA instances are long-lived between cold starts; caching per instance
// avoids hammering KV on every send. Rotation requires an FA restart
// (`az functionapp restart`) to pick up — documented in the rotation
// runbook (§C.21).
let cachedPepper: string | null | undefined = undefined;
let cachedLastError: string | null = null;

export interface LoadPepperResult {
  readonly pepper: string | null;
  /** Reason the pepper is null, if any. Surface this in AIEVENT for ops. */
  readonly fallbackReason?:
    | "env_unset"
    | "kv_read_failed"
    | "empty_secret";
  /** Diagnostic message for the kv_read_failed case (scrubbed of PII). */
  readonly errorDetail?: string;
}

/** Thrown by `loadRecipientHashPepper` when `RECIPIENT_HASH_PEPPER_REQUIRED`
 *  is set AND a pepper could not be loaded. Caller maps to a 502 — the send
 *  must not proceed on the legacy hash when prod policy says peppered. */
export class RecipientHashPepperRequiredError extends Error {
  readonly fallbackReason: "env_unset" | "kv_read_failed" | "empty_secret";
  readonly errorDetail?: string;
  constructor(
    fallbackReason: "env_unset" | "kv_read_failed" | "empty_secret",
    errorDetail?: string,
  ) {
    super(
      `Recipient-hash pepper is required (RECIPIENT_HASH_PEPPER_REQUIRED=true) but unavailable: ${fallbackReason}${errorDetail ? ` (${errorDetail})` : ""}`,
    );
    this.name = "RecipientHashPepperRequiredError";
    this.fallbackReason = fallbackReason;
    if (errorDetail !== undefined) this.errorDetail = errorDetail;
  }
}

/** True iff `RECIPIENT_HASH_PEPPER_REQUIRED` is the literal string `"true"`
 *  (case-insensitive, whitespace-trimmed). Anything else — including unset,
 *  empty, `"1"`, `"yes"` — is treated as false. Strict match avoids the
 *  "operator set it to `1` expecting true, got fail-soft" trap; the env-var
 *  contract is documented as literal `"true"` only. */
function isPepperRequired(env: NodeJS.ProcessEnv): boolean {
  const raw = env.RECIPIENT_HASH_PEPPER_REQUIRED;
  if (raw === undefined) return false;
  return raw.trim().toLowerCase() === "true";
}

/** Lazy load the recipient-hash pepper from Key Vault. Idempotent + cached
 *  per FA instance for the lifetime of the warm process. Throws
 *  `RecipientHashPepperRequiredError` when `RECIPIENT_HASH_PEPPER_REQUIRED`
 *  is `"true"` AND the pepper cannot be loaded. */
export async function loadRecipientHashPepper(): Promise<LoadPepperResult> {
  const result = await loadInternal();
  if (result.pepper === null && isPepperRequired(process.env)) {
    throw new RecipientHashPepperRequiredError(
      result.fallbackReason ?? "env_unset",
      result.errorDetail,
    );
  }
  return result;
}

async function loadInternal(): Promise<LoadPepperResult> {
  if (cachedPepper !== undefined) {
    if (cachedPepper === null) {
      return {
        pepper: null,
        fallbackReason: cachedLastError ? "kv_read_failed" : "env_unset",
        ...(cachedLastError ? { errorDetail: cachedLastError } : {}),
      };
    }
    return { pepper: cachedPepper };
  }
  const config = readPepperConfig();
  if (!config) {
    cachedPepper = null;
    return { pepper: null, fallbackReason: "env_unset" };
  }
  try {
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: config.miClientId,
    });
    const client = new SecretClient(`https://${config.kvName}.vault.azure.net`, credential);
    // Read latest version. The secretName is the operator-chosen identifier
    // (default `recipient-hash-pepper`); Key Vault returns the most recent
    // enabled version automatically.
    const secret = await client.getSecret(config.secretName);
    const value = (secret.value ?? "").trim();
    if (value.length === 0) {
      cachedPepper = null;
      return { pepper: null, fallbackReason: "empty_secret" };
    }
    cachedPepper = value;
    return { pepper: value };
  } catch (err) {
    // Scrub Azure-error payload before stashing. Class name + statusCode
    // are stable; the message often includes the KV URL + auth metadata
    // which we don't want surfacing in an AIEVENT.
    const e = err as { name?: string; statusCode?: number };
    cachedLastError = `${e?.name ?? "Error"}${e?.statusCode ? ` ${e.statusCode}` : ""}`;
    cachedPepper = null;
    return { pepper: null, fallbackReason: "kv_read_failed", errorDetail: cachedLastError };
  }
}

/** Force a re-read on next call. Used by tests and (in principle) by an
 *  operator-triggered hot-reload endpoint — not wired in v1 since rotation
 *  flow is "restart the FA". */
export function resetRecipientHashPepperCache(): void {
  cachedPepper = undefined;
  cachedLastError = null;
}
