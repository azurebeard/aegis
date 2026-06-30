// ADR-0034 Phase 8E — typed shapes returned by /api/identities/* endpoints.
// Mirrors the parser-level types in api/src/lib/servicePrincipalParser.ts;
// kept independent so a server-side schema bump that hasn't yet rolled to
// the SPA bundle decays gracefully (extra fields are ignored client-side).

export type ServicePrincipalKind = "application" | "managedIdentity" | "agent" | "other";

export interface CredentialSummary {
  readonly secrets: number;
  readonly certs: number;
  readonly earliestExpiryAt: string | null;
  readonly expiredCount: number;
}

export interface ServicePrincipalRow {
  readonly id: string;
  readonly appId: string;
  readonly displayName: string;
  readonly servicePrincipalType: string;
  readonly kind: ServicePrincipalKind;
  readonly signInAudience: string | null;
  readonly accountEnabled: boolean;
  readonly appOwnerOrganizationId: string | null;
  readonly createdDateTime: string | null;
  readonly tags: readonly string[];
  readonly credentialSummary: CredentialSummary;
}

export interface ServicePrincipalsResponse {
  readonly schemaVersion: 1;
  readonly items: readonly ServicePrincipalRow[];
  readonly retrievedAt: string;
  readonly nextLink: string | null;
  readonly skippedMalformed: number;
}

export type ServicePrincipalKindFilter = "all" | "application" | "managedIdentity";
