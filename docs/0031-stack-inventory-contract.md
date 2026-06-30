# ADR-0031 — Stack inventory (Phase A)

**Status:** Accepted
**Date:** 2026-04-28
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Aegis today is Microsoft-shaped: Defender XDR + Secure Score + Entra signals
flow inward, surfaced via the dashboard. The 2026-04-28 brainstorm (HANDOVER
context) widened the framing — Aegis as **single-pane-of-glass for whole
security posture**, including non-Microsoft vendors. The operator's stated
use case includes *"known exploits / vulnerabilities against software /
hardware stack, news, threat intelligence, patches"*. The first three of
those — KEV, NVD, vendor advisories — are public feeds with no auth gate.
What turns those feeds from noise into signal is **knowing what stack the
tenant runs**.

This is the spine. Without it, KEV is a feed; with it, KEV becomes
*"3 of your 47 deployed products have actively-exploited CVEs this week"*.

The phased shape this ADR settles:

- **Phase A (this ADR):** operator-curated stack inventory. CRUD endpoints
  - `/stack` page + a small bundled `stackCatalog.json` for vendor+product
  typeahead alignment. No outbound feeds yet.
- **Phase B (deferred):** CISA KEV cross-reference. Pulls the KEV daily
  feed, matches against `(vendor, product)` strings, surfaces a tile
  - per-item "this product is on KEV — patch by N" hint.
- **Phase C (deferred):** NIST NVD CVE lookup. Optional CPE auto-mapping
  on stack items so CVE matching becomes precise rather than fuzzy.
- **Phase D (deferred):** auto-discovery via Defender Vulnerability
  Management / Intune device inventory / Azure Resource Graph. Augments
  operator-curated entries with discovered ones; operator confirms or
  suppresses.

This ADR is forward-compatible with B/C/D — the row schema admits
later additions (`canonical: string | null`, `cpe: string | null`,
`discoveredBy: enum`) without migration.

The concerns this ADR settles:

1. **Schema** — what fields are required, optional, enum-bounded.
2. **Naming alignment** — how operators converge on a canonical product
   name without forcing a hard allowlist.
3. **Storage + RBAC** — which Table, which MI, what scope.
4. **Endpoints + read gate** — who can list, who can mutate.
5. **Audit trail** — does this go on the audit chain or AIEVENT.
6. **Per-tenant cap** — how big can the inventory get.
7. **Phase A out-of-scope** — what's deferred so this lands cleanly.

## Decision

### 1. Row schema

Required:

| Field | Type | Cap | Notes |
|---|---|---|---|
| `vendor` | string | ≤ 64 chars | E.g. `"Microsoft"`, `"Apache"`, `"Cisco"`. Case preserved as entered. |
| `product` | string | ≤ 64 chars | E.g. `"Windows Server"`, `"Tomcat"`, `"ASA"`. |
| `category` | enum | — | `os` \| `application` \| `network-device` \| `library` \| `service` \| `other` |
| `environment` | enum | — | `production` \| `staging` \| `development` \| `unknown` |

Optional:

| Field | Type | Cap | Notes |
|---|---|---|---|
| `version` | string | ≤ 32 chars | Free text — semver, build numbers, "Latest", etc. Empty allowed. |
| `notes` | string | ≤ 256 chars | Operator scratch space. |
| `tags` | string[] | ≤ 5 entries, ≤ 24 chars each | Lightweight grouping (e.g. `["pci-zone-a", "internet-facing"]`). |

System-managed:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID v4 | Stable RowKey — survives version edits. |
| `addedAt` | ISO-8601 UTC | Set on POST. |
| `addedBy` | string | AAD object ID of creating admin. |
| `updatedAt` | ISO-8601 UTC | Set on POST and every PATCH. |
| `updatedBy` | string | AAD object ID of last-modifying admin. |

`tags` are stored as a JSON-encoded string in the Table column to satisfy
Table Storage's "no array column type" constraint, decoded on read. This
matches the existing `EnabledServices` pattern in `tables.ts`. The 64 KB
property cap is unreachable at the documented field caps.

### 2. Naming alignment — bundled catalog + soft typeahead

A static `stackCatalog.json` ships with the API codebase (`api/src/lib/`)
containing ~200 curated `(vendor, product)` pairs covering the obvious
high-frequency cases: Microsoft 365 stack, Windows server/client, common
Linux distros (RHEL, Ubuntu, Debian, Alpine, Amazon Linux), browsers,
common server software (Apache HTTP Server, nginx, MySQL, PostgreSQL,
MongoDB, Redis, Kubernetes, Docker), common network/security vendors
(Cisco, Juniper, Palo Alto Networks, Fortinet, F5).

The catalog is **soft alignment, not enforcement**:

- `GET /api/stack/catalog` returns the JSON. Reader-or-admin. Cached
  aggressively (`max-age=3600 + private`). The catalog ships with the
  deploy and only changes on a code release.
- Admin add-row form uses HTML5 `<datalist>` for vendor + product
  typeahead. Operator picks from the suggestions OR free-form-types.
- Server stores **exactly what the operator typed**. No silent rewrites.
- Rows whose `(vendor, product)` does not match the catalog get a
  client-side `non-canonical` chip on the list row — the operator sees
  *"KEV matching may not find this"* and can fix it themselves.
- A future Phase B fuzzy-match pass during KEV cross-reference can
  surface "did you mean X?" suggestions; not in scope here.

Why not a hard allowlist: an operator running an obscure firewall
appliance, an internal-built service, or a product the catalog hasn't
seen yet must still be able to register it. Forcing the catalog
fails-closed in a way that hurts adoption without a security gain.

Why not free-form-only with a normaliser (lowercase + trim): catches
trivial dupes but doesn't help with the real divergence pattern
("Microsoft Windows Server" vs "Windows Server" vs "MS Windows" vs
"Windows"). The catalog gives the operator a default that scales.

### 3. Storage + RBAC

**Table:** `StackItems` (already declared in `infra/modules/storage-ops.bicep`
at the `tableNames` index 4 — a stub from the original ADR-0006 forward-
declaration).

| Column | Type | Notes |
|---|---|---|
| `PartitionKey` | string | `tenantId`. |
| `RowKey` | string | UUID v4 (no hyphens stripped — Table RowKey accepts hyphens). |
| `Vendor` | string | See §1 |
| `Product` | string | See §1 |
| `Version` | string | See §1; `""` when absent. |
| `Category` | string | See §1 |
| `Environment` | string | See §1 |
| `Notes` | string | See §1; `""` when absent. |
| `TagsJson` | string | JSON array of strings (≤ 5 entries). `"[]"` when absent. |
| `AddedAt` | string | ISO-8601 UTC |
| `AddedBy` | string | AAD object ID |
| `UpdatedAt` | string | ISO-8601 UTC |
| `UpdatedBy` | string | AAD object ID |

**RBAC** (per-table-scoped, mirroring `TenantSettings` and `ReportSnapshots`
precedents):

- Ingest MI: `Storage Table Data Contributor` — admin-triggered
  POST/PATCH/DELETE handlers run under the ingest MI (matches
  `patchSettings.ts` and `captureReportSnapshot.ts` precedents).
- Api-reader MI: `Storage Table Data Reader` — `GET /api/stack/items`.
- Agent MI: nothing in v1. Phase B+ may widen for a "stack-aware
  brief-agent" prompt, gated on a fresh ADR.

### 4. Endpoints + read gate

All under `/api/stack/*`. SWA catch-all `/api/*` covers the routing
layer at reader-or-admin; admin re-checked in-handler for mutating
verbs (matches `captureReportSnapshot.ts` precedent).

| Verb | Path | Role | Notes |
|---|---|---|---|
| `GET` | `/api/stack/catalog` | reader+admin | Returns the bundled `stackCatalog.json`. |
| `GET` | `/api/stack/items` | reader+admin | Lists all items for the tenant. Optional filters: `?category=`, `?environment=`. No pagination at v1; cap is § 6. |
| `POST` | `/api/stack/items` | admin | Creates one item; body validated against §1. Returns 201 + the created row. Returns 409 when the per-tenant cap is reached. |
| `PATCH` | `/api/stack/items/{id}` | admin | Partial update. Unknown fields rejected. |
| `DELETE` | `/api/stack/items/{id}` | admin | Hard-delete. Returns 204 on success, 404 if absent (idempotent). |

**Why no pagination at v1:** §6 caps the inventory at 100 items per
tenant. A 100-row partition scan completes well under the SWA proxy's
default timeout. Pagination is dead weight until the cap rises.

### 5. Audit trail

Stack item changes emit `AIEVENT StackItemChange` customEvents (matching
the `TenantSettingsChange` pattern for branding / cadence / tile-visibility).
Properties: `tenantId`, `principal` (AAD oid), `action`
(`stack-item-add` | `stack-item-update` | `stack-item-delete`), `id`,
`vendor`, `product`. The `vendor` + `product` are operator config, not
adversary-influenceable — including them in the event aids forensic
review without violating the audit-chain redaction rules.

This is **not** the chain-hashed audit blob (ADR-0015 / ADR-0021). The
audit chain is for tenant data and AI decisions where forensic integrity
matters; stack inventory is operator config. The same trade-off applies
to settings PATCH (ADR-0025), branding upload (ADR-0029), and reports
cadence (ADR-0030). A future "stack inventory audit chain" is a Phase B+
ADR amendment if compliance asks for it.

### 6. Per-tenant cap — 100 items

Hard cap at 100 stack items per tenant. POST 101 returns
`409 Conflict + cache-control: no-store` with `error.code = "cap_reached"`
and a message naming the cap.

Rationale: at v1 scale, tenants register the things that *matter* to
their KEV / CVE attention — typically tens, occasionally low-hundreds.
100 items is generous for a focused list and tight enough that the
partition scan and the SPA list render stay snappy. Phase B may expose
the cap as a Bicep param if a regulated-tenant ask surfaces.

### 7. SPA surface

- New `/stack` route. Reader sees the list; admin sees inline add /
  edit / delete + the catalog-backed typeahead form.
- New `StackTile` on the dashboard — compact: `"23 items · 4 categories ·
  last added 2 hours ago"`. Click → `/stack`. Hidden when the tenant has
  zero items and the user is a reader (admins always see it so they
  can bootstrap).
- Tile and page both reuse the existing dashboard + Tile + admin-section
  primitives — no new design components.

## Consequences

### Positive

- **Spine for KEV / CVE / advisory features.** Phase B is mechanical once
  the schema is stable.
- **Operator-curated by default.** No new Graph scopes, no new MI
  bindings, no new third-party fetch — sub-day landing.
- **Forward-compatible.** Phase D auto-discovery extends the row with
  `discoveredBy` + `confidence` without migrating Phase A entries.
- **AIEVENT audit pattern reused.** Operator-config changes already have
  this surface; one more event type costs nothing.

### Negative

- **Operator data-entry burden.** Tenants with sprawling stacks face
  ~100 manual entries. Mitigated by Phase D auto-discovery and the cap
  at 100 (which surfaces the burden honestly rather than hiding it).
- **Free-form fallback can drift.** Two operators can register the same
  product with different strings — the `non-canonical` chip nudges
  toward consistency but doesn't enforce it. Phase B's KEV match pass
  is the natural place to reconcile.
- **Catalog goes stale.** A static bundled JSON ages without operator
  benefit. Phase B's KEV ingest gives us a natural sync surface (KEV's
  vendor+product strings are themselves authoritative for the products
  it covers). Phase C's NVD ingest lets us re-derive the catalog from
  the CPE dictionary.

### Neutral

- **No CPE in Phase A.** Operators don't think in CPE strings; we don't
  surface the field. Phase C adds it as an optional column and a
  fuzzy-match step.
- **No bulk import.** CSV upload is a Phase B nice-to-have; not blocking.
- **No version-comparison logic.** v1 stores `version` as free text;
  semver-aware comparison ("2.4.x is < 2.6") lands when it matters
  (Phase C — ranges from CVE feeds).

## Out of scope

- Phase B (KEV cross-reference) — separate ADR; matches on
  `(vendor, product)`.
- Phase C (NVD/CVE lookup, CPE mapping) — needs precise CPE strings.
- Phase D (auto-discovery via Defender VM / Intune / Azure Resource
  Graph) — needs new Graph scopes + admin re-consent.
- Bulk CSV import.
- Stack inventory on the chain-hashed audit blob.
- Multi-tenant / MSP cross-tenant inventory views (gated on the
  multi-tenant ADR).

## Trigger to revisit

- An operator hits the 100-item cap and asks to raise it → tunable
  Bicep param.
- Phase B KEV ingest is ready to ship → re-evaluate the canonical-name
  surface (chip → suggested rewrite).
- A regulator / auditor asks for stack-inventory provenance on the
  chain-hashed audit blob → ADR amendment to swap AIEVENT for chain.
- Phase D auto-discovery is asked for → row-schema extension.

---

**References:**

- ADR-0006 — data stores (`StackItems` was forward-declared as a stub).
- ADR-0025 — admin settings page (TenantSettings RowKey + admin gate
  - AIEVENT change record pattern).
- ADR-0029 — tenant branding (per-table RBAC precedent).
- ADR-0030 — period reports (admin-triggered API write + AIEVENT
  precedent).
