// ADR-0036 — subscription-scoped Security Reader role assignment for the
// arm-ingest MI.
//
// Read-only access to `Microsoft.Security/secureScores` + the parent
// `Microsoft.Resources/subscriptions/{id}` object (for SubscriptionName
// resolution). `Security Reader` is the built-in role: `39bc4728-0917-
// 49c7-9d2c-d95423bc2eb4`. Permissions inspected against the role's
// `Actions` list confirm both `Microsoft.Security/*/read` and
// `Microsoft.Resources/subscriptions/read` are covered, so the secure-
// score ARM ingest works without further widening.
//
// History:
//   v1   — assigned `Reader` (acdd72a7-3385-48ef-bd42-f606fba81ae7) to the
//          `ingest` MI per ADR-0036 §5 deliberate trade-off.
//   v1.1 — WS10 M-Q1: tightened to `Security Reader` on the same `ingest` MI.
//   v1.2 — WS10 M-Q2 (this iteration, §10.67 follow-up): moved off the
//          shared `ingest` MI onto a dedicated `armIngest` MI defined in
//          identities.bicep. Bounds cross-data-plane blast radius: a
//          compromise of the Graph `ingest` MI does NOT grant ARM access,
//          and vice versa. The original `ingest` MI no longer holds any
//          subscription-scope role.
//
// Deployment caveat: when the principalId on a role assignment changes,
// Bicep deploys a NEW assignment under a new GUID name and does NOT
// remove the old one. ADR-0036 §5 documents the post-provision
// `az role assignment delete` step the operator must run after each
// reshape (v1→v1.1 and v1.1→v1.2).
//
// This module is its own .bicep file because role-assignment `name`
// expressions must be calculable at the start of deployment; embedding
// the principalId from `identities.outputs.*` directly in main.bicep
// trips Bicep's BCP120 forward-reference check. Passing principalId as
// a module param defers the `guid()` computation to module-deploy-start
// where the value is known.

targetScope = 'subscription'

@description('Principal ID of the arm-ingest MI (system-assigned identity from identities.bicep — id-aegis-arm-ingest-<env>-<region>). Dedicated to the ARM data plane per ADR-0036 v1.2 M-Q2 split.')
param armIngestMiPrincipalId string

var securityReaderRoleId = '39bc4728-0917-49c7-9d2c-d95423bc2eb4'

resource armIngestMiSubscriptionSecurityReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, armIngestMiPrincipalId, securityReaderRoleId)
  properties: {
    principalId: armIngestMiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      securityReaderRoleId
    )
    description: 'ARM ingest MI — Security Reader on subscription for Defender for Cloud Secure Score ingest (ADR-0036 v1.2 + WS10 M-Q2).'
  }
}

output roleAssignmentId string = armIngestMiSubscriptionSecurityReader.id
