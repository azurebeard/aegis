// Per-tenant Secure Score control-profile cache. Lives inside the existing
// `SecureScore` ops-table under a separate PartitionKey ("profile") so we
// don't need a new table or new RBAC — the ingest MI already holds
// Contributor on `SecureScore`, and the api-reader MI's account-scope
// Reader covers reads.
//
// Snapshot rows live at PartitionKey="snapshot", RowKey=yyyy-mm-dd.
// Profile rows live at PartitionKey="profile", RowKey=<controlName>.
// The two partitions never overlap — every read filters on PartitionKey.
//
// Microsoft's `secureScoreControlProfiles` Graph endpoint returns ~100-300
// per-control metadata items per tenant (title, maxScore, tier, remediation
// copy, actionUrl, threats, etc.). The `controlScores[]` items inside each
// daily snapshot carry just the live score; joining the two via
// controlName gives the SPA a "remediation backlog" view with priority
// (max-score gap) + Microsoft-supplied remediation guidance.

import { odata, RestError, type TableClient } from "@azure/data-tables";
import type { SecureScoreControlProfile as RawProfile } from "@microsoft/microsoft-graph-types";

const PROFILE_PARTITION = "profile";

// Azure Tables caps each property at 64 KB UTF-16. Microsoft's `remediation`
// strings are typically <2 KB each but cap defensively in case Microsoft
// ever inflates the field.
const TEXT_FIELD_MAX_CHARS = 32_000;

export interface ControlProfileRow {
  readonly controlName: string;
  readonly controlCategory: string;
  readonly title: string;
  readonly tier: string | null;
  readonly service: string | null;
  readonly maxScore: number | null;
  readonly rank: number | null;
  readonly actionType: string | null;
  readonly actionUrl: string | null;
  readonly remediation: string;
  readonly remediationImpact: string;
  readonly userImpact: string | null;
  readonly implementationCost: string | null;
  readonly threats: readonly string[];
  readonly deprecated: boolean;
  /** ISO-8601 of when Microsoft last modified the control profile entry. */
  readonly profileLastModified: string | null;
  /** ISO-8601 of when our ingest wrote the row. */
  readonly ingestedAt: string;
}

interface ControlProfileEntity {
  readonly partitionKey: string; // "profile"
  readonly rowKey: string; // controlName
  readonly ControlCategory: string;
  readonly Title: string;
  readonly Tier: string;
  readonly Service: string;
  readonly MaxScore: number;
  readonly Rank: number;
  readonly ActionType: string;
  readonly ActionUrl: string;
  readonly Remediation: string;
  readonly RemediationImpact: string;
  readonly UserImpact: string;
  readonly ImplementationCost: string;
  readonly ThreatsJson: string;
  readonly Deprecated: boolean;
  readonly ProfileLastModified: string;
  readonly IngestedAt: string;
}

const NULL_NUMBER_SENTINEL = -1;

/**
 * Path-sanitise the control name into a valid Table RowKey. Microsoft's
 * controlNames are alphanumeric + underscore in practice ("AdminMFA",
 * "MeetingRestrictAnonymousJoinV1"), but defensively replace any forbidden
 * chars with `_`. RowKey forbids `/`, `\`, `#`, `?`, `\t`, `\n`, control
 * chars, and non-printable.
 */
function safeRowKey(controlName: string): string {
  // Strict-allow-list — keep alphanumerics, dot, underscore.
  // Microsoft controlNames are alphanumeric + underscore in practice
  // so legitimate names round-trip unchanged; everything else becomes
  // `_`. Avoids the control-char trap of negated/blacklist regexes.
  return controlName.replace(/[^A-Za-z0-9._]/g, "_").slice(0, 1024);
}

function clampText(s: string | null | undefined): string {
  if (typeof s !== "string") return "";
  if (s.length <= TEXT_FIELD_MAX_CHARS) return s;
  return s.slice(0, TEXT_FIELD_MAX_CHARS);
}

/** Convert the Graph raw shape into the storage entity. */
export function profileToEntity(
  raw: RawProfile,
  ingestedAt: string,
): ControlProfileEntity {
  const controlName = (raw.id ?? "").trim();
  const threats = Array.isArray(raw.threats) ? raw.threats : [];
  return {
    partitionKey: PROFILE_PARTITION,
    rowKey: safeRowKey(controlName),
    ControlCategory: raw.controlCategory ?? "",
    Title: raw.title ?? "",
    Tier: raw.tier ?? "",
    Service: raw.service ?? "",
    MaxScore:
      typeof raw.maxScore === "number" ? raw.maxScore : NULL_NUMBER_SENTINEL,
    Rank: typeof raw.rank === "number" ? raw.rank : NULL_NUMBER_SENTINEL,
    ActionType: raw.actionType ?? "",
    ActionUrl: raw.actionUrl ?? "",
    Remediation: clampText(raw.remediation),
    RemediationImpact: clampText(raw.remediationImpact),
    UserImpact: raw.userImpact ?? "",
    ImplementationCost: raw.implementationCost ?? "",
    ThreatsJson: JSON.stringify(threats),
    Deprecated: raw.deprecated === true,
    ProfileLastModified: raw.lastModifiedDateTime ?? "",
    IngestedAt: ingestedAt,
  };
}

export function entityToRow(e: ControlProfileEntity): ControlProfileRow {
  return {
    controlName: e.rowKey,
    controlCategory: e.ControlCategory,
    title: e.Title,
    tier: e.Tier === "" ? null : e.Tier,
    service: e.Service === "" ? null : e.Service,
    maxScore:
      typeof e.MaxScore === "number" && e.MaxScore !== NULL_NUMBER_SENTINEL
        ? e.MaxScore
        : null,
    rank:
      typeof e.Rank === "number" && e.Rank !== NULL_NUMBER_SENTINEL ? e.Rank : null,
    actionType: e.ActionType === "" ? null : e.ActionType,
    actionUrl: e.ActionUrl === "" ? null : e.ActionUrl,
    remediation: e.Remediation ?? "",
    remediationImpact: e.RemediationImpact ?? "",
    userImpact: e.UserImpact === "" ? null : e.UserImpact,
    implementationCost: e.ImplementationCost === "" ? null : e.ImplementationCost,
    threats: safeJson<readonly string[]>(e.ThreatsJson, []),
    deprecated: e.Deprecated === true,
    profileLastModified: e.ProfileLastModified === "" ? null : e.ProfileLastModified,
    ingestedAt: e.IngestedAt,
  };
}

/**
 * Upsert (Replace) a single control-profile row. Idempotent — Graph's
 * profile catalogue changes monthly at most, and rerunning the ingest is
 * cheap (~150 rows × InsertOrReplace).
 */
export async function upsertControlProfile(
  table: TableClient,
  entity: ControlProfileEntity,
): Promise<void> {
  await table.upsertEntity(entity, "Replace");
}

/**
 * List every profile row in the partition. Sorted by RowKey ascending
 * so SPA consumers get a stable order that matches the snapshot's
 * controlScores[] when sorted by the same key.
 */
export async function listControlProfiles(
  table: TableClient,
): Promise<readonly ControlProfileRow[]> {
  const out: ControlProfileEntity[] = [];
  for await (const e of table.listEntities<ControlProfileEntity>({
    queryOptions: { filter: odata`PartitionKey eq ${PROFILE_PARTITION}` },
  })) {
    out.push(e);
  }
  out.sort((a, b) => (a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0));
  return out.map(entityToRow);
}

/** Read a single profile by controlName; null on 404. */
export async function readControlProfile(
  table: TableClient,
  controlName: string,
): Promise<ControlProfileRow | null> {
  try {
    const e = await table.getEntity<ControlProfileEntity>(
      PROFILE_PARTITION,
      safeRowKey(controlName),
    );
    return entityToRow(e);
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return null;
    throw err;
  }
}

function safeJson<T>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
