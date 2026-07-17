// storage-audit.bicep — append-blob audit store with environment-aware immutability.
// - prod: unlocked immutability policy created here; `azure.yaml` postprovision hook locks it.
// - dev/test: no immutability policy; allows `azd down` to tear the environment down cleanly.

param workload string
param environment string
param regionShort string
param location string
param uniqueSuffix string
param immutabilityEnabled bool
param retentionDays int
param resourceLocksEnabled bool
param auditWriterMiPrincipalId string
@allowed([
  'Enabled'
  'Disabled'
])
@description('Public-network-access mode. `Disabled` requires the audit blob PE in `networking.bicep` to be provisioned first. Operator note: `Disabled` blocks the agent observability endpoint from reaching this account from outside the VNet — the api-reader MI uses VNet integration (FA → PE) when private endpoints are enabled.')
param publicNetworkAccess string = 'Enabled'
@description('Principal ID of the api-reader user-assigned MI. Granted Storage Blob Data Reader on the audit container so the agent observability endpoint can walk recent NDJSON lines (HANDOVER §10 / SEC-INFO-DAAA-04). Read-only by design — write scope stays exclusive to the audit-writer MI to preserve the ADR-0015 single-writer hash-chain invariant.')
param apiReaderMiPrincipalId string = ''
param logAnalyticsWorkspaceId string
param tags object

var baseName = toLower('st${workload}audit${environment}${regionShort}')
var accountName = empty(uniqueSuffix) ? baseName : '${baseName}${toLower(uniqueSuffix)}'

// Storage Blob Data Contributor role (well-known GUID).
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // gitleaks:allow (Azure built-in role GUID, public)
// Storage Blob Data Reader role (well-known GUID).
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1' // gitleaks:allow (Azure built-in role GUID, public)

resource account 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: accountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_ZRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: publicNetworkAccess
    defaultToOAuthAuthentication: true
    encryption: {
      requireInfrastructureEncryption: true
      keySource: 'Microsoft.Storage'
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
    networkAcls: {
      // Mirrors `publicNetworkAccess` so a future flip-back stays
      // internally consistent (KV pattern).
      defaultAction: publicNetworkAccess == 'Disabled' ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: account
  name: 'default'
  properties: {
    isVersioningEnabled: false
    deleteRetentionPolicy: {
      enabled: false
    }
  }
}

resource auditContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: 'audit'
  properties: {
    publicAccess: 'None'
  }
}

// Immutability policy — created only in prod, in unlocked state. The postprovision
// hook in `azure.yaml` locks it post-deployment. `allowProtectedAppendWrites` permits
// AppendBlock operations under the locked policy without unlocking, which is the
// WS10 SEC-H-01 resolution: no mutability window.
resource immutability 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2024-01-01' = if (immutabilityEnabled) {
  parent: auditContainer
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: retentionDays
    allowProtectedAppendWrites: true
  }
}

// Container-scoped RBAC for the audit writer MI.
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: auditContainer
  name: guid(auditContainer.id, auditWriterMiPrincipalId, storageBlobDataContributorRoleId)
  properties: {
    principalId: auditWriterMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
  }
}

// Read-only access for the api-reader MI so the agent observability endpoint
// can walk recent agent-run.ndjson lines without write capability. The single-
// writer hash-chain invariant (ADR-0015) stays intact — this assignment grants
// no append / overwrite / delete capability. Container-scoped, not account-wide.
resource apiReaderAuditRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: auditContainer
  name: guid(auditContainer.id, apiReaderMiPrincipalId, storageBlobDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-to-law'
  scope: account
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

resource diagBlob 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-blob-to-law'
  scope: blobService
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

resource accountLock 'Microsoft.Authorization/locks@2020-05-01' = if (resourceLocksEnabled) {
  scope: account
  name: 'CanNotDelete-audit-storage'
  properties: {
    level: 'CanNotDelete'
    notes: 'Audit store — persistent evidence per PROJECT_BRIEF §10.'
  }
}

output storageAccountName string = account.name
output storageAccountId string = account.id
output auditContainerName string = auditContainer.name
