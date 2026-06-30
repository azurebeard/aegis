# ADR-0030 — Reports + snapshot contract

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Aegis surfaces real-time posture today through the dashboard tiles (Secure Score, Incidents, EntraRisk) and the AI-narrative surfaces (Daily Brief, Weekly Posture). Operators consume these *interactively* — they sign in, they look, they refresh. The next reporting layer is **periodic, durable, and shareable**: a CISO or board needs *"what did our security posture look like for week 17 / April / Q2"* as a single artefact, signed-off, available later for audit.

Operator brainstorm (2026-04-28 conversation) settled on a phased approach:

- **Phase A (this ADR):** A `/reports` SPA route renders the *current* period's posture as a single scrollable, print-friendly page reusing existing query data. An admin can "Capture period" — a server-side snapshot stored as a JSON envelope in a new `ReportSnapshots` table. The snapshot is permalink-addressable (`/reports?period=2026-W17`) and renders historical state.
- **Phase B (deferred):** Timer-triggered auto-capture on the operator-defined cadence.
- **Phase C (deferred):** Email delivery via Graph `mail.send`. The Phase A print-friendly CSS doubles as the email-body template.
- **Phase D (deferred):** Server-side PDF render via headless browser (Playwright in a Function) for "true PDF in the inbox".
- **Phase E (deferred):** Webhook fan-out (post snapshot URL to Teams etc.) — gated on the broader outbound-integration ADR.

This ADR settles Phase A only. The phased shape is documented so Phase A's contracts are forward-compatible: future phases extend, not break.

The concerns this ADR settles:

1. **What lives in a snapshot** — the bounded section set + their wire shapes.
2. **Period-key format** — how a "report period" is named and addressed.
3. **Storage topology** — which Table, what RBAC, what retention.
4. **Idempotency under re-capture** — overwrite vs. version.
5. **Audit-chain integration** — does capture write an audit line, and which chain does it extend.
6. **Read gate** — who can read live vs. historical reports.
7. **AI-summarisation surface** — explicitly out of Phase A.

## Decision

### 1. Snapshot envelope — versioned, content-typed

```json
{
  "schemaVersion": 1,
  "contentType":  "application/json",
  "tenantId":     "<guid>",
  "periodKey":    "2026-W17",
  "periodCadence":"weekly",
  "periodStart":  "2026-04-20T00:00:00Z",
  "periodEnd":    "2026-04-26T23:59:59.999Z",
  "capturedAt":   "2026-04-28T11:42:08.123Z",
  "capturedBy":   "<aad-object-id of admin>",
  "version":      3,
  "sections": {
    "secureScore":  { /* SecureScoreLatestResponse + trend (existing wire shape) */ },
    "incidents":    { /* IncidentsCounts + 30-day trends (existing wire shapes) */ },
    "entraRisk":    { /* RiskyUsersSummaryResponse (existing wire shape) */ },
    "brief":        { /* latest BriefResponse body or null */ },
    "posture":      { /* latest PostureResponse narrative or null */ },
    "ingestHealth": { /* per-source: status + last-success + last-failure */ }
  },
  "derived": {}
}
```

**Section shapes are the EXISTING wire types, verbatim.** Every section either points at a wire shape already exposed by an `/api/*/latest` endpoint, or a thin projection over one. This keeps the snapshot a *cache of the dashboard's source data*, not a parallel schema. Future phases (KEV cross-reference, news summary, cost figures) extend `sections` additively without bumping `schemaVersion`. Removing or reshaping a section requires a `schemaVersion` bump and a migration plan for older blobs.

The five v1 sections + `ingestHealth` summary match the operator-confirmed v1 content (2026-04-28 conversation).

**v1 captures the live state at `capturedAt`, not period-bounded aggregations.** The envelope carries `periodKey` / `periodStart` / `periodEnd` so the board sees *"week 17, captured 2026-04-28"*, but the section data is "as of `capturedAt`". Period-bounded aggregations ("47 incidents in Q2") are a Phase B candidate that walks the audit chain or runs a period-scoped query; out of scope today. This trade-off keeps Phase A's surface mechanical (reuse existing readers) and avoids a parallel aggregation pipeline.

**`contentType` field — explicit, not assumed.** v1 stores the canonical envelope as `application/json` (gzipped+base64-encoded into the Table column per §4). Phase C/D adds rendered formats — HTML for email body, PDF for board attachment. The `derived` map (empty in v1) becomes the addressing surface for those:

```json
"derived": {
  "text/html":        "blob:report-snapshots/<tenantId>/<periodKey>_<capturedAt>.html",
  "application/pdf":  "blob:report-snapshots/<tenantId>/<periodKey>_<capturedAt>.pdf"
}
```

The canonical row stays `application/json` — the renderable source of truth — and binary derivatives live alongside in a future `report-snapshots` blob container. No row-shape change is needed when those land; the `derived` map is open. Out of scope for Phase A; documented here so the contract doesn't paint a JSON-only corner.

**`version` field — monotonic per period.** See §5 for re-capture semantics.

### 2. Period-key format

Three accepted forms, matched against operator-set `reportCadence` (TenantSettings):

| Cadence | Key format | Example | Notes |
|---|---|---|---|
| `weekly` | `YYYY-Www` (ISO 8601 week) | `2026-W17` | Same keying as posture-agent — already in use |
| `monthly` | `YYYY-MM` | `2026-04` | UTC calendar month |
| `quarterly` | `YYYY-Qn` | `2026-Q2` | Calendar Q1=Jan–Mar |

The period key is the RowKey on the `ReportSnapshots` table — Table Storage RowKey constraints (no `/`, `\`, `#`, `?`, control chars) are satisfied by all three forms. Server validates `periodKey` against the cadence-derived regex on capture; mismatches return 400.

### 3. Storage topology

**Table:** `ReportSnapshots` on the existing ops storage account.

| Column | Type | Notes |
|---|---|---|
| `PartitionKey` | string | `tenantId` (matches the existing per-tenant partitioning across the ops tables) |
| `RowKey` | string | `<periodKey>_<capturedAt>` — see §5. ISO-8601 timestamps lex-sort chronologically, so `startsWith("<periodKey>_")` returns all versions for a period in capture order. |
| `SchemaVersion` | int | `1` |
| `ContentType` | string | `application/json` for v1. Future formats may add sibling rows; see §1 `derived` map. |
| `Cadence` | string | `weekly` \| `monthly` \| `quarterly` |
| `PeriodKey` | string | Duplicated from RowKey for query convenience (avoids parsing). |
| `PeriodStart` | string | ISO-8601 UTC |
| `PeriodEnd` | string | ISO-8601 UTC |
| `CapturedAt` | string | ISO-8601 UTC |
| `CapturedBy` | string | Capturing admin's AAD object ID |
| `Version` | int | Monotonic per period (see §5). 1, 2, 3, … |
| `Envelope` | string | The encoded envelope (gzipped + base64; see §4) |
| `EnvelopeBytes` | int | Pre-compression size (telemetry only) |

**RBAC:**

- Ingest MI: `Storage Table Data Contributor` scoped to the table resource ID — writes envelopes during capture. The capture handler authenticates with `ingestConfig.ingestMiClientId`, mirroring the precedent set by `patchSettings.ts` (admin-triggered writes from an API handler use the ingest MI rather than widening api-reader scope).
- Api-reader MI: `Storage Table Data Reader` scoped to the table — read for `/reports?period=…`.
- Agent MI: nothing in v1. Future phase that summarises a period via the agent plane will widen RBAC then; explicitly closed today.

Per-table scoped role assignments per the established pattern (HANDOVER §6.3 — Table Storage ABAC unavailable).

**Retention:** Two configurable axes, both with floor enforcement and a documented production recommendation.

| Setting | Env var | v1 default | Floor | Production recommendation |
|---|---|---|---|---|
| Versions kept per period | `REPORT_SNAPSHOT_VERSIONS_PER_PERIOD` | `3` | `3` (enforced — values < 3 reject at config load) | `3` for active operations; `5+` if attestation requires multiple intra-period captures |
| Maximum age of any snapshot | `REPORT_SNAPSHOT_RETENTION_DAYS` | `2555` (7 years) | `30` | `2555` (covers Cyber Essentials Plus + NIS2 + UK GDPR audit horizons) |

Versions-per-period trim runs synchronously at capture time: after writing version N+1, oldest versions for that `(tenantId, periodKey)` are deleted until total ≤ `REPORT_SNAPSHOT_VERSIONS_PER_PERIOD`. Each delete emits its own `audit.report.trim` line so the chain reflects the deletion (mirroring the `retentionRowsDeleted` pattern on Secure Score ingest).

Age-based trim (`REPORT_SNAPSHOT_RETENTION_DAYS`) is **not enforced in v1** — Phase B sweeper. Documented here so operators can set the env var ahead of the sweeper landing without re-deploying. The minimum-3-versions floor protects against an operator accidentally setting `0` or `1` and losing all forensic capture history.

Production deployments should set both env vars explicitly via Bicep parameter rather than relying on defaults; the operator-decision surface is captured in `infra/main.parameters.json` alongside other tenant-tunable defaults.

### 4. Envelope size + compression

Table Storage caps a single property at 64 KB. The envelope is mostly small numbers + ~10 KB of brief/posture prose. Worst-case (a busy month with 200 incidents + a long posture narrative) could approach the cap. Compression strategy:

- Pre-`JSON.stringify`, gzip with default level. If compressed bytes ≤ 32 KB, store base64 in `Envelope`. If 32 KB < compressed ≤ 60 KB, store base64 in `Envelope` (still fits — 60 KB compressed leaves headroom for entity overhead).
- If compressed > 60 KB (extreme outlier), capture fails with 413 + an `audit.report.capture` line of `status=size_exceeded`. v1 does not split envelopes across rows; if this fires regularly, Phase B introduces a `report-snapshots` blob container with the row pointing at it.

Reads decompress transparently. The `EnvelopeBytes` column is pre-compression for telemetry — operators can spot drift toward the cap.

### 5. Re-capture: monotonic per-period versions

Re-capturing the same `(tenantId, periodKey)` writes a **new versioned row** rather than overwriting. Versioning shape:

- **Version number** (`Version` column): monotonic per period. Computed at capture time as `max(existing versions for periodKey) + 1`. The query is partition-scoped + RowKey-prefixed, so it's a single Table Storage filter call per capture (`PartitionKey eq <tenantId> and RowKey startsWith '<periodKey>_'`).
- **RowKey shape**: `<periodKey>_<capturedAt>` where `capturedAt` is the ISO-8601 UTC timestamp of capture (e.g. `2026-W17_2026-04-28T11:42:08.123Z`). ISO-8601 lex-sorts chronologically — partition-scan with the period-prefix filter returns versions in capture order without an explicit sort. The timestamp also makes concurrent captures collision-safe (two admins clicking "Capture" simultaneously land in distinct rows; the version numbers may collapse to the same value momentarily but the next read settles them via re-numbering at query time if needed — operator UX is unaffected).
- **Latest-wins for default reads**: `GET /api/reports/snapshots/<periodKey>` returns the highest-versioned row. `GET /api/reports/snapshots/<periodKey>?version=2` (or `?capturedAt=…`) addresses a specific version.
- **Listing**: `GET /api/reports/snapshots?cadence=weekly&limit=12` returns one entry per `(periodKey, version)` — the SPA's "Recent reports" sidebar shows each version as a permalink, so an operator can compare board-prep at v1 against the live state at v3.
- **Versions kept**: see §3 retention table. Floor of 3 is enforced at config-load time; values below 3 reject with `ConfigError`. Synchronous trim on capture removes oldest versions in excess.
- **Concurrency under capture**: lease semantics from `runSecureScoreIngest.ts` are reused. The `IngestHealth[report.snapshot]` row carries the optimistic ETag lease; concurrent captures race for the lease, the loser retries with the next version number. This keeps the audit chain's `seq` allocation strictly serial.

Forensic history lives in **both** the versioned table rows (recoverable, queryable, board-shareable) and the audit chain (tamper-evident, hash-walked, deletion-aware via the `audit.report.trim` lines). The audit chain is the system of record for *the act of capturing*; the table is the system of record for *the captured content*.

### 6. Audit-chain integration

Capture emits one audit line per invocation. Trim deletes are rolled into the same line via the existing `retentionRowsDeleted` field (ADR-0011 §3 precedent on Secure Score) — keeps the chain a single line per capture and avoids a per-trim lease cycle. The deleted version numbers are listed in a new optional `trimmedVersions` array so the forensic record names what was dropped.

- `eventType: "audit.report.capture"` (new value; extends the union in `AuditLineFields`)
- `source: "report.snapshot"` (new source value — adds a fifth chain alongside `graph.security.secureScores`, `graph.security.incidents`, `graph.security.riskyUsers`, `agent.aegis.*`)
- `status: "success" | "error" | "size_exceeded"`
- `periodKey`, `cadence`, `capturedBy`, `version`, `envelopeBytes` (post-compression), `contentType`
- `retentionRowsDeleted: number` — count of older versions trimmed by this capture (0 when the period was below cap)
- `trimmedVersions?: readonly number[]` — version numbers deleted, ascending; omitted when `retentionRowsDeleted === 0`

The new source gets its own filename — `report.ndjson` — via the existing `auditFilenameForSource` dispatcher (which today routes `agent.*` to `agent-run.ndjson` and everything else to `ingest.ndjson`). To avoid the snapshot chain co-mingling with the ingest chain, `auditFilenameForSource` gains a third branch: `source === "report.snapshot"` → `report.ndjson`. Test pins this contract.

`IngestHealth` gains a row keyed `report.snapshot` for the chain's prev-line tracking (same pattern as agents and ingests). The "Capture period" button gates on this row's lease, mirroring the lease semantics in `runSecureScoreIngest.ts`.

### 7. Read gate

- **Capture (`POST /api/reports/snapshots`):** admin-only. Body: `{cadence, periodKey?}`. If `periodKey` omitted, server derives the *current* period for the cadence. Response: `{periodKey, version, capturedAt, snapshotUrl}`.
- **Read latest live (`GET /api/reports/current?cadence=weekly`):** reader-or-admin. Returns the same envelope shape but assembled from live queries — no Table read. Backs the default `/reports` page view.
- **Read historical latest version (`GET /api/reports/snapshots/<periodKey>`):** reader-or-admin. Returns the highest-versioned row's envelope. 404 if no snapshot exists for that period.
- **Read historical specific version (`GET /api/reports/snapshots/<periodKey>?version=N`):** reader-or-admin. Returns the exact version. 404 if absent.
- **List historical (`GET /api/reports/snapshots?cadence=weekly&limit=N`):** reader-or-admin. Returns `{items: [{periodKey, version, capturedAt, capturedBy, contentType, envelopeBytes}]}` — projection only, not the full envelopes. One entry per `(periodKey, version)`. Limit ≤ 50, default 12.

Reader access is the right call: the underlying tile data is already reader-readable; gating reports more tightly than tiles would create a confusing asymmetry. Capture stays admin-only because it's a state-changing action that emits an audit line.

### 8. SPA route shape

`/reports` route (registered alongside existing routes). Three view-modes via query string:

- `/reports` — current period of the cadence in `TenantSettings.reportCadence`
- `/reports?period=2026-W17` — historical snapshot
- `/reports?cadence=monthly` — current period of an explicit cadence (override)

Print CSS via `@media print` — page-break hints, hide of nav/header/admin-only chrome, monochrome-friendly tile colours. Operator's "Print to PDF" produces a clean board-ready document today.

Admin-only "Capture this period" button at the top, disabled when a snapshot for the current period already exists (prompts "Re-capture" instead, which overwrites per §5).

A "Recent reports" sidebar lists the last 12 snapshots via `GET /api/reports/snapshots?limit=12`, each a permalink to the `?period=…` view.

## Consequences

### Positive

- **Compliance evidence on demand.** Snapshot rows are durable, audit-chained, and timestamped — direct artefact for Cyber Essentials Plus / NIS2 / UK GDPR posture-attestation requirements.
- **Phase-A is ~6 hours of work, not ~6 weeks.** No new infra (one table), no new identity, no new platform dependency. Reuses every existing wire shape and the existing audit chain.
- **Forward-compatible.** Sections is open-set; future feeds (KEV, news, cross-vendor TI) extend it. Cadence is open-enum; quarterly was added without code-shape change.
- **Zero new attack surface.** Reads are read-only over existing data. Capture emits an audit line; the audit chain's existing single-writer invariant carries over.
- **Browser-print is a real first-class output.** Many boards consume PDFs delivered via Outlook/SharePoint anyway. Phase A serves that today; Phase D (headless render) is a fidelity upgrade, not a missing capability.

### Negative

- **No automatic capture in Phase A.** An admin must click "Capture period". Phase B fixes this. Mitigated by the prominent button and the cadence display.
- **Re-capture overwrites in-period.** Forensic recovery requires walking the audit chain rather than reading the table. Acceptable trade-off; the chain is the system of record.
- **Envelope size cap is a real constraint.** A pathological tenant (unusual brief length × very busy month) could hit 60 KB compressed. Phase B's blob fallback is the safety valve; v1 fails-loud at the boundary rather than silently truncating.
- **`/reports` page is a heavy fan-out.** Five existing queries fire in parallel on load. Mitigated by React Query's existing staleTime + the cache: the page is mostly served from already-warm tile caches.

### Neutral

- **No AI-generated narrative on the report page in Phase A.** The board reads the existing brief/posture narratives — no period-bounded summary. Phase B candidate: route the captured envelope through the agent plane to produce a "this-period-in-summary" prose block. Out of scope today.
- **No multi-period comparison in Phase A.** "Q1 vs Q2" charting is deferred. The list-historical endpoint provides the data; the SPA chart is Phase B.
- **No customisable templates.** Sections are a fixed v1 set. Operators wanting to redact / re-order need an ADR amendment.

## Out of scope (Phase B/C/D/E)

- Auto-capture on cadence (Phase B — Timer trigger; reuses §3 storage + §6 audit semantics).
- Email delivery via Graph `mail.send` (Phase C — needs `Mail.Send` scope grant + recipient validation + per-tenant distribution-list config; reuses the print HTML as the email body).
- True PDF generation via headless browser (Phase D — Playwright in a Function; opt-in over the print-fallback).
- Webhook fan-out (Phase E — gated on the broader outbound-integration ADR).
- Multi-period comparison views, custom templates, redaction surfaces — all explicitly Phase B+.
- Cross-tenant aggregation (MSSP/MSP — gated on the multi-tenant ADR; see ADR-0017/0019 cross-tenant prohibition).

## Trigger to revisit

- A snapshot envelope hits the 60 KB compressed cap → Phase B blob fallback becomes blocking.
- An operator asks for auto-capture → Phase B Timer.
- A regulator or auditor asks for delivered (not pulled) attestation → Phase C email.
- A board asks for a true-PDF inbox delivery → Phase D headless render.
- The first MSSP/MSP-flavoured customer ask → multi-tenant ADR.

---

## Phase C addendum — Email delivery via Graph Mail.Send (drafted §10.74, 2026-05-12)

Phase C wires the captured report snapshot to outbound email. The existing `renderEnvelopeHtml` (the Phase A print-friendly HTML) doubles as the email body — no second rendering path. The trigger surface for v1 is admin-only (POST `/api/reports/snapshots/{periodKey}/email`); auto-send on cadence is deferred to Phase C v2.

This addendum drafts the design BEFORE any code lands. WS10 reviews the addendum first; implementation follows in Slice 1.

### C.1 Sender identity model

**Decision: dedicated `mailSender` MI + Mail.Send application permission scoped via Exchange Application Access Policy.**

Three options considered:

- **(A) Dedicated mail-sender MI + Application Access Policy.** New user-assigned MI (`id-aegis-mail-sender-<env>-<region>`) attached to the Function App. `bootstrap-entra.ps1` grants Microsoft Graph `Mail.Send` (application permission) to the MI, AND creates an Exchange Application Access Policy scoping the grant to ONE sender mailbox (the operator-provided `AZURE_MAIL_SENDER_UPN`). Without the access policy, Mail.Send is "send as any user in the tenant" — the largest blast radius in Graph's permission catalog.
- **(B) Reuse the existing `ingest` MI + add Mail.Send.** Rejected — couples the Mail.Send blast radius to every other ingest scope; a compromise of the Graph ingest path becomes a tenant-wide phishing vector.
- **(C) Delegated permission via on-behalf-of (user-context send).** Rejected — Timer-fired auto-send (Phase C v2) has no user context, and admin-triggered v1 would force the admin to consent to Mail.Send personally on every invocation.

Application Access Policy is provisioned by `bootstrap-entra.ps1` via the Exchange Online PowerShell module (`New-ApplicationAccessPolicy`) — requires Exchange admin consent on first run. Operator must have ExchangeOnlineManagement module installed; bootstrap detects + fails-clear if absent.

**Deprecation forward-track (operator §10.74 verification).** Microsoft has formally announced that Application Access Policies will be deprecated in favour of **Exchange Online RBAC for Applications** (per `learn.microsoft.com/exchange/permissions-exo/application-rbac`). AAP works today and is well-documented for the single-mailbox scoping pattern Aegis needs; v1 ships with AAP for simplicity + tooling maturity. Forward-track captured in C.13: migrate to RBAC for Apps before the deprecation date (TBD by Microsoft) — replaces `New-ApplicationAccessPolicy` with `New-ServicePrincipal` (in Exchange Online) + `New-ManagementRoleAssignment -App` granting the `Application Mail.Send` role scoped to a `ManagementScope` filtered to the sender mailbox. The Graph permission grant in Entra is unchanged; only the Exchange-side scoping mechanism flips.

Both mailbox types (shared, licensed user) work identically under AAP today and under RBAC for Apps tomorrow.

**Defence-in-depth — recipient-domain allowlist at the orchestrator (WS10 LOW C.1 finding).** AAP is enforced by Exchange Online's routing; a future Graph endpoint that bypasses Exchange routing would side-step it. Belt to AAP's braces: `reportEmail.ts` orchestrator re-validates every recipient's domain against the configured `senderMailbox` domain (or the explicit external-allowlist when `allowExternalRecipients = true`) before invoking `sendMail`. A mismatch fails-closed locally — never reaches Graph.

### C.2 Sender mailbox provisioning

**Decision: operator-provided mailbox (no automatic provisioning). Both shared mailboxes AND licensed user mailboxes are supported.**

Operator passes `AZURE_MAIL_SENDER_UPN` (e.g. `noreply@<tenant>`) via azd env vars. The UPN can resolve to EITHER:

- **A shared mailbox** (no Exchange Online licence required for the mailbox itself; free up to 50 GB storage). Microsoft's recommended pattern for automation senders. Created via Exchange admin centre → Shared mailboxes, or via PowerShell `New-Mailbox -Shared`. The underlying user object is disabled (no interactive sign-in) and unlicensed.
- **A licensed user mailbox** (any Exchange Online plan: Microsoft 365 Business Basic+, Microsoft 365 E1+, Office 365 F3+, etc.). Created via Entra admin centre → New user → assign licence. Underlying user is enabled; can sign in if needed for troubleshooting.

Bootstrap detection — see C.14 onboarding flow for the validation logic. Bootstrap does NOT distinguish the two cases at the wiring level — both expose the same Graph endpoint shape (`/users/{upn}/sendMail`), the same AAP/RBAC scoping behaviour, and the same `Mail.Send` permission semantics.

**Key Microsoft pattern (operator §10.74 verification):** for app-permission Mail.Send, Exchange Online does NOT evaluate the mailbox's "Send As" / "Send On Behalf" permissions — those apply only to delegated (user-context) scenarios. Under app-only auth, Exchange authorises based on (a) the app's `Mail.Send` grant in Entra, (b) the AAP/RBAC scope, (c) the target mailbox in the Graph endpoint URL. No mailbox-side permission grants needed.

**Licensing economics (operator §10.74 brief):**

| Mailbox type | Licence cost | Aegis cost |
|---|---|---|
| Shared mailbox | £0 (free up to 50 GB; tenant needs ≥1 Microsoft 365 subscription for Exchange Online to exist at all) | £0 |
| Licensed user mailbox (e.g. Business Basic) | £5/user/month (May 2026 GBP price; refer to Microsoft pricing for current) | £5/month per dedicated sender mailbox |

With `saveToSentItems: false` (C.6), the sender mailbox accumulates zero storage growth — even a high-cadence dev tenant stays well under any storage threshold. Operators are encouraged to use shared mailboxes for the standard "noreply@" automation pattern.

Alternative considered: bootstrap creates the mailbox via Graph `users` POST + assigns a licence (or creates as shared via Exchange PowerShell). Rejected — bootstrap already does enough; adding mailbox creation requires `User.ReadWrite.All` + (for licensed) licence-assignment scope, OR Exchange admin scope for the shared-mailbox path. Too broad for an interactive dev-machine script.

### C.3 Recipient model

**Decision: hybrid — accept either a free-form recipient list OR a distribution-list address, validated at write-time.**

TenantSettings row `report-email-config`:

```jsonc
{
  "enabled": false,                  // off by default; admin opt-in
  "senderMailbox": "noreply@x.com",  // mirrors AZURE_MAIL_SENDER_UPN
  "recipients": ["audit@x.com", "ceo@x.com"],  // OR a single DL e.g. ["board-reports@x.com"]
  "subjectPrefix": "[Aegis]",         // optional; prepended to the auto-subject
  "allowExternalRecipients": false,   // operator opt-in; default-deny
  "updatedAt": "...", "updatedBy": "..."
}
```

Validation at write-time:

- Every entry must be a syntactically valid RFC 5322 address (Graph rejects malformed at send-time anyway; defence-in-depth at the admin surface).
- `recipients.length` capped at 20 (per ADR-0030 §1's "small board" sizing — boards rarely > 10 directors).
- If `allowExternalRecipients = false`, every recipient's domain must match `senderMailbox`'s domain. External recipients require an explicit operator toggle + a written audit-line reason.

**Distribution-list handling — Exchange's concern, not Aegis's (operator §10.74 risk-acceptance).**

WS10 MED finding C.3 originally recommended Aegis-side DL expansion (Graph `groups/{id}/members` lookup + per-send audit logging of resolved member counts). Operator declined: Aegis hands the recipient list to Graph `sendMail` as-given; Exchange resolves DLs server-side at send-time. Aegis stores only the addresses originally configured — DL or individual user, treated identically.

Trade-offs explicitly accepted:

- **No tenant-wide group enumeration grant.** `Group.Read.All` (application) is NOT granted to the `mailSender` MI. Smaller blast radius.
- **No Aegis-side fan-out preview.** The consent interstitial (C.11) shows the listed recipient count (`recipients.length`), not the expanded total. A DL named `board@x.com` shows as "1 recipient" in the UI even if Exchange resolves it to 12 addresses.
- **Audit-line + send-history record listed addresses only.** Regulator's "who actually received this message?" question is answered by Exchange Online's own audit log (message trace, mailbox-level audit) at the time of the send — Aegis points at the Exchange audit trail, doesn't duplicate it.

The recipient-count cap at the validator level (`recipients.length ≤ 20`) remains, but applies to listed addresses — not the expanded fan-out. Operators sending to a large DL should be aware that one listed address may fan out widely; the trust model is "operator confirmed the listed addresses are correct + the recipient DL's membership is correctly managed by tenant admins".

This is a *deliberate* simplification:

- WS10 originally wanted Aegis to fan-out + log because "who Aegis intended to send to" is auditable; Exchange's log can be redacted independently.
- Operator weighed that against the tenant-wide `Group.Read.All` grant + the implementation complexity and chose the lighter design. Acceptable for single-tenant dev; revisit if a multi-tenant deployment or a regulator requires Aegis-side reconciliation.

### C.4 External-recipient policy

**Decision: default-deny external recipients; operator opt-in via `allowExternalRecipients` flag; per-send audit-line records the external-recipient count.**

Outbound mail to an external domain is a privacy-sensitive operation — tenant data leaves the tenant boundary. The default-deny stance forces operators to consciously accept the data-egress trade-off. When `allowExternalRecipients = true`, the captureReportSnapshot UI surfaces a "Recipients include X external addresses — confirm before each send" interstitial; the admin Send endpoint also emits an additional `report.email.externalRecipientsSent` audit line per affected message.

WS10 follow-up on first send: if external recipients are sent to without a corresponding tenant-data-egress retention policy in place, a recurring AIEVENT alerts the operator.

### C.5 Trigger surface (v1)

**Decision: admin-triggered POST `/api/reports/snapshots/{periodKey}/email`. No auto-send on cadence in Phase C v1.**

Endpoint shape:

- Method: `POST`.
- Path: `/api/reports/snapshots/{periodKey}/email` (mirrors the existing snapshot endpoints' shape).
- Auth: admin role required (matches every write surface).
- Rate limit: **dedicated 10/day per tenant** (separate counter from `ADMIN_RUN_DAILY_CEILING` — WS10 LOW C.5 finding). Email sends fan out to N recipients per call; sharing the 30/day admin-write budget meant a runaway settings-patch loop could exhaust the limit before a legitimate Send. 10/day reflects the realistic upper bound for a board-reporting cadence (weekly + ad-hoc resends).
- Body: optional `{ overrideRecipients?: string[]; subjectSuffix?: string; idempotencyKey?: string }`. `overrideRecipients` only honoured when the requesting admin has the `admin` role (already enforced) AND `allowExternalRecipients = true` if any address is external.
- Headers: `Idempotency-Key: <client-supplied-uuid>` (RECOMMENDED). See C.5.1 below.
- Response: `202 Accepted` with `{ graphMessageId, recipientCount, sentAt, snapshotCaptured: boolean, replayed: boolean }`. `replayed: true` indicates the response came from the idempotency replay cache. `snapshotCaptured: true` indicates the snapshot for `{periodKey}` was created in this call (no prior capture existed — see "Auto-capture on missing snapshot" below).

#### Auto-capture on missing snapshot (operator §10.74)

When no `ReportSnapshot` row exists for the requested `{periodKey}`, the orchestrator captures it in-process before sending — operator chose this over `404 Not Found` to make "email this period" a one-click action regardless of prior capture state.

Flow:

1. Read existing snapshot row by `(tenantId, periodKey)`.
2. If absent: invoke `captureReportSnapshotCore({tenantId, periodKey, capturedBy: operatorPrincipal, source: "email-trigger"})` — a shared lib helper extracted from `captureReportSnapshot.ts`'s HTTP handler. Writes the envelope row + emits `report.snapshot.captured` audit line as if the admin had clicked Capture first.
3. Proceed with send using the just-captured envelope.

Audit-chain consequence: a single email POST produces TWO chain lines — one `report.snapshot.captured` (existing source) immediately followed by one `report.email.sent` (new source). Independent chains; both are tamper-evident.

Failure handling: if capture fails (e.g. data dependencies unavailable), the orchestrator returns `502` with `{ errorKind: "capture_failed", ... }` BEFORE the send is attempted. No partial state; no email-without-snapshot.

Idempotency-Key replay: a replayed POST returns the cached send result without re-capturing. If the original send failed AFTER capture succeeded, the snapshot exists on retry and the orchestrator skips step 2 (no double-capture).

Phase C v2 (separate addendum) adds a Timer that auto-fires on the existing `reportCadence` schedule, sends the most recent captured snapshot, and writes an `auto`-triggered audit line.

**CSRF — WS10 LOW finding.** Admin Send endpoint is NOT exempt from the FA-side Bearer-validation gate (`api/src/lib/authMiddleware.ts`). The Bearer JWT is the CSRF defence (token-bound + audience-bound); SWA Easy Auth was retired in Phase D2 so there is no cookie-based session to forge. Explicit note for future re-readers: a hypothetical re-introduction of cookie auth would require re-evaluating CSRF for this endpoint.

#### C.5.1 Idempotency (WS10 MED finding)

Graph `sendMail` is non-idempotent — a network-retry by the SPA (or a double-click on the Send button) sends twice. Mitigation:

- Server accepts `Idempotency-Key` header (or `body.idempotencyKey`); UUIDv4 recommended.
- On receipt, the handler reads the cache via the dynamic-RowKey path `TenantSettings/report-email-idempotency:<key>:<periodKey>` (operator §10.74 batch 4 — strict scoping). The same `Idempotency-Key` value reused across different `periodKey`s produces independent cache entries, so a buggy client reusing the same key across multiple period sends doesn't silently replay the wrong response. If present and not yet expired (TTL = 24 h from first-write), the handler returns the cached `{ graphMessageId, recipientCount, sentAt }` with `replayed: true` and emits an `aievent.report.email.idempotentReplay` for visibility.
- If absent, the handler proceeds with the send; on success, the cache row is written with `(graphMessageId, recipientCount, sentAt, sentByPrincipal, expiresAt = now + 24h)` BEFORE returning to the client (write-then-respond, not respond-then-write — guarantees the next replay sees the cached result).
- TTL is 24 h because a longer window risks a "I meant to re-send" admin getting silently no-op'd; shorter than the daily rate limit window so the idempotency layer can't be used to bypass it.
- Missing `Idempotency-Key` is permitted (operator backwards-compat) but server emits an `aievent.report.email.noIdempotencyKey` so the admin UI's adoption is observable.

The cache row's `expiresAt` is also enforced server-side at read time (defensive — Table Storage has no TTL primitive). Eviction is best-effort: stale rows linger until the next read-with-write touches them, OR until the future retention worker (Phase C v2) sweeps. At 10/day per tenant the unbounded growth is bounded — ~3650/year max, well within Table Storage's per-partition limits.

Cache row RowKey: `report-email-idempotency:<key>`. Same dynamic-RowKey-prefix convention as the send-history rows (see C.7). The `patchSettings` admin endpoint validator rejects any inbound write whose RowKey starts with `report-email-` — these are internal-only, written by the `mailSender` MI via the orchestrator.

**Right-to-erasure shadow window (WS10 §C.5.1 follow-up).** The idempotency cache row stores the full successful response body (`recipientCount`, `graphMessageId`, `sentAt`, `internetMessageId`, etc.) — NOT the plaintext recipient list, which lives only on the `report-email-send:<graphMessageId>` history row. But the cached `graphMessageId` is sufficient to correlate a replay back to that history row's pre-delete identity, and (until the cache row also expires or is purged) any future caller replaying the same `Idempotency-Key` receives a `200` carrying that `graphMessageId` + `recipientCount` even after the plaintext history row has been deleted via the right-to-erasure endpoint (`DELETE /api/reports/email/sends/{graphMessageId}`, §C.7). The cached body therefore exposes a *correlation handle*, not the recipient addresses themselves. Operators handling a real erasure request inside the 24h cache window MUST therefore also delete the matching `report-email-idempotency:<key>` row to remove the correlation handle. The audit chain entries (intent + sent) STAY in either case — chain integrity is non-negotiable, and the salted recipient hash on the intent line is the residual we accept. A future hardening (Phase C v2) could either (a) shorten the cache TTL on erasure-affected rows or (b) re-key the cache by `(idempotencyKey, recipientListHash)` so any drift between cache-time and replay-time recipient lists invalidates the replay; both are forward-tracked but not v1.

#### C.5.2 Inert-MI detection (Phase-C-not-configured short-circuit)

The orchestrator checks two gates BEFORE invoking Graph:

1. **TenantSettings `report-email-config.enabled === true`**: admin opt-in. If `false` or row missing → return `503 not_configured` with the next-step message ("Admin: enable email delivery in /admin/email after setting AZURE_MAIL_SENDER_UPN and re-running azd provision").
2. **FA env `MAIL_SENDER_MI_CLIENT_ID` set + non-empty**: Bicep+bootstrap completed Phase C wiring. If empty (mailbox env var was unset at deploy time, bootstrap skipped Phase C) → return `503 not_configured` with the deploy-side remediation message.

Both checks happen up-front in the HTTP handler before any Graph token acquisition. No Graph call is ever attempted in the inert state — the orchestrator returns `503` cleanly with operator-actionable text.

Idempotency replay (C.5.1) is checked AFTER the inert gates: a replay during the inert window returns the cached result if any (rare; the cache wouldn't have populated in inert state, so this is a no-op in practice).

### C.6 Email body & rendering

**Decision: dedicated email-grade renderer `renderEmailHtml(envelope)` parallel to `renderEnvelopeHtml` (operator §10.74 batch 4 — full email-grade rendering). Subject auto-generated from envelope metadata, capped at 78 chars (RFC 5322 §2.1.1 sweet spot). No attachment in v1.**

#### Email-grade rendering — new lib `renderEmailHtml(envelope)`

The print renderer (`renderEnvelopeHtml`) targets `Chromium → window.print()` and uses modern CSS (Grid, custom properties, viewport units, external font links). Email clients render HTML very differently:

- **Outlook Desktop (Windows)** uses Microsoft Word's HTML engine — no Grid, no Flexbox, limited Float, broken viewport units, must use `<table>` for layout.
- **Outlook on Web / OWA** strips `<style>` blocks in some plans, only honours inline styles reliably.
- **Gmail web** sanitises `<style>` aggressively; supports inline styles but strips many `position` rules.
- **Apple Mail** is the most permissive but mobile Mail's accessibility settings affect rendering.

The new `renderEmailHtml` lives in `api/src/lib/reportEmail.ts` (NOT `reportHtml.ts` — keeps the print path unchanged). Discipline:

- **All styles inline** (`style="..."` attributes; no `<style>` block).
- **`<table>`-based layout** with explicit `cellpadding`/`cellspacing` for cross-client consistency.
- **No CSS Grid, Flexbox, Custom Properties, Viewport units, `@media`.** Static layout only.
- **Web-safe fonts only** (Helvetica/Arial fallback chain; no Google Fonts).
- **No SVG, no `@import`, no `<link>` tags.** All resources inline or omitted.
- **Width pinned at 600px** (industry standard email body width).
- **`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ...>`** declaration for Outlook compatibility.
- **Automated-email header**: 1-line table row with sender + period + a "Aegis automated report — do not reply" marker.
- **Footer**: 1-line table row with retention disclaimer ("This message + audit chain stored for N days; recipient list is admin-managed in /admin/email").

The shared content with print HTML is the envelope sections themselves — rendered via the same `renderSection(section)` helper extracted to a lib. The print renderer wraps sections in a print-grade layout; the email renderer wraps them in a table-grade layout.

Phase D headless-render path (PDF attachment) re-uses the print HTML, not the email HTML — different audience, different output channel.

#### Subject

- **Format**: `${subjectPrefix} ${productName} report — ${periodKey}` (cadence dropped per the 78-char cap; envelope.cadence is implicit from periodKey shape).
- **Cap**: 78 chars hard limit. RFC 5322 §2.1.1 sweet spot — fits inbox preview on most clients without ellipsis, evades spam-filter heuristics that flag very long subjects.
- **Truncation**: if `subjectPrefix` + base subject exceeds 78 chars, truncate the base subject with `…` to fit. `subjectPrefix` is preserved (operator-set; intentional).
- **Examples** (`subjectPrefix = "[Aegis]"`, `productName = "Aegis"`):
  - `[Aegis] Aegis report — 2026-W19` (32 chars; comfortable).
  - `[Aegis] Aegis report — 2026-04` (31 chars; monthly).
  - `[VeryLongTenantOrgName] Aegis report — 2026-W19` (47 chars; still under cap).

#### Sender / recipients / reply-to

- **From**: configured `senderMailbox`.
- **To**: from `recipients` (or `overrideRecipients` per C.5). DLs passed to Graph as-given per C.3.
- **Reply-To**: not set — replies bounce silently. Phase C v2 adds a configurable `replyTo`.
- **Attachments**: none. Phase D adds a PDF attachment via headless render.

Graph `sendMail` `saveToSentItems: false` so the sender mailbox doesn't accumulate per-send copies (audit chain is the system of record).

#### Body size cap

**1 MB at orchestrator (WS10 MED C.6 finding).** The Phase A envelope cap is 60 KB on JSON; the rendered HTML expands 5–10× with inline CSS. Graph `sendMail` accepts ~100 MB but downstream Exchange may bounce > 25 MB. The orchestrator caps the rendered body at 1 MB — well under Exchange's bounce threshold and an order of magnitude above realistic envelope output. Exceeds → fail-closed with a `body_too_large` error code + audit line.

### C.7 Audit chain (intent-then-outcome + plaintext-recipient persistence in TenantSettings)

**Decision: three event sources per send — `report.email.intent` (pre-send), then `report.email.sent` (post-Graph-202) OR `report.email.failed` (post-Graph-error). Plaintext recipient list per send stored in TenantSettings (operator decision §10.74 — see "WORM risk-acceptance" below).**

The intent-then-outcome split (operator §10.74 batch 3 — post-send-failure handling) means the audit chain captures the "we tried to send" state BEFORE Graph is called, so a Graph-202 followed by an Aegis-side failure (TenantSettings write error) leaves a recoverable audit trail. The intent line is the durable marker; the sent/failed line is the outcome.

#### WORM risk-acceptance (operator §10.74)

WS10 MED finding C.7 recommended a dedicated WORM-immutable blob container for the plaintext recipient record to give UK GDPR Article 30 / NIS2 §27 a regulator-answerable "show me who you sent to" record that resists operator-side deletion.

Operator accepted the lighter-weight design: persist the plaintext record alongside admin settings in the existing `TenantSettings` table under a `report-email-send:<graphMessageId>` RowKey. Rationale:

- Single-tenant dev posture doesn't yet warrant a separate WORM-grade storage account.
- TenantSettings already houses operator-managed settings; the send-history rows fit the existing admin-data placement.
- Audit-chain hash continues to detect tamper at the chain level: the `report.email.sent` audit line carries the salted SHA-256 hash; chain replay flags any missing entry.

Trade-offs explicitly accepted:

- A malicious admin with write access to `TenantSettings` can delete a `report-email-send:<msgId>` row between send-time and regulator audit. The audit-chain's "missing-row-the-hash-points-to" signal flags the gap on verify but does not recover the lost plaintext.
- Without WORM-grade immutability, a regulator's "show me the recipient list for the send on date X" question is answerable WHILE the row still exists; if the row is missing, the auditor reads "audit chain shows a send happened on date X to N recipients with hash H, but the plaintext record is no longer available" + the next-best record (the operator's current `report-email-config.recipients` list, with the caveat that it may have changed since the send).
- Phase C v2 forward-track: if a customer with regulator-grade evidence requirements arrives, upgrade this layer to the WORM design WS10 originally recommended. The ADR retains the WS10 design as a documented future state.

#### Audit-chain lines (tamper-evidence layer)

Audit-chain partitions: `(tenantId, source="report.email.intent")` AND `(tenantId, source="report.email.sent")` (separate chains per source per existing convention).

##### Intent line — pre-send (always emitted)

```jsonc
{
  "schemaVersion": 1,
  "eventType": "report.email.intent",
  "source": "report.email.intent",
  "seq": <next>,
  "tenantId": "...",
  "periodKey": "2026-W19",
  "capturedAtOfSnapshot": "...",     // capturedAt from the source ReportSnapshot row
  "renderedAt": "...",               // when renderEnvelopeHtml ran
  "senderMailbox": "noreply@x.com",
  "recipientCount": 3,
  "externalRecipientCount": 0,
  "recipientHashSalted": "sha256(tenantId || ':' || canonicalised sorted lowercase joined-with-comma recipient list)",
  "bodySha256": "sha256(HTML body bytes)",
  "bodyBytes": 0,
  "subjectSha256": "sha256(subject string)",
  "callerPrincipalMiClientId": "...",
  "triggeredBy": "admin|auto",
  "operatorPrincipal": "...",
  "idempotencyKey": "...",           // present when client supplied one
  "intentAt": "..."
}
```

Recipients are stored **salted-hashed** — `sha256(tenantId || ':' || canonicalised list)` so cross-tenant rainbow lookups don't reveal recipients of one tenant by knowing them in another. The salt is the tenant GUID; not a secret, but the prepend defeats a single global rainbow.

##### Outcome line — post-send (success path)

```jsonc
{
  "schemaVersion": 1,
  "eventType": "report.email.sent",
  "source": "report.email.sent",
  "seq": <next>,
  "tenantId": "...",
  "periodKey": "2026-W19",
  "intentLineSeq": 87,               // back-reference to the matching intent line
  "graphMessageId": "AAMkAGI2...",
  "graphClientRequestId": "...",     // attempt-correlation id; see C.8.1
  "internetMessageId": "<uuid@x.com>",
  "sentAt": "..."
}
```

The outcome line back-references the intent line by `seq`. Chain-walk: read both chains, pair by `(periodKey, intentLineSeq)`; assert every intent has either a `sent` outcome or a `failed` outcome. Unpaired intent → "phantom send" (admin reconciles via Exchange Online message trace using `internetMessageId`).

##### Failure variant — post-send (failure path)

```jsonc
{
  "schemaVersion": 1,
  "eventType": "report.email.failed",
  "source": "report.email.sent",     // same partition as success; chain reader filters by eventType
  "seq": <next>,
  "tenantId": "...",
  "periodKey": "2026-W19",
  "intentLineSeq": 87,
  "graphClientRequestId": "...",
  "internetMessageId": "<uuid@x.com>",
  "errorKind": "throttle|4xx|5xx|internal|ambiguous",
  "errorMessage": "<scrubbed-200-chars>",
  "attempt": 1,
  "failedAt": "..."
}
```

The intent + (sent|failed) pair provides full state. An intent with no matching outcome → orchestrator crashed mid-flight; admin reconciles via Exchange Online message trace. The send-history row is best-effort — its absence is recoverable from the audit pair.

#### Plaintext-recipient send-history row (TenantSettings)

`TenantSettings` table grows a new dynamic-RowKey shape: `report-email-send:<graphMessageId>`. One row per send, written by the `mailSender` MI (new table-Contributor grant). Row shape (JSON-encoded columns):

```jsonc
{
  "schemaVersion": 1,
  "tenantId": "...",
  "periodKey": "2026-W19",
  "graphMessageId": "AAMkAGI2...",
  "sentAt": "...",
  "senderMailbox": "noreply@x.com",
  "recipients": ["to1@x.com", "to2@x.com", "audit@x.com"],  // listed addresses only; no DL expansion
  "operatorPrincipal": "...",
  "auditLineSeq": 142,
  "auditLineSha256": "..."
}
```

Every row in the `report-email-*` family carries `schemaVersion: 1`. Future shape changes bump the version explicitly; reader code branches on the value rather than assuming a shape.

Why TenantSettings (not a blob):

- Operator preference (§10.74): "site/admin settings" placement — TenantSettings is the existing admin-data table; send-history fits the same admin-data category.
- No new storage primitive — saves a Bicep container + lifecycle policy + RBAC grant.
- Trade-off: deletable by anyone with `Storage Table Data Contributor` on TenantSettings. Defended by the audit-chain hash (chain replay flags the gap on verify) but not WORM-immutable.

Operator-side redaction (right-to-erasure):

- **Forward sends**: edit `TenantSettings.report-email-config.recipients` via /admin/email; new sends use the updated list.
- **Historical sends**: `DELETE /api/reports/email/sends/{graphMessageId}` removes the per-send plaintext row (admin role required). Audit chain entries (intent + sent) STAY — chain integrity is non-negotiable. Chain replay against the now-orphaned hash reports "send happened, plaintext purged" (forensic walks see "intent line exists, salted-hash here, no matching plaintext row"). A separate `aievent.report.email.historyRowDeleted` is emitted to log the erasure ACTION itself, so the operator's compliance trail captures "we honoured the request".

Write ordering (operator §10.74 batch 3 — post-send failure handling):

1. **Emit `report.email.intent` audit line** (with bodySha256 + recipientHashSalted; no graphMessageId yet).
2. **POST to Graph `sendMail`** with `internetMessageId` + `client-request-id`.
3. **On 202**: emit `report.email.sent` audit line (with graphMessageId + back-reference to intent).
4. **On error**: emit `report.email.failed` audit line.
5. **Best-effort**: write the `report-email-send:<graphMessageId>` row to TenantSettings.

If step 5 fails, the audit pair (1 + 3) still proves the send happened. The orchestrator throws to the client with `outcome: "sent_but_history_write_failed"` so the admin knows reconciliation may be needed (Exchange message trace + audit chain replay together restore the recipient list).

If step 2 returns ambiguous (timeout, body-less 5xx) per C.8.1, the `SentItems` probe disambiguates BEFORE step 3/4 commits a final outcome.

#### TenantSettings RowKey-prefix convention

This is the first dynamic-RowKey shape in TenantSettings (existing rows have fixed RowKeys: `tile-visibility`, `agent-budget`, `branding`, etc.). To keep readers/validators sane:

- `report-email-send:*` rows are internal-only; the `patchSettings` admin endpoint validator rejects any inbound write whose RowKey starts with `report-email-`. Only the `mailSender` MI writes these via the orchestrator.
- A new `listReportEmailSends(table, tenantId, limit)` lib helper filters by RowKey prefix for the admin UI's send-history view.
- Bulk delete: out of scope v1. Forward-track adds a retention worker that trims rows older than `REPORT_SNAPSHOT_RETENTION_DAYS`.

### C.8 Failure semantics + retry ambiguity (WS10 HIGH finding)

- **Throttle (429) / 5xx with response body**: retry with exponential backoff (mirror graphClient retry behaviour). Max 3 attempts; if all fail, emit `report.email.failed` + return `502` to the admin.
- **Permanent 4xx (e.g. invalid recipient)**: no retry; emit `report.email.failed` + return `502` to the admin with the (scrubbed) Graph error. (WS10 §C.5 follow-up — Graph 4xx is an upstream-dependency rejection, not a client error of this API; the response body's `code: "email_send_4xx"` discriminator preserves the original kind for finer-grained UI handling.)
- **Partial-success / NDR bounces**: Mail.Send is atomic — Graph returns `202` only when the message is queued for ALL recipients. Per-recipient NDRs return as separate undeliverable emails to the sender mailbox; out-of-scope for v1 (operator-side concern).

#### C.8.1 Retry-ambiguity handling (HIGH)

Graph `sendMail` is non-idempotent server-side. A network timeout, a TCP RST mid-response, or a 5xx without a response body can leave the orchestrator unable to determine whether the message was sent. A naive retry double-sends to the board.

**Decision: every attempt carries a unique `client-request-id` GUID; on ambiguous failure, the orchestrator probes `GET /users/{from}/messages?$filter=internetMessageId eq '...'` BEFORE retrying.**

Detail:

- Before the first `sendMail`, generate an `internetMessageId` (RFC 5322 — `<{uuid}@<senderDomain>>`) and pass it via the `internetMessageHeaders` property on the message draft. Graph echoes it back on success in the response body.
- Set `client-request-id: <same uuid>` HTTP header on every attempt. Graph traces this for support.
- On retry path, orchestrator first lists messages in the sender's `SentItems` (despite `saveToSentItems: false`, the API still returns drafts-pending-send during the brief window) filtered by `internetMessageId`. If a match is found → the previous attempt landed; orchestrator returns that `graphMessageId` and writes the audit line as if the original attempt succeeded.
- If `SentItems` is empty AND the attempt failed → safe to retry.
- After the 3rd ambiguous failure with no `SentItems` match, the orchestrator emits `report.email.failed` with `errorKind: "ambiguous"` and returns `502` to the admin. The audit chain is consistent (no "phantom send" line); the admin re-triggers with the same `Idempotency-Key` from C.5.1, which short-circuits via the cache OR retries cleanly if the cache wasn't populated.

Trade-off acknowledged: the `SentItems` probe adds latency (~200-500ms per ambiguous retry) and one additional Graph read scope (`Mail.Read` on the same `mailSender` MI, scoped via the same Application Access Policy). Acceptable because (a) ambiguity is rare, (b) the probe is bounded by AAP to the same mailbox, (c) the alternative ("accept the duplicate, document it") risks regulator-visible double-sends.

**Mail.Read scope on the mail-sender MI** — added via bootstrap-entra.ps1 alongside Mail.Send, scoped to the same mailbox by the same Application Access Policy. Per-mailbox, not tenant-wide.

### C.9 Bicep + bootstrap changes

- **identities.bicep**: new `mailSender` user-assigned MI (`id-aegis-mail-sender-<env>-<region>`). Created unconditionally — inert when no mailbox configured.
- **functions.bicep**: attach `mailSender` MI to the FA's `userAssignedIdentities` map; new app setting `MAIL_SENDER_MI_CLIENT_ID`.
- **main.bicep**: wire outputs.
- **storage-ops.bicep**: new `Storage Table Data Contributor` grant for the `mailSender` MI on the `TenantSettings` table only — for writing the idempotency cache rows (C.5.1) + the send-history rows (C.7). Mirrors the existing per-table grants for ingest + agent MIs.
- **bootstrap-entra.ps1**: when `AZURE_MAIL_SENDER_UPN` is set, grant `Mail.Send` + `Mail.ReadWrite` (Microsoft Graph application permissions) to the mailSender MI's SP. Create Exchange Application Access Policy scoping both grants to the operator's mailbox. Idempotent (existing policy detected via `Get-ApplicationAccessPolicy`; existing app-role assignments detected via `Get-MgServicePrincipalAppRoleAssignedTo`). NO `Group.Read.All` — DL handling deferred to Exchange (see C.3). **2026-05-21 fix:** v1 of this section granted `Mail.Read` (not `Mail.ReadWrite`), which is insufficient for the §C.6 draft-then-send pattern's `POST /users/{upn}/messages` (draft create). Graph rejected the draft creation with "Access is denied. Check credentials and try again." despite AAP + Mail.Send being correctly in place. `Mail.ReadWrite` covers both the draft-create AND the §C.8.1 SentItems probe (subset Mail.Read implied), so the swap is semantically loss-less + closes the gap.
- **azure.yaml postprovision**: existing bootstrap call already runs; no new step. New env vars `AZURE_MAIL_SENDER_UPN` (optional) + `AZURE_MAIL_SENDER_REQUIRED` (optional, default `false`) read by bootstrap directly.

No new storage container (the WORM blob container in WS10's original C.7 recommendation is dropped per operator §10.74 risk-acceptance; plaintext recipients persist in TenantSettings instead).

### C.10 API code surface

- **`api/src/lib/graphClient.ts`**: new `graphPost` helper mirroring `graphGetJsonWithRetry`'s retry behaviour. First POST shape in the codebase; future Graph writers reuse.
- **`api/src/lib/reportEmail.ts`** (new): orchestrator — accept a `ReportSnapshotEnvelope`, render HTML, build `sendMail` payload with `internetMessageId`, POST, write send-history row + audit line, return `graphMessageId`. Handles the retry-ambiguity probe per C.8.1. Does NOT resolve DLs — recipients passed to Graph as-given.
- **`api/src/lib/captureReportSnapshot.ts`** (refactor): extract the core capture logic from `api/src/functions/captureReportSnapshot.ts`'s HTTP handler into a shared lib function `captureReportSnapshotCore(args)`. Both the HTTP handler AND `emailReportSnapshot.ts`'s auto-capture path call it. No behavioural change for the existing HTTP capture surface.
- **`api/src/functions/emailReportSnapshot.ts`** (new): admin HTTP handler. Reads/writes the idempotency cache (C.5.1); loads or auto-captures the snapshot row (C.5 auto-capture); defers to `reportEmail.ts`; returns 202.
- **`api/src/lib/tenantSettingsStore.ts`**:
  - New `ReportEmailConfigRecord` shape + `read…` / `upsert…` helpers + validator for the static `report-email-config` row.
  - New helpers for the dynamic-RowKey rows: `readIdempotencyCache`, `upsertIdempotencyCache`, `appendReportEmailSendHistory`, `listReportEmailSendHistory`. RowKey-prefix isolation: any incoming `patchSettings` write with a RowKey starting `report-email-` is rejected (these are internal-only).
- **`api/src/functions/patchSettings.ts`**: new `reportEmailConfig` branch in `ValidatedPatch`; explicit RowKey-prefix guard rejecting `report-email-` (defence-in-depth).
- **`api/src/functions/listReportEmailSends.ts`** (new): reader endpoint `GET /api/reports/email/sends?limit=<n>&continuationToken=<token>`. Mirrors `/api/briefs/history` pagination shape. Default `limit=20`; cap `limit=100`. Continuation-token-based pagination over the `report-email-send:*` RowKey prefix in TenantSettings; client iterates infinite-scroll. Admin role required.
- **`api/src/functions/getReportEmailSend.ts`** (new): single-row read endpoint `GET /api/reports/email/sends/{graphMessageId}`. Returns the full send-history row including `recipients[]`. Admin role required (recipients are PII).
- **`api/src/functions/deleteReportEmailSend.ts`** (new): right-to-erasure endpoint `DELETE /api/reports/email/sends/{graphMessageId}` (operator §10.74 batch 4 — yes in v1). Admin role required. Deletes the TenantSettings plaintext row ONLY; audit chain entries (intent + sent) STAY (chain integrity is non-negotiable). Audit-chain replay reports "send happened, plaintext purged" via the now-orphaned hash. Emits `aievent.report.email.historyRowDeleted` with `{graphMessageId, deletedBy, deletedAt}` for an operator-visible record of the erasure action itself.
- **`web/src/features/settings/sections/ReportEmailConfigSection.tsx`** (new): admin UI section for enabling + managing recipients + send-history view (consumes `/api/reports/email/sends`).
- **`web/src/features/reports/EmailSendInterstitial.tsx`** (new): universal consent modal per C.11; mounts on every Send click; surfaces recipient count + external count + body size + snapshot age.

### C.11 PII + privacy

- Recipient list is privacy-relevant. The operator-managed plaintext list lives in TenantSettings (redactable in place). Audit lines store only the salted SHA-256 hash. The historical "what was sent to whom on this date" record lives in the WORM blob (C.7) — regulator-answerable, immutable for the snapshot retention window. Server logs (App Insights traces) reference recipients only via `recipientCount` + `externalRecipientCount` — never the addresses themselves.
- Body bytes are stored in audit only as `bodySha256` + `bodyBytes`. The body itself is the rendered Phase A HTML, which already contains tenant data by design (the snapshot envelope IS the report).
- Outbound mail to external recipients is an explicit data-egress event; the operator's opt-in toggle + the per-send `externalRecipientCount` audit line make it auditable.

**Universal data-egress consent interstitial (WS10 MED C.11 finding).** EVERY admin-triggered send surfaces a confirmation modal BEFORE the POST fires, listing:

- Recipient count (listed addresses; DLs counted as 1 per C.3 — Exchange resolves fan-out post-send).
- External-recipient count (highlighted if > 0).
- Sender mailbox.
- Snapshot `capturedAt` (if available; "will capture now" indicator if `auto-capture` path applies per C.5).
- Body size in bytes (pre-send; from `renderEnvelopeHtml` length).
- "Once sent, the recipient list is recorded in the audit chain for <retention> days. Tenant-admin deletion of the audit log is detectable but irrecoverable. Exchange Online additionally logs message trace per Microsoft retention policy."

Distinct from C.4's "external recipients present" warning — the universal interstitial fires on EVERY send because mailing tenant security-posture data is materially different from interactive dashboard read. Operator's explicit click-through is the WS10-required "secure by default" gate; the recorded `triggeredBy = admin, operatorPrincipal = <upn>` in the audit line carries the accountability.

### C.12 WS10 review — resolved questions

WS10 reviewed this addendum 2026-05-12 and returned CONDITIONAL APPROVAL with 8 findings (1 HIGH, 5 MED, 2 LOW). All have been folded into the addendum above. Cross-references:

1. **ExchangeOnlineManagement install** — fail-clear with remediation step. Auto-install at bootstrap time is a supply-chain concern (PowerShell Gallery pull on dev machines). See C.1.
2. **External-recipient default-deny** — opt-in flag + universal consent interstitial (C.11) + plaintext send-history (C.7) sufficient for single-tenant dev posture. Dual approval over-engineered. Operator default stays off per §10.74 answer.
3. **Audit-line recipient hash vs plaintext** — both. Salted hash in the chain (tamper-evidence); plaintext in TenantSettings send-history row. Operator §10.74 risk-accepted the WORM-immutability downgrade; trade-off documented inline in C.7. See C.7.
4. **Body size cap** — 1 MB at orchestrator. Rendered HTML expands 5–10× from the 60 KB JSON envelope cap; 1 MB stays well under Exchange's 25 MB bounce threshold. See C.6.
5. **`saveToSentItems: false`** — keep `false`. Audit chain + WORM blob are stronger evidence than a mailbox folder an admin can delete from. See C.6.
6. **Rate limit ceiling** — dedicated 10/day per tenant, separate from `ADMIN_RUN_DAILY_CEILING`. Sharing the 30/day admin-write budget risked a runaway settings-patch loop exhausting Send. See C.5.
7. **HIGH — retry-ambiguity / double-send hazard** — `client-request-id` + `internetMessageId` per attempt + `SentItems` probe before retry. See C.8.1. Mail.Read on the same `mailSender` MI added (per-mailbox via AAP).
8. **DL-expansion logging** — RISK-ACCEPTED by operator §10.74. Aegis does NOT resolve DLs; recipients are passed to Graph as-given. `Group.Read.All` is NOT granted. Trade-off: regulator's "who actually received this?" question is answered by Exchange Online's own message trace, not Aegis. See C.3.

Additional findings folded in:

- **LOW C.1** — recipient-domain allowlist at orchestrator as defence-in-depth to AAP. See C.1.
- **LOW C.5** — CSRF: Bearer JWT is the defence post-Phase-E; explicit re-evaluation required if cookie auth ever returns. See C.5.
- **MED C.5** — `Idempotency-Key` header + 24h replay-cache. See C.5.1.
- **MED C.11** — universal consent interstitial on every send, not external-only. See C.11.

### C.13 Out of scope for Phase C v1

- Auto-send on `reportCadence` Timer (Phase C v2).
- PDF attachment via headless render (Phase D).
- Per-recipient unsubscribe / reply-thread tracking.
- Multi-tenant DL routing.
- Send-status webhook from Graph (delivery receipts).
- **Migration from AAP to RBAC for Applications** (operator §10.74 — Microsoft has formally announced AAP deprecation; replacement is `New-ServicePrincipal` + `New-ManagementRoleAssignment -App` scoped via `ManagementScope`). v1 ships with AAP; migrate when (a) Microsoft publishes a deprecation date or (b) operator decides to standardise on RBAC for Apps for other surfaces. The Graph permission grant in Entra is unchanged across the migration; only the Exchange-side scoping mechanism flips.

### C.14 Onboarding flow + opt-in gating

Phase C is **fully gated on operator opt-in**. A deploy without a configured mailbox produces a healthy Phase-A/B-only system with the email plumbing inert. Steps for an operator turning Phase C on:

1. **Pre-deploy mailbox provisioning (operator-managed, manual)**:
   - Create or designate an Entra user (e.g. `noreply@<tenant>.onmicrosoft.com` or a tenant-domain alias).
   - Assign an Exchange Online licence (the user must have a mailbox).
   - Record the UPN.

2. **azd env wiring (operator-managed, manual)**:
   - `azd env set AZURE_MAIL_SENDER_UPN noreply@<tenant>.onmicrosoft.com`.
   - Optional: `azd env set AZURE_MAIL_SENDER_REQUIRED true` if the operator wants `azd provision` to fail-loud when the mailbox can't be verified. Default `false` — missing/invalid mailbox prints a warning and skips Phase C wiring without aborting the deploy.

3. **`azd provision` (automated)**:
   - Bicep creates the `mailSender` user-assigned MI unconditionally. The MI's existence costs nothing and avoids a re-provision when Phase C is later enabled.
   - The MI is attached to the Function App via `functions.bicep` regardless of opt-in state — handlers that read `MAIL_SENDER_MI_CLIENT_ID` either find the value (Phase C on) or read empty (Phase C off → admin endpoint returns 503 with a helpful message).

4. **`azd provision` postprovision hook → `bootstrap-entra.ps1` (automated; idempotent)**:
   - **If `AZURE_MAIL_SENDER_UPN` is unset OR empty**: print `[bootstrap-entra] Phase C email delivery — AZURE_MAIL_SENDER_UPN not set; skipping mail-sender Graph + AAP wiring. To enable later, set the env var and re-run azd provision.` Exit Phase C section without grants. mailSender MI remains inert.
   - **If set**: verify the mailbox exists via Graph `GET /users/<upn>?$select=mail,mailNickname,accountEnabled,assignedLicenses`. Both shared mailboxes AND licensed user mailboxes are accepted (see C.2). Fail-clear when:
     - User not found → "`<upn>` not found in tenant — confirm the UPN matches a real Entra user, then re-run."
     - Mailbox not provisioned (`mail` property empty) → "`<upn>` exists in Entra but has no Exchange Online mailbox. For a licensed user mailbox: assign an Exchange Online plan + wait for provisioning. For a shared mailbox: create via Exchange admin centre → Shared mailboxes."
   - **Informational detection (print only, doesn't gate)**: if `accountEnabled === false` AND `assignedLicenses.length === 0` → log "Shared mailbox detected (recommended for automation senders)". Else → log "Licensed user mailbox detected".
   - **Grant Microsoft Graph application permissions** to the `mailSender` MI's service principal: `Mail.Send` + `Mail.ReadWrite`. The `ReadWrite` scope is required by the §C.6 draft-then-send pattern (`POST /users/{upn}/messages` — Graph rejects this with "Access is denied" if only `Mail.Read` is granted) AND it covers the `SentItems` retry-ambiguity probe per §C.8.1 (subset Mail.Read implied). Idempotent via existing `Get-MgServicePrincipalAppRoleAssignedTo` lookup. **2026-05-21 fix** — v1 spec granted `Mail.Read` only.
   - **Provision (or reuse) the mail-enabled security group `sg-aegis-mailsender-scope-<env>`** in the same domain as `<upn>`. See §C.20 for the sharp-edge rationale (shared mailboxes' backing Entra user is `AccountEnabled=false`, which `New-ApplicationAccessPolicy -PolicyScopeGroupId` rejects as "not a security principal"). Bootstrap creates the group if absent (`New-DistributionGroup -Type Security`), waits ~15s for Exchange directory replication, and adds the mailbox as a member. Both steps idempotent.
   - **Provision the Application Access Policy** scoping both grants to the wrapper group:
     - Connect via the Exchange Online PowerShell module (`Connect-ExchangeOnline -ShowBanner:$false`).
     - `Get-ApplicationAccessPolicy | Where-Object AppId -eq <mailSenderAppId>` → if exists, no-op.
     - Else `New-ApplicationAccessPolicy -AppId <mailSenderAppId> -PolicyScopeGroupId <scopeGroupSmtp> -AccessRight RestrictAccess -Description "Aegis mailSender MI restricted to scope group <scopeGroupSmtp> (member: <upn>) (ADR-0030 §C)"`.
     - Print summary: `[bootstrap-entra] Phase C — Mail.Send + Mail.ReadWrite on mailSender MI, scoped to group <scopeGroupSmtp> (member: <upn>) via Application Access Policy.`
   - **PowerShell-module prerequisite**: bootstrap pre-flights `Get-Module -ListAvailable ExchangeOnlineManagement`. Absent → fail-clear with `Install-Module ExchangeOnlineManagement -Scope CurrentUser`.
   - **Exchange admin role**: the AAP cmdlets require Exchange Administrator (or Exchange Recipient Administrator). Bootstrap is interactive (Graph + Exchange Connect calls may launch a browser sign-in); the operator running `azd up` for the first time MUST be Exchange admin OR the Phase C section must be deferred. Documented in Aegis onboarding runbook; bootstrap does not pre-flight the role assignment.

5. **Admin opt-in (operator-managed, post-deploy)**:
   - Admin navigates to `/admin/email` (new section, Slice 1(d)).
   - Sets `enabled: true`, recipient list, optional subject prefix. Saves. TenantSettings row `report-email-config` written.
   - Until this admin opt-in step lands, the `POST /api/reports/snapshots/{periodKey}/email` endpoint returns `503 not_configured` with the next-step message — the bootstrap-graph wiring alone doesn't enable sends.

#### Why two-step opt-in (mailbox env var + admin enable)

- **Mailbox env var (pre-deploy)** gates the infra-level grant. Without the env var, no Graph permissions are granted to anyone. This is the WS10-relevant gate — a misconfigured deploy can't accidentally send mail.
- **Admin enable (post-deploy)** gates the runtime feature. Even with mailbox + grants in place, no send happens until the admin consciously activates it. This protects against "I set up the infra months ago, forgot, and now a runaway scheduled job is mailing the board".

Both gates default-off. Phase A and B function identically with Phase C inert; the only operator-visible cue is a "Email Config (not yet configured)" greyed item in the admin nav, which links to the runbook for the env-var setup.

### C.15 Configurable variables — Bicep + env

Phase C introduces these operator-facing knobs:

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `AZURE_MAIL_SENDER_UPN` | azd env | unset | UPN of the sender mailbox; gates bootstrap Phase C wiring. |
| `AZURE_MAIL_SENDER_REQUIRED` | azd env | `false` | When `true`, missing/invalid mailbox fails the deploy. Defaults to soft-skip. |
| `REPORT_EMAIL_DAILY_CEILING` | FA app setting | `10` | Per-tenant daily send ceiling. Dedicated, not shared with `ADMIN_RUN_DAILY_CEILING` per C.5. |
| `MAIL_SENDER_MI_CLIENT_ID` | FA app setting | populated by Bicep | Client ID of the mailSender MI; consumed by `reportEmail.ts` orchestrator. |
| `report-email-config.schemaVersion` | TenantSettings row | `1` | Wire-format version; reader code branches on it. Every `report-email-*` row carries one. |
| `report-email-config.enabled` | TenantSettings row | `false` | Admin-toggleable runtime opt-in. |
| `report-email-config.recipients` | TenantSettings row | `[]` | Recipient list (DL or individual addresses; capped at 20 listed). |
| `report-email-config.senderMailbox` | TenantSettings row | `AZURE_MAIL_SENDER_UPN` (echoed) | Read-only mirror — admin UI shows it but operator changes it via env. |
| `report-email-config.subjectPrefix` | TenantSettings row | `""` | Optional subject prefix. |
| `report-email-config.allowExternalRecipients` | TenantSettings row | `false` | External-egress opt-in. |

Idempotency cache (C.5.1) + send-history rows (C.7) are internal TenantSettings dynamic-RowKey writes by the `mailSender` MI — no operator knob; row prefix `report-email-*` is rejected by `patchSettings`. Both row families carry `schemaVersion: 1`.

DL-expansion + `Group.Read.All` grant dropped per operator §10.74 risk-acceptance (see C.3) — Aegis hands recipients to Graph as-given; Exchange resolves DLs.

WORM retention parameter dropped per operator §10.74 risk-acceptance — send-history rows live in TenantSettings; no separate blob container.

### C.16 Send-history pagination wire shape

`GET /api/reports/email/sends` — admin-only reader for the send-history rows. Mirrors `/api/briefs/history` pagination conventions:

```jsonc
// GET /api/reports/email/sends?limit=20
{
  "items": [
    {
      "schemaVersion": 1,
      "graphMessageId": "AAMkAGI2...",
      "periodKey": "2026-W19",
      "sentAt": "2026-05-13T09:14:02Z",
      "senderMailbox": "noreply@x.com",
      "recipientCount": 3,
      "externalRecipientCount": 0,
      "operatorPrincipal": "admin@x.com",
      "triggeredBy": "admin",
      "auditLineSeq": 142
    }
    // ... up to `limit` items
  ],
  "continuationToken": "<opaque>" | null
}

// GET /api/reports/email/sends?limit=20&continuationToken=<token>
// → next page; null token in response when there are no more rows.
```

- Default `limit=20`; server-side cap `limit=100`.
- Ordering: descending by `sentAt` (newest first).
- `continuationToken` is the Azure Tables continuation marker, opaque to clients.
- Each item is the send-history row **projected** — full `recipients[]` list NOT included in the list response; clients fetch `GET /api/reports/email/sends/{graphMessageId}` to read it (mirrors how `getReportSnapshot` is a separate call from `listReportSnapshots`). Keeps the list response small + PII-minimised by default.
- Right-to-erasure: `DELETE /api/reports/email/sends/{graphMessageId}` removes the plaintext row only; audit chain entries stay. See C.10 + the erasure semantics in C.7.

### C.17 Test strategy without a real sender mailbox

Phase C's live surface depends on a real Exchange Online mailbox + Graph + Application Access Policy. CI doesn't have any of those. Two-layer test strategy:

**Unit + mocked-Graph (CI, always runs):**

- `graphPost` retry behaviour (mock 429 → retry, mock 503 → retry, mock 200 → return).
- `parseRetryAfterMs` (already covered in §10.72 via the ARM client tests; same logic applies).
- `reportEmail.ts` orchestrator: mock the Graph layer; assert (a) intent line emitted before send, (b) sendMail payload shape (subject + body + recipients), (c) sent line emitted on 200, (d) failed line emitted on 400, (e) idempotency replay returns cached result, (f) inert detection returns 503 before any Graph call.
- `emailReportSnapshot.ts` HTTP handler: mock the orchestrator; assert auth gate + rate limit + idempotency-key parsing + 503 inert path.
- `captureReportSnapshotCore` lib helper extracted from `captureReportSnapshot.ts`: existing capture tests inherit; new tests for the auto-capture-from-email path.
- TenantSettings dynamic-RowKey writes/reads: assert `report-email-*` rejection at the patchSettings validator + RowKey-prefix isolation.

**Integration (operator-run, gated on env):**

- `npm test -- --integration` with `AZURE_MAIL_SENDER_UPN` + a real Bearer in env.
- Sends a test email to the configured mailbox-as-recipient (sender = recipient = same mailbox); asserts Graph 202 + audit chain entries + send-history row.
- WS10 review: the integration test file is opt-in only; CI doesn't run it.

**Live smoke (manual after deploy):**

- Operator clicks "Send test email" in `/admin/email` (Phase 1(d) UI) — sends a minimal envelope to the sender mailbox itself.
- Operator verifies receipt in Outlook + checks `/admin/email/sends` shows the row + chain entries.

No `dryRun` mode in v1 — the inert detection (C.5.2) + unit-test coverage replace the need. If a customer asks for dry-run later, add it as a Phase C v2 query-string flag.

### C.18 Dev vs prod posture (operator §10.74 batch 3)

Operator chose: prod defaults stricter than dev across two axes.

| Setting | Dev | Prod |
|---|---|---|
| `AZURE_MAIL_SENDER_REQUIRED` | soft default `false` (skip-when-unset OK) | hard default `true` (deploy fails if `AZURE_MAIL_SENDER_UPN` missing/invalid) |
| `allowExternalRecipients` admin-UI toggle visibility | visible + editable | **hidden in the UI**; manual TenantSettings edit required (forces a deliberate, audit-visible change) |
| `report-email-config.enabled` default | `false` (admin opt-in) | `false` (admin opt-in — same) |
| `report-email-config.allowExternalRecipients` default | `false` | `false` |

Detection: the SPA reads the existing `apiConfig.environment` value (or the SWA build-time env var) and conditionally renders the toggle. Bootstrap reads `AZURE_ENV_NAME` (existing convention) and sets `AZURE_MAIL_SENDER_REQUIRED` default accordingly when the variable is unset.

Defence-in-depth rationale: a dev habit ("yeah it'll work, set allowExternalRecipients=true") shouldn't accidentally carry forward to prod misconfiguration. The hidden toggle in prod forces the operator to explicitly write to TenantSettings via `az storage` or a one-off CLI tool, creating a clear, audit-visible event in the change-management trail.

The UI difference is the only behavioural delta; the wire-format (TenantSettings row shape) is identical across environments — a dev → prod export is byte-portable.

### C.19 Microsoft licensing summary (operator §10.74 verification, May 2026)

Verified against Microsoft Learn (`learn.microsoft.com/exchange/permissions-exo/application-rbac` + `learn.microsoft.com/graph/auth-limit-mailbox-access` + `learn.microsoft.com/graph/outlook-send-mail-from-other-user`) — current as of May 2026.

#### Sender mailbox options

| Option | Microsoft licence required on the mailbox | Aegis support | Recommended for |
|---|---|---|---|
| **Shared mailbox** | None. Free up to 50 GB storage. Tenant must have ≥1 Microsoft 365 subscription somewhere for Exchange Online to exist. | ✅ Phase C v1 | Standard automation-sender pattern (`noreply@<tenant>`). Operator default recommendation. |
| **Licensed user mailbox** | Any Exchange Online plan: Microsoft 365 Business Basic / E1 / E3 / E5 / Office 365 F3 / etc. | ✅ Phase C v1 | Operator scenarios needing interactive sign-in to the sender mailbox (rare; troubleshooting). |
| **Microsoft 365 Group mailbox** | None on the group; underlying members have their own licences. | ❌ Out of scope v1 | (Different addressing model; would need a different orchestrator path.) |
| **Mail-enabled DL** | None on the DL; DLs route to members. | ❌ DLs are recipient-only, not sender-capable | n/a |
| **No mailbox / app-only "from"** | n/a | ❌ Not supported by Graph `sendMail` | n/a |

#### What Microsoft DOES NOT require for Phase C

- **No "Send As" / "Send On Behalf" grant on the mailbox.** App-permission Mail.Send + AAP/RBAC scope authorise the send. Send-As is for delegated (user-context) scenarios only.
- **No mailbox licence for shared mailboxes** under 50 GB storage. Aegis sends are KB-scale and don't accumulate (`saveToSentItems: false`).
- **No per-recipient licence.** Recipients (internal or external) are addressed by their email address; Aegis doesn't touch their licence state.
- **No additional Exchange admin role on the running operator at deploy time** beyond what `New-ApplicationAccessPolicy` requires (Exchange Administrator OR Exchange Recipient Administrator). Once provisioned, the AAP persists and bootstrap idempotent re-runs no-op.

#### Cost ceiling for Phase C (worst-case scenario, single-tenant dev)

- Sender mailbox: shared → £0.
- Storage: `saveToSentItems: false` → £0 sender-side accumulation.
- Mail.Send API: unmetered for app-permission Graph calls under tenant's existing Microsoft 365 subscription.
- Exchange Online "send capacity": ~10,000 recipients/day soft limit (per Microsoft documentation for Exchange Online; well above Aegis's 10/day × ≤20 recipients = 200/day ceiling).
- AAP provisioning: one-time, free.
- Aegis `mailSender` MI: free (user-assigned MIs have no cost).

**Net incremental cost of Phase C over Phase A/B: £0 (assuming shared-mailbox model + existing tenant Microsoft 365 subscription).**

#### What WOULD trigger additional licensing

- Operator chooses a licensed user mailbox: £5/mo+ per dedicated sender mailbox (UK Business Basic May 2026 retail).
- Operator sends > 10,000 recipients/day cumulative: hit Exchange Online's daily soft limit; need higher-tier mailbox plan or split across multiple sender mailboxes.
- Sender mailbox grows > 50 GB (impossible with `saveToSentItems: false`).

These are deliberately out-of-scope: operator chose the default-low-cost path and the design accommodates either choice.

#### References

- `learn.microsoft.com/exchange/permissions-exo/application-rbac` — RBAC for Applications (replacement for AAP).
- `learn.microsoft.com/exchange/permissions-exo/application-access-policies` — Application Access Policies (legacy, deprecation TBD).
- `learn.microsoft.com/graph/auth-limit-mailbox-access` — limiting application permissions to specific mailboxes.
- `learn.microsoft.com/graph/outlook-send-mail-from-other-user` — Mail.Send patterns for sending from another user (shared + licensed).

### C.20 Mail-enabled security group wrapper for AAP scope (operator §10.76, May 2026)

#### What we hit

First live-fire of Phase C (operator `noreply@picnic-dev.co.uk`, shared mailbox, 2026-05-12) succeeded on Graph grants (`Mail.Send` + `Mail.Read`) but failed at AAP creation:

```text
New-ApplicationAccessPolicy ... -PolicyScopeGroupId noreply@picnic-dev.co.uk
→ "The identity of the policy scope is not a security principal."
```

Mail.Send was therefore granted **tenant-wide** for the duration of the run (graph grant landed; AAP scope did not). Dev soft-skipped per §C.18 posture; prod would have hard-failed.

#### Root cause

Shared mailboxes in Exchange Online are backed by an Entra ID user account with `AccountEnabled=false` (Microsoft's default; the account exists for mailbox addressability but cannot sign in). `New-ApplicationAccessPolicy -PolicyScopeGroupId <upn>` resolves the UPN to the backing user, then validates that the resolved recipient is a security principal — a disabled account fails this validation. The same UPN would have succeeded if the operator chose a **licensed user mailbox** (backing account is `AccountEnabled=true`).

This is a known sharp edge — `learn.microsoft.com/graph/auth-limit-mailbox-access` documents the workaround obliquely under "scoping by group rather than by mailbox" but does not call out the shared-mailbox failure mode by name.

#### Resolution — wrap in a mail-enabled security group

Bootstrap auto-provisions a **mail-enabled security group** (`sg-aegis-mailsender-scope-<env>`) in the same SMTP domain as `<MailSenderUpn>`, adds the mailbox as a member, and scopes the AAP to the group instead of the mailbox UPN. The group IS a security principal regardless of the member's account state.

Why this works under app-permission Mail.Send:

- AAP evaluates `PolicyScopeGroupId` against the **sender mailbox** in the Graph URL (`/users/{upn}/sendMail`).
- Exchange's recipient resolver checks whether the sender mailbox is "in scope" by expanding the group's membership.
- Membership-based scoping is functionally equivalent to mailbox-based scoping for a 1-member group.

Both shared and licensed mailboxes work under the same wrapper — bootstrap doesn't branch on mailbox type for this step.

#### Choices considered + rejected

- **Re-enable the backing user account** (`Update-MgUser -AccountEnabled $true`). Single-line fix, but reverses one of the two security properties of a shared mailbox (no interactive sign-in); the other (no licence cost) survives. Rejected because the group-wrapper is the Microsoft-documented pattern and works uniformly across mailbox types.
- **Use a licensed user mailbox.** Just works under the original code path. Rejected as default because shared-mailbox is the recommended automation pattern + zero licence cost (§C.19).
- **Migrate to Exchange RBAC for Applications now.** The replacement for AAP (§C.13 forward-track). Larger bootstrap rework; deferred until Microsoft publishes a deprecation date.

#### Bootstrap script changes (`scripts/bootstrap-entra.ps1`)

Inside the existing `try { Connect-ExchangeOnline … }` block, BEFORE `New-ApplicationAccessPolicy`:

1. Derive `$mailSenderScopeGroupAlias = "sg-aegis-mailsender-scope-$Env"` and `$mailSenderScopeGroupSmtp = "$mailSenderScopeGroupAlias@$<domain-of-MailSenderUpn>"`.
2. `Get-DistributionGroup -Identity $alias` — treat "not found" as empty, re-throw other errors.
3. If absent: `New-DistributionGroup -Name <alias> -DisplayName "Aegis Mail Sender Scope (<env>)" -Alias <alias> -PrimarySmtpAddress <smtp> -Type Security -Description "Aegis mailSender MI AAP scope wrapper (<env>). Members: only the mailSender mailbox. Do not repurpose."`, then `Start-Sleep -Seconds 15` for Exchange directory replication.
4. `Get-DistributionGroupMember -Identity $alias` → if `$MailSenderUpn` not a member, `Add-DistributionGroupMember -Identity $alias -Member $MailSenderUpn`.
5. `New-ApplicationAccessPolicy ... -PolicyScopeGroupId $mailSenderScopeGroupSmtp ...` (was `$MailSenderUpn`).

All steps idempotent — re-running bootstrap with the group + member already present prints "already exists" + "already a member" lines, then either no-ops AAP creation (existing) or runs it (still pending).

#### Summary surface

`phaseC` ordered dict (echoed in BOOTSTRAP_JSON) gains two new fields:

- `scopeGroup` — primary SMTP of the wrapper group (string, or `null` if not attempted).
- `scopeGroupCreated` — `true` if bootstrap created the group this run, `false` if it pre-existed, `null` if not attempted.

`mailboxAddress` continues to echo the operator-provided mailbox UPN — this is the address Graph receives in the `/users/{upn}/sendMail` URL. The scope group is *purely* an Exchange-side scoping construct; nothing in `reportEmail.ts` or the API surface references it.

#### WS10 findings folded into the bootstrap (May 2026)

The WS10 review of the group-wrapper change surfaced two MEDIUM findings, both landed before commit:

- **#1 Foreign-group collision guard.** `Get-DistributionGroup -Identity $alias` could silently bind to a pre-existing group of the same name owned by another team, silently widening Mail.Send scope to the foreign group's members. Bootstrap now validates the existing group's signature (`PrimarySmtpAddress` matches expected SMTP AND `Description` matches the Aegis wrapper string). Mismatch → hard-throw + operator investigation required, regardless of `MailSenderRequired` state.
- **#2 Sub-step status codes.** Previously, any `try { ... }` failure inside the Exchange section reported `graph_granted_aap_failed` — misleading when the failure happened at group creation or member-add. Bootstrap now tracks `$phaseCSubStep` through `exo_connect → resolve_mi_sp → scope_group_create → scope_group_member → aap` and emits one of:
  - `graph_granted_exo_connect_failed`
  - `graph_granted_mi_sp_lookup_failed`
  - `graph_granted_scope_group_create_failed`
  - `graph_granted_scope_group_member_failed`
  - `graph_granted_aap_failed`

LOW findings — status:

- ~~Replace fixed `Start-Sleep 15` post-group-create with a poll loop on `Get-DistributionGroup`~~ **DONE** (L14a, May 2026). Replaced with bounded poll: 3-second intervals up to 90 seconds total. The script captures the elapsed-time-to-visibility and prints it via `Write-Step` for operator visibility into Exchange replication latency on the tenant. Hard-fail on timeout (the previous fixed sleep would silently let AAP creation race against a slow tenant — that race is now a loud failure with a re-run hint).
- ~~Doc callout that AAP gates `/me/sendMail`~~ **DONE** (L14b, May 2026). See §C.20.1 below.
- ~~§C.20 monitoring on `IsAssignableToRole` flip~~ **DOC-ONLY** (L14c, May 2026). See §C.20.2 below — operational runbook recommended; not implemented in code v1.
- ~~Membership-drift detection cron~~ **DOC-ONLY** (L14d, May 2026). See §C.20.3 below.

#### C.20.1 Why AAP gates the API surface we use (`/users/{upn}/sendMail`)

Aegis sends with **app-only auth** (Bearer JWT bound to the `mailSender` MI) hitting `POST /users/{upn}/sendMail`. There is no `/me/sendMail` path in Aegis because:

- `/me/*` resolves to the authenticated **user's** mailbox. App-only tokens have no user context — Graph rejects `/me/*` with `BadRequest` ("The request is not valid for the application's 'OnBehalfOf' context").
- `/users/{upn}/sendMail` resolves the target mailbox by UPN AND applies app-permission scoping. This is the path AAP gates.

AAP enforcement model:

1. Graph forwards the send to Exchange Online's SendMail permission check.
2. Exchange resolves the `mailSender` MI's appId against the AAP table.
3. If a policy exists AND it has a `PolicyScopeGroupId`, Exchange evaluates whether the sender mailbox (`{upn}` in the URL) is in scope: i.e., whether the mailbox is a member of the scope group's expanded membership.
4. In-scope → send proceeds. Out-of-scope → `403 Forbidden` with `ErrorAccessDenied`.

The same gate applies to **draft + send-draft** flows (`POST /users/{upn}/messages` + `POST /users/{upn}/messages/{id}/send`), which is the pattern Aegis uses (§C.6) so the orchestrator can attach `internetMessageHeaders` before send. Both Graph calls flow through the same Exchange SendMail permission check.

Aegis does NOT use:

- `/me/sendMail` — would fail with `BadRequest` on app-only token (no user context).
- `POST /users/{upn}/sendMail` (the direct send path without the draft) — equally AAP-gated; functionally interchangeable but loses the headers-on-draft option.
- Batch endpoints (`$batch`) — out of scope for Phase C v1; each inner request would still be AAP-gated.

#### C.20.2 `IsAssignableToRole` operator monitoring runbook

The wrapper security group is created with default `IsAssignableToRole = $false`. If an Exchange admin (or a tenant misconfiguration script) flips this property to `$true`, the group becomes a privileged-access-target and gets pulled into different Entra-side access-review and PIM treatments — none of which Aegis intends. Bootstrap MUST stay at the default.

Operator monitoring options (pick one):

1. **Azure Monitor scheduled query rule** against `AuditLogs` in the Entra ID workspace:

   ```kusto
   AuditLogs
   | where TimeGenerated > ago(15m)
   | where OperationName == "Update group"
   | where TargetResources has "sg-aegis-mailsender-scope-"
   | where ModifiedProperties has "IsAssignableToRole"
   | project TimeGenerated, InitiatedBy, TargetResources, ModifiedProperties
   ```

   `TargetResources` matches on the group's serialised representation, which includes the `mailNickname` / alias (`sg-aegis-mailsender-scope-<env>`) — alias-based matching is more stable than `displayName` and survives display-name edits.

   Alert on any row. Severity 2; route to ops mailbox.
2. **Microsoft Defender for Cloud Apps policy** — "Activity from infrequent country" + "Group modification" templates can be retargeted at the wrapper group via its alias.
3. **Manual quarterly audit** — `Get-DistributionGroup sg-aegis-mailsender-scope-<env> | Select IsAssignableToRole` should always return `$false`.

Aegis does NOT ship a Function App Timer for this check in v1 — the property is set at group creation and only changeable by Exchange admin or Graph-direct calls, both of which Microsoft already audits via AuditLogs. KQL-based detection (option 1) is the operator-recommended approach.

Bonus KQL — alert on description edits (the foreign-group-collision signature, WS10 §C.20 finding #1). A description edit doesn't widen privileges itself but would silently change the signature bootstrap re-runs use to identify "is this our group?"; the next re-run would refuse to bind. Catch it before the next deploy:

```kusto
AuditLogs
| where TimeGenerated > ago(15m)
| where OperationName == "Update group"
| where TargetResources has "sg-aegis-mailsender-scope-"
| where ModifiedProperties has "Description"
| project TimeGenerated, InitiatedBy, TargetResources, ModifiedProperties
```

#### C.20.3 Membership-drift detection runbook

The wrapper group's intended membership is exactly `{<MailSenderUpn>}`. Drift scenarios:

- An Exchange admin adds a second mailbox → the AAP silently widens to also permit Mail.Send from that mailbox.
- A re-key / mailbox-rename leaves the group pointing at an orphaned recipient → bootstrap re-run fails silently if the orphan resolves but doesn't match expected SMTP.

Detection options (pick one):

1. **KQL scheduled query** against AuditLogs, similar to §C.20.2 but filtering on member operations against the wrapper group's alias:

   ```kusto
   AuditLogs
   | where TimeGenerated > ago(15m)
   | where OperationName in ("Add member to group", "Remove member from group", "Update group")
   | where TargetResources has "sg-aegis-mailsender-scope-"
   | where OperationName != "Update group"
       or ModifiedProperties has "Group.Member"
   | project TimeGenerated, OperationName, InitiatedBy, TargetResources, ModifiedProperties
   ```

   Severity 1; route to ops mailbox. The `Update group` + `Group.Member` clause catches Exchange-Online-initiated distribution-group membership edits, which historically log under `Update group` with the membership delta in `ModifiedProperties` rather than as discrete `Add member` / `Remove member` events.
2. **Quarterly script audit** — `Get-DistributionGroupMember sg-aegis-mailsender-scope-<env>` should always return one row with `PrimarySmtpAddress == <MailSenderUpn>`. Re-run bootstrap (`bootstrap-entra.ps1 -MailSenderUpn $u`) on drift — the script's foreign-group-collision guard (§C.20 WS10 finding #1) will refuse to bind if the description signature changes, but membership ADDITION does not change the description.

Aegis does NOT ship a Function App Timer for this check in v1. If telemetry shows drift occurring on dev/prod tenants (operator can grep AzAuditLogs by hand the first few weeks), promote to a Timer-based check then.

#### Posture caveats + monitoring obligations

- **Group must not be repurposed.** The wrapper group's `Description` calls this out, but it is a soft control — an operator with Exchange admin rights could add another mailbox to the group and the AAP would silently widen. Pre-commit `WS10` check + the existing `report-email-config` admin endpoint reject inbound writes with this kind of side-channel privilege escalation, but the group itself is unprotected.
- **Forward-track to Exchange RBAC for Applications** (§C.13) carries this group across — under RBAC for Apps, the group becomes the `RecipientRestrictionFilter`'s scope rather than the AAP's `PolicyScopeGroupId`. Migration is a script change, not a re-architecture.
- **Membership drift detection** is out of scope for Phase C v1. A future cron could verify the scope group's membership matches `{$MailSenderUpn}` and alert on drift. Captured as a follow-up, not a blocker.

#### References

- `learn.microsoft.com/graph/auth-limit-mailbox-access` — Microsoft's "scoping app permissions to mailboxes" doc; mentions group-based scoping pattern.
- `learn.microsoft.com/powershell/module/exchange/new-applicationaccesspolicy` — `New-ApplicationAccessPolicy` cmdlet reference (PolicyScopeGroupId valid types).
- `learn.microsoft.com/exchange/recipients-in-exchange-online/manage-mail-enabled-security-groups` — mail-enabled security group cmdlet usage (creates via `New-DistributionGroup -Type Security`, not `New-MailEnabledSecurityGroup` — confusingly, the latter does not exist).

### C.21 Recipient-hash pepper (Key Vault) — WS10 L12

#### What changed

The pre-pepper `recipientHashSalted` audit-line field was `sha256(tenantId : canonical-recipients)` — tenant-bound but vulnerable to a rainbow-table attack on an audit-blob leak. Board distribution lists tend to be guessable (`board@`, `directors@`, named directors), and the sha256 output is deterministic per (tenantId, recipient-set), so an attacker with read access to the audit chain could enumerate likely recipient lists offline.

L12 closes this by introducing a Key Vault–backed pepper. The new field is `recipientHashSaltedV2 = sha256(pepper : tenantId : canonical-recipients)` where `pepper` is a 256-bit random secret never present in the audit chain or any other persisted artifact. An audit-blob leak no longer reveals enough material for the rainbow-table attack: the attacker would also need read access to the Key Vault.

#### Field migration

- Pre-pepper intent lines carry `recipientHashSalted` (legacy). Forever valid — the audit chain is append-only.
- Post-pepper intent lines carry `recipientHashSaltedV2`. They DO NOT also emit the legacy field — chain readers branch on field presence.
- Historical chain replay shows a clean transition at the deploy moment: lines before the pepper land carry the legacy field, lines after carry V2.
- The verifier (`scripts/verify-audit-chain.mjs`) treats both as opaque strings — it never re-derives them. ADR-0015 chain integrity is preserved across the migration with no special handling.

#### Fail-soft posture (default)

The orchestrator NEVER blocks a send on KV availability **by default**. If `RECIPIENT_HASH_PEPPER_KV_NAME` is unset, the secret is missing, or the KV read fails, the orchestrator falls back to the legacy hash and emits an `AIEVENT report.email.pepper.fallback` with the reason (`env_unset`, `kv_read_failed`, or `empty_secret`). Pepper is defense-in-depth — operationally the audit chain primitive is the integrity guarantee; the pepper is a forensic-hardening additive.

The cached `LoadPepperResult` is module-scoped per Function App instance. A KV outage between cold-starts is sticky for the warm process — operators rotating the pepper MUST restart the Function App so the cache picks up the new value. The rotation script does this automatically when `-FunctionAppName` is supplied.

#### Hard-fail posture (operator-controlled, SEC-L-L12-01)

The fail-soft posture is appropriate while peppered hashing is being rolled out — first deploys may legitimately not have a pepper provisioned yet. Once the pepper is confirmed live, the operator can opt into hard-fail by setting:

```bash
azd env set AZURE_RECIPIENT_HASH_PEPPER_REQUIRED true
azd provision  # picks up the new app setting on the Function App
```

When `RECIPIENT_HASH_PEPPER_REQUIRED` is the literal string `"true"` (case-insensitive, whitespace-trimmed), `loadRecipientHashPepper()` throws `RecipientHashPepperRequiredError` instead of returning a null pepper. The handler maps the throw to **502 `recipient_hash_pepper_required`**, the SPA renders the standard send-error banner, and the audit chain stays on V2 — no silent downgrade to the legacy field.

Recommended posture per env:

- **dev**: leave unset / empty (fail-soft) — supports KV-down developer workflow.
- **prod**: set to `true` after the first live-fire send has been confirmed to emit `recipientHashSaltedV2`. From that point a KV regression returns 502 immediately rather than persisting a fail-soft AIEVENT that an operator might not notice for days.

Cache semantics: the flag is checked on every `loadRecipientHashPepper()` call, against the cached `LoadPepperResult`. Flipping the flag on at runtime against an already-cached null pepper will hard-fail on the next call without re-reading KV — operators should treat the flag flip as a config change requiring an FA restart so the cache re-reads on the first send.

#### RBAC + Bicep

`infra/modules/keyvault.bicep` declares two role assignments (built-in Azure roles, no custom RBAC):

- `Key Vault Secrets User` (`4633458b-...`) on the mailSender MI — read access for the orchestrator.
- `Key Vault Secrets Officer` (`b86a8fe4-...`) on the deployer object — write access for the provisioning script.

The deployer grant is the only post-Phase-E change to the Aegis KV. Operators MUST set `AZURE_DEPLOYER_OBJECT_ID` in the azd env before `azd provision`:

```bash
# Operator-laptop deploy (default — principalType defaults to User):
azd env set AZURE_DEPLOYER_OBJECT_ID $(az ad signed-in-user show --query id -o tsv)

# Headless / CI deploy under a service principal:
azd env set AZURE_DEPLOYER_OBJECT_ID <sp-object-id>
azd env set AZURE_DEPLOYER_PRINCIPAL_TYPE ServicePrincipal
```

**L12-FT-FT-OPERATOR-FLIP-DOC invariant.** `AZURE_DEPLOYER_OBJECT_ID` and `AZURE_DEPLOYER_PRINCIPAL_TYPE` MUST be flipped together when migrating between operator-laptop and CI deploys. A mismatched pair (e.g. SP object ID + `User` type, or User object ID + `ServicePrincipal` type) is accepted by Azure today for built-in role assignments, but a future RBAC tightening could reject mismatched assignments — the resulting role assignment then becomes durably wrong. The `keyvault.bicep` `deployerPrincipalType` param defaults to `'User'`; ONLY override via the env var, never edit the Bicep default directly. Empty `AZURE_DEPLOYER_OBJECT_ID` disables the grant entirely (the principalType is moot in that case — operator must run the provisioning scripts out-of-band).

Empty `AZURE_DEPLOYER_OBJECT_ID` leaves the grant unprovisioned — the API stays on the legacy hash and emits the AIEVENT fallback indefinitely.

Both role assignments now carry SEC-L-L12-04 per-secret ABAC conditions (closed 2026-06-22 / [`db784f3`](db784f3)). The `mailSender` MI's Secrets User grant is gated to `recipient-hash-pepper` only; the `api-reader` MI's grant (added with chunk 4) is gated to `report-share-signing-key` only; the deployer's Secrets Officer grant is gated to the two-secret allowlist (closed 2026-06-22 / [`aa2c309`](aa2c309)).

#### Provisioning (first deploy)

After `azd provision` lands the Bicep changes, run:

```bash
./scripts/provision-recipient-hash-pepper.ps1 \
    -KeyVaultName kv-aegis-dev-uks \
    -FunctionAppName func-aegis-api-dev-2435ae1d \
    -ResourceGroupName rg-aegis-dev-uks
```

The script:

1. Verifies `az login` context.
2. Checks if the secret already exists in KV (`-Mode Provision` is no-op if so).
3. Generates 32 cryptographically-random bytes via `System.Security.Cryptography.RandomNumberGenerator` (NOT `Get-Random` — that's documented as non-cryptographic).
4. Base64-encodes the bytes.
5. Writes via `az keyvault secret set --file <tmp>` (NOT `--value <inline>` — keeps the secret out of process command lines / audit logs).
6. Restarts the Function App.

`-WhatIf` for dry-run.

The script is idempotent in `Provision` mode — safe to re-run on every deploy. Use `-Mode Rotate` to force a new secret version even if one exists.

#### Rotation (on-demand)

Operator triggers rotation in response to:

- Departing operator with KV Secrets Officer access (revoke their access, rotate so any pepper they may have observed is no longer in use).
- Suspected audit-blob leak.
- Compliance-driven scheduled rotation (annual, etc. — Aegis does not auto-rotate; the operator runs the script on a schedule of their choice).

Command:

```bash
./scripts/provision-recipient-hash-pepper.ps1 -Mode Rotate \
    -KeyVaultName kv-aegis-dev-uks \
    -FunctionAppName func-aegis-api-dev-2435ae1d \
    -ResourceGroupName rg-aegis-dev-uks
```

KV writes a new secret version; the SecretClient `getSecret(name)` (without an explicit version) returns the latest version. The Function App restart forces every instance's module-scope cache to re-read on the next send. From that point forward all `recipientHashSaltedV2` values use the new pepper.

Old `recipientHashSaltedV2` values (computed with the previous pepper) remain in the audit chain forever — there is no concept of "re-pepper historical lines". A forensic replay against the *current* pepper would not reproduce them, but each individual line's `lineSha256` is still valid (the chain hashes the line content including the fingerprint, so chain integrity is unaffected by rotation).

**Rotation-skew window (WS10 SEC-L-L12-02).** When multiple Function App instances are warm (Flex Consumption scales 1–N), the rotation script restarts them via `az functionapp restart` but the restart happens per-instance with a small stagger. For up to ~30 seconds after the restart command, adjacent intent lines for the same tenant can carry `recipientHashSaltedV2` values computed against DIFFERENT peppers — the just-restarted instance uses the new value, the still-restarting instance uses the cached old value. This is operationally invisible (the fingerprint is opaque to consumers) and forensically tractable (a replay against EITHER pepper will reproduce one of the two cohorts). Operators investigating a rotation should not be surprised by the brief multi-value window.

#### What rotation does NOT do

- Does NOT re-hash historical intent lines (ADR-0015 §6 — chain is append-only).
- Does NOT invalidate the idempotency cache (24h TTL; see §C.5.1).
- Does NOT trigger any recipient-side re-notification (the recipient set is unchanged; the pepper change is invisible outside the audit chain).
- Does NOT require coordination with the operator's email infrastructure.

#### Disaster recovery

If the pepper secret is accidentally deleted from KV:

1. The next send falls back to the legacy hash (with an AIEVENT). Operator sees the warning in telemetry.
2. Operator runs `provision-recipient-hash-pepper.ps1 -Mode Provision` (since the secret no longer exists, this becomes a fresh provision).
3. Function App restart picks up the new pepper.
4. Audit chain remains intact: legacy `recipientHashSalted` values bracket the gap on either side of the original pepper era; new `recipientHashSaltedV2` values resume from the recovery.

Soft-delete + purge protection on the KV (Bicep `softDeleteRetentionDays`, `purgeProtection`) provide a 7–90 day window to recover the original secret if the deletion was unintentional.

#### References

- `learn.microsoft.com/azure/key-vault/secrets/about-secrets` — Key Vault Secrets fundamentals.
- `learn.microsoft.com/azure/key-vault/general/rbac-guide` — RBAC vs access policies for Key Vault.
- `learn.microsoft.com/dotnet/api/azure.security.keyvault.secrets.secretclient.getsecret` — `getSecret(name)` returns latest version by default.

### C.22 Email-to-link delivery — signed share-link tokens

#### What changed

Pre-§C.22, the email body carried a rendered KPI digest of the report. The full HTML report (`reportHtml.ts`, ~1500 lines, EntraRisk + ControlScores + prior-period deltas + incidents + risky users) was reachable only through the SPA at `/reports`. The email render (`reportEmailRender.ts`, ~290 lines, table-based for Outlook-compat) covered only the top three headline metrics. Two divergent renderers, ongoing parity-drift cost on every new section.

§C.22 retires the rich email render. The email body now carries:

- A one-line summary derived from the same KPI extractors as before.
- An "Open full report →" button + a plain text URL fallback (Outlook strip-styles).
- The URL points at a new public endpoint `GET /api/reports/share/{token}` that renders the canonical HTML report via `renderEnvelopeHtml(envelope)` — the same renderer the SPA's print view uses.

Recipients click the link. The endpoint verifies the signed token, loads the snapshot, renders the HTML, returns it. One source of truth for the report; one renderer to maintain.

#### Token wire format

```text
<base64url(canonical-JSON(claims))>.<base64url(HMAC-SHA256(key, body-bytes))>

claims = {
  v: 1,            // format version
  t: <tenantId>,   // GUID
  p: <periodKey>,  // "2026-05" / "2026-Q2" / "2026-W19"
  exp: <unix-s>,   // expiry (seconds since epoch)
  jti: <uuid>      // per-token id (reserved for future per-link revocation)
}
```

JCS canonicalisation (ADR-0015 §2) before HMAC so JSON key-order variance can't break verification. Constant-time HMAC compare via `crypto.timingSafeEqual`. Custom base64url decoder rejects non-alphabet chars (prevents the `Buffer.from("base64")` silent-ignore evasion). Strict check ordering: malformed → bad_signature → invalid_claims → unsupported_version → expired — so an attacker without the key can't probe claim-shape semantics via error-reason variance. See `api/src/lib/reportShareToken.ts` for the implementation; `reportShareToken.test.ts` (22 cases) for the contract.

#### TTL + ceiling

- **Default TTL: 14 days** from issue (`DEFAULT_SHARE_TOKEN_TTL_MS`). Long enough that a recipient who opens an email a week late still gets the report; short enough that a forwarded link doesn't outlive the snapshot's relevance.
- **Issuer-side ceiling: 90 days** (`MAX_SHARE_TOKEN_TTL_MS`). `signReportShareToken` throws on `expiresAtMs > Date.now() + 90d`. Defence-in-depth against a future caller bug or compromised process minting a year+ long link that bypasses rotation hygiene.
- Operator-configurable TTL is forward-tracked under a TenantSettings extension; not in v1.

#### Trust model

- **The signing key is the security boundary.** An attacker without KV read on `report-share-signing-key` cannot forge tokens. An attacker with KV read can forge anything — the KV grant on the signing-key secret is the boundary.
- **Recipients can forward the link.** Anyone holding a valid, unexpired token can read the snapshot. Matches the pre-§C.22 trust model — the email body itself already carried the same data and was forwardable.
- **Rotation invalidates all outstanding links.** Rotating the KV secret produces a new key; tokens minted against the prior key fail signature verification. Use rotation as the incident-response path; communicate to operators relying on long-TTL links BEFORE rotating.

The token also lands in server access logs (App Insights `request.url`, SWA front-door logs, FA console). Anyone with log read access on the FA acquires forwardable links until `exp`. Confirm App Insights sampling/redaction posture before exposing the feature to regulated tenants (chunk-2 WS10 advisory A1).

#### Endpoint security posture

`GET /api/reports/share/{token}` is `authLevel: anonymous` — no `readClientPrincipal`, no admin-role gate. The token IS the auth. The handler is on `ANONYMOUS_ALLOWLIST` in `handlerAuthCoverage.test.ts` with the explicit rationale "token-IS-the-auth: verifyReportShareToken + KV signing key gate every response".

Status-code map:

- 400 `invalid_token` — malformed / bad-signature / wrong-version / tenant-mismatch
- 410 `link_expired` — token's `exp` has passed (user-actionable: ask sender to resend)
- 503 `share_link_unavailable` — KV signing key unavailable
- 404 `snapshot_not_found` — periodKey valid but snapshot deleted (right-to-erasure path)
- 200 — HTML body, content-type `text/html; charset=utf-8`

Response headers on EVERY response (success + error):

```text
cache-control: private, no-store
referrer-policy: no-referrer
x-content-type-options: nosniff
content-security-policy: default-src 'none'; style-src 'unsafe-inline';
  img-src 'self' data:; form-action 'none'; base-uri 'none';
  frame-ancestors 'none'
```

The CSP intentionally omits `script-src`, so the default-src 'none' applies — no JS executes regardless of envelope content. `style-src 'unsafe-inline'` is required because `reportHtml.ts` inlines `<style>` blocks; the trade-off is acceptable because envelope content reaches the renderer through `escapeHtml` everywhere user-controlled fields surface.

#### Fail-soft posture (default)

Both issuer (email send) and verifier (share endpoint) treat KV signing-key unavailability as fail-soft:

- **Issuer (`buildShareUrlOrAievent`):** when the URL base is unset/non-HTTPS or the KV key cannot be loaded, returns null. The email body falls back to the legacy KPI render. AIEVENT `report.email.share_link.fallback` fires with one of eight distinct reasons (`url_base_unset`, `url_base_not_https`, `env_unset`, `kv_read_failed`, `empty_secret`, `too_short`, `kv_unknown`, `sign_threw`). Each reason maps to a distinct remediation path.
- **Verifier (GET endpoint):** when the KV key cannot be loaded, returns 503. Distinct from "token bad" 400 so the operator can correlate KV outages quickly.

Both behaviours are appropriate for the chunk 1→4 rollout window during which the KV secret may not yet be provisioned. Forward-track: a `REPORT_SHARE_URL_REQUIRED=true` env flag (mirror of `RECIPIENT_HASH_PEPPER_REQUIRED`) lets prod opt into hard-fail after first-live-fire confirms the feature is healthy.

#### Bicep + KV RBAC

Two role assignments declared in `infra/modules/keyvault.bicep`:

- `mailSenderKvSecretsUser` — pre-existing for §C.21 pepper. Vault scope.
- `apiReaderKvSecretsUser` — new for §C.22 signing key. Vault scope. The api-reader MI is the single principal both the share endpoint and the email-issuer use for KV reads (see `reportShareSigningKey.ts` header — one grant, one cache).

Both grants are vault-scope today. With two Aegis-managed secrets now in the vault, per-secret ABAC tightening becomes meaningful — both grants could narrow to `@Resource[name] StringEquals '<secret>'`. Tracked as SEC-L-L12-04 in HANDOVER §6.3; deferred to a dedicated bicep-tightening pass.

#### Operator workflow

```bash
# (Optional) override the URL base for a custom-domain deploy:
azd env set AZURE_REPORT_SHARE_URL_BASE \
  https://reports.example.com/api/reports/share

# Provision infra (RBAC + app settings):
azd provision

# Generate + write the signing key + restart the FA:
./scripts/provision-report-share-signing-key.ps1 \
    -KeyVaultName kv-aegis-dev-weu \
    -FunctionAppName func-aegis-api-dev-weu \
    -ResourceGroupName rg-aegis-dev-weu

# Test: SPA /reports → Send by email → recipient clicks the link.
# Expected: 200 HTML report rendered via reportHtml.ts.
```

For rotation, repeat the provisioning script with `-Mode Rotate`. The FA restart at the end flushes the module-scope cache so the new key is in effect immediately. **Rotation invalidates all outstanding links** — communicate before running.

#### Forward-tracks

| ID | Item | Trigger |
|---|---|---|
| Chunk-2 A1 | App Insights sampling/redaction posture for share-link URL paths | Before regulated-tenant exposure |
| Chunk-2 A2 | Strict-Transport-Security header on the share endpoint | Opportunistic |
| Chunk-2 A3 | Audit-chain extension — `report.html.share` source emitting one line per share read | Operationally important for privacy-relevant access audit; separate WS10 review |
| Chunk-2 A4 | Loader `decode_failed` fallbackReason taxonomy | Opportunistic |
| Chunk-3 A3 | Richer `sign_threw` AIEVENT errorDetail (constructor-name allowlist) | Opportunistic |
| §C.22 chunk-5+ | `REPORT_SHARE_URL_REQUIRED=true` hard-fail flag (mirror of pepper flag) | After prod first-live-fire confirms feature health |
| SEC-L-L12-04 | Per-secret ABAC on both KV role assignments | Now actionable; dedicated bicep-tightening pass |
| Operator UX | Operator-configurable TTL via TenantSettings extension | First customer ask |

#### Migration commits (chronological)

| Commit | Chunk | What |
|---|---|---|
| `0d0ded2` | 1 | Token sign/verify primitives + 22 vitest cases |
| `48e96bf` | 2 | KV signing-key loader + GET share endpoint + handler tests |
| `5d004f2` | 3 | Email render rewrite + 90d TTL ceiling + orchestrator integration |
| `c34bd0f` | 4 | Bicep RBAC + app settings + provisioning script |
| (this) | 5 | ADR-0030 §C.22 + HANDOVER entry |

#### References

- `learn.microsoft.com/azure/key-vault/secrets/about-secrets` — Key Vault Secrets fundamentals (shared with §C.21).
- RFC 4648 §5 — base64url encoding (URL-safe alphabet, no padding).
- RFC 5234 — ABNF for the token wire shape.
- ADR-0015 §2 — JCS canonicalisation for the chain (reused for token claims).

---

**References:**

- ADR-0011 — ingestion schedule / idempotency / retry (lease + audit-chain semantics reused).
- ADR-0015 — audit log hash chain (extended with `audit.report.capture` + `report.ndjson` filename).
- ADR-0021 — agent audit log extension (filename-dispatch precedent).
- ADR-0025 — admin settings page (TenantSettings RowKey + admin gate pattern).
- HANDOVER §6.3 — open backlog (this ADR adds reporting as a tracked initiative).
