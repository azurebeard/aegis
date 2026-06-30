// keyvault.bicep — Key Vault configured for RBAC auth (no access policies).
// No secrets provisioned in this pass; the vault exists so future Function Apps can reference it.

param workload string
param environment string
param regionShort string
param location string
param uniqueSuffix string
param purgeProtection bool
@minValue(7)
@maxValue(90)
param softDeleteRetentionDays int
param resourceLocksEnabled bool
param logAnalyticsWorkspaceId string
param tags object
@allowed([
  'Enabled'
  'Disabled'
])
@description('Public-network-access mode. Drives both the top-level `publicNetworkAccess` property and the `networkAcls.defaultAction` so a single switch covers both the new (Microsoft.KeyVault) and legacy (network-rules) gates. Set to `Disabled` only after private endpoints have been provisioned for the vault (see `networking.bicep`). Operator note: `Disabled` blocks `az keyvault secret set` from a workstation outside the VNet — see `deployerIpAllowlist` below for the prod-tier workflow.')
param publicNetworkAccess string = 'Enabled'

// F-fwd-3 (docs/prod-tier-dryrun-lessons-learned.md §3) — when
// `publicNetworkAccess: Disabled` the vault is closed to public traffic,
// but the operator running `azd provision` (which has to seed the
// recipient-hash-pepper and report-share-signing-key secrets via
// `scripts/provision-*.ps1`) is OUTSIDE the VNet and hits Forbidden on
// `az keyvault secret set`. This param wires a single-CIDR firewall
// exception that LEAVES `publicNetworkAccess: Disabled` AS-IS (the PE
// remains the primary access path) but allows the named CIDR through
// `networkAcls.ipRules`. The exception is durable — the operator
// allowlist applies to all subsequent rotations from the same network
// boundary. Empty array (default) means no exception, preserving the
// pre-F-fwd-3 posture for dev / VNet-resident operator scenarios.
// Wire via:
//   azd env set AZURE_DEPLOYER_IP_ALLOWLIST "203.0.113.42/32"
// Multi-CIDR supported via comma-separated env var (main.bicep splits).
// Format: `<ip-or-cidr>` (Microsoft.KeyVault validates; /31 + /32 + IPv4
// CIDR all accepted). KV does not support IPv6 ipRules — a v6 entry will
// fail at provision with a clear ARM error.
@description('F-fwd-3 — operator CIDR exceptions for the KV firewall when publicNetworkAccess=Disabled. Applied as `networkAcls.ipRules` while default-action stays Deny. See header for the env var wiring.')
param deployerIpAllowlist array = []

// ADR-0030 §C.21 / WS10 L12 — recipient-hash pepper secret RBAC.
// Bicep does NOT provision the secret VALUE (no Bicep crypto-strong RNG);
// `scripts/provision-recipient-hash-pepper.ps1` (and the equivalent
// signing-key script) generate 32 random bytes and write via
// `az keyvault secret set` on first deploy AND on operator-triggered
// rotation. Bicep declares the role assignments only — the API's
// `mailSender` MI reads pepper (Secrets User), the `api-reader` MI reads
// the signing key (Secrets User), the operator running azd writes
// (Secrets Officer).
//
// SEC-L-L12-04 closure — per-secret ABAC conditions on
// both Aegis-managed read grants. The vault is shared with future
// non-Aegis secrets in principle; without ABAC, either MI could read
// any future secret in the vault, breaching least-privilege. Each
// read grant is now gated to its single named secret via
// `@Resource[Microsoft.KeyVault/vaults/secrets:name] StringEqualsIgnoreCase '<secret>'`
// over the two read data-actions of the `Key Vault Secrets User` role
// (`getSecret/action` + `readMetadata/action`). The deployer Secrets
// Officer grant is intentionally LEFT vault-scope — operator action
// remains the trust boundary, and the rotation scripts target the
// secrets by name from the operator's CLI, so a misuse vector
// requires operator intent.
@description('mailSender MI principalId — granted Key Vault Secrets User scoped (via ABAC) to the recipient-hash-pepper secret only. Empty disables the grant.')
param mailSenderMiPrincipalId string = ''
@description('api-reader MI principalId — granted Key Vault Secrets User scoped (via ABAC) to the report-share-signing-key secret only (ADR-0030 §C.22 chunk 4). Empty disables the grant.')
param apiReaderMiPrincipalId string = ''
@description('Deployer (operator) object ID — granted Key Vault Secrets Officer so the provisioning scripts can write/rotate the two Aegis-managed secrets. Empty disables the grant (CI/headless deploys that do not provision either secret).')
param deployerObjectId string = ''
@allowed([
  'User'
  'ServicePrincipal'
])
@description('L12-FT-OFFICER-PRINCIPAL-TYPE — principal type for the deployer Secrets Officer grant. Defaults to `User` for operator-laptop deploys; CI / headless deploys running under an azd service-principal MUST set this to `ServicePrincipal` so the role assignment matches the principal type and is durable against a future Azure RBAC tightening that rejects mismatched assignments (built-in roles tolerate the mismatch today but the contract is not guaranteed).')
param deployerPrincipalType string = 'User'
@description('SEC-L-L12-04 — recipient-hash-pepper secret name targeted by the mailSender MI ABAC condition. MUST match `functions.bicep:recipientHashPepperKvSecretName` and the `-SecretName` default of `provision-recipient-hash-pepper.ps1`. Drift between the three surfaces produces a silent 403 on the mailSender read path.')
param recipientHashPepperSecretName string = 'recipient-hash-pepper'
@description('SEC-L-L12-04 — report-share-signing-key secret name targeted by the api-reader MI ABAC condition. MUST match `functions.bicep:reportShareSigningKeyKvSecretName` and the `-SecretName` default of `provision-report-share-signing-key.ps1`. Drift produces a silent 403 on the share-link mint + verify paths.')
param reportShareSigningKeySecretName string = 'report-share-signing-key'

@description('ADR-0037 — threatIntel MI principalId — granted Key Vault Secrets User scoped (via ABAC) to the ransomware-live-api-key secret only. Empty disables the grant (deploys that intentionally skip the ransomware.live integration; the MI is still created in identities.bicep but the KV read path is closed).')
param threatIntelMiPrincipalId string = ''

@description('ADR-0037 — ransomware.live PRO API key secret name targeted by the threatIntel MI ABAC condition. MUST match `functions.bicep:ransomwareLiveApiKeyKvSecretName` and the `-SecretName` default of `provision-ransomware-live-api-key.ps1`. Drift produces a silent 403 on the threatIntel ingest path.')
param ransomwareLiveSecretName string = 'ransomware-live-api-key'

var baseName = 'kv-${workload}-${environment}-${regionShort}'
var vaultName = empty(uniqueSuffix) ? baseName : '${baseName}-${toLower(uniqueSuffix)}'

resource kv 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionDays
    enablePurgeProtection: purgeProtection ? true : null
    publicNetworkAccess: publicNetworkAccess
    networkAcls: {
      // When `publicNetworkAccess: 'Disabled'`, `networkAcls.defaultAction`
      // is semantically a no-op (the resource is closed at the higher
      // gate). Set both so the policy is internally consistent and a
      // future operator flipping `publicNetworkAccess` back to `Enabled`
      // doesn't accidentally re-open the firewall.
      defaultAction: publicNetworkAccess == 'Disabled' ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
      ipRules: [for cidr in deployerIpAllowlist: {
        value: cidr
      }]
    }
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-to-law'
  scope: kv
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
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

resource vaultLock 'Microsoft.Authorization/locks@2020-05-01' = if (resourceLocksEnabled) {
  scope: kv
  name: 'CanNotDelete-keyvault'
  properties: {
    level: 'CanNotDelete'
    notes: 'Key Vault — persistent secret store per PROJECT_BRIEF §10.'
  }
}

// §10.66 Phase E dropped the deployer KV Secrets Officer assignment
// because the legacy `aad-client-secret-<env>` flow was retired. L12
// (ADR-0030 §C.21) reintroduces the deployer assignment, and SEC-L-L12-04
// closes the per-secret ABAC follow-up on the two
// READ-side grants now that the vault holds two Aegis-managed secrets.
// Two role IDs (built-in):
//   * Key Vault Secrets User    — `4633458b-17de-408a-b874-0445c86b69e6`
//   * Key Vault Secrets Officer — `b86a8fe4-44ce-4948-aee5-eccb2c155cd7`

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6' // gitleaks:allow
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' // gitleaks:allow

// SEC-L-L12-04 — single-secret ABAC condition factory.
//
// The Key Vault Secrets User built-in role has two data actions:
//   * Microsoft.KeyVault/vaults/secrets/getSecret/action
//   * Microsoft.KeyVault/vaults/secrets/readMetadata/action
//
// We gate BOTH actions so the assigned MI can only call them against
// the named secret. The condition uses ABAC v2 syntax (matching the
// `Microsoft.KeyVault/vaults/secrets:name` resource attribute):
//   "EITHER the action being attempted is not one of those two read
//   actions (leave the decision to base RBAC, which says deny for
//   anything else this role doesn't grant) OR the secret name matches."
//
// `StringEqualsIgnoreCase` follows the MSFT canonical pattern (Key
// Vault secret names are case-insensitive by storage but case-
// preserving on display — `recipient-hash-pepper` and
// `Recipient-Hash-Pepper` would address the same secret, so the
// condition must not treat them differently).
//
// Operator note: an in-place RA update from "no condition" → "with
// condition" is supported by ARM. If a deployer reports the rare
// `RoleAssignmentRequestImmutable` failure, the workaround is
// `az role assignment delete` on the existing RA followed by
// re-running `azd provision` to recreate it with the condition
// already in place.
var kvSingleSecretAbacV2 = '''(
  (
    !(ActionMatches{'Microsoft.KeyVault/vaults/secrets/getSecret/action'})
    AND
    !(ActionMatches{'Microsoft.KeyVault/vaults/secrets/readMetadata/action'})
  )
  OR
  (
    @Resource[Microsoft.KeyVault/vaults/secrets:name] StringEqualsIgnoreCase '{0}'
  )
)'''

// L12-FT-02 — `Key Vault Secrets Officer` multi-secret allowlist
// condition. The Officer role grants 8 data actions (setSecret,
// getSecret, readMetadata, delete, backup, restore, recover, purge);
// all are secret-targeted (no vault-level list-all), so a pure
// `@Resource[...:name]` predicate is the recommended canonical
// MSFT pattern — no need to enumerate every action.
//
// Fail-closed semantic: for any future Officer-role action that
// is NOT secret-targeted (e.g. a hypothetical vault-level operation),
// the `@Resource[Microsoft.KeyVault/vaults/secrets:name]` attribute
// is undefined; ABAC v2 evaluates an undefined attribute as not
// matching, both clauses are false, condition is false, action is
// denied. Acceptable — the deployer rotation flow only ever sets,
// gets, deletes, or recovers the two named secrets; any
// vault-level action would be a misuse vector.
// ADR-0037 — extended to a third secret (`ransomware-live-api-key`).
// Same shape; one more OR clause. Fail-closed semantic preserved (any
// future cross-workload secret added to this vault stays outside the
// Officer scope until this allowlist is explicitly extended).
var kvMultiSecretOfficerAbacV2 = '(\n  @Resource[Microsoft.KeyVault/vaults/secrets:name] StringEqualsIgnoreCase \'${recipientHashPepperSecretName}\'\n  OR\n  @Resource[Microsoft.KeyVault/vaults/secrets:name] StringEqualsIgnoreCase \'${reportShareSigningKeySecretName}\'\n  OR\n  @Resource[Microsoft.KeyVault/vaults/secrets:name] StringEqualsIgnoreCase \'${ransomwareLiveSecretName}\'\n)'

resource mailSenderKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(mailSenderMiPrincipalId)) {
  scope: kv
  name: guid(kv.id, mailSenderMiPrincipalId, kvSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: mailSenderMiPrincipalId
    principalType: 'ServicePrincipal'
    description: 'ADR-0030 §C.21 + SEC-L-L12-04 — mailSender MI reads recipient-hash-pepper ONLY (per-secret ABAC).'
    condition: replace(kvSingleSecretAbacV2, '{0}', recipientHashPepperSecretName)
    conditionVersion: '2.0'
  }
}

// ADR-0030 §C.22 chunk 4 — api-reader MI reads the share-link signing key.
// Used by both the verifier (GET /api/reports/share/{token}) and the
// issuer (sendReportSnapshotEmail) — see reportShareSigningKey.ts header.
// SEC-L-L12-04 closed: ABAC condition gates the grant to this single
// secret name only.
resource apiReaderKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: kv
  name: guid(kv.id, apiReaderMiPrincipalId, kvSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    description: 'ADR-0030 §C.22 + SEC-L-L12-04 — api-reader MI reads report-share-signing-key ONLY (per-secret ABAC).'
    condition: replace(kvSingleSecretAbacV2, '{0}', reportShareSigningKeySecretName)
    conditionVersion: '2.0'
  }
}

// ADR-0037 Option B — api-reader MI writes new VERSIONS
// of the ransomware.live PRO API key. Consumed by the admin-only
// `rotateRansomwareIntelKey` POST handler so an operator can paste a
// freshly-issued key into the SPA admin section instead of dropping to
// the operator-CLI `provision-ransomware-live-api-key.ps1 -Mode Rotate`
// workflow.
//
// **Trust boundary cost (Option B vs operator-CLI):** a compromised admin
// session can now rotate this one secret to an invalid value (DoS the
// ingest path). Mitigations: (a) per-secret ABAC scoping (this block) so
// the api-reader MI can ONLY touch `ransomware-live-api-key` — every
// other secret in the vault stays out of reach; (b) the rotate handler
// validates the supplied key against ransomware.live `GET /validate`
// before writing (won't store garbage); (c) 5/day per-tenant rate limit
// (separate from the 30/day admin-run budget so cross-vertical limits
// don't starve each other); (d) audit-trail line per rotation. Net
// blast radius: temporarily DoS one ingest source. Acceptable for the
// self-service UX win.
//
// Same condition shape as the existing single-secret User grants below;
// just the Officer-role roleDefinitionId differs. Fail-closed semantic
// preserved (any future Officer-role action that isn't secret-targeted
// has an undefined `@Resource[…secrets:name]` attribute and is denied).
resource apiReaderKvRansomwareKeyOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(apiReaderMiPrincipalId)) {
  scope: kv
  name: guid(kv.id, apiReaderMiPrincipalId, kvSecretsOfficerRoleId, ransomwareLiveSecretName)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
    principalId: apiReaderMiPrincipalId
    principalType: 'ServicePrincipal'
    description: 'ADR-0037 Option B + SEC-L-L12-04 — api-reader writes new versions of ransomware-live-api-key ONLY (per-secret ABAC). Consumed by the rotateRansomwareIntelKey admin handler.'
    condition: replace(kvSingleSecretAbacV2, '{0}', ransomwareLiveSecretName)
    conditionVersion: '2.0'
  }
}

// ADR-0037 — threatIntel MI reads the ransomware.live PRO API key.
// Used by the runRansomwareIntelIngest Timer + admin-trigger handler.
// Same per-secret ABAC pattern as mailSender/api-reader above —
// gated to one named secret only. Separate trust boundary from the
// other two: the consumed surface is a third-party HTTP API, not a
// Microsoft-internal data plane.
resource threatIntelKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(threatIntelMiPrincipalId)) {
  scope: kv
  name: guid(kv.id, threatIntelMiPrincipalId, kvSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: threatIntelMiPrincipalId
    principalType: 'ServicePrincipal'
    description: 'ADR-0037 + SEC-L-L12-04 — threatIntel MI reads ransomware-live-api-key ONLY (per-secret ABAC).'
    condition: replace(kvSingleSecretAbacV2, '{0}', ransomwareLiveSecretName)
    conditionVersion: '2.0'
  }
}

resource deployerKvSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerObjectId)) {
  scope: kv
  name: guid(kv.id, deployerObjectId, kvSecretsOfficerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
    principalId: deployerObjectId
    // L12-FT-OFFICER-PRINCIPAL-TYPE — was hardcoded `User`; now
    // parameterised. Azure's built-in Secrets Officer role tolerates a
    // mismatched principalType today, but a future RBAC tightening
    // could reject it. Operator-laptop deploys keep the default
    // `User`; CI deploys under azd-SP set `deployerPrincipalType` to
    // `ServicePrincipal` via `azd env set
    // AZURE_DEPLOYER_PRINCIPAL_TYPE ServicePrincipal`.
    principalType: deployerPrincipalType
    description: 'ADR-0030 §C.21 + L12-FT-02 — operator writes/rotates the two Aegis-managed secrets ONLY (per-secret ABAC).'
    // L12-FT-02 — multi-secret allowlist. Was vault-scope after L12-04
    // (operator action remains the trust boundary). Tightened now to
    // prevent a future cross-workload secret addition to this vault
    // from silently inheriting Officer access via the same MI / user.
    condition: kvMultiSecretOfficerAbacV2
    conditionVersion: '2.0'
  }
}

output keyVaultName string = kv.name
output keyVaultUri string = kv.properties.vaultUri
output keyVaultId string = kv.id
