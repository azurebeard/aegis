<#
.SYNOPSIS
  Idempotent cleanup for AI-plane resources when `deployAiAgents=false`.
  Mitigation for SEC-OBS-DAAA-04 (HANDOVER §6.3).

.DESCRIPTION
  Azure's `incremental` deployment mode (azd default) does NOT delete
  resources that transition from "declared" to "skipped" in Bicep — so
  when an operator flips `AZURE_DEPLOY_AI_AGENTS` from true to false and
  re-runs `azd provision`, the Foundry Hub, AgentRun alert, and ~11
  agent-MI role assignments all persist on the infrastructure despite
  the Bicep module guards evaluating false.

  Practical posture is unchanged (agent MI is unbound from the Function
  App so no code runs under that identity), but the principle-of-least-
  privilege claim "deployAiAgents=false ⇒ zero agent-MI grants" is
  weaker than advertised. This script removes the stale residuals.

  **Data preservation invariant** (mirrors the ADR-0017 design-note
  guidance, also tracked in HANDOVER §6.3 "Tables + containers for the
  AI plane are UNCONDITIONAL"): this script NEVER touches BriefCache /
  AgentBudget / AgentHealth / PostureCache / IncidentAnalysisCache
  tables, the daily-briefs / posture-narratives / incident-narratives
  containers, or the agent MI itself. A future flip back to
  `deployAiAgents=true` restores RBAC + functionality with no data loss.

  Resources removed (when -AcceptDataLoss is supplied):
    * All RBAC role assignments where principalId == agent MI principal
      ID, across the subscription / resource group / table / container
      scopes Bicep would have created. Filter is by-principal, so any
      hand-applied (out-of-Bicep) grant on the MI is also cleaned.
    * The Foundry Hub Cognitive-Services account (cascades to the
      project + model deployments + endpoint).
    * The AgentRun scheduled-query alert rule.

  Resources DELIBERATELY left intact:
    * The agent MI itself (`id-aegis-agent-<env>-<region>`) — preserves
      identity continuity across toggles so a flip-back doesn't change
      the principal ID. Without grants the MI is benign.
    * Tables + blob containers consumed by the agent (data preservation).

  Operating modes:
    * Default (`-AcceptDataLoss` NOT supplied): dry-run. Lists what
      would be removed and exits non-zero so the operator sees the
      preview before committing.
    * `-AcceptDataLoss`: actions the removals. The flag name is
      explicit — accidentally running this script in a healthy AI plane
      can't happen without the operator typing the flag.

  Naming: agent MI / Foundry hub / project / alert names follow CAF and
  are recomputed from `-Workload` + `-Environment` + `-RegionShort` so
  there's no Bicep ↔ script drift to manage.

.PARAMETER SubscriptionId
  Target subscription. Sourced from azd env `AZURE_SUBSCRIPTION_ID`.

.PARAMETER ResourceGroupName
  Target RG. Sourced from azd env `AZURE_RESOURCE_GROUP_NAME`.

.PARAMETER Workload
  CAF workload short. Default 'aegis'.

.PARAMETER Environment
  CAF environment slot — `dev`, `test`, `prod` etc. Sourced from
  `AZURE_ENV_NAME`.

.PARAMETER RegionShort
  CAF region short — `weu`, `uks` etc. Sourced from azd env
  `AZURE_REGION_SHORT` if persisted; otherwise must be supplied.

.PARAMETER DeployAiAgents
  Required gate. The script no-ops unless this is the literal string
  `"false"` (case-insensitive, whitespace-trimmed). Any other value —
  including `"true"`, empty, `"True "` — exits 0 with a `noop` message.
  This is the second of two safety gates (the first being
  `-AcceptDataLoss`); together they make accidental destructive runs
  effectively impossible.

.PARAMETER AcceptDataLoss
  Switch. Without it, the script previews and exits non-zero.

.OUTPUTS
  Summary JSON on stdout describing what was checked / removed /
  skipped. Designed to be appended to the azd postprovision log so the
  operator has a record post-deploy.

.NOTES
  - Idempotent: re-running when state is already clean is a no-op.
  - Auth: relies on the caller's `az login` context. The caller MUST
    hold `User Access Administrator` on the RG (to delete role
    assignments) and `Contributor` on the RG (to delete the Foundry
    Hub + alert). The bootstrap operator (azd / deployer SP) already
    has both via the `AZURE_DEPLOYER_OBJECT_ID` pattern.
  - No Function App restart needed — the agent handlers are disabled
    by the upstream `deployAiAgents=false` toggle (functions.bicep
    short-circuits the `agentAppSettings` array + `agentMiResourceId`
    identity binding), so the MI is already unbound from the FA.

.EXAMPLE
  pwsh -File scripts/cleanup-ai-plane.ps1 `
    -SubscriptionId $env:AZURE_SUBSCRIPTION_ID `
    -ResourceGroupName $env:AZURE_RESOURCE_GROUP_NAME `
    -Environment $env:AZURE_ENV_NAME `
    -RegionShort weu `
    -DeployAiAgents $env:AZURE_DEPLOY_AI_AGENTS
  # Preview: lists what would be removed; exits 1.

.EXAMPLE
  pwsh -File scripts/cleanup-ai-plane.ps1 `
    -SubscriptionId $env:AZURE_SUBSCRIPTION_ID `
    -ResourceGroupName $env:AZURE_RESOURCE_GROUP_NAME `
    -Environment $env:AZURE_ENV_NAME `
    -RegionShort weu `
    -DeployAiAgents $env:AZURE_DEPLOY_AI_AGENTS `
    -AcceptDataLoss
  # Actions removals; emits summary JSON on success.

.LINK
  HANDOVER.md §6.3 SEC-OBS-DAAA-04
  docs/ADR-0017 (Foundry resource shape)
  docs/ADR-0019 (AgentRun alert)
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $SubscriptionId,
  [Parameter(Mandatory = $true)] [string] $ResourceGroupName,
  [Parameter()]                  [string] $Workload     = 'aegis',
  [Parameter(Mandatory = $true)] [string] $Environment,
  [Parameter(Mandatory = $true)] [string] $RegionShort,
  # Not Mandatory — empty means "unset" which we treat as "true" (the
  # Bicep default) so the script no-ops. This matches the azd hook
  # pattern where `${AZURE_DEPLOY_AI_AGENTS:-}` may expand to empty
  # before the toggle has ever been set.
  [Parameter(Mandatory = $false)] [AllowEmptyString()] [string] $DeployAiAgents = '',
  [Parameter()]                  [switch] $AcceptDataLoss
)

$ErrorActionPreference = 'Stop'

# --- Safety gate 1: the toggle ---------------------------------------------
# Only proceed when the operator has explicitly set the flag to "false".
# Trim + lowercase + literal compare. Any other value short-circuits.
$flag = ($DeployAiAgents ?? '').Trim().ToLowerInvariant()
if ($flag -ne 'false') {
  $payload = [pscustomobject]@{
    status         = 'noop'
    reason         = 'deployAiAgents-not-false'
    deployAiAgents = $DeployAiAgents
  }
  Write-Host ("[cleanup-ai-plane] no-op (deployAiAgents=`"$DeployAiAgents`" is not the literal string `"false`")")
  $payload | ConvertTo-Json -Compress
  exit 0
}

# --- Compute the four target resource names (CAF; mirrors Bicep) ----------
$agentMiName        = "id-${Workload}-agent-${Environment}-${RegionShort}"
$foundryHubName     = "aif-${Workload}-hub-${Environment}-${RegionShort}"
$foundryProjectName = "aif-${Workload}-proj-${Environment}-${RegionShort}"
$agentAlertName     = "alert-${Workload}-agentrun-anomaly-${Environment}-${RegionShort}"

Write-Host "[cleanup-ai-plane] deployAiAgents=false confirmed; target resources:"
Write-Host "  agent MI    : $agentMiName"
Write-Host "  Foundry hub : $foundryHubName"
Write-Host "  Foundry proj: $foundryProjectName"
Write-Host "  Agent alert : $agentAlertName"

# Make sure we're operating in the right subscription. `az` will quietly
# act on whatever subscription the local context is on otherwise.
az account set --subscription $SubscriptionId | Out-Null

# --- Discover agent MI principalId (if MI still exists) -------------------
$agentMiPrincipalId = ''
$miJson = az identity show `
  --name $agentMiName `
  --resource-group $ResourceGroupName `
  --query 'principalId' `
  --output tsv 2>$null
if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($miJson)) {
  $agentMiPrincipalId = $miJson.Trim()
  Write-Host "[cleanup-ai-plane] agent MI principalId: $agentMiPrincipalId"
} else {
  Write-Host "[cleanup-ai-plane] agent MI '$agentMiName' not found — skipping role-assignment loop."
}

# --- Enumerate stale role assignments -------------------------------------
$assignments = @()
if (-not [string]::IsNullOrWhiteSpace($agentMiPrincipalId)) {
  # `--assignee` enumerates ALL assignments (across all scopes the caller
  # can see) where the principal is the agent MI. This includes:
  #  * RG-scope (rg-aegis-<env>-<region>) — Storage Table Data Reader
  #    on the table service
  #  * Per-table scope — Storage Table Data Contributor on each writable
  #    table (BriefCache / AgentBudget / AgentHealth / PostureCache /
  #    IncidentAnalysisCache / IngestHealth)
  #  * Per-container scope — Storage Blob Data Contributor on daily-briefs
  #    / posture-narratives / incident-narratives; Reader on incidents-detail
  #  * Foundry project scope — Azure AI Developer on the project
  # Capturing them all by principal means a future Bicep grant addition
  # is auto-covered; no script-side allowlist to maintain.
  $assignmentsRaw = az role assignment list `
    --assignee $agentMiPrincipalId `
    --all `
    --output json 2>$null
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($assignmentsRaw)) {
    $assignments = $assignmentsRaw | ConvertFrom-Json
  }
  Write-Host "[cleanup-ai-plane] $($assignments.Count) role assignment(s) found on agent MI."
}

# --- Check Foundry Hub presence ------------------------------------------
$foundryHubExists = $false
az cognitiveservices account show `
  --name $foundryHubName `
  --resource-group $ResourceGroupName `
  --query 'id' `
  --output tsv 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { $foundryHubExists = $true }

# --- Check AgentRun alert presence ---------------------------------------
$agentAlertExists = $false
az monitor scheduled-query show `
  --name $agentAlertName `
  --resource-group $ResourceGroupName `
  --query 'id' `
  --output tsv 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { $agentAlertExists = $true }

Write-Host "[cleanup-ai-plane] Foundry hub present : $foundryHubExists"
Write-Host "[cleanup-ai-plane] Agent alert present : $agentAlertExists"

# --- Safety gate 2: -AcceptDataLoss ---------------------------------------
if (-not $AcceptDataLoss) {
  $preview = [pscustomobject]@{
    status              = 'preview'
    deployAiAgents      = $DeployAiAgents
    agentMiPrincipalId  = $agentMiPrincipalId
    roleAssignmentCount = $assignments.Count
    foundryHubExists    = $foundryHubExists
    agentAlertExists    = $agentAlertExists
    note                = 'Re-run with -AcceptDataLoss to action removals.'
  }
  Write-Host "[cleanup-ai-plane] PREVIEW — re-run with -AcceptDataLoss to commit."
  $preview | ConvertTo-Json -Compress
  exit 1
}

# --- ACT: remove role assignments ----------------------------------------
$removedAssignments = 0
foreach ($a in $assignments) {
  $rid = $a.id
  Write-Host "[cleanup-ai-plane] removing role assignment: $($a.roleDefinitionName) on scope $($a.scope)"
  az role assignment delete --ids $rid --output none 2>$null
  if ($LASTEXITCODE -eq 0) { $removedAssignments++ } else { Write-Host "  WARN: delete failed for $rid" }
}

# --- ACT: delete Foundry hub (cascades to project + deployments) ---------
$removedFoundry = $false
if ($foundryHubExists) {
  # The hub has a `CanNotDelete` lock (ai-foundry.bicep:352) when the
  # Bicep module is active. With `deployAiAgents=false` the module was
  # skipped on the most recent deploy, so the lock should be gone — but
  # if the operator flipped from true → false and the lock was created
  # under the previous deploy, it persists. Probe + remove the lock first.
  $lockJson = az lock list `
    --resource-group $ResourceGroupName `
    --resource $foundryHubName `
    --namespace Microsoft.CognitiveServices `
    --resource-type accounts `
    --query "[?name=='CanNotDelete-ai-foundry-hub'].id" `
    --output tsv 2>$null
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($lockJson)) {
    Write-Host "[cleanup-ai-plane] removing residual CanNotDelete lock on Foundry hub"
    az lock delete --ids $lockJson.Trim() --output none 2>$null | Out-Null
  }

  Write-Host "[cleanup-ai-plane] deleting Foundry hub $foundryHubName"
  az cognitiveservices account delete `
    --name $foundryHubName `
    --resource-group $ResourceGroupName 2>$null
  if ($LASTEXITCODE -eq 0) { $removedFoundry = $true }
}

# --- ACT: delete AgentRun alert ------------------------------------------
$removedAlert = $false
if ($agentAlertExists) {
  Write-Host "[cleanup-ai-plane] deleting AgentRun alert $agentAlertName"
  az monitor scheduled-query delete `
    --name $agentAlertName `
    --resource-group $ResourceGroupName `
    --yes --output none 2>$null
  if ($LASTEXITCODE -eq 0) { $removedAlert = $true }
}

# --- Summary JSON on stdout ----------------------------------------------
$summary = [pscustomobject]@{
  status                = 'cleaned'
  deployAiAgents        = $DeployAiAgents
  agentMiPrincipalId    = $agentMiPrincipalId
  roleAssignmentsRemoved = $removedAssignments
  roleAssignmentsTotal  = $assignments.Count
  foundryHubRemoved     = $removedFoundry
  agentAlertRemoved     = $removedAlert
}
Write-Host "[cleanup-ai-plane] DONE — $removedAssignments role assignments removed, Foundry hub: $removedFoundry, alert: $removedAlert"
$summary | ConvertTo-Json -Compress
exit 0
