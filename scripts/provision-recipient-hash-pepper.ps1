<#
.SYNOPSIS
  Provision (first deploy) or rotate (operator-triggered) the recipient-hash
  pepper secret in Key Vault.

.DESCRIPTION
  ADR-0030 §C.21 / WS10 L12. The pepper is a 32-byte cryptographically-random
  secret used by `api/src/lib/reportEmail.ts` to defend the
  `recipientHashSaltedV2` audit fingerprint against rainbow-table attacks on
  an audit-blob leak.

  Operating modes:
    * `-Mode Provision`  — write the secret only if it does not already
                           exist. Idempotent + safe to run on every deploy.
    * `-Mode Rotate`     — write a NEW secret VERSION regardless of
                           existing state. Operator-triggered (incident
                           response, departing operator with KV access).
                           After rotation, restart the Function App so the
                           module-scope pepper cache picks up the new value.

  Auth: relies on the caller's `az login` context. The caller MUST have
  `Key Vault Secrets Officer` on the target vault. The `infra/modules/
  keyvault.bicep` deployer-grant covers operator (user) and azd (SP) cases
  when `AZURE_DEPLOYER_OBJECT_ID` is set in the azd env.

  Field migration: existing audit chain lines stay valid forever (chain
  integrity per ADR-0015 §6). New `report.email.intent` lines emitted after
  the FA restart will carry the peppered `recipientHashSaltedV2` field
  instead of the legacy `recipientHashSalted`. Chain readers branch on
  field presence (ADR-0030 §C.21).

.PARAMETER KeyVaultName
  The KV name (e.g. `kv-aegis-dev-uks`). Sourced from azd env
  `AZURE_KEY_VAULT_NAME` if unspecified.

.PARAMETER SecretName
  The secret name. Defaults to `recipient-hash-pepper` (matches the
  `infra/modules/functions.bicep` app-setting default).

.PARAMETER Mode
  `Provision` (default — write only if absent) or `Rotate` (always write a
  new version).

.PARAMETER FunctionAppName
  Optional — when supplied, the script restarts the Function App at the end
  so the module-scope pepper cache picks up the new value. Required for
  `-Mode Rotate` to produce visible behaviour; optional for `-Mode Provision`
  on a brand-new deploy because the FA has not yet served any requests.

.PARAMETER ResourceGroupName
  Required when `-FunctionAppName` is supplied.

.EXAMPLE
  # First deploy after `azd provision` lands the new RBAC:
  ./scripts/provision-recipient-hash-pepper.ps1 `
      -KeyVaultName kv-aegis-dev-uks `
      -FunctionAppName func-aegis-api-dev-2435ae1d `
      -ResourceGroupName rg-aegis-dev-uks

.EXAMPLE
  # Rotation:
  ./scripts/provision-recipient-hash-pepper.ps1 -Mode Rotate `
      -KeyVaultName kv-aegis-dev-uks `
      -FunctionAppName func-aegis-api-dev-2435ae1d `
      -ResourceGroupName rg-aegis-dev-uks

.NOTES
  This script writes to Key Vault and (optionally) restarts the Function App.
  Use `-WhatIf` for a dry-run. Exit code 0 on success; non-zero on failure
  (KV write failed, az CLI not authenticated, etc.).
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $KeyVaultName,
    [string] $SecretName = 'recipient-hash-pepper',
    [ValidateSet('Provision', 'Rotate')]
    [string] $Mode = 'Provision',
    [string] $FunctionAppName,
    [string] $ResourceGroupName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string] $Message)
    [Console]::Error.WriteLine("[provision-pepper] $Message")
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
    throw "SecretName must be non-empty (default is 'recipient-hash-pepper')."
}

# L12-FT-FT-PS1-WARN — drift guard for manual invocations.
# When `-SecretName` was NOT explicitly passed (using the PS1 default) AND
# the azd env carries a Bicep-emitted canonical (`RECIPIENT_HASH_PEPPER_SECRET_NAME`)
# that differs, warn the operator to align. The PS1 default still matches
# Bicep canonical today, so this is silent in the happy path; the warn
# fires only when a future Bicep var edit drifts from the PS1 default.
if (-not $PSBoundParameters.ContainsKey('SecretName') -and `
    -not [string]::IsNullOrWhiteSpace($env:RECIPIENT_HASH_PEPPER_SECRET_NAME) -and `
    $env:RECIPIENT_HASH_PEPPER_SECRET_NAME -ne $SecretName) {
    Write-Warning ("(L12-FT-FT-PS1-WARN) -SecretName not specified; using PS1 default '{0}'. " +
        "Bicep canonical from azd env is '{1}'. The two surfaces have drifted. " +
        "Re-run with -SecretName '{1}' to align with the deployed ABAC, or " +
        "update the PS1 default to match if the rename is intentional." -f $SecretName, $env:RECIPIENT_HASH_PEPPER_SECRET_NAME)
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
    # `az keyvault secret show` returns non-zero on 404 AND on any other
    # error (permissions, vault not found). Distinguish via the stderr text.
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

# ---- Generate cryptographically-random 32-byte secret + base64 encode ----
# .NET's RandomNumberGenerator is the documented crypto-strong source on
# PowerShell 7+. Avoid Get-Random — documented as non-cryptographic.
$bytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
} finally {
    $rng.Dispose()
}
$pepperValue = [Convert]::ToBase64String($bytes)

if (-not $PSCmdlet.ShouldProcess("$KeyVaultName/$SecretName", "Set secret (mode=$Mode)")) {
    Write-Step "Dry-run (-WhatIf): would write a new secret version."
    exit 0
}

# ---- Write to KV ----
# `az keyvault secret set` ALWAYS creates a new version, never edits existing
# versions in place. Provision and Rotate use the same call; difference is
# only the existence check above.
#
# IMPORTANT: pass the value via a temp file to avoid leaking it via the
# process command line (visible in `ps`, audit logs, etc.). az supports
# --file for this exact reason.
$tmp = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($tmp, $pepperValue, [System.Text.Encoding]::UTF8)
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
    $pepperValue = $null
}

# ---- Optional Function App restart ----
$restarted = $false
if (-not [string]::IsNullOrWhiteSpace($FunctionAppName)) {
    if ($PSCmdlet.ShouldProcess("$ResourceGroupName/$FunctionAppName", 'Restart Function App so the pepper cache picks up the new value')) {
        Write-Step "Restarting Function App $FunctionAppName so the module-scope pepper cache picks up the new value."
        $restartOutput = & az functionapp restart --name $FunctionAppName --resource-group $ResourceGroupName --output none 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "az functionapp restart failed: $restartOutput"
        }
        $restarted = $true
        Write-Step "Function App restarted. New intent lines will carry recipientHashSaltedV2 with the new pepper from first send onward."
    }
} else {
    Write-Step "No -FunctionAppName supplied. Skipping FA restart — operator must restart manually for the new pepper to take effect (the module-scope cache holds the old value until process restart)."
}

Write-Output @{
    keyVaultName = $KeyVaultName
    secretName = $SecretName
    mode = $Mode
    action = if ($secretExists) { 'rotated_new_version' } else { 'provisioned_first' }
    functionAppRestarted = $restarted
} | ConvertTo-Json -Compress
