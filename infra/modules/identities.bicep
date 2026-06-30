// identities.bicep — user-assigned managed identities.
// Purpose-separated per ADR-0010 §Positive consequences (identity boundary) and
// ADR-0011 §5a (ingest vs API separation):
//  - auditWriter : appends to the audit blob container
//   - apiReader   : HTTP read handlers — narrow container-scoped reads only
//                   (no AzureWebJobsStorage, no deployment-container; those
//                   moved to `host` MI on 2026-04-19, see §7.4)
//   - ingest      : Timer handlers carrying Graph app roles (ADR-0010) and
//                   writing SecureScore + Incidents + EntraRisk +
//                   TenantDirectory + TenantSettings + IngestHealth (ADR-0011
//                   §5a). No ARM data-plane permissions — those live on
//                   armIngest below.
//   - armIngest   : Timer handlers calling the Azure Resource Manager (ARM)
//                   data plane only — currently `Microsoft.Security/secureScores`
//                   for ADR-0036 Defender for Cloud Secure Score ingest.
//                   Carries subscription-scope `Security Reader` (CIS Microsoft
//                   Azure Foundations 1.23 alignment) + table-scoped
//                   Contributor on AzureSecureScores + IngestHealth. Split
//                   from `ingest` per WS10 verdict on ADR-0036 Phase A
//                   (M-Q2 forward-track, §10.67 follow-up): bounds the
//                   cross-data-plane blast radius — a compromise of the Graph
//                   ingest MI does NOT grant ARM access, and vice versa.
//   - host        : Functions runtime infrastructure — AzureWebJobsStorage
//                   (blob singleton leases, queues, deployment container).
//                   Dedicated MI so api-reader stays narrow. Added 2026-04-19
//                   after live-observed NoOpListener state on Flex Consumption
//                   Timer triggers without account-scope host-storage access.
//   - agent       : brief-agent Foundry caller (ADR-0017 §Identity). Carries
//                   `Azure AI Developer` on the Foundry Project + narrow table
//                   RBAC (BriefCache, AgentBudget, AgentHealth) + container-
//                   scoped Blob Data Contributor on daily-briefs + Blob Data
//                   Reader on incidents-detail. No Graph / Defender / Sentinel
//                   scopes — agent reads tenant context from the data plane
//                   only, never direct API access (ADR-0017 §Cross-tenant
//                   surface default-deny).
//   - mailSender  : Microsoft Graph `Mail.Send` + `Mail.Read` for outbound
//                   email of report snapshots (ADR-0030 Phase C, §C.1/C.2).
//                   Scoped to a single operator-provided mailbox via
//                   Exchange Online Application Access Policy (AAP) —
//                   provisioned by bootstrap-entra.ps1 when
//                   `AZURE_MAIL_SENDER_UPN` is set. The MI is created
//                   unconditionally (cheap; inert when no mailbox
//                   configured per §C.5.2). Carries `Storage Table Data
//                   Contributor` on `TenantSettings` only (for the
//                   idempotency cache + send-history rows). No subscription
//                   or container access; no other Graph scopes.
//   - threatIntel : Outbound HTTP to the ransomware.live PRO API
//                   (ADR-0037). Reads the `ransomware-live-api-key` KV
//                   secret via per-secret ABAC (mirrors SEC-L-L12-04
//                   pattern). Writes to `RansomwareIntel` + `IngestHealth`
//                   tables only. NO Graph scopes, NO subscription-scope
//                   role, NO container access — separate trust boundary
//                   from every other MI because the consumer is a third-
//                   party API (different posture from Microsoft Graph or
//                   ARM). The MI is created unconditionally; inert until
//                   the operator seeds the KV secret via
//                   `scripts/provision-ransomware-live-api-key.ps1`.

param workload string
param environment string
param regionShort string
param location string
param tags object

resource auditWriter 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${workload}-audit-${environment}-${regionShort}'
  location: location
  tags: tags
}

resource apiReader 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${workload}-api-${environment}-${regionShort}'
  location: location
  tags: tags
}

resource ingest 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${workload}-ingest-${environment}-${regionShort}'
  location: location
  tags: tags
}

resource armIngest 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${workload}-arm-ingest-${environment}-${regionShort}'
  location: location
  tags: tags
}

resource host 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${workload}-host-${environment}-${regionShort}'
  location: location
  tags: tags
}

resource agent 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${workload}-agent-${environment}-${regionShort}'
  location: location
  tags: tags
}

resource mailSender 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${workload}-mail-sender-${environment}-${regionShort}'
  location: location
  tags: tags
}

resource threatIntel 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${workload}-threatintel-${environment}-${regionShort}'
  location: location
  tags: tags
}

output auditWriterMiPrincipalId string = auditWriter.properties.principalId
output auditWriterMiClientId string = auditWriter.properties.clientId
output auditWriterMiResourceId string = auditWriter.id

output apiReaderMiPrincipalId string = apiReader.properties.principalId
output apiReaderMiClientId string = apiReader.properties.clientId
output apiReaderMiResourceId string = apiReader.id

output ingestMiPrincipalId string = ingest.properties.principalId
output ingestMiClientId string = ingest.properties.clientId
output ingestMiResourceId string = ingest.id

output armIngestMiPrincipalId string = armIngest.properties.principalId
output armIngestMiClientId string = armIngest.properties.clientId
output armIngestMiResourceId string = armIngest.id

output hostMiPrincipalId string = host.properties.principalId
output hostMiClientId string = host.properties.clientId
output hostMiResourceId string = host.id

output agentMiPrincipalId string = agent.properties.principalId
output agentMiClientId string = agent.properties.clientId
output agentMiResourceId string = agent.id

output mailSenderMiPrincipalId string = mailSender.properties.principalId
output mailSenderMiClientId string = mailSender.properties.clientId
output mailSenderMiResourceId string = mailSender.id

output threatIntelMiPrincipalId string = threatIntel.properties.principalId
output threatIntelMiClientId string = threatIntel.properties.clientId
output threatIntelMiResourceId string = threatIntel.id
