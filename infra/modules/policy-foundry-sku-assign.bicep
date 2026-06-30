// policy-foundry-sku-assign.bicep — RG-scope assignment of the
// `aegis-foundry-model-sku-allowlist` policy. Split from the definition module
// because Bicep requires the assignment's scope (RG) to match the file's
// targetScope, while the definition is subscription-scoped. Driven by
// `policy-foundry-sku.bicep` which creates the definition and then invokes
// this module at RG scope.

targetScope = 'resourceGroup'

param policyDefinitionId string
param assignmentName string
param allowedSkuNames array
param allowedModelNames array

resource policyAssign 'Microsoft.Authorization/policyAssignments@2024-04-01' = {
  name: assignmentName
  properties: {
    displayName: 'Aegis Foundry model SKU + name allowlist (RG-scope)'
    description: 'Enforces the SKU + model allowlist on all Foundry model deployments in this RG. ADR-0017 §Decision.8 item 2.'
    policyDefinitionId: policyDefinitionId
    enforcementMode: 'Default'
    parameters: {
      allowedSkuNames: {
        value: allowedSkuNames
      }
      allowedModelNames: {
        value: allowedModelNames
      }
    }
  }
}

output policyAssignmentId string = policyAssign.id
