// swa.bicep — Azure Static Web App (Standard tier, ADR-0007).
// System-assigned managed identity: used by SWA to call the linked Function App
// as a same-origin proxy. With ADR-0035 Phase E (Easy Auth removed on FA),
// the SWA-MI token is no longer validated by the FA — the proxy is
// pass-through for the SPA's Bearer JWT.
//
// ADR-0035 Phase D2 — historic AAD_CLIENT_ID + AAD_CLIENT_SECRET app
// settings retired alongside SWA built-in OIDC. The SPA authenticates
// directly to Entra via MSAL.js. The KV `aad-client-secret-<env>` becomes
// orphaned (Phase E §8a removes it + the deployer's KV Secrets Officer
// role assignment).

param workload string
param environment string
param regionShort string
param location string
param uniqueSuffix string
param tags object

@description('App Insights connection string for SPA + SWA telemetry.')
@secure()
param appInsightsConnectionString string

// §10.66 Phase E — keyVaultName param removed; the SWA no longer references
// the deprecated `aad-client-secret-<env>` KV secret (retired in Phase D2).

var baseSwaName = 'stapp-${workload}-${environment}-${regionShort}'
var swaName = empty(uniqueSuffix) ? baseSwaName : '${baseSwaName}-${toLower(uniqueSuffix)}'

resource swa 'Microsoft.Web/staticSites@2024-04-01' = {
  name: swaName
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    allowConfigFileUpdates: true
    enterpriseGradeCdnStatus: 'Disabled'
    stagingEnvironmentPolicy: 'Enabled'
  }
}

// App Insights app settings only. AAD_CLIENT_ID + AAD_CLIENT_SECRET were
// retired in ADR-0035 Phase D2 — SWA built-in OIDC is removed; the SPA
// authenticates directly to Entra via MSAL.js. The KV `aad-client-secret-<env>`
// is left orphaned (Phase E §8a deletes it alongside the deployer's KV
// Secrets Officer role assignment). The SWA's KV Secrets User role on the
// vault is also removed here — no SWA-side KV reference remains.
//
// The `aadClientAppId` and `aadClientSecretName` params previously
// retained for one-deploy-cycle compatibility were removed in this commit;
// the call site in `main.bicep` no longer passes them.

resource swaAppSettings 'Microsoft.Web/staticSites/config@2024-04-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsightsConnectionString
  }
}

output swaName string = swa.name
output swaResourceId string = swa.id
output swaDefaultHostname string = swa.properties.defaultHostname
output swaSystemMiPrincipalId string = swa.identity.principalId
