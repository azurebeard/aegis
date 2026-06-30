// ADR-0031 — wire shapes for /api/stack/*.

export const STACK_CATEGORIES = [
  "os",
  "application",
  "network-device",
  "library",
  "service",
  "other",
] as const;
export type StackCategory = (typeof STACK_CATEGORIES)[number];

export const STACK_ENVIRONMENTS = ["production", "staging", "development", "unknown"] as const;
export type StackEnvironment = (typeof STACK_ENVIRONMENTS)[number];

export const STACK_CATEGORY_LABELS: Readonly<Record<StackCategory, string>> = {
  os: "OS",
  application: "Application",
  "network-device": "Network device",
  library: "Library",
  service: "Service",
  other: "Other",
};

export const STACK_ENVIRONMENT_LABELS: Readonly<Record<StackEnvironment, string>> = {
  production: "Production",
  staging: "Staging",
  development: "Development",
  unknown: "Unknown",
};

/** ADR-0033 — operator-set workflow state per (stackItem, CVE). */
export const KEV_SUPPRESSION_STATUSES = [
  "open",
  "acknowledged",
  "risk_accepted",
  "remediated",
  "not_applicable",
] as const;
export type KevSuppressionStatus = (typeof KEV_SUPPRESSION_STATUSES)[number];

export const KEV_STATUS_LABELS: Readonly<Record<KevSuppressionStatus, string>> = {
  open: "Open",
  acknowledged: "Acknowledged",
  risk_accepted: "Risk accepted",
  remediated: "Remediated",
  not_applicable: "Not applicable",
};

/** ADR-0032 — KEV match attached to each stack item by the read endpoint. */
export interface CveMatchSummary {
  readonly cveID: string;
  readonly vendorProject: string;
  readonly product: string;
  readonly vulnerabilityName: string;
  readonly dateAdded: string;
  readonly dueDate: string;
  readonly knownRansomwareCampaignUse: "Known" | "Unknown";
  readonly requiredAction: string;
  /** ADR-0033. Default `"open"` when no suppression row exists. */
  readonly status: KevSuppressionStatus;
  readonly notes: string | null;
  readonly expiresAt: string | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface StackItem {
  readonly id: string;
  readonly vendor: string;
  readonly product: string;
  readonly version: string;
  readonly category: StackCategory;
  readonly environment: StackEnvironment;
  readonly notes: string;
  readonly tags: readonly string[];
  readonly canonical: boolean;
  readonly addedAt: string;
  readonly addedBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  /** ADR-0032 §3 — populated by GET /api/stack/items at read time. Empty
   *  array when no KEV CVEs match the (vendor, product). Optional on the
   *  wire for forward-compat with old API versions. */
  readonly kevMatches?: readonly CveMatchSummary[];
}

export interface StackItemsResponse {
  readonly schemaVersion: 1;
  readonly items: readonly StackItem[];
  readonly cap: number;
}

export interface CatalogPair {
  readonly vendor: string;
  readonly product: string;
  readonly defaultCategory: StackCategory;
}

export interface StackCatalogResponse {
  readonly schemaVersion: 1;
  readonly pairs: readonly CatalogPair[];
}

export interface CreateStackItemInput {
  readonly vendor: string;
  readonly product: string;
  readonly version?: string;
  readonly category: StackCategory;
  readonly environment: StackEnvironment;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

export interface PatchStackItemInput {
  readonly vendor?: string;
  readonly product?: string;
  readonly version?: string;
  readonly category?: StackCategory;
  readonly environment?: StackEnvironment;
  readonly notes?: string;
  readonly tags?: readonly string[];
}
