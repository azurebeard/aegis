// policy-foundry-sku.bicep — Azure Policy `aegis-foundry-model-sku-allowlist`.
// ADR-0017 §Decision.8 item 2: RG-scope Deny on model-deployment creation
// outside the approved SKU set + model-name allowlist. Closes two failure modes:
//   - Out-of-band Foundry-portal deployment creation (the only approved path is
//     this Bicep module; policy denies portal-created deployments).
//   - GlobalStandard / DataZoneStandard / GlobalProvisionedManaged SKUs which
//     would silently cross the data-residency boundary (ADR-0017 §6.1.3).
//
// Policy lives at subscription scope (definition) and is assigned at
// resource-group scope (effect). This module is invoked from the
// subscription-scope `main.bicep` and emits both parts.

targetScope = 'subscription'

@description('Full resource ID of the target resource group (scope of the policy assignment).')
param resourceGroupId string

@description('Short token used in the policy name. Matches the workload token in main.bicep.')
param workload string = 'aegis'

@description('Allowed SKU names for Microsoft.CognitiveServices/accounts/deployments on the Foundry account (ADR-0017 §6.1.3). Only Standard is data-residency-safe for this deployment.')
param allowedSkuNames array = [
  'Standard'
]

@description('Allowed OpenAI model names on Foundry deployments (ADR-0018). Defaults are the two SKUs this ADR pack actually deploys.')
param allowedModelNames array = [
  'gpt-4.1-mini'
  'gpt-4.1-nano'
]

var policyName = '${workload}-foundry-model-sku-allowlist'
var assignmentName = '${workload}-foundry-model-sku-allowlist-assign'

// -- Policy definition (subscription scope) --

resource policyDef 'Microsoft.Authorization/policyDefinitions@2023-04-01' = {
  name: policyName
  properties: {
    displayName: 'Aegis — Foundry model deployment SKU + model allowlist'
    description: 'Deny `Microsoft.CognitiveServices/accounts/deployments` where the SKU is not in the Standard tier OR the underlying model name is not on the aegis allowlist. Closes out-of-band portal deployments and forbids federated (Global / DataZone) SKUs that cross data-residency boundaries. ADR-0017 §Decision.8 + §6.1.3.'
    policyType: 'Custom'
    mode: 'All'
    metadata: {
      category: 'Cost + Data Residency'
      version: '1.0.0'
      source: 'aegis'
    }
    parameters: {
      allowedSkuNames: {
        type: 'Array'
        metadata: {
          displayName: 'Allowed deployment SKU names'
          description: 'Only deployments whose `sku.name` is in this list are permitted.'
        }
        defaultValue: allowedSkuNames
      }
      allowedModelNames: {
        type: 'Array'
        metadata: {
          displayName: 'Allowed OpenAI model names'
          description: 'Only deployments whose `properties.model.name` is in this list are permitted.'
        }
        defaultValue: allowedModelNames
      }
    }
    policyRule: {
      if: {
        allOf: [
          {
            field: 'type'
            equals: 'Microsoft.CognitiveServices/accounts/deployments'
          }
          {
            anyOf: [
              {
                not: {
                  field: 'Microsoft.CognitiveServices/accounts/deployments/sku.name'
                  in: '[parameters(\'allowedSkuNames\')]'
                }
              }
              {
                not: {
                  field: 'Microsoft.CognitiveServices/accounts/deployments/model.name'
                  in: '[parameters(\'allowedModelNames\')]'
                }
              }
            ]
          }
        ]
      }
      then: {
        effect: 'deny'
      }
    }
  }
}

// -- Policy assignment (RG scope, via nested module) --
//
// Bicep forbids a resource whose scope differs from the file's targetScope,
// so the assignment is in a separate RG-scoped module invoked here. See
// `policy-foundry-sku-assign.bicep`.

module policyAssign 'policy-foundry-sku-assign.bicep' = {
  name: 'deploy-${assignmentName}'
  scope: resourceGroup(last(split(resourceGroupId, '/')))
  params: {
    policyDefinitionId: policyDef.id
    assignmentName: assignmentName
    allowedSkuNames: allowedSkuNames
    allowedModelNames: allowedModelNames
  }
}

output policyDefinitionId string = policyDef.id
output policyAssignmentId string = policyAssign.outputs.policyAssignmentId
