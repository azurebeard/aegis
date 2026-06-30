# ADR-0025 — Admin Settings Page (Phase 1 + 2 + 3)

**Status:** Phase 1 Accepted 2026-04-20 · Phase 2 Accepted 2026-04-20 · Phase 3 Accepted 2026-04-20
**Supersedes:** none (new)
**Related:** ADR-0007 (Easy Auth), ADR-0012 / ADR-0013 / ADR-0020 / ADR-0023 (tile contracts)

## Context

Operators want a dashboard-wide on/off toggle per tile so they can:

- Hide tiles that don't match their tenant's licence (e.g. the EntraRisk tile on a P1 tenant where the licence probe reports `licence_required`).
- Visually declutter for SMB tenants / demos where a signal isn't relevant.

Full admin-settings scope (per HANDOVER §6.3) also includes capability auto-detection, agent-budget sliders, and a brief-agent `userIdentifierStrategy`. This ADR covers **Phase 1** only — tile visibility — so the admin surface lands under ~600 LOC in a single commit. Phases 2 and 3 will amend this ADR or add siblings.

## Decision

### 1. New table: `TenantSettings`

- **Account:** `staegisopsdevweu` (ops table store — same as all other tenant-scoped operational state).
- **Schema for Phase 1:**

  ```text
  PartitionKey  = <tenantId>
  RowKey        = "tile-visibility"
  SecureScore   = bool (default true when row absent)
  Incidents     = bool (default true)
  Brief         = bool (default true)
  RiskyUsers    = bool (default true)
  UpdatedAt     = ISO-8601 UTC
  UpdatedBy     = principal upn or oid (max 256 chars)
  ```

- **Why a flat-column shape, not JSON:** type-check at the storage layer, and deltas are cheap (PATCH = merge on named columns). Phases 2/3 will add additional RowKeys (e.g. `agent-budget`, `user-identifier-strategy`) rather than bolt onto this row — one concern per row, clean partition query.
- **Retention:** unbounded. A tenant has at most a handful of settings rows; they never go stale.
- **Default-when-absent:** all tiles visible. Only missing-row → all true; a row with a mix is the source of truth from then on.

### 2. RBAC

- **Ingest MI** — per-table `Storage Table Data Contributor` on `TenantSettings`. Writes happen from the admin-PATCH handler, which is already gated behind the SWA admin role + Easy Auth SWA-MI binding; the ingest MI is the Function App's established writer identity for ops tables.
- **Api-reader MI** — per-table `Storage Table Data Reader` on `TenantSettings`. Reads served to any authenticated/reader user so the SPA can hide disabled tiles at render time.
- **Agent MI** — no access needed in Phase 1. Phases 2/3 (capability detection, agent budget, identifier strategy) will extend this.

Follows the precedent established by SecureScore / Incidents / EntraRisk / IngestHealth (per-table Contributor scope; no ABAC — row-scope discipline is code-enforced by the handlers that own the writes).

**Row-scope isolation (forward-looking for Phases 2/3).** Phases 2 and 3 will add `capability`, `agent-budget`, and `user-identifier-strategy` RowKeys under the same `TenantSettings` table. The table-scope Contributor granted to the ingest MI today gives it write access to *all* RowKeys in the table — including rows that will later be written by other identities (e.g. agent budget might be written from the agent-code path that currently uses the agent MI). We accept this in Phase 1 because table RBAC cannot express row-level scope; code-enforcement by the handler is the constraint, identical to the `IngestHealth[agent.*]` pattern (WS10 SEC-M-HOTFIX-0420-01 precedent). Before Phase 2 lands, we add an ABAC condition constraining the ingest MI to `RowKey in ('tile-visibility', 'capability')` — exact allow-list rather than prefix-match since the RowKeys don't share a common namespace. Agent MI and api-reader MI get their own per-RowKey grants at the point the writer path actually splits.

### 3. API contract

Two endpoints, both on the root path `/api/settings`:

#### 3.1 `GET /api/settings`

- **Authorisation:** SWA role `authenticated` or `reader` (via SWA route rule, method-scoped).
- **Response (200):**

  ```json
  {
    "tileVisibility": {
      "secureScore": true,
      "incidents": true,
      "brief": true,
      "riskyUsers": true
    },
    "updatedAt": "2026-04-20T09:30:00Z",
    "updatedBy": "bth.priv@picnicdev.onmicrosoft.com"
  }
  ```

- **Absent-row behaviour:** returns the four `true` defaults + `updatedAt: null`, `updatedBy: null`.
- **Cache-Control:** `private, max-age=30` — settings change rarely; 30s avoids hammering the table on every page load, yet the delay is barely perceptible when an admin changes a toggle.

#### 3.2 `PATCH /api/settings`

- **Authorisation:** SWA role `admin` (via SWA route rule, method-scoped).
- **Request body (≤ 1024 bytes):**

  ```json
  {
    "tileVisibility": {
      "secureScore": false
    }
  }
  ```

- **Merge semantics:** partial update. Unknown keys → 400; non-boolean values → 400; unknown tile names → 400. Validated via an explicit allowlist (`secureScore`, `incidents`, `brief`, `riskyUsers`).
- **Response (200):** the full updated settings object, same shape as GET.
- **Side effects:** writes `UpdatedAt = now` + `UpdatedBy = <client-principal-upn>`. Both are audit-relevant — downstream Phase 3 will emit a `TenantSettingsChange` customEvent.
- **Rate limit:** 30/day per tenant, re-using the `ADMIN_RUN_DAILY_LIMIT` shared constant (precedent: all four admin-run endpoints).

### 4. SWA route rules

Two method-scoped entries — required because GET and PATCH have different authorisation:

```json
{ "route": "/api/settings", "methods": ["GET"],   "allowedRoles": ["authenticated", "reader"] }
{ "route": "/api/settings", "methods": ["PATCH"], "allowedRoles": ["admin"] }
```

The existing `/api/*` → `["authenticated", "reader"]` catch-all still applies below these, but the method-scoped rules take precedence (SWA matches the most specific rule first per Microsoft Learn documentation on `staticwebapp.config.json`).

### 5. Web contract

- **New route:** `/admin` (React Router). Admin-role-gated via a `RequireAdmin` wrapper — non-admins redirect to `/` with a flash. Route only appears in the header nav when `useCurrentUser().roles.includes("admin")`.
- **Component:** `AdminSettingsPage` with four `Switch` controls (Fluent UI). Submit button disabled until dirty. Errors render via the existing `ApiError` display pattern.
- **Query hook:** `useAdminSettings()` — React Query, key `["admin", "settings"]`, 30s stale time.
- **Mutation hook:** `useUpdateAdminSettings()` — PATCH, optimistic cache update, rollback on error.
- **Tile visibility wiring:** each populated tile (`SecureScoreTile` / `IncidentsTile` / `BriefTile` / `RiskyUsersTile`) reads `useAdminSettings()` and returns `null` when its flag is `false`. The tile's own data fetch (`useQuery`) is gated with `enabled: visible` so disabled tiles don't burn quota on background polls.

### 6. Audit / telemetry

- **Phase 1:** PATCH emits a `TenantSettingsChange` customEvent with `{action: "tile-visibility-update", changed: ["secureScore", "incidents"], principal: "<upn>"}`. No audit-chain NDJSON write — tile visibility is a UX concern, not an integrity-chain concern.
- **Phase 3+:** will extend with audit-chain writes for agent-budget + identifier-strategy changes (those affect model inputs + spend ceilings, so they're integrity-chain-worthy).

### 7. Out of scope for Phase 1

- ~~Capability detection per tile (P2 probe → auto-disable).~~ **Landed in Phase 2 — see §8 below.**
- Agent budget sliders. Tracked as Phase 3.
- `userIdentifierStrategy` toggle for brief-agent EntraRisk prompting. Tracked as Phase 3.
- Per-user (as opposed to per-tenant) overrides. Not on roadmap.
- Changelog of past settings changes. Emergent from audit-chain once Phase 3 lands.

## Consequences

**Positive.**

- Lands the admin surface under 600 LOC with minimal new architecture.
- Re-uses the existing ingest-MI Contributor pattern + api-reader Reader pattern — no new RBAC primitives.
- Tile visibility is cheap to revert: the default-when-absent-row rule means deleting a settings row reverts to all-visible.
- Paves the way for Phases 2/3 without a schema migration: additional RowKeys under the same PK.

**Negative / constraints.**

- Per-tenant toggles mean one admin's "hide this tile" affects all users of the tenant. Acceptable for v1 (single-operator deployments); revisit if the product ever ships multi-admin tenants where "hide for me" differs from "hide for everyone".
- In-process rate limiter (30/day) for the PATCH endpoint is per-Function-instance, same caveat as the other four admin-run endpoints — same centralised-limiter ADR captures the follow-up.

## References

- HANDOVER §6.3 — "Admin settings page with per-tile on/off + capability/licensing awareness" (driver).
- HANDOVER §10.3 — "Option A — Step 6.1 admin settings page".
- Microsoft Learn — Static Web Apps `staticwebapp.config.json` routes schema (route rules, method-scoped allowedRoles).
- ADR-0011 §5a — per-table RBAC precedent for ops tables.

---

## § 8. Phase 2 amendment — capability detection + auto-hide (2026-04-20)

### 8.1 Drivers

Phase 1 shipped operator-controlled tile visibility but didn't surface **why** a tile might have nothing useful to show. The motivating case is a P1 tenant with the EntraRisk tile enabled: the underlying `/v1.0/identityProtection/riskyUsers` endpoint returns 403 / empty with the distinctive P2-required shape, and ADR-0023 §7 already sets `IngestHealth[graph.security.riskyUsers].Status = "licence_required"` with the sticky-state rule. Without a matching surface on the admin page, the operator has no way to distinguish "intentionally disabled" from "would-be-useful-but-licence-blocked".

### 8.2 Decision — derive capability from `IngestHealth`, not a new table

HANDOVER §6.3 originally posited a dedicated `TenantCapabilities` table (PK=tenantId, RK=capability name). In practice, every capability signal Phase 2 cares about is **already** cached in `IngestHealth.<source>.Status` — the licence probe writes it, the Timer handlers maintain it, and the api-reader MI already has read access across the table (Phase 1 RBAC posture). A new table would be pure duplication.

Phase 2 therefore derives capability at `GET /api/settings` read-time by mapping each tile to its authoritative `IngestHealth` row:

| Tile key     | IngestHealth RowKey              |
|--------------|----------------------------------|
| `secureScore` | `graph.security.secureScores`    |
| `incidents`  | `graph.security.incidents`       |
| `brief`      | `agent.aegis.brief`              |
| `riskyUsers` | `graph.security.riskyUsers`      |

Mapping from `Status` to the API's `TileCapability` enum:

| IngestHealth.Status | TileCapability     |
|---------------------|--------------------|
| `licence_required`  | `licence_required` |
| anything else       | `present`          |
| row missing         | `unknown`          |

No new table; no new RBAC; no new write path. If Phase 3+ wants finer-grained non-licence capabilities (e.g. "Defender P2 required for advanced hunting"), a dedicated table becomes justified — that's a Phase 3 decision, not Phase 2.

### 8.3 Decision — server-derived `effectiveVisibility`

The `GET /api/settings` response now returns three related shapes:

- `tileVisibility` — the stored operator intent (Phase 1 shape, unchanged).
- `tileCapabilities` — per-tile `present | licence_required | unknown` (Phase 2, derived).
- `effectiveVisibility` — what the SPA should actually render: `visibility[k] && capability[k] !== "licence_required"` (derived).

The SPA's HomePage reads `effectiveVisibility` (rather than `tileVisibility`) so a `licence_required` tile is hidden **even if** the operator toggle is on. This gives Picnic Dev (P1 tenant) the "clean dashboard" outcome without operator action, and clearly surfaces the reason on the admin page.

**Why server-derived rather than client-derived:** keeps the capability→effective-visibility mapping policy-as-code in one place, not duplicated across four tiles. Also makes the read path cache-friendly — the SPA trusts a single field, no client-side join.

### 8.4 Admin-page UX

Each tile row in the admin page gains a capability pill next to the toggle:

- `present` → subtle green "Available" pill.
- `licence_required` → amber "Licence required" pill + inline "Learn more" link. When `licence_required`, the toggle is still operator-changeable (the row is written as usual on PATCH), but a "Currently hidden — licence not present on tenant" label makes clear the toggle has no effect on rendering until the underlying capability becomes `present`.
- `unknown` → neutral "Not probed yet" pill (fresh tenant before the first Timer fire).

The operator can still toggle a `licence_required` tile to `false` explicitly — the PATCH writes as before, but `effectiveVisibility[k]` stays false regardless.

### 8.5 Authorisation

No new RBAC grants, no new writer paths, no schema delta.

Capability derivation reads from `IngestHealth`:

- **GET `/api/settings`** — api-reader MI (existing tableService-scope Reader).
- **PATCH `/api/ingest/settings`** — ingest MI (existing per-table Contributor on `IngestHealth` implies read). Both identities are legitimate readers under the RBAC posture established in ADR-0006 + ADR-0011 §5a; neither path exposes a new scope.

### 8.6 Out of scope for Phase 2

- Explicit "show me the licence-required empty state anyway" override for debugging. Not a real operator need.
- Non-licence capability signals (e.g. "Defender XDR not licensed"). Phase 3+ will revisit if the product gains tile verticals that need finer-grained detection.
- Client-side caching of capability state separate from visibility. Same React Query cache key; capability changes propagate with the next settings refetch (30s stale time).

### 8.7 Consequences

**Positive.**

- Zero schema / RBAC delta. Leverages ADR-0023's existing sticky-state probe.
- Operator-facing answer to "why is EntraRisk hidden?" lands on the admin page where the toggle already is.
- Auto-hide is the default behaviour on licence-blocked tiles — no operator action required to get the "clean dashboard on P1" outcome.

**Negative / constraints.**

- Capability freshness is bounded by Timer cadence. RiskyUsers Timer fires every 4h; a tenant that just upgraded to P2 waits up to 4h (or an admin Refresh-now click) before the admin page reflects `present`. Acceptable for v1.
- Tight coupling between `TileKey` and `IngestHealth` source names — documented in §8.2 so a future rename can grep both surfaces.

---

## § 9. Phase 3 amendment — agent-budget overrides + userIdentifierStrategy (2026-04-20)

### 9.1 Drivers

Two operator-controlled knobs belong to the admin surface, not an app setting:

1. **Brief-agent budget ceilings.** Today the manual-run ceiling (default 30/day) and token budget (default 200K/day) are env vars on the Function App — every change needs `azd provision`. An operator tuning spend against a short experiment or a demo can't adjust without a redeploy.
2. **EntraRisk `userIdentifierStrategy`.** ADR-0020 Step-6 amendment locked the brief-agent's EntraRisk prompt context to `objectId` for zero-PII reasons; the SPA joins client-side. Some operators (SMB tenants where the admin knows every user by name; demo tenants; regulated deployments) want `partial_mask` or `display_name` instead — a per-tenant policy, set once, not a per-brief choice.

### 9.2 Data model — two new RowKeys on `TenantSettings`

Following the one-concern-per-row pattern established in Phase 1 §1:

```text
PartitionKey = <tenantId>, RowKey = "agent-budget"
  BriefManualRunCeiling  : int   (1–100)
  BriefDailyTokenBudget  : int   (50,000–500,000)
  UpdatedAt              : ISO-8601 UTC
  UpdatedBy              : principal upn or oid (max 256 chars)

PartitionKey = <tenantId>, RowKey = "user-identifier-strategy"
  Strategy  : string  enum ("objectId" | "partial_mask" | "display_name")
  UpdatedAt : ISO-8601 UTC
  UpdatedBy : principal upn or oid (max 256 chars)
```

**Default-when-absent:**

- Agent budget → fall back to env vars `BRIEF_DAILY_MANUAL_RUN_CEILING` + `BRIEF_DAILY_TOKEN_BUDGET` (current 30 + 200,000). The row is pure override — deleting it reverts to env.
- User identifier strategy → `"objectId"` (privacy-by-default, matches ADR-0020 Step-6).

### 9.3 Value ranges + validation

| Field | Min | Max | Rationale |
|-------|-----|-----|-----------|
| `BriefManualRunCeiling` | 1 | 100 | Below 1 disables admin refresh entirely — infeasible to recover from. 100 is 3× the default and covers demo-heavy days; above that a centralised-limiter ADR is the right answer. |
| `BriefDailyTokenBudget` | 50,000 | 500,000 | Default 200K already covers ~300 runs. 50K floor ≈ 75 runs (safety margin). 500K ceiling bounds a runaway admin to ~£2.50/day on `aegis-small` prices — well inside the £25/mo dev budget alert. |

Both values are validated at the PATCH handler before storage. Out-of-range → 400. Non-integer → 400.

`Strategy` is validated against a string allowlist: `["objectId", "partial_mask", "display_name"]`. Anything else → 400.

### 9.4 API contract deltas

#### GET `/api/settings` response

Response shape extended with two optional fields (same Phase-2-fallback pattern — old clients ignore):

```json
{
  "tileVisibility": { ... },
  "tileCapabilities": { ... },
  "effectiveVisibility": { ... },
  "agentBudget": {
    "briefManualRunCeiling": 30,
    "briefDailyTokenBudget": 200000,
    "updatedAt": null,
    "updatedBy": null,
    "source": "default" | "tenant"
  },
  "userIdentifierStrategy": {
    "strategy": "objectId",
    "updatedAt": null,
    "updatedBy": null,
    "source": "default" | "tenant"
  },
  "updatedAt": "...",
  "updatedBy": "..."
}
```

The per-section `source` field distinguishes env-default from operator-set. Admin page renders a "Using defaults" label when `source: "default"`.

#### PATCH `/api/ingest/settings` body

Validator extended to accept any subset of the three concerns in a single PATCH body:

```json
{
  "tileVisibility": { "secureScore": false },
  "agentBudget": { "briefManualRunCeiling": 50 },
  "userIdentifierStrategy": { "strategy": "display_name" }
}
```

Each concern is routed to its own upsert under the appropriate RowKey. Empty top-level `tileVisibility` is still rejected (Phase 1 contract); empty `agentBudget` or `userIdentifierStrategy` are likewise rejected. Mixed concerns in one PATCH are allowed — the rate limiter counts one request, not three.

### 9.5 Runtime override — brief-agent read path

`runBriefAgent.ts` gains a single TenantSettings read at the top of the handler (before `reserveTokens`):

1. Load `agent-budget` row → if present, pass `briefManualRunCeiling` + `briefDailyTokenBudget` overrides into `reserveTokens`. If absent, reserveTokens uses env defaults (unchanged behaviour).
2. Load `user-identifier-strategy` row → if present, pass the strategy into `readRiskyUsersForBrief`. `readRiskyUsersForBrief` projects the stored row to the appropriate shape before the data reaches the prompt builder.

**Why read at brief-agent boot rather than at reserveTokens call site:** one read per brief run is trivial; threading the value through callers is the cleanest change. Both reads use the agent MI's existing table-service-scope Reader role — no new RBAC.

### 9.6 userIdentifierStrategy — projection rules

```text
strategy=objectId        → { id }                                 (Step-6 default)
strategy=partial_mask    → { id, displayNameMasked: "J*** D**" }
strategy=display_name    → { id, displayName: "Jane Doe" }
```

Masking rule (deterministic, simple): split on whitespace; for each token, keep the first unicode character, replace the remainder with `*` repeated to a fixed 3-char length (so `"J"` → `"J***"`, `"Ji"` → `"J***"`, `"Jin"` → `"J***"`, `"Jane"` → `"J***"`). Joins with single space. Tokens shorter than 1 char skipped. This keeps every mask the same length regardless of name length — avoids leaking name length as a side channel.

The projected field name is deliberately `displayNameMasked` (not `displayName`) when `strategy=partial_mask` — the prompt builder can then branch on the presence of either field rather than needing a matching strategy value.

**Attacker model + defence-in-depth (WS10 SEC-L-ADR25-P3-01).** `display_name` opts the operator into sending the tenant's `UserDisplayName` (Entra-authoritative) into the model prompt. The existing four-layer defence (ADR-0020 §four-layer defence: cap → control-char strip → denylist → fence) wraps the full `JSON.stringify(rows)` block, so a hostile `UserDisplayName` is inspected as part of the fenced block. Two caveats:

1. The denylist (`promptInjectionDenylist.ts`) is explicitly a **fail-open** defence ("a fail-closed defence-in-depth, not a complete classifier"). A crafted `UserDisplayName` that avoids every denylist pattern would land fenced inside `<context>` — the system prompt instructs the model to distrust content there, but this is probabilistic, not guaranteed.
2. Poisoning `UserDisplayName` in the tenant requires Graph `User.ReadWrite.All` (or similar high-privilege AAD role). An attacker with that privilege already has a larger blast radius than prompt injection — the risk is bounded by the attacker's existing Entra control.

Therefore: `display_name` is an operator-acknowledged risk relaxation. `objectId` (default) and `partial_mask` do not land the raw user-provided string in the prompt. Operators picking `display_name` explicitly accept the layer-3-denylist-reliant defence posture. Tracked as a Phase-3+ hardening option: screen `UserDisplayName` field-level before `JSON.stringify` so a bad name fails the block rather than dropping the whole `riskyUsers.recent` source.

### 9.7 RBAC + the ABAC promise from Phase 1

Phase 1 §2 promised an ABAC condition on the ingest MI's Contributor role before Phase 2 added new RowKeys. Phase 2 didn't add RowKeys (capability is derived). Phase 3 **does** add two new RowKeys (`agent-budget`, `user-identifier-strategy`).

**Attempted approach:** the ABAC condition we wanted to land was:

```text
@Request[Microsoft.Storage/storageAccounts/tableServices/tables/entities:rowKey]
StringEqualsIgnoreCase { 'tile-visibility', 'agent-budget', 'user-identifier-strategy' }
```

**Decision: code-enforced row scope, not ABAC.** Pitfall 15 already captured that Azure Storage ABAC support on Table Storage is narrow — the `:name` attribute on the table path isn't supported, and write-action row-scope conditions on `…/tableServices/tables/entities/write` have variable preview status across regions. Shipping an ABAC condition today risks a silent "condition evaluates to false on unrelated writes" regression with no observable path back.

The row-scope discipline is therefore **code-enforced**, identical to the `IngestHealth[agent.*]` pattern established in ADR-0019 and accepted by WS10 as SEC-M-HOTFIX-0420-01. Every writer path for TenantSettings goes through `patchSettings.ts` → one of the three `upsert*` functions in `tenantSettingsStore.ts`, each of which writes exactly one RowKey (`tile-visibility` / `agent-budget` / `user-identifier-strategy`). Any future PR that introduces a new writer path touches this file and hits the WS10 RBAC-change review.

**Amendment (2026-04-20 Option D investigation):** Microsoft Learn confirms Azure Storage ABAC is supported on Blob / Data Lake / Queue data actions only — Table Storage has no ABAC surface in GA or preview. Attempting `@Resource[...entities:RowKey] ...` on a table role assignment is ambient fail-open (conditions on unsupported actions pass through as if absent — zero security benefit). Code-enforcement is therefore the permanent control, not a stopgap. Revisit trigger: an Azure Updates announcement for Table Storage ABAC preview. HANDOVER §6.3 carries the full investigation record + source links.

### 9.8 Admin-page UX

Three Card sections on `/admin`:

1. **Tile visibility** (existing from Phase 1 + 2) — unchanged layout.
2. **Agent budget** (new) — two Fluent UI sliders with integer value displays and min/max labels, plus a "Reset to defaults" button that clears the row. "Using defaults" label when `source=default`.
3. **Brief agent — EntraRisk user identifier** (new) — Radio group with three options, short explanatory copy next to each. "Using defaults" label when `source=default`.

Each section has its own Save / Discard pair; dirty-tracking is per-section. A successful PATCH updates only the edited section; the other two stay as-returned.

### 9.9 Audit / telemetry

`patchSettings.ts` already emits `TenantSettingsChange` for tile-visibility changes. Extended to include:

- `action: "agent-budget-update"` with `changed: ["briefManualRunCeiling", "briefDailyTokenBudget"]`.
- `action: "user-identifier-strategy-update"` with `from` + `to` values.

No audit-chain write for v3 (same rationale as Phase 1 §6 — these are UX/policy choices, not integrity-chain-worthy). Can revisit if a later compliance requirement demands it.

### 9.10 Out of scope for Phase 3

- Per-agent budget (`posture-agent`, `incidents-agent` when Phase 7 multi-agent lands) — single `agent-budget` row covers brief only today; Phase 7 will add `agent-budget-<name>` or similar.
- `userIdentifierStrategy` for ingest paths or non-brief agents — brief-agent is the only LLM consumer of the EntraRisk shape; other verticals get raw data (SPA-side join handles display).
- Changelog of past budget / strategy changes. Already out-of-scope per §7; Phase 3 doesn't change that.

### 9.11 Consequences

**Positive.**

- Operator can tune brief spend without a redeploy — closes the §10.3 budget-control asymmetry.
- `userIdentifierStrategy` lets privacy-sensitive operators stay on `objectId` (Step-6 default) while SMB / demo operators opt into `display_name` with explicit audit. No per-brief toggle, no per-user preference — tenant-wide policy.
- ABAC condition on the ingest MI lands as promised in Phase 1 §2 — no further drift.

**Negative / constraints.**

- Agent-budget changes take effect on the next brief run (not retroactively). A mid-day change leaves earlier runs on the old budget. Acceptable — budgets are daily windows anyway.
- `userIdentifierStrategy` change doesn't re-run prior briefs. Operators who flip to `display_name` see the new identifier from the next daily brief, not on today's cached one. Admin Refresh-now button forces a re-run.
