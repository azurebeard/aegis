<#
.SYNOPSIS
  Provision (first deploy) or rotate (operator-triggered) the report-share
  signing key secret in Key Vault.

.DESCRIPTION
  ADR-0030 §C.22 chunk 4 — the HMAC-SHA256 signing key used by
  `api/src/lib/reportShareToken.ts` to mint and verify the time-limited
  tokens embedded in the email body's "Open full report" link. Without
  this secret the share-link feature is offline (`buildShareUrlOrAievent`
  in `reportEmail.ts` returns null and the email body falls back to the
  legacy KPI shape with an AIEVENT `report.email.share_link.fallback`).

  Operating modes:
    * `-Mode Provision`  — write the secret only if it does not already
                           exist. Idempotent + safe to run on every deploy.
    * `-Mode Rotate`     — write a NEW secret VERSION regardless of
                           existing state. Operator-triggered (incident
                           response, key compromise, calendar rotation).
                           Rotation INVALIDATES all outstanding share
                           links — any link emailed before the rotation
                           returns 400 invalid_token after rotation,
                           which is the intended behaviour (recipients
                           must request a fresh email).

  Auth: relies on the caller's `az login` context. The caller MUST have
  `Key Vault Secrets Officer` on the target vault. The
  `infra/modules/keyvault.bicep` deployer-grant covers operator (user)
  and azd (SP) cases when `AZURE_DEPLOYER_OBJECT_ID` is set in the azd
  env (same grant the recipient-hash pepper provisioning script uses).

  After a rotation, restart the Function App so the module-scope
  `reportShareSigningKey.ts` cache picks up the new key value. The
  script does this automatically when `-FunctionAppName` is supplied.

.PARAMETER KeyVaultName
  The KV name (e.g. `kv-aegis-dev-weu`). Sourced from azd env
  `AZURE_KEY_VAULT_NAME` if unspecified.

.PARAMETER SecretName
  The secret name. Defaults to `report-share-signing-key` (matches the
  `infra/modules/functions.bicep` app-setting default).

.PARAMETER Mode
  `Provision` (default — write only if absent) or `Rotate` (always
  write a new version).

.PARAMETER FunctionAppName
  Optional — when supplied, the script restarts the Function App at the
  end so the module-scope signing-key cache picks up the new value.
  Required for `-Mode Rotate` to produce visible behaviour; optional for
  `-Mode Provision` on a brand-new deploy because the FA has not yet
  served any requests.

.PARAMETER ResourceGroupName
  Required when `-FunctionAppName` is supplied.

.EXAMPLE
  # First deploy after `azd provision` lands the new RBAC:
  ./scripts/provision-report-share-signing-key.ps1 `
      -KeyVaultName kv-aegis-dev-weu `
      -FunctionAppName func-aegis-api-dev-weu `
      -ResourceGroupName rg-aegis-dev-weu

.EXAMPLE
  # Rotation (e.g. quarterly calendar rotation):
  ./scripts/provision-report-share-signing-key.ps1 -Mode Rotate `
      -KeyVaultName kv-aegis-dev-weu `
      -FunctionAppName func-aegis-api-dev-weu `
      -ResourceGroupName rg-aegis-dev-weu

.NOTES
  This script writes to Key Vault and (optionally) restarts the
  Function App. Use `-WhatIf` for a dry-run. Exit code 0 on success;
  non-zero on failure (KV write failed, az CLI not authenticated, etc.).

  Rotation invalidates all outstanding share links — communicate the
  rotation to operators relying on long-TTL links BEFORE running it.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $KeyVaultName,
    [string] $SecretName = 'report-share-signing-key',
    [ValidateSet('Provision', 'Rotate')]
    [string] $Mode = 'Provision',
    [string] $FunctionAppName,
    [string] $ResourceGroupName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string] $Message)
    [Console]::Error.WriteLine("[provision-share-key] $Message")
}

# ---- Parameter resolution ----
if ([string]::IsNullOrWhiteSpace($KeyVaultName)) {
    # azd persists the Bicep output as `KEY_VAULT_NAME` (no AZURE_ prefix).
    # Fall back to either name so manual operator invocations work whether
    # the env is sourced from `azd env get-values` or any custom export.
    $KeyVaultName = if (-not [string]::IsNullOrWhiteSpace($env:KEY_VAULT_NAME)) {
        $env:KEY_VAULT_NAME
    } else {
        $env:AZURE_KEY_VAULT_NAME
    }
}
if ([string]::IsNullOrWhiteSpace($KeyVaultName)) {
    throw "KeyVaultName is required. Pass -KeyVaultName or set KEY_VAULT_NAME (Bicep output) or AZURE_KEY_VAULT_NAME."
}
if ([string]::IsNullOrWhiteSpace($SecretName)) {
    throw "SecretName must be non-empty (default is 'report-share-signing-key')."
}

# L12-FT-FT-PS1-WARN — drift guard for manual invocations.
# When `-SecretName` was NOT explicitly passed (using the PS1 default) AND
# the azd env carries a Bicep-emitted canonical (`REPORT_SHARE_SIGNING_KEY_SECRET_NAME`)
# that differs, warn the operator to align. Silent in the happy path; the
# warn fires only when a future Bicep var edit drifts from the PS1 default.
if (-not $PSBoundParameters.ContainsKey('SecretName') -and `
    -not [string]::IsNullOrWhiteSpace($env:REPORT_SHARE_SIGNING_KEY_SECRET_NAME) -and `
    $env:REPORT_SHARE_SIGNING_KEY_SECRET_NAME -ne $SecretName) {
    Write-Warning ("(L12-FT-FT-PS1-WARN) -SecretName not specified; using PS1 default '{0}'. " +
        "Bicep canonical from azd env is '{1}'. The two surfaces have drifted. " +
        "Re-run with -SecretName '{1}' to align with the deployed ABAC, or " +
        "update the PS1 default to match if the rename is intentional." -f $SecretName, $env:REPORT_SHARE_SIGNING_KEY_SECRET_NAME)
}
if (-not [string]::IsNullOrWhiteSpace($FunctionAppName) -and [string]::IsNullOrWhiteSpace($ResourceGroupName)) {
    throw "-FunctionAppName requires -ResourceGroupName so the restart can target the right resource."
}

# ---- az CLI sanity check ----
$azAccount = & az account show --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "az CLI is not authenticated. Run 'az login' first. Output: $azAccount"
}

Write-Step "Mode=$Mode  KV=$KeyVaultName  Secret=$SecretName"

# ---- Existence check ----
$secretShow = & az keyvault secret show --vault-name $KeyVaultName --name $SecretName --output json 2>&1
$secretExists = ($LASTEXITCODE -eq 0)
if ($secretExists) {
    Write-Step "Existing secret found. Latest version: $(($secretShow | ConvertFrom-Json).id)"
} else {
    if ($secretShow -match 'SecretNotFound|was not found') {
        Write-Step "Secret does not yet exist."
    } else {
        throw "az keyvault secret show failed unexpectedly. Output: $secretShow"
    }
}

# ---- Provision/Rotate decision ----
if ($Mode -eq 'Provision' -and $secretExists) {
    Write-Step "Mode=Provision and secret already exists — no-op. Use -Mode Rotate to force a new version."
    Write-Output @{
        keyVaultName = $KeyVaultName
        secretName = $SecretName
        mode = $Mode
        action = 'no_op_existing'
        functionAppRestarted = $false
    } | ConvertTo-Json -Compress
    exit 0
}

# ---- Generate cryptographically-random 32-byte key + base64 encode ----
# .NET's RandomNumberGenerator is the documented crypto-strong source on
# PowerShell 7+. Avoid Get-Random — documented as non-cryptographic.
$bytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
} finally {
    $rng.Dispose()
}
$keyValue = [Convert]::ToBase64String($bytes)

if (-not $PSCmdlet.ShouldProcess("$KeyVaultName/$SecretName", "Set secret (mode=$Mode)")) {
    Write-Step "Dry-run (-WhatIf): would write a new secret version."
    exit 0
}

# ---- Write to KV ----
# `az keyvault secret set` ALWAYS creates a new version, never edits
# existing versions in place. Provision and Rotate use the same call;
# difference is only the existence check above.
#
# IMPORTANT: pass the value via a temp file to avoid leaking it via the
# process command line (visible in `ps`, audit logs, etc.). az supports
# --file for this exact reason.
$tmp = [System.IO.Path]::GetTempFileName()
try {
    # WS10 chunk-4 advisory 2: restrict temp-file permissions to the
    # current user BEFORE writing the secret. GetTempFileName() creates
    # the file with default umask; on shared Linux hosts that briefly
    # leaves the secret world-readable in the gap between create + write.
    # On Windows %TEMP% per-user dirs are already user-locked; chmod is a
    # no-op there. Silenced because `chmod` may not exist on Windows
    # PowerShell paths.
    if ($IsLinux -or $IsMacOS) {
        & chmod 600 $tmp 2>$null
    }
    [System.IO.File]::WriteAllText($tmp, $keyValue, [System.Text.Encoding]::UTF8)
    $setOutput = & az keyvault secret set --vault-name $KeyVaultName --name $SecretName --file $tmp --output json 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az keyvault secret set failed: $setOutput"
    }
    $newSecret = $setOutput | ConvertFrom-Json
    Write-Step "Wrote new secret version: $($newSecret.id)"
} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    # Best-effort scrub of the variable in memory (PowerShell GC is
    # non-deterministic; this is a tidy-up, not a security boundary).
    $keyValue = $null
}

# ---- Optional Function App restart ----
$restarted = $false
if (-not [string]::IsNullOrWhiteSpace($FunctionAppName)) {
    if ($PSCmdlet.ShouldProcess("$ResourceGroupName/$FunctionAppName", 'Restart Function App so the signing-key cache picks up the new value')) {
        Write-Step "Restarting Function App $FunctionAppName so the module-scope signing-key cache picks up the new value."
        $restartOutput = & az functionapp restart --name $FunctionAppName --resource-group $ResourceGroupName --output none 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "az functionapp restart failed: $restartOutput"
        }
        $restarted = $true
        Write-Step "Function App restarted. New share-link tokens minted from the next email send will use the new key; tokens from before the rotation will fail 400 invalid_token."
    }
} else {
    Write-Step "No -FunctionAppName supplied. Skipping FA restart — operator must restart manually for the new key to take effect (the module-scope cache holds the old value until process restart). After rotation, this is required for the new key to take effect on the running FA instance."
}

Write-Output @{
    keyVaultName = $KeyVaultName
    secretName = $SecretName
    mode = $Mode
    action = if ($secretExists) { 'rotated_new_version' } else { 'provisioned_first' }
    functionAppRestarted = $restarted
} | ConvertTo-Json -Compress
