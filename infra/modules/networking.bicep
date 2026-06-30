// networking.bicep — VNet, subnets, Private DNS zones, and the private
// endpoints that bind KV / Storage / Foundry behind the VNet. Function
// App VNet integration is wired in `functions.bicep` (consumes
// `faSubnetId` output from here).
//
// `privateEndpointsEnabled=false` (default): module creates NOTHING.
// Every backing module's `publicNetworkAccess` defaults to `'Enabled'`
// so existing dev/test environments keep landing unchanged.
//
// `privateEndpointsEnabled=true`: full build-out — VNet, 2 subnets,
// 5 DNS zones, 5 zone VNet links, 6 private endpoints, 6 DNS zone
// groups. Static Web App inbound stays public (linked-backend proxy
// requirement); Function App outbound flows through `snet-func`
// → private endpoints → backing services. Operator note: KV /
// Storage / Foundry are unreachable from public Internet under this
// posture.
//
// Subnet sizing rationale:
//   - PE subnet `snet-pe` @ /27 (32 addresses, 27 usable after Azure
//     reserves 5): holds 6 PEs + headroom. Tight by design — a runaway
//     PE proliferation should hit this limit before it becomes a sprawl.
//   - FA subnet `snet-func` @ /24 (256 addresses): Flex Consumption
//     plan VNet-integration **requires** /24 minimum and delegation to
//     `Microsoft.App/environments`. Wasteful by address-count but
//     non-negotiable.
//
// CAF naming follows the workload-env-region pattern. Per-resource
// CAF prefixes: `vnet-`, `snet-`, `pe-`, `pdns-`, `vnetlink-`.

@description('Workload short code (e.g. aegis). Drives CAF resource naming.')
param workload string

@description('Environment token: dev / test / prod.')
param environment string

@description('Short region code (e.g. uks, weu) — same value as the rest of the deployment.')
param regionShort string

@description('Azure region. Used for the VNet location; private DNS zones are global.')
param location string

@description('Tags inherited from main.bicep — common workload + environment + cost-centre dimensions.')
param tags object

@description('Master switch. When `false`, the module creates no resources and outputs empty strings. Drives the parameterised `publicNetworkAccess` flag on the consumer modules.')
param privateEndpointsEnabled bool

// Resource IDs to bind private endpoints to. When private endpoints are
// disabled these inputs are unused (the corresponding `if` guard on each
// PE resource short-circuits).

@description('Key Vault resource ID. Bound to a `vault`-subresource PE when private endpoints are enabled.')
param keyVaultResourceId string = ''

@description('Audit storage account resource ID. Bound to a `blob`-subresource PE.')
param auditStorageResourceId string = ''

@description('Ops storage account resource ID. Bound to three PEs — one each for `blob`, `table`, and `queue` subresources (table + queue carry the bulk of read traffic; blob carries deployment + cache containers).')
param opsStorageResourceId string = ''

@description('Foundry hub (Cognitive Services account) resource ID. Bound to an `account`-subresource PE which covers both the model-deployment endpoints and the project hub endpoint.')
param foundryAccountResourceId string = ''

// --- naming (CAF) ---

var vnetName = 'vnet-${workload}-${environment}-${regionShort}'
var peSubnetName = 'snet-pe'
var funcSubnetName = 'snet-func'

// VNet address space + subnet ranges. All within 10.10.0.0/16 — wide
// enough that any future subnet (Bastion, jumpbox, second AZ) can land
// without renumbering.
var vnetCidr = '10.10.0.0/16'
var peSubnetCidr = '10.10.1.0/27'
var funcSubnetCidr = '10.10.2.0/24'

// --- VNet + subnets ---

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = if (privateEndpointsEnabled) {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [vnetCidr]
    }
    subnets: [
      {
        name: peSubnetName
        properties: {
          addressPrefixes: [peSubnetCidr]
          // PE subnet must not have NSG-rules that block intra-VNet
          // traffic. We deliberately don't attach an NSG here — the
          // PEs are the resource boundary, not the subnet.
          privateEndpointNetworkPolicies: 'Disabled'
          privateLinkServiceNetworkPolicies: 'Enabled'
        }
      }
      {
        name: funcSubnetName
        properties: {
          addressPrefixes: [funcSubnetCidr]
          // Flex Consumption plan requires the delegation to
          // `Microsoft.App/environments`. The /24 size is also a
          // Flex Consumption requirement (per Microsoft docs).
          delegations: [
            {
              name: 'flex-functions-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
          // deterministic outbound for
          // public Microsoft endpoints (App Insights ingestion, Graph,
          // Exchange Online, CISA KEV feed) that are NOT covered by any
          // private endpoint. Without an explicit NAT gateway, traffic
          // would rely on Azure's default-outbound which Microsoft is
          // retiring (effective Sept 2025) on newly-created subnets.
          natGateway: {
            id: natGateway.id
          }
        }
      }
    ]
  }
}

// --- NAT gateway for snet-func outbound ---
//
// Standard SKU public IP + NAT gateway, attached to `snet-func`. Cost
// is ~£1/day idle. Without this, the FA's outbound to non-PE
// destinations (App Insights, Graph, CISA KEV) flows over Azure's
// default outbound — actively being deprecated as of 2025. The PE
// subnet (`snet-pe`) does NOT need a NAT gateway because PE traffic
// stays in-VNet.
//
// Forward-track: an AMPLS (Azure Monitor Private Link Scope) would
// also bring App Insights / Log Analytics ingestion onto the private
// plane and eliminate the public-Internet hop for telemetry. Captured
// for the prod follow-up; out of scope for this commit.

resource natPublicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = if (privateEndpointsEnabled) {
  name: 'pip-natgw-${workload}-${environment}-${regionShort}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource natGateway 'Microsoft.Network/natGateways@2024-05-01' = if (privateEndpointsEnabled) {
  name: 'natgw-${workload}-${environment}-${regionShort}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    // 4 minute idle timeout matches Microsoft's recommended default for
    // long-poll-friendly outbound flows (Function App handlers may keep
    // outbound HTTP connections open longer than the 4-minute Azure LB
    // default; NAT gateway honours this independently).
    idleTimeoutInMinutes: 4
    publicIpAddresses: [
      {
        id: natPublicIp.id
      }
    ]
  }
}

// --- Private DNS zones ---
//
// Each Azure private-link service requires a specific zone name. Names
// are sourced from Microsoft's "Azure services DNS zone configuration"
// reference and MUST match exactly — a typo silently produces a zone
// that the PE auto-DNS-registration step won't populate, leaving the
// resolved name pointing to the public IP. The zones are global; the
// VNet link is what scopes resolution to this VNet.

// Foundry / Azure AI Services kind=AIServices uses THREE host families
// behind one `account` subresource — each needs its own privatelink zone
// (Microsoft Learn — "Use private endpoints with Azure AI Foundry"):
//   * cognitiveservices.azure.com — legacy Cognitive Services control + data planes
//   * openai.azure.com            — model inference endpoints used by `@azure/ai-projects` clients
//   * services.ai.azure.com       — second-gen project data plane (`customSubDomainName`-bound)
// All three are bound to the single `peFoundry` PE via the
// `peFoundryDns.properties.privateDnsZoneConfigs` list below.
// missing the latter two zones produced
// public-IP DNS resolution → Foundry's `publicNetworkAccess: 'Disabled'`
// denied the request → all three agents (brief / posture / incidents)
// silently failed. Single-zone coverage is the classic Foundry-private-
// endpoint footgun; this comment block is the breadcrumb.

var dnsZoneNames = privateEndpointsEnabled ? [
  'privatelink.vaultcore.azure.net'
  'privatelink.blob.${az.environment().suffixes.storage}'
  'privatelink.table.${az.environment().suffixes.storage}'
  'privatelink.queue.${az.environment().suffixes.storage}'
  'privatelink.cognitiveservices.azure.com'
  'privatelink.openai.azure.com'
  'privatelink.services.ai.azure.com'
] : []

resource dnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zoneName in dnsZoneNames: {
  name: zoneName
  location: 'global'
  tags: tags
}]

// VNet link per zone — without this, the VNet's hosts won't resolve the
// privatelink names to the PE-issued private IPs.
resource dnsZoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zoneName, i) in dnsZoneNames: {
  parent: dnsZones[i]
  name: 'vnetlink-${vnetName}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}]

// Convenience accessors — zone index lookups. The order MUST match
// `dnsZoneNames` above. Centralising the indexes here keeps the PE
// dnsZoneGroups blocks below readable.
var kvZoneIdx = 0
var blobZoneIdx = 1
var tableZoneIdx = 2
var queueZoneIdx = 3
var cognitiveZoneIdx = 4
var openaiZoneIdx = 5
var aiServicesZoneIdx = 6

// --- Private endpoints + DNS zone groups ---
//
// Each PE is a NIC on the PE subnet pointing at a `groupId` (subresource)
// of the target resource. The PE issues a private IP from
// `10.10.1.0/27`. The companion `privateDnsZoneGroups` child resource
// is what makes Azure auto-write the A record into the matching DNS
// zone (no manual `az network private-dns record-set` calls).

resource peKeyVault 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateEndpointsEnabled && !empty(keyVaultResourceId)) {
  name: 'pe-kv-${workload}-${environment}-${regionShort}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/${peSubnetName}'
    }
    privateLinkServiceConnections: [
      {
        name: 'kv-connection'
        properties: {
          privateLinkServiceId: keyVaultResourceId
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource peKeyVaultDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateEndpointsEnabled && !empty(keyVaultResourceId)) {
  parent: peKeyVault
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault-config'
        properties: {
          privateDnsZoneId: dnsZones[kvZoneIdx].id
        }
      }
    ]
  }
}

resource peAuditBlob 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateEndpointsEnabled && !empty(auditStorageResourceId)) {
  name: 'pe-staudit-blob-${workload}-${environment}-${regionShort}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/${peSubnetName}'
    }
    privateLinkServiceConnections: [
      {
        name: 'audit-blob-connection'
        properties: {
          privateLinkServiceId: auditStorageResourceId
          groupIds: ['blob']
        }
      }
    ]
  }
}

resource peAuditBlobDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateEndpointsEnabled && !empty(auditStorageResourceId)) {
  parent: peAuditBlob
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob-config'
        properties: {
          privateDnsZoneId: dnsZones[blobZoneIdx].id
        }
      }
    ]
  }
}

resource peOpsBlob 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateEndpointsEnabled && !empty(opsStorageResourceId)) {
  name: 'pe-stops-blob-${workload}-${environment}-${regionShort}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/${peSubnetName}'
    }
    privateLinkServiceConnections: [
      {
        name: 'ops-blob-connection'
        properties: {
          privateLinkServiceId: opsStorageResourceId
          groupIds: ['blob']
        }
      }
    ]
  }
}

resource peOpsBlobDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateEndpointsEnabled && !empty(opsStorageResourceId)) {
  parent: peOpsBlob
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob-config'
        properties: {
          privateDnsZoneId: dnsZones[blobZoneIdx].id
        }
      }
    ]
  }
}

resource peOpsTable 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateEndpointsEnabled && !empty(opsStorageResourceId)) {
  name: 'pe-stops-table-${workload}-${environment}-${regionShort}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/${peSubnetName}'
    }
    privateLinkServiceConnections: [
      {
        name: 'ops-table-connection'
        properties: {
          privateLinkServiceId: opsStorageResourceId
          groupIds: ['table']
        }
      }
    ]
  }
}

resource peOpsTableDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateEndpointsEnabled && !empty(opsStorageResourceId)) {
  parent: peOpsTable
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'table-config'
        properties: {
          privateDnsZoneId: dnsZones[tableZoneIdx].id
        }
      }
    ]
  }
}

resource peOpsQueue 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateEndpointsEnabled && !empty(opsStorageResourceId)) {
  name: 'pe-stops-queue-${workload}-${environment}-${regionShort}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/${peSubnetName}'
    }
    privateLinkServiceConnections: [
      {
        name: 'ops-queue-connection'
        properties: {
          privateLinkServiceId: opsStorageResourceId
          groupIds: ['queue']
        }
      }
    ]
  }
}

resource peOpsQueueDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateEndpointsEnabled && !empty(opsStorageResourceId)) {
  parent: peOpsQueue
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'queue-config'
        properties: {
          privateDnsZoneId: dnsZones[queueZoneIdx].id
        }
      }
    ]
  }
}

resource peFoundry 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateEndpointsEnabled && !empty(foundryAccountResourceId)) {
  name: 'pe-foundry-${workload}-${environment}-${regionShort}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/${peSubnetName}'
    }
    privateLinkServiceConnections: [
      {
        name: 'foundry-connection'
        properties: {
          privateLinkServiceId: foundryAccountResourceId
          groupIds: ['account']
        }
      }
    ]
  }
}

resource peFoundryDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateEndpointsEnabled && !empty(foundryAccountResourceId)) {
  parent: peFoundry
  name: 'default'
  properties: {
    // WS10 verdict 2026-06-23 C1 — three zone configs on the single PE
    // (one PE per groupId='account' covers all three host families; only
    // the DNS registration needs to fan out). See the dnsZoneNames
    // comment above for the host-family mapping.
    privateDnsZoneConfigs: [
      {
        name: 'cognitive-config'
        properties: {
          privateDnsZoneId: dnsZones[cognitiveZoneIdx].id
        }
      }
      {
        name: 'openai-config'
        properties: {
          privateDnsZoneId: dnsZones[openaiZoneIdx].id
        }
      }
      {
        name: 'aiservices-config'
        properties: {
          privateDnsZoneId: dnsZones[aiServicesZoneIdx].id
        }
      }
    ]
  }
}

// --- outputs ---
//
// `funcSubnetId` is consumed by `functions.bicep` to wire the FA's
// VNet integration. Empty when private endpoints are disabled (the FA
// then omits `virtualNetworkSubnetId`).
//
// The PE resource IDs are not exposed as outputs — there's no
// downstream consumer; the dnsZoneGroups child resources self-register
// records and that's the entire integration surface.

output funcSubnetId string = privateEndpointsEnabled ? '${vnet.id}/subnets/${funcSubnetName}' : ''
output peSubnetId string = privateEndpointsEnabled ? '${vnet.id}/subnets/${peSubnetName}' : ''
output vnetId string = privateEndpointsEnabled ? vnet.id : ''
