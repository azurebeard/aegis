# ADR-0033 — KEV match status workflow

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0032 Phase B+ landed the bidirectional contiguous-token product matcher
on 2026-04-28 PM. A live trial-run immediately surfaced the natural
consequence: **a moderate stack produces dozens to hundreds of KEV matches**.
The /kev page becomes an undifferentiated list — every operator visit shows
the same data, there's no concept of "I've handled this", and the volume
discourages action.

ADR-0032 §Out of scope explicitly deferred *"per-CVE remediation tracking
(workflow: 'started', 'in progress', 'remediated')"* — this ADR settles
the workflow.

The user-facing outcome:

- Each `(stackItem, cveID)` pair has an admin-settable **status**: `open`,
  `acknowledged`, `risk_accepted`, `remediated`, or `not_applicable`.
- Default `/kev` view shows only `open` matches → operator queue.
- Status chips (with counts) toggle visibility of each cohort.
- Status badge on each row + admin dropdown to change it inline.
- Audit via `AIEVENT KevSuppressionChange` — every transition records
  from/to + actor + timestamp.

Concerns this ADR settles:

1. **Status set + semantics.**
2. **Storage shape** — table layout + RBAC.
3. **Read merging** — how status data joins the existing read-time KEV match.
4. **Default view** — what filters are active out of the box.
5. **Expiry** — auto-revert to `open` after a set date.
6. **Audit** — AIEVENT pattern (consistent with TenantSettings / StackItems).
7. **Deployment-baseline mode** — explicitly out of scope (Phase 2.5).
8. **Outbound alerting on new matches** — explicitly out of scope (separate
   outbound-integration ADR).

## Decision

### 1. Status set — five states

```ts
type KevSuppressionStatus =
  | "open"            // default; operator hasn't decided yet — appears in queue
  | "acknowledged"    // operator is aware; deferring action; still shows in queue (badge)
  | "risk_accepted"   // operator decided not to remediate; appears only on demand
  | "remediated"      // operator patched / mitigated; appears only on demand
  | "not_applicable"; // operator confirmed match is wrong (e.g. version not affected); appears only on demand
```

Why five rather than three:

- `risk_accepted` vs `remediated` matter for compliance audits — different
  evidence, different trade-offs.
- `not_applicable` is operationally distinct from both — it's a "match was
  wrong" signal rather than "we accepted/fixed it". Useful future signal
  for fuzzy-match feedback (Phase B+ refinement).
- `acknowledged` is the "I see it, working on it" state — keeps the row
  in the queue but reduces the "did anyone notice?" anxiety.

### 2. Storage — `KevSuppressions` table

| Column | Type | Notes |
|---|---|---|
| `PartitionKey` | string | `tenantId` |
| `RowKey` | string | `<stackItemId>_<cveID>` — both already validated upstream |
| `Status` | string | One of the five enum values |
| `Notes` | string | Optional, ≤ 256 chars, plain-text-only |
| `ExpiresAt` | string | Optional ISO-8601 UTC; empty when no expiry |
| `UpdatedAt` | string | ISO-8601 UTC |
| `UpdatedBy` | string | AAD object ID of last-modifying admin |

**Default-when-absent:** missing row implies `status = "open"` and no
notes / expiry. The matcher computes `effectiveStatus` per `(item, CVE)`
pair on read by joining suppressions; an absent row needs no write —
mass-`open` doesn't bloat storage.

**Expiry handling at read-time:** on each `GET /api/stack/items` (read-time
match), the joiner checks `expiresAt`. If set and in the past, the
`effectiveStatus` returned to the SPA is `"open"` regardless of stored
`Status`. Phase 2.5 adds a Timer sweeper that physically deletes expired
rows; until then, the on-disk `Status` may diverge from `effectiveStatus`
(harmless — reads are authoritative).

**RBAC** — per-table-scoped, mirrors StackItems / KEV / TenantSettings:

- Ingest MI: `Storage Table Data Contributor` — admin-triggered PATCH
  writes via the API handler use the ingest MI (precedent: patchSettings,
  postStackItem).
- Api-reader MI: `Storage Table Data Reader` — read for join in
  `getStackItems` + `getKevSummary`.
- Agent MI: nothing in v1.

### 3. Read merging

`GET /api/stack/items` (read-time KEV match — ADR-0032 §3) is extended:

1. Read StackItems for tenant (existing).
2. Read KEV catalog (existing).
3. **NEW:** Read `KevSuppressions` for tenant. Map keyed `<itemId>_<cveID>`.
4. For each stack item, compute `kevMatches` (existing matcher).
5. **NEW:** For each match, look up the suppression row. Apply
   `effectiveStatus` (with expiry resolution).

The `CveMatchSummary` projection gains:

```ts
{
  // ... existing fields ...
  status: KevSuppressionStatus;          // effective (expiry-aware)
  notes: string | null;                  // null when no row
  expiresAt: string | null;              // ISO; null when no expiry
  updatedAt: string | null;              // null when default
  updatedBy: string | null;              // null when default
}
```

`status: "open"` is the safe default for missing rows — operators see
the queue, not a silent suppression.

`getKevSummary` also extends with per-status counts:

```ts
matches: {
  totalPairs: number;          // active matches (status != not_applicable)
  open: number;
  acknowledged: number;
  riskAccepted: number;
  remediated: number;
  notApplicable: number;
  matchedItemCount: number;    // distinct items with at least one open match
  dueThisWeek: number;         // open matches with dueDate in next 7d
}
```

**Decision:** `matchedItemCount` and `dueThisWeek` count **only `open`**.
Operators want "what's left to do" prominent; resolved counts are
secondary.

### 4. Default view + filters on `/kev`

- Default chip selection: `open` (only).
- Other chips: `acknowledged`, `risk_accepted`, `remediated`,
  `not_applicable`. Toggling shows that cohort.
- Chip labels include counts: `Open (47)`, `Remediated (12)`.
- Multi-select chips — operator can show `Open + Acknowledged` for
  a wider triage view.
- Existing sort: due-date asc, ransomware-linked tiebreak.

Operators with zero `open` matches see a clean *"All matches handled"*
empty state instead of a wall of resolved CVEs.

### 5. Expiry

- Optional per-row `ExpiresAt` field.
- Use case: `acknowledged` → "I'm patching tomorrow, hide for 24h"; or
  `risk_accepted` → "re-review in 90 days".
- **No Timer sweeper in v1.** The read-time joiner resolves expiry by
  computing `effectiveStatus = expired ? "open" : stored`. The on-disk
  `Status` may be stale (`acknowledged` row that's expired); the SPA
  shows the correct effective state. Phase 2.5 adds a sweeper that
  physically deletes expired rows during a daily timer; until then,
  storage carries some dead-but-harmless state.

### 6. Audit

Each PATCH emits `AIEVENT KevSuppressionChange` with:

- `action`: `"kev-suppression-set"` (create-or-update) | `"kev-suppression-clear"` (delete)
- `tenantId`, `principal` (AAD oid)
- `stackItemId`, `cveID`
- `from`: prior status (or `"open"` when no row existed)
- `to`: new status
- `expiresAt`: optional new expiry (or `null`)

**Not** the chain-hashed audit blob — operator config, mirrors
`TenantSettingsChange` / `StackItemChange` precedents.

### 7. Endpoints

Under `/api/kev/*`:

| Verb | Path | Role | Notes |
|---|---|---|---|
| `PATCH` | `/api/kev/suppressions/{stackItemId}/{cveID}` | admin | Body: `{status, notes?, expiresAt?}`. Upsert. Validates body + path. |
| `DELETE` | `/api/kev/suppressions/{stackItemId}/{cveID}` | admin | Removes the row → effective status reverts to `open`. Idempotent. |

The PATCH path uses URL-segment params (not query) to keep the resource
path canonical and deep-linkable. Path validators reuse
`isValidStackItemId` (UUID v4) + a CVE-ID regex (`^CVE-\d{4}-\d{4,7}$`).

**No GET /api/kev/suppressions** — the data is always returned merged
into `getStackItems.kevMatches[]`; a standalone read endpoint would just
duplicate cache invalidation surface. If a future use case needs the raw
suppressions list (audit export, compliance dashboard), add then.

## Consequences

### Positive

- **/kev becomes a triage queue.** The match list compounds → an action
  surface. "47 open" shrinks as operators work through it.
- **Compliance-friendly.** Five-state distinction supports both
  remediation tracking and risk acceptance with documented owner +
  timestamp.
- **No new MI, no new Graph scopes.** Per-table RBAC mirrors every
  precedent.
- **Read-time join keeps the wire shape stable.** SPA continues to
  consume `kevMatches[]`; the matches just carry richer metadata.
- **Forward-compatible** with Phase 2.5 (deployment baseline) and
  Phase 3 (outbound alerting on new matches added to KEV).

### Negative

- **Three reads per `GET /api/stack/items`** (StackItems + KEV + Suppressions).
  At v1 scale (100 stack items × 1100 CVEs × ~50 suppressions) this is
  still sub-millisecond; documenting for revisit if costs grow.
- **No bulk-status operations in v1.** "Mark all under vendor X as
  not_applicable" requires per-row PATCHes from the SPA. Phase 2.5+ if
  the workload demands.
- **No per-CVE remediation prose tracking.** `notes` is one-shot text,
  not a thread. If operators want a journal per CVE, that's Phase 2.5.

### Neutral

- **Expiry is read-time-only in v1.** Storage carries dead rows until
  Phase 2.5 sweeper. Operationally invisible at the v1 row volume.
- **`not_applicable` is workflow-flavoured, not a fuzzy-match correction.**
  Phase 2.5+ feedback loop could feed `not_applicable` patterns back
  into the matcher's exclusion list, but v1 doesn't.

## Out of scope (Phase 2.5 / 3)

- **Deployment baseline mode** — operator config to pre-acknowledge
  existing matches at first deploy. Backlogged.
- **Timer sweeper** for physical deletion of expired suppression rows.
- **Bulk operations** ("mark all open under vendor X as remediated").
- **Per-CVE comment thread** — replaces single-shot `notes` field.
- **Outbound alerting on new matches** — gated on outbound-integration ADR.
- **Suppression-pattern feedback into the matcher** — `not_applicable`
  history hints at fuzzy-match false positives.

## Trigger to revisit

- Operators routinely use `not_applicable` for the same `(vendor,
  product)` pairs → matcher refinement signal.
- Bulk operation requests → Phase 2.5 bulk endpoint.
- Storage row count climbs into the thousands → Phase 2.5 sweeper.
- First operator asks for "notify me when a new KEV match appears" →
  outbound-integration ADR.

---

**References:**

- ADR-0025 — admin settings page (TenantSettings RowKey + AIEVENT change record).
- ADR-0031 — operator-curated stack inventory (StackItems table + ID validator).
- ADR-0032 — KEV ingest + cross-reference (matcher + read-time join).
