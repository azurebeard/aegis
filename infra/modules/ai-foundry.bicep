// ai-foundry.bicep — Azure AI Foundry account + project + model deployments.
// ADR-0017 (identity + region + connection model), ADR-0018 (gpt-4.1-mini as
// aegis-small on Standard tier), ADR-0019 (orchestrator pattern — this module
// only provides the inference plane it calls into).
//
// Resource-shape reconciliation (infra-pass):
// ADR-0017 §1 names the two resources `aif-<env>-<region>-hub` / `-proj` and uses
// the phrase "workspace kind=Hub / kind=Project". That wording reflects the
// older ML-workspaces-based AI Studio architecture. The SDK the ADR actually
// locks in (`@azure/ai-projects@^2.1.0`) targets the newer second-generation
// AI Foundry data plane, which is backed by:
//   - `Microsoft.CognitiveServices/accounts`   (`kind: 'AIServices'`)  — the "Hub"
//   - `Microsoft.CognitiveServices/accounts/projects`                  — the "Project"
//   - `Microsoft.CognitiveServices/accounts/deployments`               — the models
// (children of the ACCOUNT, not the project — projects consume account deployments).
//
// This module implements the CognitiveServices route. The portal surfaces the
// account as the "Foundry Hub" and the child as the "Foundry Project", so the
// ADR's user-facing names are preserved; only the ARM type differs from the
// ADR's internal prose. `@azure/ai-projects` endpoint
// `https://<account>.services.ai.azure.com/api/projects/<project>` requires
// `customSubDomainName` on the account — set here.
//
// Region parity (ADR-0017 §2): the module takes
// `opsLocation` as its ONLY location parameter. There is no separate override
// knob — parity is structural. The runtime check on `FOUNDRY_REGION` (handler-
// side) is the defence-in-depth second layer for the degenerate case where an
// operator manually edits app settings without re-running `azd up`.
//
// Cross-tenant posture (ADR-0017 §6.1): `networkAcls.defaultAction: 'Deny'`
// + `disableLocalAuth: true` + implicit `allowedTenants: [subscription().tenantId]`
// (unset = tenant-pinned by default). No MSP / cross-tenant features enabled.
//
// Federated model SKUs (ADR-0017 §6.1.3 + §Decision.8): both deployments pin
// `sku.name: 'Standard'` — the strictly regional tier. GlobalStandard /
// DataZoneStandard / GlobalProvisionedManaged are forbidden at the Bicep plane
// and additionally denied by Azure Policy `aegis-foundry-model-sku-allowlist`
// (see `policy-foundry-sku.bicep`).

param workload string
param environment string
param regionShort string

@description('Foundry region — pinned to the ops-store region at the call site; no separate override knob (ADR-0017 §2 region parity).')
param opsLocation string

param tags object

@description('Principal ID of the agent user-assigned MI (ADR-0017 §3). Granted Azure AI Developer on the Project.')
param agentMiPrincipalId string

@description('Log Analytics workspace ID for diagnostic settings (observability module output).')
param logAnalyticsWorkspaceId string

@description('Enable resource lock + purge protection. Driven by env-aware hardening tier at the caller (prod only).')
param resourceLocksEnabled bool

@description('Env-aware public network access on the AI Services account. Driven by the same privateEndpointsEnabled switch KV and storage use (ADR-0017 §5).')
param publicNetworkAccessEnabled bool = true

@description('Model deployment name for the small-tier default (aegis-small). ADR-0018.')
param smallDeploymentName string = 'aegis-small'

@description('Underlying OpenAI model for the small-tier deployment. ADR-0018 picks gpt-4.1-mini.')
param smallModelName string = 'gpt-4.1-mini'

@description('Pinned model version for the small-tier deployment (GA release of gpt-4.1 class). Re-validate against the Foundry catalogue each ADR review.')
param smallModelVersion string = '2025-04-14'

@minValue(10)
@maxValue(5000)
@description('TPM capacity (thousands) for the small-tier deployment. Default 50 = 50K TPM, generous for single-tenant brief workload; prod may tune up. Minimum 10 matches Foundry default quota.')
param smallCapacityTpmThousands int = 50

@description('Opt-in: deploy the nano-tier model. Default false. As of 2026-04-19 `gpt-4.1-nano` is NOT available on the regional `Standard` SKU in West Europe — only `GlobalStandard` / `DataZoneStandard` — both of which ADR-0017 §6.1.3 forbids. Step 5 brief-agent only needs aegis-small (gpt-4.1-mini on Standard, which IS available in WEU). When a step-7 agent vertical needs router-class classification, re-evaluate: either enable `DataZoneStandard` (EU-only residency; requires ADR-0017 amendment) or migrate Foundry to a region where nano is on Standard.')
param deployNano bool = false

@description('Model deployment name for the nano-tier (aegis-nano). Only deployed when `deployNano` is true.')
param nanoDeploymentName string = 'aegis-nano'

@description('Underlying OpenAI model for the nano-tier deployment.')
param nanoModelName string = 'gpt-4.1-nano'

@description('Pinned model version for the nano-tier deployment.')
param nanoModelVersion string = '2025-04-14'

@minValue(10)
@maxValue(5000)
@description('TPM capacity (thousands) for the nano-tier deployment. Default 10 = 10K TPM; nano is intended for router-class classification only (ADR-0018). Minimum 10 matches Foundry default quota.')
param nanoCapacityTpmThousands int = 10

// -- Names (ADR-0001 CAF + ADR-0017 §1 refinement) --

var hubAccountName = 'aif-${workload}-hub-${environment}-${regionShort}'
var projectName = 'aif-${workload}-proj-${environment}-${regionShort}'

// `customSubDomainName` MUST match the account name segment that the
// `@azure/ai-projects` SDK expects when it constructs
// `https://<customSubDomainName>.services.ai.azure.com/api/projects/<projectName>`.
// Azure Cognitive Services requires this to be globally-unique across all
// Cognitive / OpenAI accounts. We reuse the account name directly (already
// RG-disambiguated by env + regionShort + workload token) and accept that
// collisions are vanishingly rare at the `aif-aegis-hub-*` prefix level.
var customSubDomain = hubAccountName

// -- Role definition IDs --
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
// Azure AI Developer — ADR-0017 §3 "Minimum role to create threads, invoke
// agents, and consume deployments inside the project." Azure AI User is the
// newer least-privilege default per 2026-04-13 Foundry RBAC guidance; a
// follow-up ADR may step down to it, but ADR-0017 locks Developer and this
// module honours that.
var azureAiDeveloperRoleId = '64702f94-c441-49e6-a78b-ef80e0188fee' // gitleaks:allow

// -- AI Services account (portal surface: "Foundry Hub") --

resource hubAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: hubAccountName
  location: opsLocation
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    // `customSubDomainName` is required for the services.ai.azure.com
    // endpoint to resolve. SDK-locked requirement (ADR-0017 §4).
    customSubDomainName: customSubDomain

    // Enables the /projects child resource — required by the second-gen
    // Foundry data plane and by `@azure/ai-projects`.
    allowProjectManagement: true

    // MI-only auth plane — ADR-0017 §3 (no app-reg, no keys).
    disableLocalAuth: true

    // Env-aware networkAcls.
    //
    // On Microsoft.CognitiveServices/accounts, `networkAcls` is evaluated
    // independently of `publicNetworkAccess`: `defaultAction: 'Deny'` with
    // empty rule arrays denies all inbound even when `publicNetworkAccess:
    // 'Enabled'`. Dev deployments need `'Allow'` so the Flex Consumption
    // Function App (no stable egress IP) can reach Foundry. Prod with
    // `privateEndpointsEnabled: true` flips to `'Deny'` + PE + Function-App-
    // subnet rule in a follow-on pass.
    //
    // Tenant-pinning (ADR-0017 §6.1.1) is already enforced by
    // `disableLocalAuth: true` + implicit `allowedTenants` = [this tenant].
    // networkAcls does not add tenant scope — it is IP/VNet scope only.
    networkAcls: {
      defaultAction: publicNetworkAccessEnabled ? 'Allow' : 'Deny'
      virtualNetworkRules: []
      ipRules: []
    }

    // Env-aware public network access per ADR-0017 §5.
    publicNetworkAccess: publicNetworkAccessEnabled ? 'Enabled' : 'Disabled'

    // Belt-and-braces against future Microsoft feature that might let a
    // connected-data-source or external-tool integration broaden the
    // outbound surface. Restricts the account to Microsoft-managed FQDNs
    // by default; equivalent intent to the ML-workspaces `hbiWorkspace: true`
    // flag the ADR references (which does not exist on CognitiveServices
    // accounts).
    restrictOutboundNetworkAccess: true
    allowedFqdnList: []
  }
}

// -- Foundry Project child --

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: hubAccount
  name: projectName
  location: opsLocation
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: projectName
    description: 'Single-tenant XDR Hub (aegis) agent project — ${environment}. ADR-0017.'
  }
}

// -- Model deployments (children of the account, consumed by the project) --

resource smallDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: hubAccount
  name: smallDeploymentName
  sku: {
    name: 'Standard' // Regional SKU only — GlobalStandard / DataZoneStandard / GlobalProvisionedManaged forbidden (ADR-0017 §6.1.3).
    capacity: smallCapacityTpmThousands
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: smallModelName
      version: smallModelVersion
    }
    raiPolicyName: 'Microsoft.DefaultV2'
    // Pin the model version explicitly (ADR-0018 §Decision.2 explicit pinning).
    // `NoAutoUpgrade` ensures a Microsoft-side model deprecation cycle surfaces
    // as a Bicep deploy intent (operator re-validates the prompt contract) rather
    // than silently changing the underlying model during a random azd run.
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource nanoDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = if (deployNano) {
  parent: hubAccount
  name: nanoDeploymentName
  sku: {
    name: 'Standard'
    capacity: nanoCapacityTpmThousands
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: nanoModelName
      version: nanoModelVersion
    }
    raiPolicyName: 'Microsoft.DefaultV2'
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  // Sequential deployment — Azure CognitiveServices rejects parallel
  // deployments on the same account; this is the documented workaround.
  dependsOn: [
    smallDeployment
  ]
}

// -- Agent MI RBAC (project-scope, ADR-0017 §3) --

resource agentAiDeveloperRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId)) {
  scope: project
  name: guid(project.id, agentMiPrincipalId, azureAiDeveloperRoleId)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', azureAiDeveloperRoleId)
    description: 'Agent MI — Azure AI Developer on the Foundry Project (ADR-0017 §3). Minimum role to create threads, invoke agents, and consume deployments.'
  }
}

// -- Diagnostic settings → existing LAW --
//
// Both the account and the project are scoped separately (WS10
// SEC-M-STEP5-INFRA-01 resolution). The account carries resource-level audit
// categories (control-plane operations against the Foundry Hub); the project
// carries agent / thread / run data-plane audit categories that only surface
// at the child resource.

resource diagHub 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-to-law'
  scope: hubAccount
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    // Diagnostic log categories for Microsoft.CognitiveServices/accounts
    // (Foundry Hub + Project):
    //   Audit                    — control-plane / RBAC / deployment changes
    //   RequestResponse          — per-call metadata (model, tokens, status,
    //                              latency). Prompt + completion content is
    //                              NOT logged through this path under the
    //                              default `ContentLogging: false` Cognitive
    //                              Services setting (Modified Abuse Monitoring
    //                              opt-in retains that default — see §6.3).
    //   AzureOpenAIRequestUsage  — per-request token counts (billing fidelity)
    //   Trace                    — verbose SDK / internal traces
    //
    // §6.3 Foundry diagnostic-settings log-fidelity review:
    // The previous config enabled both `audit` AND `allLogs` category groups.
    // `allLogs` is a strict superset of `audit` — having both is a no-op for
    // ingested rows but flags as redundant config in static review. Collapsed
    // to a single `allLogs` line. Net coverage unchanged.
    //
    // Production-tier narrowing trigger (deferred): when the Modified Abuse
    // Monitoring submission lands (operator action, not deploy work — see
    // `docs/archive/MODIFIED-ABUSE-MONITORING-SUBMISSION.md`) the operator may opt
    // to narrow prod to `[Audit, RequestResponse, AzureOpenAIRequestUsage]`
    // and drop `Trace` to tighten metadata fidelity. Decision memo at
    // `docs/foundry-diag-review-2026-06-22.md`. Dev stays on allLogs for
    // debugging headroom — no customer data flows in dev.
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource diagProject 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-to-law'
  scope: project
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    // Diagnostic log categories for Microsoft.CognitiveServices/accounts
    // (Foundry Hub + Project):
    //   Audit                    — control-plane / RBAC / deployment changes
    //   RequestResponse          — per-call metadata (model, tokens, status,
    //                              latency). Prompt + completion content is
    //                              NOT logged through this path under the
    //                              default `ContentLogging: false` Cognitive
    //                              Services setting (Modified Abuse Monitoring
    //                              opt-in retains that default — see §6.3).
    //   AzureOpenAIRequestUsage  — per-request token counts (billing fidelity)
    //   Trace                    — verbose SDK / internal traces
    //
    // §6.3 Foundry diagnostic-settings log-fidelity review:
    // The previous config enabled both `audit` AND `allLogs` category groups.
    // `allLogs` is a strict superset of `audit` — having both is a no-op for
    // ingested rows but flags as redundant config in static review. Collapsed
    // to a single `allLogs` line. Net coverage unchanged.
    //
    // Production-tier narrowing trigger (deferred): when the Modified Abuse
    // Monitoring submission lands (operator action, not deploy work — see
    // `docs/archive/MODIFIED-ABUSE-MONITORING-SUBMISSION.md`) the operator may opt
    // to narrow prod to `[Audit, RequestResponse, AzureOpenAIRequestUsage]`
    // and drop `Trace` to tighten metadata fidelity. Decision memo at
    // `docs/foundry-diag-review-2026-06-22.md`. Dev stays on allLogs for
    // debugging headroom — no customer data flows in dev.
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// -- Prod-only resource lock (ADR-0017 §7) --

resource hubLock 'Microsoft.Authorization/locks@2020-05-01' = if (resourceLocksEnabled) {
  scope: hubAccount
  name: 'CanNotDelete-ai-foundry-hub'
  properties: {
    level: 'CanNotDelete'
    notes: 'Foundry Hub + Project contain agent-run transcripts. Preserve for post-incident inspection per ADR-0017 §7.'
  }
}

// -- Outputs --

output hubAccountName string = hubAccount.name
output hubAccountId string = hubAccount.id
output projectName string = project.name
output projectId string = project.id
// Endpoint shape per ADR-0017 §4, SDK-locked.
output projectEndpoint string = 'https://${customSubDomain}.services.ai.azure.com/api/projects/${project.name}'
output foundryRegion string = opsLocation
output smallDeploymentName string = smallDeployment.name
// Empty string when nano is not deployed (default). Callers that reference this
// output MUST check `empty()` before using the value to avoid referencing a
// non-existent deployment.
output nanoDeploymentName string = deployNano ? nanoDeployment.name : ''
