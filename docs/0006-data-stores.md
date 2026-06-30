# ADR-0006 — Data stores

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

XDR Hub has three distinct data concerns (brief §4), each with different durability, query, retention, and cost requirements:

1. **Operational state** — dashboard data, ingested signals, approvals, manual tasks, per-agent run metadata. Read-heavy from the dashboard; written by scheduled ingestion Functions and by agent-mediated writes via the API layer. Query patterns are predominantly point lookups and short range scans by partition.
2. **Audit log** — every agent decision, autonomous surface update, and suggest-and-approve action. Append-only, immutable, retention-governed.
3. **Agent conversation memory** — short-term per-session state for Foundry agents (ADR-0005).

The brief (§4, §14 item 1) commits to Table Storage, Blob with immutable WORM policy, and Foundry threads respectively. This ADR ratifies those commitments and records the schema shape, access paths, and retention rules that downstream Bicep (ADR-0004), Functions (ADR-0002), and agent code (ADR-0005) depend on.

## Decision

### Operational state — Azure Table Storage

One storage account `staegisops<env><region>` (per ADR-0001) with one table per domain:

| Table | Purpose | PartitionKey | RowKey |
|---|---|---|---|
| `SecureScore` | Tenant secure score snapshots over time | `<tenantId>` | `<ISO-8601-snapshot-timestamp>` |
| `Incidents` | Defender XDR incidents | `<tenantId>` | `<incidentId>` |
| `EntraRisk` | Entra risk detections | `<tenantId>` | `<detectionId>` |
| `CAPolicies` | Conditional Access policy snapshots and coverage | `<tenantId>` | `<policyId>` |
| `StackItems` | User-declared tech-stack items | `<tenantId>` | `<itemId>` |
| `KEVMatches` | Tech-stack ↔ CISA KEV match results | `<tenantId>` | `<kevId>-<itemId>` |
| `ApprovalDecisions` | Tier 2 approve and reject records | `<tenantId>` | `<decisionId>` |
| `ManualTasks` | Tier 3 user-authored tasks and notes | `<tenantId>` | `<taskId>` |
| `AgentRuns` | Per-agent invocation metadata (tokens, duration, correlation) | `<agentName>` | `<runId>` |
| `IngestHealth` | Per-source ingest health (status, consecutive failures, last run, audit seq). Added 2026-04-18 by ADR-0011 §5a — ingest-written, API-read, **never user-writable**. See ADR-0011 for the column list. | `<tenantId>` | `<source>` (e.g. `graph.security.secureScores`) |

Schema conventions:

- `tenantId` in the partition key guarantees that tenant-scoped queries hit a single partition.
- Time-series tables (e.g. `SecureScore`) use a RowKey format that supports reverse-chronological retrieval where that is the dominant access pattern; exact encoding decided per-table at implementation and documented in `/infra/modules/storage.bicep` comments.
- Every row carries `CreatedUtc`, `UpdatedUtc`, and a `SchemaVersion` integer. Migrations increment `SchemaVersion`; readers must tolerate older versions until the migration completes.

Access control:

- The ingestion Functions' Managed Identity has Storage Table Data Contributor on the specific tables it writes, no broader.
- The API layer's Managed Identity has Storage Table Data Reader on every table and Storage Table Data Contributor on `ApprovalDecisions` and `ManualTasks` only.
- `IngestHealth` is writable **only** from ingest code paths (Timer-triggered handlers) and readable by the API layer. No end-user request path writes to this table. The separation is **identity-level + code-level**, not per-table RBAC: the ingest MI (`id-aegis-ingest-<env>-<region>`, ADR-0011 §5a) is the Function App identity wired into Timer handlers and carries the Graph app role (ADR-0010); the api-reader MI is wired into HTTP handlers and carries Reader-class permissions. Azure Table Storage does not express per-table Contributor scoping without ABAC conditions; a future ABAC pass can tighten to table-scoped Contributor if tenant posture warrants it, but identity separation + the code-level convention that no HTTP handler names `IngestHealth` in a write operation is the v1 boundary. See ADR-0011 §5a for rationale.
- No user principal has direct access; all reads and writes go through the API layer.

### Audit log — Blob Storage with immutability policy (WORM)

One storage account `staegisaudit<env><region>` (per ADR-0001), one container `audit`, one **append blob** per calendar day per source:

- Path: `audit/<yyyy>/<mm>/<dd>/<source>.ndjson`
- **Blob type: Append blob.** Append blobs accept `AppendBlock` operations under a locked time-based retention policy without unlocking the policy; delete and overwrite remain blocked for the life of the retention period. This is the only storage pattern that gives genuine write-once audit within the active day; a generic block blob with an unlocked-then-locked policy leaves a 24-hour window during which audit evidence is mutable and is therefore not used.
- Format: newline-delimited JSON, one event per line.
- Required event fields: `timestamp`, `correlationId`, `actor` (user principal or agent name), `action`, `inputs`, `outputs`, `schemaVersion`.

Immutability:

- Time-based retention policy with **default 365 days**, configurable per deployment via a Bicep parameter.
- Policy is **locked at container creation** by Bicep (equivalent to `az storage container immutability-policy create --policy-mode Locked`) and is **never unlocked** during normal operation. No day-rollover unlock-and-relock mechanism exists or is permitted.
- Legal-hold capability is retained for incident-response scenarios and is unused by default.

Write path:

- Only Functions with a specific user-assigned Managed Identity (`id-aegis-audit-<env>-<region>`) may write to the audit container. The RBAC role granted is **Storage Blob Data Contributor scoped to the audit container only**, not to the storage account.
- The audit-writer Function batches events in memory for up to 60 seconds, then calls `AppendBlock` against the current day's append blob. Crash-safe on next tick.
- Audit writes never block the calling operation; failures are surfaced to App Insights and retried with exponential backoff.

### Agent conversation memory — Foundry threads

- Native Foundry Agent Service threads, per ADR-0005.
- No custom conversation store in v1.
- Thread IDs are persisted against the user's session (Easy Auth token) and correlated into the audit log via the standard `correlationId` field.

### Explicitly NOT a v1 store

- Cosmos DB (any API).
- Azure SQL Database.
- Azure AI Search (roadmap per brief §4; v1 uses blob + flat JSON knowledge index).
- Redis (considered for LLM response caching under brief §5 — out of v1 unless a measured performance need emerges).

Introducing any of these requires a new or superseding ADR.

### Upgrade and migration

- Ops and audit storage accounts are marked with Bicep `PreserveResource` and resource-level delete locks (brief §10). Upgrades never recreate these accounts.
- Schema migrations are **additive**. Dropping or renaming fields requires a numbered migration under `/infra/migrations/<version>/` with a dual-read window of at least one release.
- A migration that changes `PartitionKey` or `RowKey` requires writing to a new table name and a cut-over window; Table Storage does not support in-place re-keying.

### Re-evaluation triggers

The Table Storage choice is deliberate for v1 and is explicitly reopenable. A superseding ADR moving the ops store to Azure SQL Database Serverless (or Cosmos DB Table API) MUST be raised when any of these fires:

1. **Two or more cross-table joins become load-bearing in the dashboard.** Denormalised shadow tables are cheap up to about one pair; beyond that, application-code joins become the expensive path and relational SQL starts to pay for itself.
2. **A schema change requires renaming or re-typing a `PartitionKey` or `RowKey` on any table.** Table Storage does not support in-place re-keying; the second such migration within a release cycle is comparable in cost to a one-shot move to SQL.
3. **Ad-hoc reporting, aggregations, or export features are added to scope.** Table Storage's lack of secondary indexes and aggregations makes these either slow or duplicative (materialised views in application code).
4. **The < £25/month cost target in brief §11 is relaxed or removed.** The primary argument for Table Storage over SQL Serverless is cost at idle; if the target moves, the trade-off moves with it.

Data volumes at v1 scale (single-tenant, thousands of rows per table) make a one-shot Table → SQL migration a script, not a project. The intent is to defer that script until a trigger above fires, not to avoid it indefinitely. Trigger 1 or 3 firing twice in the same release cycle should be treated as equivalent to any of the other three.

## Consequences

### Positive

- **Table Storage is cheap** — far below Cosmos DB's baseline cost, which directly supports the < £25/month tenant target (brief §11).
- **Partition-keyed access is the dominant pattern**; Table Storage serves this natively without paying for query capabilities the dashboard does not use.
- **WORM audit** gives a defensible compliance posture at effectively zero operator burden — immutability is a storage-account feature, not application code to maintain.
- **Foundry-native thread memory** removes an entire subsystem from v1 scope.
- **Access-control boundaries mirror the data classes** — ingestion, API, and audit-writer identities each have exactly the rights they need.

### Negative / trade-offs

- **Cross-partition queries are expensive in Table Storage.** "Across all tenants" queries are not supported; this is acceptable because each deployment is single-tenant (brief §1).
- **No secondary indexes in Table Storage.** Any query the schema does not directly support is either a denormalised second table or a migration to Cosmos. The table list above has been designed against the known v1 dashboard access patterns; unknown access patterns will surface an explicit ADR.
- **WORM complicates testing.** Test environments use shorter retention (e.g. 1 day) and an unlocked policy; Bicep parameters gate production-vs-test behaviour. Tests that need to verify write-once semantics run against a disposable test container.
- **Foundry thread portability.** Moving away from Foundry Agent Service (the trade-off flagged in ADR-0005) would require rebuilding short-term memory. Accepted alongside the agent-platform decision.

### Neutral

- Migrating any single domain from Table Storage to Cosmos is an additive migration, not a rewrite, because the schema is designed around keyed access rather than query flexibility.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| Cosmos DB (Table API) as the ops store | Higher baseline cost (RU reservations) without a query pattern in v1 that benefits from it. Reconsidered only if cross-partition queries become load-bearing. |
| Cosmos DB (SQL API) | Strictly more capable and more expensive; v1 does not need document-style queries or SQL. |
| Azure SQL Database | Relational is overkill for point-lookup, append-heavy ingestion. Introduces connection management and backup concerns Table Storage avoids. |
| Single storage account for ops plus audit | Conflates access controls (the identity that writes ops should not be able to write audit) and retention policies (WORM on ops would be wrong). Two accounts is clearer and cheaper than the alternative of careful RBAC on one account. |
| Log Analytics or a custom KQL table for audit | Loses tamper-evidence guarantees; Log Analytics is optimised for query, not for immutability. Log Analytics remains in scope for telemetry via App Insights, not for the audit-of-record. |
| Custom conversation store for agent memory | Duplicates Foundry threads. Only justified if a v1 requirement appeared for cross-session replay — none has. |

## Related

- `PROJECT_BRIEF.md` §4 — Data and memory model
- `PROJECT_BRIEF.md` §5 — Deterministic first, LLM last (dashboard reads from the ops store, not Graph APIs)
- `PROJECT_BRIEF.md` §9 — Security posture (Managed Identity, Key Vault, audit retention, private endpoints)
- `PROJECT_BRIEF.md` §10 — Deployment and versioning (upgrade-safe storage)
- `PROJECT_BRIEF.md` §11 — Observability and cost controls (< £25/month target)
- `PROJECT_BRIEF.md` §14 item 1 — Open decision: Table Storage vs Cosmos DB
- ADR-0001 — Codename and repo identity (storage account and resource naming)
- ADR-0002 — API runtime language (TypeScript Functions read and write the ops store)
- ADR-0004 — Hosting plan (Functions on Flex Consumption are the exclusive writers)
- ADR-0005 — Agent orchestration (specialists read the ops store via Function-backed tools; agent runs emit audit events)

---

## Amendments

| Date | Author | Change | Driven by |
|---|---|---|---|
| 2026-04-18 | Ben Thomas | Added `IngestHealth` table to the operational-state catalogue; documented identity-level + code-level separation between ingest-write and API-read paths. A dedicated ingest MI (ADR-0011 §5a) is the Function App identity for Timer handlers. Additive change only — no existing schema altered; no per-table Azure RBAC claim (Table Storage lacks that scoping without ABAC). | ADR-0011 §5a (first vertical — Secure Score ingestion); WS10 finding SEC-M-ADR-11-01 (data-classification separation). |
| 2026-04-18 | Ben Thomas | **`SecureScore.ControlScores` property stored as `description`-stripped JSON.** Azure Table Storage enforces a 64 KB per-property cap (≤ 32K UTF-16 characters). Microsoft-authored `controlScores[].description` prose across ~100 controls pushes the stringified array past that cap on real tenants. `api/src/lib/tables.ts` emits only `{controlCategory, controlName, score}` per control; descriptions are intentionally not persisted. ADR-0012 §5 already commits to plain-text-only rendering and the `/web/src/features/secureScore` ESLint `react/no-danger` gate prevents any HTML injection path for this field, so dropping descriptions at the storage layer changes no tile behaviour. Read-back path backfills `description: ""` so the internal `SecureScoreSnapshot` type remains consistent for every consumer. A future details view that needs descriptions should fetch them lazily from Graph or stage per-control blob entries. | Live deploy 2026-04-18: first real Graph response returned `{odata.error: PropertyValueTooLarge}` on the first `InsertOrReplace`. |
| 2026-04-18 | Ben Thomas | **Per-table Contributor scope replaces ABAC on `tableServices`.** The ADR-0011 §5a implementation initially used a `Storage Table Data Contributor` assignment at the Table service scope with an ABAC condition filtering `@Resource[...tableServices/tables:name]` to `{SecureScore, IngestHealth}`. Azure RBAC rejected the condition at deployment validation: `InvalidRoleAssignmentCondition: Resource attribute Microsoft.Storage/storageAccounts/tableServices/tables:name is not valid`. Azure Storage does not expose `:name` as an ABAC attribute on tables in the current API version. Replaced with two per-table-scoped role assignments (one on `SecureScore`, one on `IngestHealth`) — strictly narrower than the ABAC version would have been. Reads remain unrestricted via a tableService-scoped Reader role on the api-reader MI. | Live deploy 2026-04-18: initial Bicep apply failed with the InvalidRoleAssignmentCondition error above. |
