// storage-ops.bicep — operational Table Storage (ADR-0006) + Function deployment blob container.
// All tables pre-created. No secrets; auth is Managed Identity + Azure RBAC (shared-key access disabled).
// Step 2: blob service + `func-deployments` container + container-scoped Blob Data Owner for the
// api-reader MI so Flex Consumption can push/pull the app package.
// Step 3: IngestHealth table (ADR-0011 §5a); Table Data Contributor for the ingest MI;
// Table Data Reader for the api-reader MI.
// Step 4 (ADRs 0014 / 0016): `incidents-detail` container for per-incident full-JSON blobs;
// blob versioning + change feed + 7-day soft-delete as compensating controls for the ingest
// MI's Contributor role (ADR-0014 §3.3 lifecycle-only-deletes invariant); lifecycle management
// policy deletes incidents-detail blobs after `incidentsRetentionDays` (180d prod / 14d dev);
// Contributor role to ingest MI scoped to the container, Reader role to api-reader MI.
// Step 5 (ADRs 0019 / 0020 / 0022): three new tables `BriefCache` / `AgentBudget` /
// `AgentHealth`; `daily-briefs` container for per-day brief blobs; lifecycle rule with
// `briefRetentionDays` (180d prod / 14d dev); agent MI gets per-table Contributor on the
// three new tables, container-scoped Blob Data Contributor on `daily-briefs`, and
// container-scoped Blob Data Reader on `incidents-detail`. NO Graph / Defender / Sentinel
// scopes — agent reads tenant context from the ops store only (ADR-0017 §3).

param workload string
param environment string
param regionShort string
param location string
param uniqueSuffix string
param resourceLocksEnabled bool
param logAnalyticsWorkspaceId string
param tags object
@allowed([
  'Enabled'
  'Disabled'
])
@description('Public-network-access mode. `Disabled` requires the ops storage PEs (blob + table + queue) in `networking.bicep` to be provisioned first. Operator note: `Disabled` blocks `azd deploy api` from uploading the Function App deployment zip from a workstation outside the VNet — see `deployerIpAllowlist` below for the prod-tier workflow (path (c)).')
param publicNetworkAccess string = 'Enabled'

// F-fwd-4 (docs/prod-tier-dryrun-lessons-learned.md §3) — see the
// equivalent block in `keyvault.bicep` for the rationale. Ops storage
// hosts the Function App's deployment zip (`func-deployments` container);
// `azd deploy api` runs from the operator's workstation and PUTs the
// build artifact into that container before the FA rehydrates from it.
// With `publicNetworkAccess: Disabled` the PUT hits Forbidden because
// the operator is outside the VNet boundary. This array wires durable
// CIDR exceptions through `networkAcls.ipRules` while leaving the
// default-action gate `Deny` (PE remains the primary access path).
// Wire via:
//   azd env set AZURE_DEPLOYER_IP_ALLOWLIST "203.0.113.42/32"
// Multi-CIDR supported via comma-separated env var (main.bicep splits).
// Format: IPv4 single IP or CIDR per Microsoft.Storage networkAcls schema.
// Storage rejects `/31` and `/32` are accepted; private RFC1918 ranges
// fail at provision with `'PublicEndpointSubnetMissingNetworkAcls'` so
// only public CIDRs are valid here. IPv6 ipRules unsupported by Storage.
@description('F-fwd-4 — operator CIDR exceptions for the ops storage firewall when publicNetworkAccess=Disabled. Applied as `networkAcls.ipRules`. See header for env var wiring.')
param deployerIpAllowlist array = []

@description('Principal ID of the api-reader user-assigned MI. Narrow HTTP read-path MI: Storage Table Data Reader on the Table service (read-only across all tables, ADR-0006); Storage Blob Data Reader on incidents-detail (step 4). NO access to host-storage containers (those moved to the `host` MI on 2026-04-19).')
param apiReaderMiPrincipalId string = ''

@description('Principal ID of the ingest user-assigned MI (ADR-0011 §5a). Granted Storage Table Data Contributor on SecureScore + IngestHealth, and Storage Blob Data Contributor on incidents-detail (step 4, ADR-0014 §3.3). Separation from user-request code paths is identity + code-level per ADR-0006 amendment.')
param ingestMiPrincipalId string = ''

@description('Principal ID of the arm-ingest user-assigned MI (ADR-0036 v1.2 — M-Q2 split). ARM-data-plane-only identity, granted Storage Table Data Contributor on AzureSecureScores + IngestHealth (so the ARM ingest path can write its own freshness row alongside the original ingest MI). No Graph permissions, no other table scopes. Pairs with the subscription-scope Security Reader assignment in defender-cloud-rbac.bicep.')
param armIngestMiPrincipalId string = ''

@description('Principal ID of the mail-sender user-assigned MI (ADR-0030 Phase C §C.9). Granted Storage Table Data Contributor on TenantSettings ONLY — used to write the idempotency cache rows (report-email-idempotency:<key>:<periodKey>) + the send-history rows (report-email-send:<graphMessageId>). No other table scopes; no blob scopes; no subscription role. Graph Mail.Send + Mail.Read scoped via Exchange AAP provisioned by bootstrap-entra.ps1.')
param mailSenderMiPrincipalId string = ''

@description('Principal ID of the host user-assigned MI. Owns AzureWebJobsStorage + Flex Consumption deployment infrastructure. Granted account-scope Storage Blob Data Owner + Storage Queue Data Contributor per Microsoft functions-identity-based-connections-tutorial. NOT granted to api-reader (which stays narrow). Added 2026-04-19 after live-observed Timer NoOpListener state without account-scope host access.')
param hostMiPrincipalId string = ''

@description('Principal ID of the agent user-assigned MI (ADR-0017 §3). Granted per-table Table Data Contributor on BriefCache / AgentBudget / AgentHealth, container-scoped Blob Data Contributor on daily-briefs, and container-scoped Blob Data Reader on incidents-detail. No other scopes; agent reads tenant context from the ops store only.')
param agentMiPrincipalId string = ''

@description('Principal ID of the threatIntel user-assigned MI (ADR-0037). Outbound ransomware.live PRO API consumer. Granted Storage Table Data Contributor on RansomwareIntel + IngestHealth only — no other table scopes, no container access, no Graph scopes, no subscription-scope role. Per-secret ABAC on the KV secret lives in keyvault.bicep. Separate trust boundary from every other MI because the consumer is a third-party HTTP API.')
param threatIntelMiPrincipalId string = ''

@description('Deploy the AI plane. When false, all agent-MI role assignments + the api-reader Blob Reader grants on agent-only containers (daily-briefs, posture-narratives, incident-narratives) are skipped. Tables + containers themselves remain — data-preservation on toggle per HANDOVER §6.3.')
param deployAiAgents bool = true

@description('Retention in days for the incidents-detail blob container (ADR-0014 §5). 180 in prod / 14 in dev by default; lifecycle management policy deletes blobs past this age.')
@minValue(7)
@maxValue(3650)
param incidentsRetentionDays int = 14

@description('Retention in days for the daily-briefs blob container (ADR-0022). Env-aware: 180d prod / 14d dev by default; lifecycle management policy deletes blobs past this age. Mirrors incidents retention — briefs are synthesised reports, deterministic summaries live in BriefCache table for shorter-lived read-path access.')
@minValue(7)
@maxValue(3650)
param briefRetentionDays int = 14

@description('Retention in days for the posture-narratives blob container (ADR-0027 §Decision.5). 21d default per the ADR — two-sprint window + one week buffer; weekly cadence means <4 narratives fall inside the window on a quiet tenant. Lifecycle management policy deletes blobs past this age.')
@minValue(7)
@maxValue(3650)
param postureRetentionDays int = 21

@description('Retention in days for the incident-narratives blob container (ADR-0028 §Decision.5). 90d default — per-incident cache is bound to the parent incident lifecycle; this sweep is a belt-and-braces floor alongside the daily sweep that removes the analysis row when the parent incident summary is purged.')
@minValue(7)
@maxValue(3650)
param incidentsAnalysisRetentionDays int = 90

var baseName = toLower('st${workload}ops${environment}${regionShort}')
var accountName = empty(uniqueSuffix) ? baseName : '${baseName}${toLower(uniqueSuffix)}'

var funcDeploymentsContainerName = 'func-deployments'
var incidentsDetailContainerName = 'incidents-detail'
var dailyBriefsContainerName = 'daily-briefs'
var postureNarrativesContainerName = 'posture-narratives'
var incidentNarrativesContainerName = 'incident-narratives'
var brandingAssetsContainerName = 'branding-assets'

// Azure built-in role definition IDs (public, documented).
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
var storageBlobDataOwnerRoleId       = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' // gitleaks:allow
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // gitleaks:allow
var storageBlobDataReaderRoleId      = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1' // gitleaks:allow
var storageTableDataContributorRole  = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3' // gitleaks:allow
var storageTableDataReaderRoleId      = '76199698-9eea-4c19-bc75-cec21354c6b6' // gitleaks:allow
var storageQueueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88' // gitleaks:allow

// Table list mirrors ADR-0006 §"Operational state — Azure Table Storage".
// 2026-04-18 — `IngestHealth` added by ADR-0011 §5a (ADR-0006 amendment).
var tableNames = [
  'SecureScore'
  'Incidents'
  'EntraRisk'
  'ConditionalAccessPolicies' // ADR-0034 §3.3 (2026-05-10) — Phase 8D: per-(tenantId, policyId) snapshot of /v1.0/identity/conditionalAccess/policies, hourly. Diff detection writes ca.policy.changed audit lines. Ingest MI Contributor; api-reader MI Reader.
  'AzureSecureScores' // ADR-0036 (2026-05-10) — Defender for Cloud Secure Score: per-(tenantId, subscriptionId, snapshotDate) daily snapshot via ARM API Microsoft.Security/secureScores. 90-day retention; Ingest MI Contributor; api-reader MI Reader.
  'StackItems'
  'KEVMatches'
  'ApprovalDecisions'
  'ManualTasks'
  'AgentRuns'
  'IngestHealth'
  'BriefCache'     // ADR-0022 read-path cache
  'AgentBudget'    // ADR-0019 pessimistic token reservation
  'AgentHealth'    // ADR-0019 circuit breaker state
  'TenantDirectory' // 2026-04-20: tenant displayName cache (ingest writes, agent reads) — used by brief-agent prompt builder because agent MI has no Graph scopes (ADR-0017 §3).
  'TenantSettings'  // ADR-0025 (2026-04-20): per-tenant operator settings. RowKey dispatches by concern (`tile-visibility` for Phase 1). Ingest MI Contributor; api-reader MI Reader.
  'PostureCache'    // ADR-0027 §Decision.5 (2026-04-20): weekly posture narrative cache; RowKey `posture.<yyyy-Www>`. Agent MI Contributor; api-reader MI Reader (via account-scope Table Reader).
  'IncidentAnalysisCache' // ADR-0028 §Decision.5 (2026-04-21): per-incident on-demand analysis cache; RowKey `incidents.analysis.<id>`. Agent MI Contributor; api-reader MI Reader (via account-scope Table Reader).
  'ReportSnapshots' // ADR-0030 (2026-04-28): captured period reports; RowKey `<periodKey>_<capturedAt>`. Ingest MI Contributor; api-reader MI Reader.
  'KEV' // ADR-0032 (2026-04-28): CISA KEV catalog (single global partition); RowKey = cveID. Ingest MI Contributor; api-reader MI Reader.
  'KevSuppressions' // ADR-0033 (2026-04-28): per-(itemId, cveID) status workflow; RowKey = `<itemId>_<cveID>`. Ingest MI Contributor; api-reader MI Reader.
  'UserDormancy' // ADR-0034 §3.1 (2026-05-01) — Phase 8B: per-(tenantId, userId) signInActivity snapshot for the dormant-account report. Ingest MI Contributor; api-reader MI Reader.
  'SignIns' // ADR-0034 §3.2 (2026-05-08) — Phase 8C: per-(tenantId, signInId) Entra sign-in events with geo-fence cross-reference. 30d retention default; Ingest MI Contributor; api-reader MI Reader.
  'ArmIngestHealth' // ADR-0036 v1.3 (2026-05-12) — per-(tenantId, source) freshness row for ARM-data-plane ingest sources (azure.security.*). Split from IngestHealth to bound the cross-plane forge-row surface (WS10 v1.2 MED follow-track). armIngest MI Contributor; api-reader MI Reader (account-scope).
  'RansomwareIntel' // ADR-0037 (2026-06-25) — ransomware.live PRO threat-intel: two RowKey families (`victim.<base64(post_title@group)>` + `press.<sha256(url)>`); PartitionKey = tenantId; 90d retention default. threatIntel MI Contributor; api-reader MI Reader (account-scope).
]

resource account 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: accountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
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
        table: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
    networkAcls: {
      // Mirrors `publicNetworkAccess` so a future flip-back stays
      // internally consistent.
      defaultAction: publicNetworkAccess == 'Disabled' ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
      ipRules: [for cidr in deployerIpAllowlist: {
        value: cidr
        action: 'Allow'
      }]
    }
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2024-01-01' = {
  parent: account
  name: 'default'
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2024-01-01' = [for t in tableNames: {
  parent: tableService
  name: t
}]

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

resource diagTable 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-table-to-law'
  scope: tableService
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
  name: 'CanNotDelete-ops-storage'
  properties: {
    level: 'CanNotDelete'
    notes: 'Operational data persists across upgrades per PROJECT_BRIEF §10.'
  }
}

// -- Blob service (step 4 enables versioning + change feed + 7-day soft-delete) --
//
// These features are account-wide (they apply to every container, including func-deployments).
// Rationale and compensating controls:
//   - Versioning: 7-day retention on superseded or deleted blobs. For incidents-detail this is
//     the out-of-band-delete recovery window ADR-0016 SEC-M-ADR-16-01 depends on. For
//     func-deployments the versions accumulate on each azd deploy; lifecycle policy below
//     prunes them after 7 days to cap cost.
//   - Change feed: emits append-only log of blob operations. Forensic trail for
//     unauthorised deletes / overwrites that the audit chain (ADR-0015) cannot cover.
//   - `deleteRetentionPolicy`: 7-day blob soft-delete. Distinct from versioning — deleted
//     blobs recoverable via `undelete` API.

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: account
  name: 'default'
  properties: {
    isVersioningEnabled: true
    changeFeed: {
      enabled: true
      retentionInDays: 30
    }
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource funcDeploymentsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: funcDeploymentsContainerName
  properties: {
    publicAccess: 'None'
  }
}

// -- Functions host system containers (pre-created for narrow RBAC scoping) --
//
// The Azure Functions v4 host uses these containers under MI-auth
// `AzureWebJobsStorage` for its own internal state: host singleton blob
// leases (required by `useMonitor: true` Timer triggers), function secrets,
// and host metadata. They are normally auto-created by the host on first
// start — but auto-creation fails on MI-auth without account-scope Blob
// Data Owner, which would widen api-reader's blob privileges beyond the
// existing narrow container-scoped model (ADR-0006 / ADR-0011).
//
// Pre-creating them here, plus granting **container-scoped** Blob Data
// Owner only on these two, preserves least privilege: api-reader retains
// its narrow container-scoped grants on func-deployments + these two host
// containers, plus read-only on incidents-detail. Application containers
// (`incidents-detail`, future daily-briefs) are NOT writable by api-reader.
//
// Live-observed root cause of the Timer NoOpListener state on Flex
// Consumption: without this access the host can't acquire the
// Timer's singleton blob lease, so scheduled fires never register.

resource webJobsHostsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: 'azure-webjobs-hosts'
  properties: {
    publicAccess: 'None'
  }
}

resource webJobsSecretsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: 'azure-webjobs-secrets'
  properties: {
    publicAccess: 'None'
  }
}

// -- incidents-detail container (step 4, ADR-0014 §3.2) --
//
// One blob per ingested version of an incident, path
// `<yyyy>/<mm>/<dd>/<incidentId>.json`. Lifecycle policy (below) deletes blobs past
// `incidentsRetentionDays`; ingest MI does not exercise delete (ADR-0014 §3.3
// lifecycle-only-deletes invariant).

resource incidentsDetailContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: incidentsDetailContainerName
  properties: {
    publicAccess: 'None'
  }
}

// -- daily-briefs container (step 5, ADR-0022) --
//
// One blob per (tenantId, yyyy-mm-dd) brief, path
// `<yyyy>/<mm>/<dd>/<tenantId>.md`. Contents are the rendered brief body
// (sanitised Markdown per ADR-0022 §XSS defence). BriefCache table carries
// the authoritative ETag, hash, runId and staleness window; the blob is the
// body. Lifecycle policy (below) deletes blobs past `briefRetentionDays`;
// agent MI does not exercise delete (lifecycle-only-deletes invariant,
// mirroring ADR-0014 §3.3 for incidents-detail).
resource dailyBriefsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: dailyBriefsContainerName
  properties: {
    publicAccess: 'None'
  }
}

// -- posture-narratives container (ADR-0027 §Decision.5) --
//
// One blob per (tenantId, yyyy-Www) weekly posture narrative, path
// `<yyyy>/<Www>/<tenantId>.md`. Contents are the rendered posture body.
// Lifecycle policy (below) deletes blobs past `postureRetentionDays`;
// agent MI does not exercise delete (lifecycle-only-deletes invariant,
// mirroring ADR-0014 §3.3 for incidents-detail).
resource postureNarrativesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: postureNarrativesContainerName
  properties: {
    publicAccess: 'None'
  }
}

// -- incident-narratives container (ADR-0028 §Decision.5) --
//
// One blob per incident: `<incidentId>.md`. Flat path because the RowKey
// (`incidents.analysis.<id>`) is the lookup primitive. Re-analysis
// overwrites. Lifecycle policy (below) deletes blobs past
// `incidentsAnalysisRetentionDays`; agent MI does not exercise delete
// (lifecycle-only-deletes invariant, ADR-0014 §3.3 precedent).
resource incidentNarrativesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: incidentNarrativesContainerName
  properties: {
    publicAccess: 'None'
  }
}

// -- Lifecycle management policy --
//
// Rules:
//   - `incidents-detail` blobs: delete after `incidentsRetentionDays` (180 prod / 14 dev).
//   - `func-deployments` old versions: delete after 7 days (caps versioning cost).
// Executed by Azure Storage's service identity, not the ingest MI (ADR-0014 §3.3).

resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2024-01-01' = {
  parent: account
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'incidents-detail-retention'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              // Trailing slash on the prefix prevents the rule from matching
              // sibling containers that share the same name prefix (e.g. a
              // hypothetical future `incidents-detail-archive`). Azure
              // lifecycle prefixes are interpreted as raw string prefixes
              // against the full `<container>/<path>` path, so without the
              // slash both would match.
              prefixMatch: [
                '${incidentsDetailContainerName}/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: incidentsRetentionDays
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 7
                }
              }
            }
          }
        }
        {
          name: 'func-deployments-version-prune'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${funcDeploymentsContainerName}/'
              ]
            }
            actions: {
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 7
                }
              }
            }
          }
        }
        {
          name: 'daily-briefs-retention'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              // Trailing slash prevents sibling containers with the same
              // prefix from matching.
              prefixMatch: [
                '${dailyBriefsContainerName}/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: briefRetentionDays
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 7
                }
              }
            }
          }
        }
        {
          name: 'posture-narratives-retention'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${postureNarrativesContainerName}/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: postureRetentionDays
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 7
                }
              }
            }
          }
        }
        {
          name: 'incident-narratives-retention'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${incidentNarrativesContainerName}/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: incidentsAnalysisRetentionDays
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 7
                }
              }
            }
          }
        }
      ]
    }
  }
}

// -- Host MI — Functions runtime infrastructure (AzureWebJobsStorage + deployment) --
//
// Dedicated identity introduced 2026-04-19 after live-observed NoOpListener state
// on Flex Consumption Timer triggers: the host needs account-scope Blob Data Owner
// and Queue Data Contributor to (a) list/create hidden system containers on first
// run, (b) acquire the singleton blob lease for `useMonitor: true` Timers, and (c)
// read/write the scale-controller queue. Keeping these on api-reader would widen
// its privilege across every application container (incidents-detail, future
// daily-briefs) — so they live on a separate MI instead.
//
// Scope rationale:
//   - account-scope Blob Data Owner: Microsoft's identity-based-connections
//     tutorial mandates account scope for MI-auth AzureWebJobsStorage; host auto-
//     creates additional hidden containers at runtime beyond azure-webjobs-hosts
//     and azure-webjobs-secrets, so container-scope alone is insufficient.
//   - account-scope Queue Data Contributor: Functions scale controller persists
//     scale state in queues with instance-suffixed names that cannot be pre-
//     created.
//   - func-deployments container blob ownership moved from api-reader to host
//     (deployment is host infrastructure, not user-facing).
//   - api-reader retains ONLY its narrow HTTP read-path grants (Table Data
//     Reader on tableService, Blob Data Reader on incidents-detail). No host-
//     storage access.

resource funcDeploymentsHostRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(hostMiPrincipalId)) {
  scope: funcDeploymentsContainer
  name: guid(funcDeploymentsContainer.id, hostMiPrincipalId, storageBlobDataOwnerRoleId)
  properties: {
    principalId: hostMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRoleId)
    description: 'Flex Consumption deployment package read/write (host MI, container-scoped).'
  }
}

resource hostAccountBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(hostMiPrincipalId)) {
  scope: account
  name: guid(account.id, hostMiPrincipalId, storageBlobDataOwnerRoleId)
  properties: {
    principalId: hostMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRoleId)
    description: 'AzureWebJobsStorage MI-auth — host-storage Blob Data Owner at account scope (Microsoft-documented requirement). Host MI only; api-reader retains narrow grants.'
  }
}

resource hostAccountQueueRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(hostMiPrincipalId)) {
  scope: account
  name: guid(account.id, hostMiPrincipalId, storageQueueDataContributorRoleId)
  properties: {
    principalId: hostMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageQueueDataContributorRoleId)
    description: 'AzureWebJobsStorage MI-auth — scale-controller queue access at account scope. Host MI only; no application queues exist.'
  }
}

// Container-scoped Blob Data Owner on the two hidden host system containers.
// Redundant with account-scope Blob Data Owner above, but pre-creating the
// containers closes a first-run race: without them, the host must list
// containers at account level AND create them, which requires both listing
// and blob permissions. Pre-creation + narrow grant keeps the code path
// deterministic and gives the container an explicit resource lifetime.
resource webJobsHostsRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(hostMiPrincipalId)) {
  scope: webJobsHostsContainer
  name: guid(webJobsHostsContainer.id, hostMiPrincipalId, storageBlobDataOwnerRoleId)
  properties: {
    principalId: hostMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRoleId)
    description: 'Functions host singleton blob leases (Timer useMonitor) — host MI, container-scoped duplicate of account grant.'
  }
}

resource webJobsSecretsRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(hostMiPrincipalId)) {
  scope: webJobsSecretsContainer
  name: guid(webJobsSecretsContainer.id, hostMiPrincipalId, storageBlobDataOwnerRoleId)
  properties: {
    principalId: hostMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRoleId)
    description: 'Functions host internal secrets container — host MI, container-scoped duplicate of account grant.'
  }
}

// --- Step 3 RBAC (ADR-0006 + ADR-0011 §5a) -------------------------------------------------
// Posture:
//   api-reader MI:  Storage Table Data Reader on the Table service — minimum read-only
//                   data-plane role; matches ADR-0006 ("Reader on every table"). Per-table
//                   scoping offers no further reduction for reads.
//   ingest MI:      Storage Table Data Contributor on `SecureScore` and `IngestHealth`
//                   *only*, via **per-table scoped** role assignments. Azure Storage ABAC
//                   attributes on Tables are limited (the `:name` resource attribute is
//                   not exposed for tableServices/tables); per-table scope is the correct
//                   mechanism. Two narrow role assignments replace what would have been
//                   an account-wide Contributor.

resource apiReaderTableRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tableService
  name: guid(tableService.id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API HTTP handlers — read-only across all ops tables (ADR-0006).'
  }
}

// Writable tables for the ingest MI. Hardcoded indices into `tableNames` avoid a second
// for-loop over string comparisons and keep the dependency on the exact table order
// above explicit.
// IMPORTANT — these indices MUST match the position of each name in
// `tableNames` (defined at line ~87). 2026-05-12 audit (§10.67 follow-up):
// previous values were stale — most were off-by-one after
// 'ConditionalAccessPolicies' was inserted at position 3 on 2026-05-10
// without bumping the indices; AzureSecureScores was set to 22
// (append-at-end) but the table was actually inserted at position 4.
// Every grant resource scoped via tables[broken-idx] landed on the WRONG
// table. Live state retained the historically-correct grants from before
// the drift (Bicep does not garbage-collect role assignments under
// changed scope), so the bug was silent — ingest + apiReader MIs ended
// up with over-grants on agent-scope tables (AgentRuns, AgentHealth,
// IncidentAnalysisCache) and missed grants on the intended ones.
// Indices below verified against the current tableNames array.
var ingestWritableIdxSecureScore     = 0   // 'SecureScore'
var ingestWritableIdxIncidents       = 1   // 'Incidents'
var ingestWritableIdxEntraRisk       = 2   // 'EntraRisk'
var ingestWritableIdxConditionalAccessPolicies = 3 // 'ConditionalAccessPolicies' (ADR-0034 §3.3, Phase 8D)
var ingestWritableIdxAzureSecureScores = 4 // 'AzureSecureScores' (ADR-0036)
var ingestWritableIdxStackItems      = 5   // 'StackItems' (ADR-0031 Phase A)
var ingestWritableIdxIngestHealth    = 10  // 'IngestHealth'
var ingestWritableIdxTenantDirectory = 14  // 'TenantDirectory' (2026-04-20)
var ingestWritableIdxTenantSettings  = 15  // 'TenantSettings' (ADR-0025 Phase 1)
var ingestWritableIdxReportSnapshots = 18  // 'ReportSnapshots' (ADR-0030)
var ingestWritableIdxKev             = 19  // 'KEV' (ADR-0032)
var ingestWritableIdxKevSuppressions = 20  // 'KevSuppressions' (ADR-0033)
var ingestWritableIdxUserDormancy    = 21  // 'UserDormancy' (ADR-0034 §3.1, Phase 8B)
var ingestWritableIdxSignIns         = 22  // 'SignIns' (ADR-0034 §3.2, Phase 8C)
var ingestWritableIdxArmIngestHealth = 23  // 'ArmIngestHealth' (ADR-0036 v1.3 — ARM-data-plane freshness rows split off IngestHealth)
var ingestWritableIdxRansomwareIntel = 24  // 'RansomwareIntel' (ADR-0037)

resource ingestTableSecureScore 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxSecureScore]
  name: guid(tables[ingestWritableIdxSecureScore].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest Timer handlers — Contributor on SecureScore only (ADR-0011 §5a).'
  }
}

resource ingestTableIngestHealth 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxIngestHealth]
  name: guid(tables[ingestWritableIdxIngestHealth].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest Timer handlers — Contributor on IngestHealth only (ADR-0011 §5a).'
  }
}

// Step 4 (ADR-0014 §3.1) — ingest MI writes incident summary rows to the Incidents table.
// Per-table scoped like SecureScore and IngestHealth above.
resource ingestTableIncidents 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxIncidents]
  name: guid(tables[ingestWritableIdxIncidents].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest Timer handlers — Contributor on Incidents only (ADR-0014 §3.1).'
  }
}

// Step 6 (ADR-0023 §3) — ingest MI writes risky-user rows to the EntraRisk table.
// Per-table scoped like SecureScore / IngestHealth / Incidents above. Same ingest MI
// that already carries SecurityIncident.Read.All also carries IdentityRiskyUser.Read.All
// + Organization.Read.All for the licence probe (ADR-0023 §7 / §11).
resource ingestTableEntraRisk 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxEntraRisk]
  name: guid(tables[ingestWritableIdxEntraRisk].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest Timer handlers — Contributor on EntraRisk only (ADR-0023 §3).'
  }
}

// 2026-04-20 — ingest MI writes the tenant displayName row to TenantDirectory, piggy-backed
// on the existing /v1.0/organization Graph call in runEntraRiskIngest (Organization.Read.All
// already granted for the P2 licence probe). Agent MI reads via its account-scope Table
// Reader role; the row feeds the brief-agent prompt header so the model sees a human name
// rather than a tenant GUID. Single row per tenant — PK=tenantId, RK='directory'.
resource ingestTableTenantDirectory 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxTenantDirectory]
  name: guid(tables[ingestWritableIdxTenantDirectory].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest Timer handlers — Contributor on TenantDirectory only (2026-04-20 — tenant displayName cache for brief-agent prompt).'
  }
}

// ADR-0025 Phase 1 — TenantSettings table. Ingest MI writes operator-controlled
// settings (PATCH handler writes under this MI; admin authorisation enforced at the SWA role
// gate + Easy Auth SWA-MI binding + handler-level client-principal check). api-reader MI
// reads so the SPA can hide disabled tiles at render time. Agent MI not granted — Phase 1
// settings are UI-only; Phases 2/3 (capability, agent budget, identifier strategy) will
// extend.
resource ingestTableTenantSettings 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxTenantSettings]
  name: guid(tables[ingestWritableIdxTenantSettings].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest MI — Contributor on TenantSettings only (ADR-0025 Phase 1 — operator-controlled tile visibility).'
  }
}

resource apiReaderTableTenantSettings 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tables[ingestWritableIdxTenantSettings]
  name: guid(tables[ingestWritableIdxTenantSettings].id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API reader MI — Reader on TenantSettings only (ADR-0025 Phase 1 — GET /api/settings serves any authenticated user).'
  }
}

// ADR-0030 — ReportSnapshots table. Captured period reports written by the
// admin-triggered POST /api/reports/snapshots handler (admin-gated at SWA + handler-level
// client-principal check; same identity pattern as patchSettings.ts — admin-triggered API
// writes use the ingest MI). api-reader MI reads for GET /api/reports/snapshots/* and the
// SPA's /reports page. Agent MI deliberately not granted in v1 — Phase B+ (period summary
// via agent plane) will widen RBAC then. Per-table scope identical to the SecureScore /
// IngestHealth / TenantSettings precedents.
resource ingestTableReportSnapshots 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxReportSnapshots]
  name: guid(tables[ingestWritableIdxReportSnapshots].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest MI — Contributor on ReportSnapshots only (ADR-0030 §3 — admin-triggered period capture; reuses ingest MI per patchSettings.ts precedent).'
  }
}

resource apiReaderTableReportSnapshots 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tables[ingestWritableIdxReportSnapshots]
  name: guid(tables[ingestWritableIdxReportSnapshots].id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API reader MI — Reader on ReportSnapshots only (ADR-0030 §7 — reader-or-admin GET serves /reports historical view).'
  }
}

// ADR-0031 Phase A — StackItems table. Operator-curated stack inventory
// (vendor + product + version + category + environment + tags + notes). Admin-triggered
// POST/PATCH/DELETE handlers run under the ingest MI per the patchSettings.ts /
// captureReportSnapshot.ts precedent. api-reader MI reads for GET /api/stack/items
// + /api/stack/catalog. Agent MI deliberately not granted in v1 — Phase B+ may widen
// for a stack-aware brief-agent prompt, gated on a fresh ADR. Per-table scope identical
// to TenantSettings + ReportSnapshots precedents.
resource ingestTableStackItems 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxStackItems]
  name: guid(tables[ingestWritableIdxStackItems].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest MI — Contributor on StackItems only (ADR-0031 §3 — admin-triggered CRUD).'
  }
}

resource apiReaderTableStackItems 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tables[ingestWritableIdxStackItems]
  name: guid(tables[ingestWritableIdxStackItems].id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API reader MI — Reader on StackItems only (ADR-0031 §4 — reader-or-admin GET).'
  }
}

// ADR-0032 — KEV catalog table. CISA Known Exploited Vulnerabilities,
// public unauthenticated feed, single global partition (PartitionKey = "kev").
// Daily Timer + admin-triggered manual ingest under the ingest MI; reads under
// api-reader MI for the read-time match in GET /api/stack/items. Agent MI
// deliberately not granted in v1 (Phase B+ may widen for a KEV-aware posture-
// agent prompt). Per-table scope mirrors StackItems / ReportSnapshots / TenantSettings.
resource ingestTableKev 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxKev]
  name: guid(tables[ingestWritableIdxKev].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest MI — Contributor on KEV only (ADR-0032 §6 — daily Timer + admin manual run).'
  }
}

resource apiReaderTableKev 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tables[ingestWritableIdxKev]
  name: guid(tables[ingestWritableIdxKev].id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API reader MI — Reader on KEV only (ADR-0032 §6 — read-time match in GET /api/stack/items + summary).'
  }
}

// ADR-0033 — KevSuppressions table. Per-(itemId, cveID) match status
// workflow (open / acknowledged / risk_accepted / remediated / not_applicable).
// Admin PATCH/DELETE under the ingest MI per the patchSettings.ts precedent;
// api-reader MI reads for the join in GET /api/stack/items + getKevSummary
// status counts. Agent MI deliberately not granted — workflow is operator
// state, not AI-plane input. Per-table scope mirrors KEV / StackItems /
// ReportSnapshots / TenantSettings.
resource ingestTableKevSuppressions 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxKevSuppressions]
  name: guid(tables[ingestWritableIdxKevSuppressions].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest MI — Contributor on KevSuppressions only (ADR-0033 §2 — admin-triggered status writes).'
  }
}

resource apiReaderTableKevSuppressions 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tables[ingestWritableIdxKevSuppressions]
  name: guid(tables[ingestWritableIdxKevSuppressions].id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API reader MI — Reader on KevSuppressions only (ADR-0033 §3 — join into kevMatches at read time).'
  }
}

// Step 8 Phase B (ADR-0034 §3.1) — ingest MI writes user dormancy snapshots.
// Per-table scope mirrors EntraRisk above (same identity-domain ingest pattern).
// User.Read.All grant on the bootstrap script lands in the same commit as
// runUserDormancyIngest.ts per ADR-0013 §3 same-commit-as-consumer invariant.
resource ingestTableUserDormancy 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxUserDormancy]
  name: guid(tables[ingestWritableIdxUserDormancy].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest Timer handlers — Contributor on UserDormancy only (ADR-0034 §3.1, Phase 8B).'
  }
}

resource apiReaderTableUserDormancy 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tables[ingestWritableIdxUserDormancy]
  name: guid(tables[ingestWritableIdxUserDormancy].id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API reader MI — Reader on UserDormancy only (ADR-0034 §3.1, Phase 8B).'
  }
}

// Step 8 Phase C (ADR-0034 §3.2) — ingest MI writes Entra sign-in events.
// Per-table scope mirrors UserDormancy / EntraRisk above. AuditLog.Read.All
// Graph scope is already granted (pulled forward to Phase 8B on 2026-05-08
// to satisfy the signInActivity property dependency); Phase 8C reuses the
// existing assignment and adds no new Graph scope.
resource ingestTableSignIns 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxSignIns]
  name: guid(tables[ingestWritableIdxSignIns].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest Timer handlers — Contributor on SignIns only (ADR-0034 §3.2, Phase 8C).'
  }
}

resource apiReaderTableSignIns 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tables[ingestWritableIdxSignIns]
  name: guid(tables[ingestWritableIdxSignIns].id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API reader MI — Reader on SignIns only (ADR-0034 §3.2, Phase 8C).'
  }
}

// Step 8 Phase D (ADR-0034 §3.3) — ingest MI writes Conditional Access policy
// snapshots. Per-table-scope mirrors UserDormancy / SignIns (same identity-domain
// ingest pattern). Policy.Read.All Graph scope grant on the bootstrap script
// lands in the same commit as runConditionalAccessIngest.ts per ADR-0013 §3
// same-commit-as-consumer invariant. NOT account-scoped — the writer needs
// write/delete permission on this single table only (snapshot-replace pattern
// reconciles missing rows on each run).
resource ingestTableConditionalAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: tables[ingestWritableIdxConditionalAccessPolicies]
  name: guid(tables[ingestWritableIdxConditionalAccessPolicies].id, ingestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Ingest Timer handlers — Contributor on ConditionalAccessPolicies only (ADR-0034 §3.3, Phase 8D).'
  }
}

resource apiReaderTableConditionalAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tables[ingestWritableIdxConditionalAccessPolicies]
  name: guid(tables[ingestWritableIdxConditionalAccessPolicies].id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API reader MI — Reader on ConditionalAccessPolicies only (ADR-0034 §3.3, Phase 8D).'
  }
}

// ADR-0036 — Defender for Cloud Secure Score ingest. Per-table-scope mirrors
// every other vertical above. v1.2 (M-Q2 split, §10.67 follow-up) moves
// table-write rights from the original `ingest` MI to the new dedicated
// `armIngest` MI which also holds the subscription-scope Security Reader
// assignment (defender-cloud-rbac.bicep). The original `ingest` MI no longer
// has any access to AzureSecureScores — bounds cross-data-plane blast radius
// per ADR-0036 v1.2 §5.
//
// ARM ingest MI — Contributor on AzureSecureScores (Defender for Cloud
// secure-score daily snapshot writes) + Contributor on IngestHealth (so
// the ARM ingest path can write its own freshness row alongside the
// original ingest MI; both can write — table-level Contributor doesn't
// conflict on different RowKeys).
resource armIngestTableAzureSecureScores 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(armIngestMiPrincipalId)) {
  scope: tables[ingestWritableIdxAzureSecureScores]
  name: guid(tables[ingestWritableIdxAzureSecureScores].id, armIngestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: armIngestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'ARM ingest MI — Contributor on AzureSecureScores only (ADR-0036 v1.2 M-Q2).'
  }
}

// ADR-0036 v1.3 — ARM-data-plane freshness rows live in their own
// ArmIngestHealth table so a compromise of armIngest can't forge a
// freshness row against a Graph-side source's RowKey on the shared
// IngestHealth table.
resource armIngestTableArmIngestHealth 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(armIngestMiPrincipalId)) {
  scope: tables[ingestWritableIdxArmIngestHealth]
  name: guid(tables[ingestWritableIdxArmIngestHealth].id, armIngestMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: armIngestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'ARM ingest MI — Contributor on ArmIngestHealth only (ADR-0036 v1.3; for azure.security.* freshness rows).'
  }
}

// ADR-0037 — Ransomware.live PRO threat-intel ingest. Same per-table-scope
// pattern as ARM ingest above. Separate dedicated `threatIntel` MI because
// the consumer is a third-party HTTP API (not Microsoft Graph, not ARM) and
// the trust boundary is distinct: a compromise of the ransomware.live API
// key does NOT propagate to either internal data plane. Two narrow grants
// only — RansomwareIntel (vertical writes) + IngestHealth (own freshness
// row). No other table scopes; no container access; no subscription role;
// no Graph scopes. Per-secret KV ABAC for the API key lives in
// keyvault.bicep mirroring the SEC-L-L12-04 pattern.
resource threatIntelTableRansomwareIntel 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(threatIntelMiPrincipalId)) {
  scope: tables[ingestWritableIdxRansomwareIntel]
  name: guid(tables[ingestWritableIdxRansomwareIntel].id, threatIntelMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: threatIntelMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'ThreatIntel MI — Contributor on RansomwareIntel only (ADR-0037).'
  }
}

resource threatIntelTableIngestHealth 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(threatIntelMiPrincipalId)) {
  scope: tables[ingestWritableIdxIngestHealth]
  name: guid(tables[ingestWritableIdxIngestHealth].id, threatIntelMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: threatIntelMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'ThreatIntel MI — Contributor on IngestHealth only (ADR-0037; own freshness row keyed by external.ransomware.live).'
  }
}

// Note (ADR-0037): no separate api-reader per-table Reader grant for
// RansomwareIntel — api-reader already holds account-scope
// `Storage Table Data Reader` on the entire tableService via the
// `apiReaderTableRead` assignment above (line ~633). The new table
// inherits read access through that grant; adding a per-table Reader
// here would be redundant + noise.

resource apiReaderTableAzureSecureScores 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: tables[ingestWritableIdxAzureSecureScores]
  name: guid(tables[ingestWritableIdxAzureSecureScores].id, apiReaderMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'API reader MI — Reader on AzureSecureScores only (ADR-0036).'
  }
}

// ADR-0030 Phase C §C.9 — mail-sender MI gets Contributor on
// TenantSettings only, for the idempotency cache (§C.5.1) +
// send-history rows (§C.7). RowKey prefix `report-email-*` is
// internal-only — the `patchSettings` admin endpoint validator
// rejects any inbound write with that prefix so the only writer
// is the orchestrator running under the mail-sender MI.
//
// No other table grants; no blob or subscription scope. Graph
// permissions (Mail.Send + Mail.Read) provisioned by
// bootstrap-entra.ps1 when AZURE_MAIL_SENDER_UPN is set, scoped
// to the operator's mailbox via Exchange Application Access
// Policy. Inert when no mailbox configured.
resource mailSenderTableTenantSettings 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(mailSenderMiPrincipalId)) {
  scope: tables[ingestWritableIdxTenantSettings]
  name: guid(tables[ingestWritableIdxTenantSettings].id, mailSenderMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: mailSenderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Mail-sender MI — Contributor on TenantSettings only (ADR-0030 Phase C §C.9; idempotency cache + send-history rows under RowKey prefix report-email-*).'
  }
}

// --- Step 4 incidents-detail RBAC (ADR-0014 §3.3, ADR-0016 §5) --------------------------------
// Container-scoped role assignments — not account-scoped. Ingest MI writes; api-reader MI reads.
// Delete capability on Contributor is intentionally not exercised (lifecycle-only-deletes
// invariant, ADR-0014 §3.3); compensating controls are blob versioning + change feed + the
// audit `detailBlobsWritten` field that surfaces writer-side anomalies.

resource ingestIncidentsDetailWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: incidentsDetailContainer
  name: guid(incidentsDetailContainer.id, ingestMiPrincipalId, storageBlobDataContributorRoleId)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    description: 'Ingest Timer handlers — Contributor on incidents-detail container only; delete not exercised (ADR-0014 §3.3 lifecycle-only-deletes invariant).'
  }
}

resource apiReaderIncidentsDetailRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: incidentsDetailContainer
  name: guid(incidentsDetailContainer.id, apiReaderMiPrincipalId, storageBlobDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    description: 'API detail handler — read-only on incidents-detail container for Table+blob merge (ADR-0016 §1.3).'
  }
}

resource apiReaderDailyBriefsRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId) && deployAiAgents) {
  scope: dailyBriefsContainer
  name: guid(dailyBriefsContainer.id, apiReaderMiPrincipalId, storageBlobDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    description: 'API brief read handler — read-only on daily-briefs container; serves getBriefLatest + getBriefByDate after sha256 verification against BriefCache row (ADR-0022 §3).'
  }
}

// --- Step 5 agent MI RBAC (ADR-0017 §3) ---------------------------------------------------------
// Posture:
//   - tableService-scope Storage Table Data Reader — reads the deterministic context tables
//     (SecureScore, Incidents, IngestHealth, EntraRisk, CAPolicies, StackItems, KEVMatches,
//     ApprovalDecisions, ManualTasks, AgentRuns) so the brief-agent prompt builder can assemble
//     its context without a per-table assignment (ADR-0017 §3 RBAC row 2).
//   - per-table Contributor on exactly the three tables the agent owns (BriefCache /
//     AgentBudget / AgentHealth).
//   - per-table Contributor on IngestHealth — the agent advances its own per-source chain
//     cursor (seq + lastLineSha256) on the shared `IngestHealth` table using the same
//     ETag-lease primitive as ingest. Code-enforced row scope: only rows with RowKey
//     starting `agent.*` (runAgent.ts uses `spec.sourceChain`, e.g. `agent.aegis.brief`).
//     Table Storage has no row-level RBAC; an ABAC condition restricting to
//     `RowKey startsWith 'agent.'` is tracked in HANDOVER §6.3 as a hardening follow-up.
//   - container-scoped Blob Data Contributor on daily-briefs (write brief blob bodies).
//   - container-scoped Blob Data Reader on incidents-detail (context expansion when the
//     orchestrator judges it beneficial — ADR-0017 §3 RBAC row 5).
// NO Graph / Defender / Sentinel scopes — the agent reads tenant context exclusively from the
// ops store (ADR-0017 §3). NO write scopes on the audit container — audit writes go through the
// audit MI via the shim so the single-writer hash-chain invariant stays intact (ADR-0015).

// 2026-05-12 audit: shifted +1 each after 'ConditionalAccessPolicies' was
// inserted at position 3 on 2026-05-10. Verified against the current
// tableNames array.
var agentWritableIdxBriefCache             = 11  // 'BriefCache'
var agentWritableIdxAgentBudget            = 12  // 'AgentBudget'
var agentWritableIdxAgentHealth            = 13  // 'AgentHealth'
var agentWritableIdxPostureCache           = 16  // 'PostureCache' (ADR-0027 §Decision.6)
var agentWritableIdxIncidentAnalysisCache  = 17  // 'IncidentAnalysisCache' (ADR-0028 §Decision.6)

resource agentTableRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: tableService
  name: guid(tableService.id, agentMiPrincipalId, storageTableDataReaderRoleId)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderRoleId)
    description: 'Agent MI — read-only across all ops tables (ADR-0017 §3 RBAC row 2). Feeds the brief-agent deterministic prompt builder (SecureScore + Incidents + IngestHealth).'
  }
}

resource agentTableBriefCache 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: tables[agentWritableIdxBriefCache]
  name: guid(tables[agentWritableIdxBriefCache].id, agentMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Agent MI — Contributor on BriefCache only (ADR-0022).'
  }
}

resource agentTableAgentBudget 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: tables[agentWritableIdxAgentBudget]
  name: guid(tables[agentWritableIdxAgentBudget].id, agentMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Agent MI — Contributor on AgentBudget only (ADR-0019 pessimistic reservation + TTL sweep).'
  }
}

resource agentTableAgentHealth 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: tables[agentWritableIdxAgentHealth]
  name: guid(tables[agentWritableIdxAgentHealth].id, agentMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Agent MI — Contributor on AgentHealth only (ADR-0019 circuit breaker state).'
  }
}

// ADR-0027 §Decision.6 — agent MI writes weekly posture narrative
// index rows to PostureCache. Per-table scoped, same discipline as BriefCache.
// Row-scope (`PartitionKey eq tenantId` + `RowKey startsWith posture.`) is
// code-enforced in runPostureAgent.ts — Table Storage has no row-level RBAC;
// an ABAC follow-up is tracked in HANDOVER §6.3 alongside the existing
// IngestHealth row-scope entry.
resource agentTablePostureCache 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: tables[agentWritableIdxPostureCache]
  name: guid(tables[agentWritableIdxPostureCache].id, agentMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Agent MI — Contributor on PostureCache only (ADR-0027 §Decision.6 weekly posture narrative index).'
  }
}

// ADR-0027 §Decision.6 — agent MI writes posture narrative bodies to the
// posture-narratives container. Container-scoped; delete not exercised
// (lifecycle-only-deletes invariant, ADR-0014 §3.3 precedent).
resource agentPostureNarrativesWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: postureNarrativesContainer
  name: guid(postureNarrativesContainer.id, agentMiPrincipalId, storageBlobDataContributorRoleId)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    description: 'Agent MI — Contributor on posture-narratives container only; delete not exercised (lifecycle-only-deletes invariant).'
  }
}

// API read-path — api-reader MI reads posture-narratives for getPostureLatest
// after defence-in-depth sha256 verification against the PostureCache row.
// Container-scoped; mirrors the daily-briefs pattern.
resource apiReaderPostureNarrativesRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId) && deployAiAgents) {
  scope: postureNarrativesContainer
  name: guid(postureNarrativesContainer.id, apiReaderMiPrincipalId, storageBlobDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    description: 'API posture read handler — read-only on posture-narratives container; serves getPostureLatest after sha256 verification against PostureCache row (ADR-0027 §Decision.5).'
  }
}

// ADR-0028 §Decision.6 — agent MI writes per-incident analysis index rows
// to IncidentAnalysisCache. Per-table scoped; same discipline as
// BriefCache / PostureCache. Row-scope (RowKey starts with
// `incidents.analysis.`) is code-enforced in runIncidentsAgent.ts —
// Table Storage has no row-level RBAC; an ABAC follow-up is tracked in
// HANDOVER §6.3 alongside the existing row-scope entries.
resource agentTableIncidentAnalysisCache 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: tables[agentWritableIdxIncidentAnalysisCache]
  name: guid(tables[agentWritableIdxIncidentAnalysisCache].id, agentMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Agent MI — Contributor on IncidentAnalysisCache only (ADR-0028 §Decision.6 per-incident on-demand analysis index).'
  }
}

// -- branding-assets container (ADR-0029 Phase B §Decision.2) --
//
// One blob per tenant at `<tenantId>/logo`. Ingest MI writes (admin upload +
// delete handlers); api-reader MI reads (reader serve handler). Agent MI
// deliberately has NO grant — branding never enters the AI plane per
// §Decision.7. No lifecycle rule — logos are permanent per-tenant assets;
// account-level 7-day version retention (blob soft-delete + versioning)
// covers accidental-overwrite recovery without a per-container policy.
resource brandingAssetsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: brandingAssetsContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource ingestBrandingAssetsWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(ingestMiPrincipalId)) {
  scope: brandingAssetsContainer
  name: guid(brandingAssetsContainer.id, ingestMiPrincipalId, storageBlobDataContributorRoleId)
  properties: {
    principalId: ingestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    description: 'Ingest MI — Contributor on branding-assets container only; upload + delete handlers (ADR-0029 Phase B §Decision.2).'
  }
}

resource apiReaderBrandingAssetsRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: brandingAssetsContainer
  name: guid(brandingAssetsContainer.id, apiReaderMiPrincipalId, storageBlobDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    description: 'API reader MI — read-only on branding-assets container only; serves GET /api/branding/{tenantId}/logo (ADR-0029 Phase B §Decision.2).'
  }
}

// ADR-0028 §Decision.6 — agent MI writes incident-narrative bodies to the
// incident-narratives container. Container-scoped; delete not exercised
// (lifecycle-only-deletes invariant, ADR-0014 §3.3 precedent).
resource agentIncidentNarrativesWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: incidentNarrativesContainer
  name: guid(incidentNarrativesContainer.id, agentMiPrincipalId, storageBlobDataContributorRoleId)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    description: 'Agent MI — Contributor on incident-narratives container only; delete not exercised (lifecycle-only-deletes invariant).'
  }
}

// API read-path — api-reader MI reads incident-narratives for
// getIncidentAnalysis after defence-in-depth sha256 verification against
// the IncidentAnalysisCache row. Container-scoped; mirrors the
// posture-narratives / daily-briefs patterns.
resource apiReaderIncidentNarrativesRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId) && deployAiAgents) {
  scope: incidentNarrativesContainer
  name: guid(incidentNarrativesContainer.id, apiReaderMiPrincipalId, storageBlobDataReaderRoleId)
  properties: {
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    description: 'API incidents-analysis read handler — read-only on incident-narratives container; serves getIncidentAnalysis after sha256 verification against IncidentAnalysisCache row (ADR-0028 §Decision.5).'
  }
}

resource agentTableIngestHealth 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: tables[ingestWritableIdxIngestHealth]
  name: guid(tables[ingestWritableIdxIngestHealth].id, agentMiPrincipalId, storageTableDataContributorRole)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRole)
    description: 'Agent MI — Contributor on IngestHealth; code-enforced to rows with RowKey starting `agent.*` via spec.sourceChain in runAgent.ts. ADR-0019 §Decision.5 writer-singleton. ABAC tightening tracked in HANDOVER §6.3.'
  }
}

resource agentDailyBriefsWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: dailyBriefsContainer
  name: guid(dailyBriefsContainer.id, agentMiPrincipalId, storageBlobDataContributorRoleId)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    description: 'Agent MI — Contributor on daily-briefs container only; delete not exercised (lifecycle-only-deletes invariant, ADR-0014 §3.3 precedent).'
  }
}

resource agentIncidentsDetailRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(agentMiPrincipalId) && deployAiAgents) {
  scope: incidentsDetailContainer
  name: guid(incidentsDetailContainer.id, agentMiPrincipalId, storageBlobDataReaderRoleId)
  properties: {
    principalId: agentMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    description: 'Agent MI — read-only on incidents-detail container for orchestrator-judged context expansion (ADR-0017 §3).'
  }
}

output storageAccountName string = account.name
output storageAccountId string = account.id
output funcDeploymentsContainerName string = funcDeploymentsContainer.name
output incidentsDetailContainerName string = incidentsDetailContainer.name
output dailyBriefsContainerName string = dailyBriefsContainer.name
output postureNarrativesContainerName string = postureNarrativesContainer.name
output incidentNarrativesContainerName string = incidentNarrativesContainer.name
output brandingAssetsContainerName string = brandingAssetsContainer.name
output tableServiceResourceId string = tableService.id
