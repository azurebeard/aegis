#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Idempotent bootstrap for the XDR Hub Entra ID app registrations (ADR-0035).

.DESCRIPTION
    Idempotent Entra ID bootstrap for the XDR Hub. Post-§10.72 the script's
    responsibility is the ADR-0035 Phase B native-auth split-app set; the
    legacy combined app (`app-aegis-<env>-<tenant-short>`) and SWA Easy
    Auth client-secret rotation are retired and no longer reconciled.

    The two split-app registrations:
    - `app-aegis-api-<env>-<tenant-short>` — resource-only, owns `admin` +
      `reader` App Roles, exposes the `api.access` delegated scope,
      `requestedAccessTokenVersion=2` (so the FA's authMiddleware sees the
      v2.0 issuer claim).
    - `app-aegis-spa-<env>-<tenant-short>` — SPA platform redirect URIs,
      requiredResourceAccess to API + Graph `User.Read`, no client secret
      (public-client PKCE).

    Responsibilities:
    - Create/update API app FIRST (owns App Roles + the `api.access`
      scope; SPA's requiredResourceAccess references the API's appId).
    - Create/update SPA app SECOND (links to the API via
      requiredResourceAccess).
    - Grant tenant-wide admin consent on SPA → API `api.access`.
    - Declare `reader` and `admin` App Roles with stable, salted-hash GUIDs
      on both the API SP and the SPA SP (separate salt per display-name,
      no GUID collision per WS10 SEC-I-03).
    - Assign the `admin` App Role to the seed admin user on BOTH the API
      SP and the SPA SP. The SPA-side assignment is what populates the
      ID-token `roles` claim that SPA role-gates read.
    - Optional Microsoft Graph app-role grant to the ingest MI
      (ADR-0010 §4).
    - Print a structured summary (no secret values).

.PARAMETER Env
    Environment token: dev, test, or prod. Drives the app-reg name.

.PARAMETER TenantId
    Deployer's Entra tenant ID.

.PARAMETER AdminEmail
    UPN (or email) of the user who gets the `admin` App Role on first run.
    Looked up against `userPrincipalName`, then `mail`, then `otherMails`.

.PARAMETER AdminUpn
    Optional. When supplied, takes priority over -AdminEmail for the tenant
    directory lookup. Use this for the common "external email + internal
    UPN" case: -AdminEmail ben@azurebeard.co.uk (external, used for any
    downstream contact metadata) while -AdminUpn bth.priv@contoso.onmicrosoft.com
    is the tenant UPN that actually resolves to the Entra user object.
    The lookup uses `userPrincipalName eq <AdminUpn>` exclusively — no
    otherMails fallback, since the UPN is authoritative for the tenant.

.PARAMETER KeyVaultName
    Name of the Key Vault that stores the client secret.

.PARAMETER SwaHostname
    Static Web App default hostname, e.g. `stapp-aegis-dev-uks.azurestaticapps.net`.

.PARAMETER IngestMiObjectId
    Object ID (principal ID) of the ingest user-assigned managed identity's service principal.
    When supplied, the script grants Microsoft Graph application permissions from
    $RequiredGraphScopes to this MI (ADR-0010). Omit for Phase-1/2 deployments that
    pre-date the ingest MI.

.PARAMETER RequiredGraphScopes
    List of Microsoft Graph application-permission values to grant to the ingest MI.
    Default: 'SecurityEvents.Read.All' (sole scope for build-order step 3, ADR-0010).

.PARAMETER FunctionAppName
    Name of the Function App to restart after Graph grants. Restarting invalidates the
    IMDS managed-identity token cache so the new Graph app role is observed on the next
    Timer fire (closes the SEC-M-ADR-10-01 cache-lag race).

.PARAMETER ResourceGroupName
    Resource group that hosts the Function App; required alongside -FunctionAppName.

.PARAMETER RevokeGraphGrants
    Remove every Microsoft Graph app-role assignment previously made by this script to the
    ingest MI. Used by teardown and for scope-rollback.

.PARAMETER RequireAdminUserResolved
    Strict-mode switch. When set, the script fails if neither -AdminUpn nor
    -AdminEmail resolves to an Entra user — silently shipping a deployment with
    no admin App Role assigned is a common footgun (a typo in AZURE_ADMIN_UPN
    becomes a no-op WARNING in the legacy behaviour; this flag converts the
    warning into a throw). The summary JSON is still emitted BEFORE the throw
    (SEC-M-STEP3-INFRA-01 precedent) so the azd postprovision hook's
    BOOTSTRAP_JSON capture succeeds regardless.

    Default behaviour by -Env:
      prod        => strict ON  (implicit; can be opted out via
                                  -AllowMissingAdminInProd)
      dev / test  => strict OFF (explicit -RequireAdminUserResolved still works)

    On prod this flag is REDUNDANT — the implicit default is already strict.
    Keep using it on dev/test runs where you want fail-fast on a typo.

.PARAMETER AllowMissingAdminInProd
    Emergency opt-out from the prod-implicit strict default. Use when you must
    re-run `azd provision` against prod KNOWING the admin user is unresolvable
    (e.g. UPN renamed mid-migration) and you'll assign the App Role via portal
    afterwards. Leave unset normally — the strict prod default is the right
    posture.

.PARAMETER WhatIf
    Do not mutate anything; print the actions that would be taken.

.NOTES
    Requires PowerShell 7+ and the Microsoft.Graph PowerShell SDK.
    Required modules:
      Microsoft.Graph.Applications, Microsoft.Graph.Identity.DirectoryManagement,
      Microsoft.Graph.Users, Microsoft.Graph.Identity.SignIns
      (Identity.SignIns added in ADR-0035 Phase B for tenant-wide consent grant).
    Deployer must be signed in to Graph with scopes:
      Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All,
      Directory.ReadWrite.All, DelegatedPermissionGrant.ReadWrite.All
      (DelegatedPermissionGrant.ReadWrite.All added in ADR-0035 Phase B for the
      tenant-wide SPA → API api.access consent grant).
    The caller must also hold Key Vault Secrets Officer (or broader) on the target vault.
    Graph grants additionally require Application Administrator (or Privileged Role Admin)
    on the tenant. Run this script from a dedicated admin account per ADR-0010 §3 (deployer
    session minimisation) — do NOT use a day-to-day account.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('dev', 'test', 'prod')]
    [string]$Env,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AdminEmail,

    [Parameter(Mandatory = $false)]
    [string]$AdminUpn = '',

    [Parameter(Mandatory = $false)]
    [string]$KeyVaultName = '',

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SwaHostname,

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$IngestMiObjectId = '',

    [Parameter(Mandatory = $false)]
    [string[]]$RequiredGraphScopes = @(
        'SecurityEvents.Read.All',    # step 3 — Secure Score (ADR-0010)
        'SecurityIncident.Read.All',  # step 4 — Defender XDR Incidents (ADR-0013)
        'IdentityRiskyUser.Read.All', # step 6 — EntraRisk riskyUsers (ADR-0023)
        'Organization.Read.All',      # step 6 — P2 licence probe (ADR-0023 §7)
        'User.Read.All',              # Phase 8B — /v1.0/users base read (ADR-0034 §5)
        'AuditLog.Read.All',          # Phase 8B — `signInActivity` property requires this scope IN ADDITION to User.Read.All per Microsoft Graph docs (https://learn.microsoft.com/en-us/graph/api/resources/signinactivity). Pre-declared in ADR-0034 §5 for Phase 8C (geo-fenced sign-ins) but pulled forward to 8B by the signInActivity dependency that ADR-0034 missed in v1. Same scope serves both consumers.
        'Application.Read.All',       # Phase 8E — `/identities` page on-demand SP enumeration (ADR-0034 §5 + §7). Read-only enumeration of `/v1.0/servicePrincipals`; no write surface (deny-list at ADR-0013 §3 still rejects the `*.ReadWrite.*` regex which this scope does NOT match).
        'Policy.Read.All'             # Phase 8D — Conditional Access policy state ingest (ADR-0034 §3.3 + §5). Read-only `/v1.0/identity/conditionalAccess/policies` walk; ADR-0013 §3 deny-list (`*.ReadWrite.*`) does not match. Ingest cadence: hourly. Diff detection writes `ca.policy.changed` audit lines.
    ),

    [Parameter(Mandatory = $false)]
    [string]$FunctionAppName = '',

    [Parameter(Mandatory = $false)]
    [string]$ResourceGroupName = '',

    # F-fwd-5 (docs/prod-tier-dryrun-lessons-learned.md §3) — pin every `az`
    # call inside this script to a known subscription. Without this, the
    # operator's active az sub (from `az account show`) is implicit, and a
    # drift between it and azd's `AZURE_SUBSCRIPTION_ID` surfaces as a
    # `ResourceGroupNotFound` on the post-grant Function App restart.
    # Default reads `AZURE_SUBSCRIPTION_ID` from env (azd hook context
    # always sets this). Empty resolves to the active-sub behaviour, i.e.
    # the pre-fix posture — preserved so the script remains usable for
    # standalone reconciles where azd is not the entry point.
    [Parameter(Mandatory = $false)]
    [ValidatePattern('^([0-9a-fA-F-]{36})?$')]
    [string]$SubscriptionId = $env:AZURE_SUBSCRIPTION_ID,

    [Parameter(Mandatory = $false)]
    [switch]$RevokeGraphGrants,

    [Parameter(Mandatory = $false)]
    [switch]$RequireAdminUserResolved,

    [Parameter(Mandatory = $false)]
    [switch]$AllowMissingAdminInProd,

    # ADR-0030 Phase C — outbound email of report snapshots via Graph Mail.Send.
    # Object ID of the mail-sender MI's service principal (from
    # `azd env get MAIL_SENDER_MI_PRINCIPAL_ID`). When absent, Phase C is
    # skipped entirely; the mailSender MI exists in Bicep but receives no
    # Graph permissions or AAP scope (§C.5.2 inert state).
    [Parameter(Mandatory = $false)]
    [ValidatePattern('^([0-9a-fA-F-]{36})?$')]
    [string]$MailSenderMiObjectId = '',

    # UPN of the operator-provided sender mailbox. Both shared mailboxes
    # AND licensed user mailboxes are supported (ADR-0030 §C.2 / §C.19).
    # When empty, Phase C is skipped at the mailbox-validation step
    # (mailSender MI stays inert; admin endpoint returns 503 until
    # configured). Default off — operator must opt in.
    [Parameter(Mandatory = $false)]
    [string]$MailSenderUpn = '',

    # Fail-clear if Phase C wiring cannot complete. Tri-state to allow
    # explicit `true`/`false` overrides on top of the env-aware default
    # (prod → required; dev/test → optional). Empty string ('') resolves
    # to the env-aware default at runtime. ADR-0030 §C.18 dev-vs-prod
    # posture; WS10 §10.74 MED-2 fix (the previous [switch] type silently
    # ignored false-overrides via azure.yaml).
    [Parameter(Mandatory = $false)]
    [ValidateSet('', 'true', 'false')]
    [string]$MailSenderRequired = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Hygiene: prod defaults to strict admin-resolution. Explicit
# -RequireAdminUserResolved still wins for dev/test if the operator wants to
# fail-fast on a typo. -AllowMissingAdminInProd is the documented opt-out for
# a known-unresolvable admin re-run on prod (e.g. UPN renamed mid-migration).
$strictRequireAdminUser = $RequireAdminUserResolved.IsPresent -or `
    ($Env -eq 'prod' -and -not $AllowMissingAdminInProd.IsPresent)

# Status messages go to stderr so that the final ConvertTo-Json on stdout is
# the sole thing the caller (azd postprovision hook) parses.
function Write-Step {
    param([string]$Message)
    [Console]::Error.WriteLine("[bootstrap-entra] $Message")
}

function Get-TenantShortCode {
    # Stable, human-readable fragment for the app display name.
    # Uses the last 8 chars of the tenant GUID to avoid collision while keeping
    # the name readable.
    param([string]$Id)
    return ($Id -replace '-', '').Substring(24, 8).ToLower()
}

function Get-SaltedRoleGuid {
    param([string]$AppDisplayName, [string]$RoleKey)
    # Local variable deliberately named `seed` (not the built-in pipeline-input automatic).
    $salt = 'aegis-xdr-hub-app-role-v1'
    $seed = "$AppDisplayName::$RoleKey::$salt"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($seed))
    } finally {
        $sha.Dispose()
    }
    # Take first 16 bytes, format as a GUID (deterministic). Copy into a
    # freshly-allocated byte[16] so PowerShell resolves the `[guid]::new(byte[])`
    # overload instead of trying the string constructor with a coerced array.
    $guidBytes = [byte[]]::new(16)
    [array]::Copy($bytes, 0, $guidBytes, 0, 16)
    $g = [guid]::new($guidBytes)
    return $g.ToString()
}

function Get-OdataStringLiteral {
    # Safely embed a string into an OData filter — escape single quotes by
    # doubling them per OData §5.1.1.6.1. Defensive: the caller's input is
    # typically a trusted email, but we do not rely on that.
    param([string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Test-ScopeDenyList {
    <#
    .SYNOPSIS
        Reject any scope that violates the ADR-0013 §3 scope-catalogue growth policy.
    .DESCRIPTION
        XDR Hub is read-only for v1 (PROJECT_BRIEF.md §1). Any Graph scope on the
        Security / Defender namespace whose value contains 'ReadWrite' is forbidden
        in `$RequiredGraphScopes` — a deny-listed scope causes the bootstrap run to
        fail with a structured error, NOT a warning. Adding such a scope requires
        an ADR that explicitly reopens the read-only decision, which in turn
        updates this deny-list.
    #>
    param([Parameter(Mandatory = $true)] [string[]]$Scopes)

    # Regex intentionally catches every current and future `*.ReadWrite.*` variant on
    # the Security / Defender namespace (plus explicit names for belt-and-braces).
    $denyPattern = '^(Security(Events|Incident|Alert|Actions|IdentitiesHealth)|IdentityRisk(yUser|Event)|Policy|ThreatIndicators|AdvancedHunting)\.ReadWrite\.(All|OwnedBy)$'
    $explicitDenyList = @(
        'SecurityEvents.ReadWrite.All',
        'SecurityIncident.ReadWrite.All',
        'SecurityAlert.ReadWrite.All',
        'SecurityActions.ReadWrite.All',
        'ThreatIndicators.ReadWrite.OwnedBy'
    )
    $violations = @()
    foreach ($s in $Scopes) {
        if ($s -match $denyPattern -or $explicitDenyList -contains $s) {
            $violations += $s
        }
    }
    if ($violations.Count -gt 0) {
        throw "Scope-catalogue deny-list violation (ADR-0013 §3): the following scopes are forbidden under the read-only stance (PROJECT_BRIEF.md §1) and require an ADR that reopens the decision before they can be granted: $($violations -join ', ')"
    }
}

function Grant-GraphAppRolesToMi {
    <#
    .SYNOPSIS
        Idempotently grant Microsoft Graph application permissions to a user-assigned
        managed identity's service principal (ADR-0010 §4).
    .DESCRIPTION
        For each scope in $Scopes:
          - Resolves the matching appRole on the Microsoft Graph SP (by .value).
          - Skips if an assignment with that appRoleId already exists on the MI SP.
          - Otherwise creates the assignment via New-MgServicePrincipalAppRoleAssignment.
        Drift detection: lists every existing Graph-resource assignment on the MI SP,
        warns about ones not in the declared $Scopes (no removal unless caller passes
        -Revoke). Returns a list of {scope, status, appRoleId} for summary output.

        Deny-list enforcement (ADR-0013 §3): before any grant is attempted, the scope
        list is screened against Test-ScopeDenyList. A deny-listed scope (any
        `*.ReadWrite.*` on Security/Defender namespaces) fails the bootstrap run.
    #>
    param(
        [Parameter(Mandatory = $true)] [string]$MiObjectId,
        [Parameter(Mandatory = $true)] [string[]]$Scopes,
        [switch]$Revoke,
        [switch]$WhatIfPreference
    )

    # Deny-list check is unconditional — applies to forward grants AND revocations.
    # For a revoke call, the deny-list pass catches accidental attempts to reference
    # a forbidden scope by name (even for removal, we don't want deny-listed scopes
    # appearing in the audit record of `$Scopes`).
    Test-ScopeDenyList -Scopes $Scopes

    $graphAppId = '00000003-0000-0000-c000-000000000000'
    $graphSp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'" -ErrorAction Stop | Select-Object -First 1
    if (-not $graphSp) { throw "Microsoft Graph service principal (appId $graphAppId) not found in tenant." }

    # Snapshot existing Graph app-role assignments on the MI.
    $existingAssignments = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $MiObjectId -ErrorAction Stop |
        Where-Object { $_.ResourceId -eq $graphSp.Id }

    $results = @()

    if ($Revoke) {
        foreach ($a in $existingAssignments) {
            $roleName = ($graphSp.AppRoles | Where-Object { $_.Id -eq $a.AppRoleId } | Select-Object -First 1).Value
            Write-Step "REVOKE Graph app-role '$roleName' (assignmentId $($a.Id)) from MI $MiObjectId"
            if (-not $WhatIfPreference) {
                Remove-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $MiObjectId -AppRoleAssignmentId $a.Id -ErrorAction Stop
            }
            $results += [pscustomobject]@{ scope = $roleName; status = 'revoked'; appRoleId = $a.AppRoleId }
        }
        return $results
    }

    # Forward pass — grant each requested scope.
    foreach ($scopeValue in $Scopes) {
        $appRole = $graphSp.AppRoles | Where-Object { $_.Value -eq $scopeValue -and $_.AllowedMemberTypes -contains 'Application' } | Select-Object -First 1
        if (-not $appRole) {
            throw "Scope '$scopeValue' is not a Microsoft Graph application app-role on the Graph service principal."
        }
        $already = $existingAssignments | Where-Object { $_.AppRoleId -eq $appRole.Id } | Select-Object -First 1
        if ($already) {
            Write-Step "ALREADY_GRANTED '$scopeValue' to MI $MiObjectId"
            $results += [pscustomobject]@{ scope = $scopeValue; status = 'already_granted'; appRoleId = $appRole.Id }
            continue
        }
        Write-Step "GRANT '$scopeValue' to MI $MiObjectId"
        if (-not $WhatIfPreference) {
            New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $MiObjectId `
                -PrincipalId $MiObjectId `
                -ResourceId $graphSp.Id `
                -AppRoleId $appRole.Id -ErrorAction Stop | Out-Null
        }
        $results += [pscustomobject]@{ scope = $scopeValue; status = 'granted'; appRoleId = $appRole.Id }
    }

    # Drift pass — warn about extra assignments not in $Scopes.
    foreach ($a in $existingAssignments) {
        $roleName = ($graphSp.AppRoles | Where-Object { $_.Id -eq $a.AppRoleId } | Select-Object -First 1).Value
        if ($Scopes -notcontains $roleName) {
            [Console]::Error.WriteLine("[bootstrap-entra] WARNING: Drift — MI $MiObjectId has Graph app-role '$roleName' that is NOT in the declared scope list. Review, then run with -RevokeGraphGrants if it should be removed.")
            $results += [pscustomobject]@{ scope = $roleName; status = 'drift_extra'; appRoleId = $a.AppRoleId }
        }
    }

    return $results
}

# ---- Module check ----
$required = @(
    'Microsoft.Graph.Applications',
    'Microsoft.Graph.Identity.DirectoryManagement',
    'Microsoft.Graph.Users',
    'Microsoft.Graph.Identity.SignIns'  # ADR-0035 Phase B — Get-/New-MgOauth2PermissionGrant for SPA→API tenant-wide consent.
)
foreach ($m in $required) {
    if (-not (Get-Module -ListAvailable -Name $m)) {
        throw "Missing module: $m. Install with: Install-Module $m -Scope CurrentUser"
    }
}
Import-Module Microsoft.Graph.Applications -ErrorAction Stop
Import-Module Microsoft.Graph.Identity.DirectoryManagement -ErrorAction Stop
Import-Module Microsoft.Graph.Users -ErrorAction Stop
Import-Module Microsoft.Graph.Identity.SignIns -ErrorAction Stop
Import-Module Microsoft.Graph.Users.Actions -ErrorAction SilentlyContinue

# Key Vault writes use `az keyvault secret set` via the already-authenticated
# Azure CLI session (the deployer ran `az login`), avoiding a second PowerShell
# Az-module login prompt.
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI (az) is required for Key Vault writes and is not in PATH.'
}

# ---- Main body: everything Graph-touching runs inside this try so the matching
#      finally block can Disconnect-MgGraph unconditionally (ADR-0010 §3 deployer-
#      session minimisation). ----
try {

# ---- Graph auth ----
Write-Step 'Connecting to Microsoft Graph...'
$scopes = @(
    'Application.ReadWrite.All',
    'AppRoleAssignment.ReadWrite.All',
    'Directory.ReadWrite.All',
    'DelegatedPermissionGrant.ReadWrite.All'  # ADR-0035 Phase B — tenant-wide SPA→API api.access consent.
)
$ctx = Get-MgContext
if (-not $ctx -or $ctx.TenantId -ne $TenantId) {
    Connect-MgGraph -TenantId $TenantId -Scopes $scopes -NoWelcome | Out-Null
} else {
    # Verify the current session has the required scopes.
    $missing = $scopes | Where-Object { $ctx.Scopes -notcontains $_ }
    if ($missing) {
        Write-Step "Re-authenticating to acquire missing scopes: $($missing -join ', ')"
        Connect-MgGraph -TenantId $TenantId -Scopes $scopes -NoWelcome | Out-Null
    }
}

# ---- Compute identifiers ----
$tenantShort = Get-TenantShortCode -Id $TenantId

# Microsoft Graph application identifiers — used by the SPA app's
# `requiredResourceAccess` for the `User.Read` delegated permission
# (the OIDC sign-in scope). Stable, published GUIDs.
$graphAppId = '00000003-0000-0000-c000-000000000000'
$userReadScopeId = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'

# §10.72 — legacy combined-app reconcile retired. Pre-§10.72 this section
# computed display name + redirect URI + reader/admin role GUIDs +
# `aad-client-secret-<env>` KV name for the `app-aegis-<env>-<tenantShort>`
# combined application (SWA Easy Auth audience) and reconciled it +
# its service principal + client secret. SWA Easy Auth is gone (ADR-0035
# Phase D2 retired SWA built-in OIDC; Phase E retired the legacy
# `x-ms-client-principal` path). The legacy registration is no longer
# consumed by any live component; the script's responsibility now starts
# at the Phase B native-auth split apps below.
#
# The legacy app registration in Entra is NOT deleted by this script —
# manual operator delete is the safe path (avoids breaking any external
# audit/assignment references that still cite the legacy app's appId).

# ============================================================================
# ADR-0035 Phase B — Native Entra auth split app registrations
# ----------------------------------------------------------------------------
# Reconciles the SPA + API app registrations alongside the legacy combined app.
# API app is created FIRST (it owns App Roles + the api.access scope); SPA app
# is created SECOND and links back to the API via requiredResourceAccess. The
# legacy app is left untouched here — Phase E retires it.
#
# Partial-failure resumption: a kill between API-create and
# SPA-create resumes cleanly on the next run because both apps are looked up
# by display-name match. Salted role-IDs are keyed off the per-app display
# name, so the API app's `admin`/`reader` role GUIDs differ from the legacy
# app's — no cross-app collision.
# ============================================================================

$apiDisplayName  = "app-aegis-api-$Env-$tenantShort"
$spaDisplayName  = "app-aegis-spa-$Env-$tenantShort"
$apiReaderRoleId = Get-SaltedRoleGuid -AppDisplayName $apiDisplayName -RoleKey 'reader'
$apiAdminRoleId  = Get-SaltedRoleGuid -AppDisplayName $apiDisplayName -RoleKey 'admin'
$apiAccessScopeId = Get-SaltedRoleGuid -AppDisplayName $apiDisplayName -RoleKey 'api.access'
# SPA app reg also defines `admin` and `reader` App Roles. Reason: the
# SPA's ID token only carries a `roles` claim if (a) appRoles are defined
# on the SPA app reg AND (b) the user has appRoleAssignments on the SPA's
# SP. Without these, the SPA's MSAL `account.idTokenClaims.roles` is
# empty and SPA-side role gates (AppHeader admin tab, AdminSettingsPage
# guard) all fail closed even when the user has admin on the API SP.
# Salted off the SPA display name so role IDs differ from the API app's
# (no GUID collision per WS10 SEC-I-03 caveat).
$spaReaderRoleId = Get-SaltedRoleGuid -AppDisplayName $spaDisplayName -RoleKey 'reader'
$spaAdminRoleId  = Get-SaltedRoleGuid -AppDisplayName $spaDisplayName -RoleKey 'admin'
$spaRedirectUris = @("https://$SwaHostname/", "https://$SwaHostname/auth/callback")

Write-Step "ADR-0035 Phase B: reconciling native-auth split apps."
Write-Step "  API app : $apiDisplayName"
Write-Step "  SPA app : $spaDisplayName"

# ---- API app (resource-only) ----
$apiAppRoles = @(
    @{
        AllowedMemberTypes = @('User')
        Description        = 'Read-only XDR Hub user (API audience).'
        DisplayName        = 'Reader'
        Id                 = $apiReaderRoleId
        IsEnabled          = $true
        Value              = 'reader'
    },
    @{
        AllowedMemberTypes = @('User')
        Description        = 'XDR Hub administrator (API audience); full access to approvals and audit.'
        DisplayName        = 'Admin'
        Id                 = $apiAdminRoleId
        IsEnabled          = $true
        Value              = 'admin'
    }
)
$apiOauth2Scopes = @(
    @{
        Id                      = $apiAccessScopeId
        AdminConsentDisplayName = 'Access Aegis API'
        AdminConsentDescription = 'Allows the Aegis SPA to call the Aegis API on behalf of the signed-in user.'
        UserConsentDisplayName  = 'Access Aegis API on your behalf'
        UserConsentDescription  = 'Allows the Aegis SPA to call the Aegis API on your behalf.'
        Value                   = 'api.access'
        Type                    = 'User'
        IsEnabled               = $true
    }
)
$apiAppApi = @{
    RequestedAccessTokenVersion = 2
    Oauth2PermissionScopes      = $apiOauth2Scopes
}

$apiNameLiteral = Get-OdataStringLiteral -Value $apiDisplayName
$apiExisting = Get-MgApplication -Filter "displayName eq $apiNameLiteral" -ConsistencyLevel eventual -CountVariable __ca -ErrorAction SilentlyContinue | Select-Object -First 1

if ($null -eq $apiExisting) {
    Write-Step 'API app not found — creating.'
    if ($PSCmdlet.ShouldProcess($apiDisplayName, 'Create API app registration')) {
        $apiApp = New-MgApplication `
            -DisplayName $apiDisplayName `
            -SignInAudience 'AzureADMyOrg' `
            -AppRoles $apiAppRoles `
            -Api $apiAppApi
        # IdentifierUris must be set after creation since they reference the appId.
        Update-MgApplication -ApplicationId $apiApp.Id -IdentifierUris @("api://$($apiApp.AppId)")
        $apiApp = Get-MgApplication -ApplicationId $apiApp.Id
    } else {
        return
    }
} else {
    Write-Step "API app present (AppId $($apiExisting.AppId)) — reconciling."
    if ($PSCmdlet.ShouldProcess($apiDisplayName, 'Update API app registration')) {
        # NOTE — Update-MgApplication collection-properties (-AppRoles, -Api,
        # -IdentifierUris) are REPLACE semantics, not merge. Any portal-side
        # drift (extra roles, extra exposed scopes, extra identifier URIs)
        # is overwritten on every reconcile. Source-of-truth is this script.
        Update-MgApplication `
            -ApplicationId $apiExisting.Id `
            -SignInAudience 'AzureADMyOrg' `
            -AppRoles $apiAppRoles `
            -Api $apiAppApi `
            -IdentifierUris @("api://$($apiExisting.AppId)")
        $apiApp = Get-MgApplication -ApplicationId $apiExisting.Id
    } else {
        return
    }
}

# ---- API service principal ----
$apiSp = Get-MgServicePrincipal -Filter "appId eq '$($apiApp.AppId)'" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $apiSp) {
    Write-Step 'API service principal not found — creating.'
    if ($PSCmdlet.ShouldProcess($apiApp.AppId, 'Create API service principal')) {
        $apiSp = New-MgServicePrincipal -AppId $apiApp.AppId
    }
} else {
    Write-Step "API service principal present (Id $($apiSp.Id))."
}

# ---- SPA app (public client, PKCE, no secret) ----
# requiredResourceAccess: Microsoft Graph User.Read (sign-in scope) + API api.access.
$spaRequiredResourceAccess = @(
    @{
        ResourceAppId  = $graphAppId
        ResourceAccess = @(
            @{ Id = $userReadScopeId; Type = 'Scope' }
        )
    },
    @{
        ResourceAppId  = $apiApp.AppId
        ResourceAccess = @(
            @{ Id = $apiAccessScopeId; Type = 'Scope' }
        )
    }
)
# App Roles on the SPA app reg — drive the `roles` claim in the SPA's ID
# token. Microsoft Identity Platform emits the `roles` claim in an ID
# token only when (a) the app reg has appRoles defined AND (b) the user
# has appRoleAssignments on the app's SP. Both are needed; the admin-
# user assignment block below adds the SPA SP as a third target.
# IDs are salted off the SPA display name (separate from the API app's
# admin/reader role IDs to avoid cross-app collisions).
$spaAppRoles = @(
    @{
        AllowedMemberTypes = @('User')
        Description        = 'Read-only XDR Hub user (SPA audience — drives ID-token roles claim).'
        DisplayName        = 'Reader'
        Id                 = $spaReaderRoleId
        IsEnabled          = $true
        Value              = 'reader'
    },
    @{
        AllowedMemberTypes = @('User')
        Description        = 'XDR Hub administrator (SPA audience — drives ID-token roles claim used by SPA-side role gates).'
        DisplayName        = 'Admin'
        Id                 = $spaAdminRoleId
        IsEnabled          = $true
        Value              = 'admin'
    }
)
$spaPlatform = @{ RedirectUris = $spaRedirectUris }

$spaNameLiteral = Get-OdataStringLiteral -Value $spaDisplayName
$spaExisting = Get-MgApplication -Filter "displayName eq $spaNameLiteral" -ConsistencyLevel eventual -CountVariable __cs -ErrorAction SilentlyContinue | Select-Object -First 1

if ($null -eq $spaExisting) {
    Write-Step 'SPA app not found — creating.'
    if ($PSCmdlet.ShouldProcess($spaDisplayName, 'Create SPA app registration')) {
        $spaApp = New-MgApplication `
            -DisplayName $spaDisplayName `
            -SignInAudience 'AzureADMyOrg' `
            -Spa $spaPlatform `
            -AppRoles $spaAppRoles `
            -RequiredResourceAccess $spaRequiredResourceAccess
    } else {
        return
    }
} else {
    Write-Step "SPA app present (AppId $($spaExisting.AppId)) — reconciling."
    if ($PSCmdlet.ShouldProcess($spaDisplayName, 'Update SPA app registration')) {
        # NOTE — Update-MgApplication collection-properties (-Spa.RedirectUris,
        # -AppRoles, -RequiredResourceAccess) are REPLACE semantics. Operator
        # additions in the portal (extra redirect URIs, extra requiredResourceAccess
        # entries, extra appRoles) are overwritten on each reconcile. Source-of-
        # truth is this script.
        Update-MgApplication `
            -ApplicationId $spaExisting.Id `
            -SignInAudience 'AzureADMyOrg' `
            -Spa $spaPlatform `
            -AppRoles $spaAppRoles `
            -RequiredResourceAccess $spaRequiredResourceAccess
        $spaApp = Get-MgApplication -ApplicationId $spaExisting.Id
    } else {
        return
    }
}

# ---- SPA service principal ----
$spaSp = Get-MgServicePrincipal -Filter "appId eq '$($spaApp.AppId)'" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $spaSp) {
    Write-Step 'SPA service principal not found — creating.'
    if ($PSCmdlet.ShouldProcess($spaApp.AppId, 'Create SPA service principal')) {
        $spaSp = New-MgServicePrincipal -AppId $spaApp.AppId
    }
} else {
    Write-Step "SPA service principal present (Id $($spaSp.Id))."
}

# ---- Tenant-wide admin consent: SPA → API api.access ----
# Idempotent reconcile: enumerate grants for the SPA SP, filter in-memory rather
# than relying on Graph's $filter combining clientId + resourceId + consentType
# (some SDK versions fail this composite filter).
$spaConsentGrantedThisRun = $false
$existingSpaApiGrant = Get-MgOauth2PermissionGrant -Filter "clientId eq '$($spaSp.Id)'" -ErrorAction SilentlyContinue `
    | Where-Object { $_.ResourceId -eq $apiSp.Id -and $_.ConsentType -eq 'AllPrincipals' } `
    | Select-Object -First 1
if ($null -eq $existingSpaApiGrant) {
    Write-Step 'Granting tenant-wide admin consent: SPA → API api.access.'
    if ($PSCmdlet.ShouldProcess("SPA $($spaSp.Id) → API $($apiSp.Id)", 'Grant tenant-wide consent (api.access)')) {
        New-MgOauth2PermissionGrant -BodyParameter @{
            ClientId    = $spaSp.Id
            ConsentType = 'AllPrincipals'
            ResourceId  = $apiSp.Id
            Scope       = 'api.access'
        } | Out-Null
        $spaConsentGrantedThisRun = $true
    }
} else {
    Write-Step 'Tenant-wide admin consent already present (api.access).'
}

# ---- Seed admin role assignment ----
# Resolution order:
#   1. If -AdminUpn is supplied, look up the Entra user by userPrincipalName
#      exclusively — authoritative for the tenant. Closes the external-email
#      case where -AdminEmail is a vanity address that doesn't resolve on
#  the tenant directory.
#   2. Otherwise fall back to the -AdminEmail lookup: UPN/mail, then otherMails.
$adminUser = $null
$adminIdentifierUsed = $AdminEmail
if (-not [string]::IsNullOrWhiteSpace($AdminUpn)) {
    Write-Step "Resolving admin user by UPN: $AdminUpn..."
    $adminIdentifierUsed = $AdminUpn
    $upnLiteral = Get-OdataStringLiteral -Value $AdminUpn
    $adminUser = Get-MgUser -Filter "userPrincipalName eq $upnLiteral" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $adminUser) {
        [Console]::Error.WriteLine("[bootstrap-entra] WARNING: Admin UPN '$AdminUpn' not found in tenant. Skipping role assignment — assign the 'admin' App Role manually via portal.")
    }
} else {
    Write-Step "Resolving admin user $AdminEmail..."
    $adminLiteral = Get-OdataStringLiteral -Value $AdminEmail
    $adminUser = Get-MgUser -Filter "userPrincipalName eq $adminLiteral or mail eq $adminLiteral" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $adminUser) {
        [Console]::Error.WriteLine("[bootstrap-entra] WARNING: Admin user '$AdminEmail' not found in tenant via userPrincipalName/mail. Retrying against otherMails.")
        $adminUser = Get-MgUser -All -Property Id,DisplayName,UserPrincipalName,Mail,OtherMails -ErrorAction SilentlyContinue `
            | Where-Object { $_.OtherMails -and ($_.OtherMails -contains $AdminEmail) } `
            | Select-Object -First 1
        if ($null -eq $adminUser) {
            [Console]::Error.WriteLine("[bootstrap-entra] WARNING: Admin user '$AdminEmail' not found. Skipping role assignment — assign the 'admin' App Role manually via portal, or pass -AdminUpn with the internal UPN.")
        }
    }
}
$adminAssignedOnApi    = $false
$adminAssignedOnSpa    = $false
if ($null -ne $adminUser) {
    # Cache the user's existing assignments once — saves two list calls.
    $userAssignments = Get-MgUserAppRoleAssignment -UserId $adminUser.Id

    # ADR-0035 Phase D2 — admin role lands on TWO SPs (§10.72 dropped the
    # legacy combined SP target):
    #   1. API SP — drives the access-token `roles` claim used by the FA's
    #      authMiddleware.
    #   2. SPA SP — drives the ID-token `roles` claim used by SPA-side role
    #      gates (AppHeader admin tab visibility, AdminSettingsPage guard).
    #      Without this third assignment, the SPA's `account.idTokenClaims`
    #      has empty `roles` and admin nav is hidden even though the API
    #      enforces correctly.
    $assignmentTargets = @(
        @{ SpId = $apiSp.Id; RoleId = $apiAdminRoleId;  Label = 'API SP (ADR-0035 Phase B)' },
        @{ SpId = $spaSp.Id; RoleId = $spaAdminRoleId;  Label = 'SPA SP (ADR-0035 Phase D2 — ID-token roles claim)' }
    )
    foreach ($target in $assignmentTargets) {
        $existingAssignment = $userAssignments | Where-Object { $_.ResourceId -eq $target.SpId -and $_.AppRoleId -eq $target.RoleId } | Select-Object -First 1
        if ($null -ne $existingAssignment) {
            Write-Step "Admin role already assigned to $adminIdentifierUsed on $($target.Label)."
            if ($target.Label -like 'API*')      { $adminAssignedOnApi    = $true }
            elseif ($target.Label -like 'SPA*')  { $adminAssignedOnSpa    = $true }
        } else {
            Write-Step "Assigning Admin role to $adminIdentifierUsed on $($target.Label)."
            if ($PSCmdlet.ShouldProcess("$adminIdentifierUsed → $($target.Label)", 'Assign Admin app role')) {
                New-MgUserAppRoleAssignment -UserId $adminUser.Id `
                    -PrincipalId $adminUser.Id `
                    -ResourceId $target.SpId `
                    -AppRoleId $target.RoleId | Out-Null
                if ($target.Label -like 'API*')      { $adminAssignedOnApi    = $true }
                elseif ($target.Label -like 'SPA*')  { $adminAssignedOnSpa    = $true }
            }
        }
    }
}

# Strict-mode tri-state resolution status. Evaluated now so it lands in the
# summary JSON, but the matching throw happens AFTER the summary is on stdout
# so the azd hook's BOOTSTRAP_JSON capture still succeeds (mirrors the
# functionAppRestartStatus pattern).
$adminResolutionStatus =
    if ($adminUser) { 'resolved' }
    elseif ($strictRequireAdminUser) { 'required_but_unresolved' }
    else { 'unresolved_tolerated' }

# ---- Graph app-role grants to the ingest MI (ADR-0010 §4) ----
# Idempotent; safe to re-run. Skipped when -IngestMiObjectId is not supplied (older
# deployments that pre-date the ingest MI).
$graphGrantResults = @()
if ([string]::IsNullOrWhiteSpace($IngestMiObjectId)) {
    Write-Step 'Skipping Graph app-role grant phase: -IngestMiObjectId not supplied.'
} else {
    if ($RevokeGraphGrants) {
        Write-Step "Revoking all Graph app-role assignments from ingest MI $IngestMiObjectId."
        $graphGrantResults = Grant-GraphAppRolesToMi -MiObjectId $IngestMiObjectId -Scopes $RequiredGraphScopes -Revoke -WhatIfPreference:(-not $PSCmdlet.ShouldProcess($IngestMiObjectId, 'Revoke Graph app-roles'))
    } else {
        Write-Step "Granting Graph scopes [$($RequiredGraphScopes -join ', ')] to ingest MI $IngestMiObjectId."
        $graphGrantResults = Grant-GraphAppRolesToMi -MiObjectId $IngestMiObjectId -Scopes $RequiredGraphScopes -WhatIfPreference:(-not $PSCmdlet.ShouldProcess($IngestMiObjectId, 'Grant Graph app-roles'))
    }
}

# ============================================================================
# ADR-0030 Phase C — mail-sender MI Graph + AAP wiring (§C.9/§C.14)
# ----------------------------------------------------------------------------
# Grants two Microsoft Graph application permissions to the mailSender MI:
#   - Mail.ReadWrite (covers BOTH the draft-create POST per ADR-0030 §C.6
#                     AND the §C.8.1 retry-ambiguity SentItems probe;
#                     supersedes Mail.Read which was the original v1 spec)
#   - Mail.Send      (the actual send-draft capability)
# Then provisions an Exchange Online Application Access Policy (AAP) scoping
# both grants to a single operator-provided mailbox. Both shared mailboxes
# AND licensed user mailboxes are supported (§C.2 / §C.19).
#
# 2026-05-21 fix: v1 of this bootstrap granted Mail.Read only, missing that
# the draft-then-send pattern uses POST /users/{upn}/messages which requires
# Mail.ReadWrite (not just Mail.Read). First live-fire after L12 deploy
# surfaced this as a Graph "Access is denied. Check credentials and try
# again." rejection despite AAP + Mail.Send being correctly granted.
#
# Gating model (§C.14 onboarding flow):
#   * $MailSenderMiObjectId empty → defensive skip (Bicep always provisions
#     the MI; this only fires if the postprovision hook fails to pass it).
#   * $MailSenderUpn empty → Phase C opt-in not yet engaged. MI stays inert
#     (Graph 401/403 if any handler ever calls it; orchestrator §C.5.2
#     short-circuits to 503 before any Graph call).
#   * $MailSenderRequired (default off in dev/test, on in prod per §C.18)
#     → fail-clear on missing UPN OR mailbox lookup failure OR AAP failure.
#
# Output: a `phaseC` block in the summary JSON with `status` enum +
# diagnostic detail so the operator + the azd hook can both see what
# happened. Idempotent across re-runs (existing AAP detected; existing
# Graph grants detected by Grant-GraphAppRolesToMi).
# ============================================================================

# Resolve the "is Phase C required this run" decision. Tri-state:
#   '' (default)         → env-aware default (prod → true; dev/test → false)
#   'true'  / 'false'    → explicit override (operator opt-in/opt-out)
switch ($MailSenderRequired) {
    'true'  { $mailSenderRequiredResolved = $true;  $mailSenderRequiredSource = 'explicit_true' }
    'false' { $mailSenderRequiredResolved = $false; $mailSenderRequiredSource = 'explicit_false' }
    default {
        if ($Env -eq 'prod') {
            $mailSenderRequiredResolved = $true
            $mailSenderRequiredSource = 'prod_default'
        } else {
            $mailSenderRequiredResolved = $false
            $mailSenderRequiredSource = 'non_prod_default_off'
        }
    }
}

# Initialise summary fields up-front so even a thrown error still emits
# observable state via the BOOTSTRAP_JSON capture (mirrors the
# functionAppRestartStatus pattern).
$mailSenderStatus = 'not_attempted'
$mailSenderDetail = ''
$mailSenderType = $null            # 'shared' | 'licensed' (informational)
$mailSenderAapPresent = $null      # $true | $false | $null (not-yet-determined)
$mailSenderMailboxAddress = $null  # echoed from `mail` property; canonical form
$mailSenderScopeGroupSmtp = $null  # mail-enabled security group wrapping the mailbox for AAP (shared-mailbox sharp edge — backing user is AccountEnabled=false, which Exchange rejects as "not a security principal")
$mailSenderScopeGroupCreated = $null  # $true if bootstrap created the group this run; $false if it pre-existed; $null if not attempted
$phaseCFatalError = $null          # WS10 MED-1 fix — captured here, re-thrown AFTER summary emit

try {
if ([string]::IsNullOrWhiteSpace($MailSenderMiObjectId)) {
    Write-Step 'Phase C: -MailSenderMiObjectId not supplied; skipping mail-sender wiring (mailSender MI may not be in Bicep yet).'
    $mailSenderStatus = 'skipped_no_mi'
} elseif ([string]::IsNullOrWhiteSpace($MailSenderUpn)) {
    if ($mailSenderRequiredResolved) {
        throw "Phase C: -MailSenderRequired is set (source=$mailSenderRequiredSource) but -MailSenderUpn is empty. Set AZURE_MAIL_SENDER_UPN to a tenant mailbox UPN before re-running, or override with `-MailSenderRequired:`$false` for non-prod testing."
    }
    Write-Step "Phase C: -MailSenderUpn not supplied; mailSender MI stays inert (required=$mailSenderRequiredResolved source=$mailSenderRequiredSource)."
    $mailSenderStatus = 'skipped_no_upn'
} else {
    Write-Step "Phase C: validating mailbox $MailSenderUpn"
    $mailboxUser = $null
    try {
        $mailboxUser = Get-MgUser -UserId $MailSenderUpn -Property 'id,mail,mailNickname,accountEnabled,assignedLicenses' -ErrorAction Stop
    } catch {
        $msg = $_.Exception.Message
        if ($mailSenderRequiredResolved) {
            throw "Phase C: -MailSenderUpn '$MailSenderUpn' lookup failed (required=$mailSenderRequiredResolved). $msg"
        }
        Write-Step "Phase C: -MailSenderUpn '$MailSenderUpn' lookup failed; soft-skip (required=$mailSenderRequiredResolved). $msg"
        $mailSenderStatus = 'skipped_user_not_found'
        $mailSenderDetail = $msg
    }
    if ($null -ne $mailboxUser) {
        if ([string]::IsNullOrWhiteSpace($mailboxUser.Mail)) {
            $detail = "User '$MailSenderUpn' exists in Entra (id=$($mailboxUser.Id)) but has no Exchange mailbox (mail property empty). For a licensed user mailbox: assign an Exchange Online plan + wait for mailbox provisioning. For a shared mailbox: create via Exchange admin centre."
            if ($mailSenderRequiredResolved) {
                throw "Phase C: $detail"
            }
            Write-Step "Phase C: $detail; soft-skip."
            $mailSenderStatus = 'skipped_no_mailbox'
            $mailSenderDetail = $detail
        } else {
            $mailSenderMailboxAddress = $mailboxUser.Mail
            $assignedLicensesCount = if ($null -eq $mailboxUser.AssignedLicenses) { 0 } else { @($mailboxUser.AssignedLicenses).Count }
            if ((-not $mailboxUser.AccountEnabled) -and ($assignedLicensesCount -eq 0)) {
                $mailSenderType = 'shared'
                Write-Step "Phase C: Shared mailbox detected for $($mailboxUser.Mail) (no licence required; recommended for automation senders)."
            } else {
                $mailSenderType = 'licensed'
                Write-Step "Phase C: Licensed user mailbox detected for $($mailboxUser.Mail) (accountEnabled=$($mailboxUser.AccountEnabled), licences=$assignedLicensesCount)."
            }

            # Grant Mail.Send + Mail.ReadWrite to the mail-sender MI.
            # Mail.ReadWrite is the minimum required for the §C.6 draft-then-
            # send pattern (POST /users/{upn}/messages → POST .../send) AND
            # covers the §C.8.1 SentItems probe (subset Mail.Read implied).
            # 2026-05-21 fix — v1 granted Mail.Read only, which is insufficient.
            $mailSenderScopes = @('Mail.Send', 'Mail.ReadWrite')
            try {
                if ($RevokeGraphGrants) {
                    Write-Step "Phase C: Revoking Graph scopes [$($mailSenderScopes -join ', ')] from mail-sender MI $MailSenderMiObjectId."
                    $mailGrantResults = Grant-GraphAppRolesToMi -MiObjectId $MailSenderMiObjectId -Scopes $mailSenderScopes -Revoke -WhatIfPreference:(-not $PSCmdlet.ShouldProcess($MailSenderMiObjectId, 'Revoke Phase C Graph app-roles'))
                } else {
                    Write-Step "Phase C: Granting Graph scopes [$($mailSenderScopes -join ', ')] to mail-sender MI $MailSenderMiObjectId."
                    $mailGrantResults = Grant-GraphAppRolesToMi -MiObjectId $MailSenderMiObjectId -Scopes $mailSenderScopes -WhatIfPreference:(-not $PSCmdlet.ShouldProcess($MailSenderMiObjectId, 'Grant Phase C Graph app-roles'))
                }
                # Fold into the global $graphGrantResults so the FA restart heuristic counts these too.
                $graphGrantResults += $mailGrantResults
            } catch {
                $msg = $_.Exception.Message
                if ($mailSenderRequiredResolved) {
                    throw "Phase C: Graph app-role grant failed for mail-sender MI: $msg"
                }
                Write-Step "Phase C: Graph app-role grant failed; soft-skip. $msg"
                $mailSenderStatus = 'graph_grant_failed'
                $mailSenderDetail = $msg
            }

            # Provision the AAP via the Exchange Online PowerShell module.
            if ($mailSenderStatus -ne 'graph_grant_failed') {
                if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
                    $detail = "ExchangeOnlineManagement PowerShell module not installed. Run 'Install-Module ExchangeOnlineManagement -Scope CurrentUser' and re-run."
                    if ($mailSenderRequiredResolved) {
                        throw "Phase C: $detail"
                    }
                    Write-Step "Phase C: $detail Soft-skipping AAP step; mail-sender MI has Graph permissions but is NOT scoped to a mailbox. DO NOT enable Phase C in TenantSettings until AAP is in place."
                    $mailSenderStatus = 'graph_granted_no_aap_module_missing'
                    $mailSenderDetail = $detail
                    $mailSenderAapPresent = $false
                } else {
                    Write-Step 'Phase C: Connecting to Exchange Online (interactive sign-in may appear; requires Exchange Administrator role)…'
                    # WS10 §10.76 MEDIUM #2 — sub-step tracker so the soft-skip status
                    # honestly reflects which step threw (group create vs member add vs
                    # AAP) instead of always reporting `graph_granted_aap_failed`.
                    $phaseCSubStep = 'exo_connect'
                    try {
                        Import-Module ExchangeOnlineManagement -ErrorAction Stop
                        Connect-ExchangeOnline -ShowBanner:$false -ErrorAction Stop | Out-Null
                        # Resolve the mail-sender MI's SP appId so AAP can be keyed by appId.
                        $phaseCSubStep = 'resolve_mi_sp'
                        $mailSenderSpFilter = "id eq '$MailSenderMiObjectId'"
                        $mailSenderSp = Get-MgServicePrincipal -Filter $mailSenderSpFilter -ErrorAction Stop | Select-Object -First 1
                        if ($null -eq $mailSenderSp) {
                            throw "Service principal for mail-sender MI $MailSenderMiObjectId not found in tenant directory."
                        }
                        $mailSenderAppId = $mailSenderSp.AppId

                        $phaseCSubStep = 'scope_group_create'
                        # Provision (or reuse) a mail-enabled security group wrapping the
                        # mailbox. New-ApplicationAccessPolicy -PolicyScopeGroupId rejects
                        # a shared mailbox whose backing Entra user is AccountEnabled=false
                        # ("The identity of the policy scope is not a security principal").
                        # The mail-enabled security group IS a security principal regardless
                        # of member state — Microsoft's documented workaround. ADR-0030 §C.13.
                        $mailSenderUpnDomain = ($MailSenderUpn -split '@', 2)[1]
                        if ([string]::IsNullOrWhiteSpace($mailSenderUpnDomain)) {
                            throw "Phase C: -MailSenderUpn '$MailSenderUpn' is not a valid UPN (no '@domain' suffix)."
                        }
                        $mailSenderScopeGroupAlias = "sg-aegis-mailsender-scope-$Env"
                        $mailSenderScopeGroupSmtp = "$mailSenderScopeGroupAlias@$mailSenderUpnDomain"

                        $existingScopeGroup = $null
                        try {
                            $existingScopeGroup = Get-DistributionGroup -Identity $mailSenderScopeGroupAlias -ErrorAction Stop
                        } catch {
                            # Treat "not found" as empty; re-throw any other error.
                            if ($_.Exception.Message -notmatch "couldn'?t be found|wasn'?t found|cannot find") {
                                throw
                            }
                            $existingScopeGroup = $null
                        }

                        if ($null -eq $existingScopeGroup) {
                            if ($PSCmdlet.ShouldProcess($mailSenderScopeGroupSmtp, 'Create mail-enabled security group for AAP scope')) {
                                New-DistributionGroup `
                                    -Name $mailSenderScopeGroupAlias `
                                    -DisplayName "Aegis Mail Sender Scope ($Env)" `
                                    -Alias $mailSenderScopeGroupAlias `
                                    -PrimarySmtpAddress $mailSenderScopeGroupSmtp `
                                    -Type Security `
                                    -Description "Aegis mailSender MI AAP scope wrapper ($Env). Members: only the mailSender mailbox. Do not repurpose — group existence implies tenant-wide Mail.Send restriction." `
                                    -ErrorAction Stop | Out-Null
                                Write-Step "Phase C: Mail-enabled security group created: $mailSenderScopeGroupSmtp"
                                $mailSenderScopeGroupCreated = $true
                                # ADR-0030 §C.20 — poll for Exchange directory replication to
                                # settle before AAP creation. Newly-created groups can be
                                # invisible to downstream cmdlets (Get-DistributionGroup,
                                # New-ApplicationAccessPolicy) for several seconds.
                                # Previously a fixed 15s sleep — too long on a fast tenant,
                                # too short on a slow one. Now: bounded poll-and-back-off.
                                # WS10 SEC-X-PHANTOM L14 carry-forward.
                                $pollMaxSeconds = 90
                                $pollIntervalSeconds = 3
                                $pollStart = Get-Date
                                $groupVisible = $false
                                while (((Get-Date) - $pollStart).TotalSeconds -lt $pollMaxSeconds) {
                                    try {
                                        $verifyGroup = Get-DistributionGroup -Identity $mailSenderScopeGroupAlias -ErrorAction Stop
                                        if ($null -ne $verifyGroup -and $verifyGroup.PrimarySmtpAddress -eq $mailSenderScopeGroupSmtp) {
                                            $groupVisible = $true
                                            $elapsed = [int]((Get-Date) - $pollStart).TotalSeconds
                                            Write-Step "Phase C: Scope group visible after ${elapsed}s of polling."
                                            break
                                        }
                                    } catch {
                                        # Not yet visible — continue polling.
                                    }
                                    Start-Sleep -Seconds $pollIntervalSeconds
                                }
                                if (-not $groupVisible) {
                                    throw "Phase C: scope group '$mailSenderScopeGroupAlias' did not become visible after ${pollMaxSeconds}s of polling. Exchange directory replication is unusually slow; re-run the bootstrap in a few minutes (ADR-0030 §C.20)."
                                }
                            } else {
                                $mailSenderScopeGroupCreated = $false
                            }
                        } else {
                            # Validate the existing group is genuinely the Aegis scope group,
                            # not a foreign group that happens to share the alias (WS10 §10.76
                            # MEDIUM #1 — silent privilege widening if Aegis binds to a foreign
                            # group whose members would then be in the Mail.Send AAP scope).
                            $existingDescription = if ($null -ne $existingScopeGroup.Description) { [string]$existingScopeGroup.Description } else { '' }
                            $existingSmtp = if ($null -ne $existingScopeGroup.PrimarySmtpAddress) { [string]$existingScopeGroup.PrimarySmtpAddress } else { '' }
                            $signatureMatch = ($existingDescription -match 'Aegis mailSender MI AAP scope wrapper') -and ($existingSmtp -eq $mailSenderScopeGroupSmtp)
                            if (-not $signatureMatch) {
                                throw "Phase C: distribution group '$mailSenderScopeGroupAlias' exists in the tenant but does not match the Aegis scope-group signature (PrimarySmtpAddress='$existingSmtp', Description='$existingDescription'). Refusing to bind — manual investigation required for foreign-group collision (ADR-0030 §C.20)."
                            }
                            Write-Step "Phase C: Mail-enabled security group already exists (signature verified): $mailSenderScopeGroupSmtp"
                            $mailSenderScopeGroupCreated = $false
                        }

                        $phaseCSubStep = 'scope_group_member'
                        # Ensure the mailbox is a member of the scope group (idempotent).
                        $existingScopeMembers = @(Get-DistributionGroupMember -Identity $mailSenderScopeGroupAlias -ErrorAction Stop)
                        $isAlreadyMember = $existingScopeMembers | Where-Object {
                            $_.PrimarySmtpAddress -eq $MailSenderUpn -or $_.WindowsLiveID -eq $MailSenderUpn
                        } | Select-Object -First 1
                        if ($null -eq $isAlreadyMember) {
                            if ($PSCmdlet.ShouldProcess("$MailSenderUpn → $mailSenderScopeGroupSmtp", 'Add mailbox to scope group')) {
                                Add-DistributionGroupMember -Identity $mailSenderScopeGroupAlias -Member $MailSenderUpn -ErrorAction Stop
                                Write-Step "Phase C: Added $MailSenderUpn to scope group $mailSenderScopeGroupSmtp."
                            }
                        } else {
                            Write-Step "Phase C: $MailSenderUpn is already a member of scope group $mailSenderScopeGroupSmtp."
                        }

                        $phaseCSubStep = 'aap'
                        # Idempotency — check for an existing AAP keyed on this appId.
                        $existingAap = $null
                        try {
                            $existingAap = Get-ApplicationAccessPolicy -ErrorAction Stop | Where-Object { $_.AppId -eq $mailSenderAppId } | Select-Object -First 1
                        } catch {
                            # Get-ApplicationAccessPolicy may throw if no policies exist; treat as empty.
                            $existingAap = $null
                        }
                        if ($null -ne $existingAap) {
                            Write-Step "Phase C: Application Access Policy already exists for AppId $mailSenderAppId (scope=$($existingAap.ScopeName) right=$($existingAap.AccessRight)). No-op."
                            $mailSenderStatus = 'configured'
                            $mailSenderAapPresent = $true
                        } else {
                            if ($PSCmdlet.ShouldProcess("$mailSenderAppId → $mailSenderScopeGroupSmtp", 'Create Application Access Policy')) {
                                New-ApplicationAccessPolicy `
                                    -AppId $mailSenderAppId `
                                    -PolicyScopeGroupId $mailSenderScopeGroupSmtp `
                                    -AccessRight RestrictAccess `
                                    -Description "Aegis mailSender MI restricted to scope group $mailSenderScopeGroupSmtp (member: $MailSenderUpn) (ADR-0030 §C)" `
                                    -ErrorAction Stop | Out-Null
                                Write-Step "Phase C: Application Access Policy created — mail-sender MI scoped to group $mailSenderScopeGroupSmtp (member: $MailSenderUpn)."
                                $mailSenderStatus = 'configured'
                                $mailSenderAapPresent = $true
                            } else {
                                $mailSenderStatus = 'whatif_skipped'
                                $mailSenderAapPresent = $false
                            }
                        }
                    } catch {
                        $msg = $_.Exception.Message
                        # WS10 §10.76 MEDIUM #2 — map the sub-step tracker to a specific
                        # status code so the operator sees which stage failed.
                        $phaseCStatusBySubStep = @{
                            'exo_connect'        = 'graph_granted_exo_connect_failed'
                            'resolve_mi_sp'      = 'graph_granted_mi_sp_lookup_failed'
                            'scope_group_create' = 'graph_granted_scope_group_create_failed'
                            'scope_group_member' = 'graph_granted_scope_group_member_failed'
                            'aap'                = 'graph_granted_aap_failed'
                        }
                        $resolvedSubStepStatus = $phaseCStatusBySubStep[$phaseCSubStep]
                        if ([string]::IsNullOrEmpty($resolvedSubStepStatus)) {
                            $resolvedSubStepStatus = 'graph_granted_aap_failed'
                        }
                        if ($mailSenderRequiredResolved) {
                            throw "Phase C: Exchange Online step failed at '$phaseCSubStep': $msg"
                        }
                        Write-Step "Phase C: Exchange Online step failed at '$phaseCSubStep'; soft-skip. $msg"
                        $mailSenderStatus = $resolvedSubStepStatus
                        $mailSenderDetail = $msg
                        $mailSenderAapPresent = $false
                    } finally {
                        # Best-effort disconnect. Some Exchange module versions throw if no session is open.
                        try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch { }
                    }
                }
            }
        }
    }
}
} catch {
    # WS10 MED-1 fix — capture any throw from the Phase C section so the
    # summary JSON below still emits with observable state. Re-thrown
    # AFTER the JSON emit at the foot of the script. Mirrors the
    # $functionAppRestartError pattern.
    $phaseCFatalError = $_.Exception.Message
    if ($mailSenderStatus -eq 'not_attempted' -or $mailSenderStatus -eq 'configured') {
        $mailSenderStatus = 'fatal'
    }
    if ([string]::IsNullOrWhiteSpace($mailSenderDetail)) {
        $mailSenderDetail = $phaseCFatalError
    } else {
        $mailSenderDetail = "$mailSenderDetail | fatal: $phaseCFatalError"
    }
    Write-Step "Phase C: FATAL — $phaseCFatalError (re-thrown after summary emit)"
}

# ---- Function App restart to invalidate the IMDS MI token cache ----
# The restart is what actually closes the cache-lag race — a post-grant sleep or a
# deployer-session smoke test would not warm the Function App's own IMDS cache.
# Runs only when the caller supplies both -FunctionAppName and -ResourceGroupName,
# and at least one grant/revoke was actioned this run (skipped for no-op reconciles).
# Restart outcome is written to the summary JSON and emitted on stdout BEFORE any
# throw: the hook's BOOTSTRAP_JSON capture succeeds
# regardless of restart outcome, and a failed restart still fails the script but
# only after the summary is observable.
$grantActionedThisRun = $graphGrantResults | Where-Object { $_.status -in @('granted', 'revoked') } | Measure-Object | Select-Object -ExpandProperty Count
$functionAppRestartStatus = 'skipped_missing_params'
$functionAppRestartError = $null
if (-not [string]::IsNullOrWhiteSpace($FunctionAppName) -and -not [string]::IsNullOrWhiteSpace($ResourceGroupName)) {
    if ($grantActionedThisRun -gt 0) {
        # F-fwd-5: explicit --subscription on every az call. Built once per
        # invocation so the array splat below stays cheap. Omitted when
        # $SubscriptionId is empty (standalone-reconcile fallback).
        $azSubArgs = @()
        if (-not [string]::IsNullOrWhiteSpace($SubscriptionId)) {
            $azSubArgs = @('--subscription', $SubscriptionId)
        }
        Write-Step "Restarting Function App $FunctionAppName (rg $ResourceGroupName, sub $(if ($SubscriptionId) { $SubscriptionId } else { '<active>' })) to invalidate MI token cache."
        if ($PSCmdlet.ShouldProcess("$ResourceGroupName/$FunctionAppName", 'Restart Function App')) {
            $restartOutput = & az functionapp restart --name $FunctionAppName --resource-group $ResourceGroupName @azSubArgs --output none 2>&1
            if ($LASTEXITCODE -eq 0) {
                $functionAppRestartStatus = 'ok'
            } else {
                $functionAppRestartStatus = 'failed'
                $functionAppRestartError = "az functionapp restart exit=$LASTEXITCODE output=$($restartOutput -join ' | ')"
                [Console]::Error.WriteLine("[bootstrap-entra] ERROR: $functionAppRestartError")
            }
        } else {
            $functionAppRestartStatus = 'whatif_skipped'
        }
    } else {
        $functionAppRestartStatus = 'skipped_noop'
        Write-Step 'Skipping Function App restart — no grants/revocations actioned this run.'
    }
}

# ---- Summary ----
$summary = [ordered]@{
    tenantId                 = $TenantId
    # ADR-0035 Phase B native-auth split apps. §10.72 dropped the legacy
    # combined-app fields (`appId`, `servicePrincipalId`, `readerRoleId`,
    # `adminRoleId`, `redirectUri`, `logoutUri`, `keyVaultSecretName`,
    # `clientSecretRotated`, `adminAssignedOnLegacy`) — consumers (azd
    # postprovision hook, operator dashboards) read the `nativeAuth.*`
    # fields below as the canonical surface.
    nativeAuth = [ordered]@{
        apiAppDisplayName        = $apiDisplayName
        apiAppId                 = $apiApp.AppId
        apiServicePrincipalId    = $apiSp.Id
        apiIdentifierUri         = "api://$($apiApp.AppId)"
        apiReaderRoleId          = $apiReaderRoleId
        apiAdminRoleId           = $apiAdminRoleId
        apiAccessScopeId         = $apiAccessScopeId
        spaAppDisplayName        = $spaDisplayName
        spaAppId                 = $spaApp.AppId
        spaServicePrincipalId    = $spaSp.Id
        spaRedirectUris          = $spaRedirectUris
        spaReaderRoleId          = $spaReaderRoleId
        spaAdminRoleId           = $spaAdminRoleId
        tenantWideConsentGranted = $spaConsentGrantedThisRun
        adminAssignedOnApi       = $adminAssignedOnApi
        adminAssignedOnSpa       = $adminAssignedOnSpa
    }
    adminEmail               = $AdminEmail
    adminUpn                 = $AdminUpn
    adminIdentifierUsed      = $adminIdentifierUsed
    adminUserResolved        = [bool]$adminUser
    adminResolutionStatus    = $adminResolutionStatus
    requireAdminUserResolved = [bool]$strictRequireAdminUser
    requireAdminUserResolvedSource =
        if ($RequireAdminUserResolved.IsPresent) { 'explicit' }
        elseif ($Env -eq 'prod' -and -not $AllowMissingAdminInProd.IsPresent) { 'prod_default' }
        elseif ($Env -eq 'prod' -and $AllowMissingAdminInProd.IsPresent) { 'prod_opted_out' }
        else { 'non_prod_default_off' }
    ingestMiObjectId         = $IngestMiObjectId
    graphGrantResults        = $graphGrantResults
    functionAppRestartStatus = $functionAppRestartStatus
    functionAppRestartError  = $functionAppRestartError
    # ADR-0030 Phase C — mail-sender wiring. `status` enum:
    #   'not_attempted'                       — Phase C section never ran
    #   'skipped_no_mi'                       — MI principal ID not supplied
    #   'skipped_no_upn'                      — Mailbox UPN not configured (opt-in not engaged)
    #   'skipped_user_not_found'              — UPN lookup failed; soft-skip (non-prod only)
    #   'skipped_no_mailbox'                  — User exists, no mailbox; soft-skip
    #   'graph_grant_failed'                  — Mail.Send/Read grant errored; soft-skip
    #   'graph_granted_no_aap_module_missing' — ExchangeOnlineManagement absent; AAP skipped
    #   'graph_granted_aap_failed'            — AAP creation errored; soft-skip
    #   'whatif_skipped'                      — -WhatIf prevented AAP creation
    #   'configured'                          — All grants + AAP in place
    # Hard-fail variants (script throws) are surfaced via stderr — the JSON
    # is still emitted first per the SEC-M-STEP3-INFRA-01 pattern so the hook
    # can read `phaseC.status` and `phaseC.detail` even on a throwing run.
    phaseC = [ordered]@{
        status                 = $mailSenderStatus
        detail                 = $mailSenderDetail
        mailboxAddress         = $mailSenderMailboxAddress
        mailboxType            = $mailSenderType
        aapPresent             = $mailSenderAapPresent
        scopeGroup             = $mailSenderScopeGroupSmtp
        scopeGroupCreated      = $mailSenderScopeGroupCreated
        required               = $mailSenderRequiredResolved
        requiredSource         = $mailSenderRequiredSource
        miObjectId             = $MailSenderMiObjectId
        fatalError             = $phaseCFatalError
    }
}

Write-Step 'Summary:'
$summary.GetEnumerator() | ForEach-Object { [Console]::Error.WriteLine("  $($_.Key) = $($_.Value)") }

# Emit machine-readable JSON on stdout for the azd postprovision hook to consume
# BEFORE any throw, so summary is always visible. stdout is reserved for this JSON.
$summary | ConvertTo-Json -Depth 4 -Compress

# Post-emit: fail the script if the restart failed. The summary is already on stdout,
# so the hook can diagnose from BOOTSTRAP_JSON. Recovery path documented in HANDOVER.md.
if ($functionAppRestartStatus -eq 'failed') {
    throw $functionAppRestartError
}

# WS10 MED-1 fix — re-throw a Phase C fatal error AFTER summary emit so the
# operator's `phaseC.status` + `phaseC.detail` are visible in BOOTSTRAP_JSON
# even on hard-fail paths. Only fires when $MailSenderRequired resolved to
# true AND a downstream step threw (mailbox lookup, Graph grant, AAP).
if ($null -ne $phaseCFatalError) {
    throw "Phase C bootstrap failed: $phaseCFatalError"
}

# Strict-mode: fail AFTER summary emission if admin was required but unresolved.
# Typical trigger is a typo in AZURE_ADMIN_UPN. Recovery: fix the UPN / email
# env var and re-run `azd provision`, or assign the admin App Role via portal
# and drop the flag.
if ($adminResolutionStatus -eq 'required_but_unresolved') {
    $strictSource = $summary.requireAdminUserResolvedSource
    throw "Admin user not resolved and strict-require-admin is in force ($strictSource). Tried -AdminUpn='$AdminUpn' -AdminEmail='$AdminEmail'. Fix the parameter values, or for a one-off prod re-run with a known-unresolvable admin pass -AllowMissingAdminInProd."
}

} finally {
    # Session minimisation — drop Graph tokens even on script failure (ADR-0010 §3).
    try {
        if (Get-MgContext -ErrorAction SilentlyContinue) {
            Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
            [Console]::Error.WriteLine("[bootstrap-entra] Disconnected from Microsoft Graph.")
        }
    } catch {
        # Best-effort cleanup; swallow.
    }
}
