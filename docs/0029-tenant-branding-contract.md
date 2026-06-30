# ADR-0029 — Tenant branding contract

**Status:** Accepted
**Date:** 2026-04-20
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

Operators running Project Aegis today see fixed Fluent-blue branding + the string "Aegis" in the header. The first practical evaluation / deployment surface — operator's own tenant or an initial reseller — is served fine by the defaults. The second ("my customer wants their logo here" or "we're running dark mode internally") needs a customisation path.

Two shipped patterns in the codebase are good precedents for how this lands:

- **ADR-0025 Phase 2 (capability surface).** Per-tenant derived state from a Table row, consumed by the SPA at query time. Admin-only writes.
- **ADR-0025 Phase 3 (`agent-budget`, `userIdentifierStrategy`).** Per-tenant operator configuration under additional `TenantSettings` RowKeys, additive schema, admin-page section per concern.

Branding follows the same shape. Under `TenantSettings` gets a new RowKey `branding`. The `/admin` settings page gets a fifth section card. The SPA reads at boot and wraps `FluentProvider` with a derived theme + consumed product name / footer / logo.

The concerns this ADR settles:

1. **What is customisable** — the bounded set of operator dials (text, colour, logo, theme default).
2. **Where the branding lives** — Table vs blob storage, and the read/write identities.
3. **Default theme vs per-user override** — the interaction between tenant-scoped default and browser localStorage.
4. **CSP + origin-same-ness** — how logo assets are served without relaxing the SWA's CSP.
5. **Upload hygiene for logos** — MIME allowlist, magic-byte validation, size cap, SVG explicitly deferred.
6. **Phasing** — what lands when, what's explicitly Phase 2.

## Decision

### 1. Customisable surface — bounded

Four text-only fields (Phase A) plus one asset field (Phase B):

| Field | Type | Cap | Default | Notes |
|---|---|---|---|---|
| `ProductName` | string | ≤ 64 chars | `"Aegis"` | Header title + `<title>` tag |
| `PrimaryHex` | string | `/^#[0-9a-fA-F]{6}$/` | `"#0078D4"` (Fluent blue 10) | Brand ramp seed; derives both light + dark theme |
| `FooterText` | string | ≤ 128 chars | `""` (no footer) | Optional bottom-of-page line |
| `DefaultTheme` | enum | `light` \| `dark` \| `system` | `"system"` | Tenant-scoped first-load preference |
| `LogoSha256` | string | 64 chars | `""` (no logo) | **Phase B only.** Points at the blob in `branding-assets` |
| `LogoContentType` | enum | `image/png` \| `image/webp` \| `image/jpeg` | `""` | **Phase B only.** |
| `LogoSize` | int | ≤ `1_048_576` (1 MB) | `0` | **Phase B only.** Validated server-side. |

Everything else (typography, spacing, Fluent component customisation, per-tile colour overrides) is explicitly non-surface in v1. The Fluent design system is the baseline; this ADR settles **whose brand shows**, not **how the system looks**.

### 2. Storage topology

**Table row** (Phase A + B) — `TenantSettings[branding]`. Fourth RowKey under the existing table (tile-visibility, agent-budget, user-identifier-strategy, + branding). Flat columns matching the customisable surface + the standard `UpdatedAt` / `UpdatedBy`. Reuses the existing RBAC (ingest MI Contributor per ADR-0025 §2; api-reader MI Reader). Code-enforced RowKey discipline per the same precedent (HANDOVER §6.3 — Table Storage ABAC unavailable).

**Blob container** (Phase B) — new `branding-assets` on the ops storage account. Per-tenant single path:

```text
branding-assets/<tenantId>/logo
```

No versioning; overwrite-on-upload is correct (audit trail of versions lives on the `TenantSettings` row's `UpdatedAt` + `LogoSha256`). Container is RBAC-gated: ingest MI gets `Storage Blob Data Contributor` for the upload handler's write path; api-reader MI gets `Storage Blob Data Reader` for the serve handler's stream path. Agent MI gets nothing — branding is not in the AI plane.

### 3. API contract

**Phase A:**

- `GET /api/settings` (existing) — response gains a `branding` key alongside `tileVisibility` / `capabilities` / `agentBudget` / `userIdentifierStrategy`. Absent-row returns the defaults from §Decision.1. Auth: reader.
- `PATCH /api/ingest/settings` (existing) — union validator additively accepts:

```json
{
  "branding": {
    "productName": "...",
    "primaryHex": "#RRGGBB",
    "footerText": "...",
    "defaultTheme": "light"
  }
}
```

All four fields are optional on a patch (merge semantics). Any field present is validated strictly: `productName` length cap, `primaryHex` regex, `footerText` length cap, `defaultTheme` enum. Auth: admin. Emits `TenantSettingsChange` customEvent with `action: "branding-update"` and a `changed` array naming modified keys.

**Phase B:**

- `POST /api/ingest/branding/logo` (admin, binary body) — writes the blob + updates `LogoSha256` / `LogoContentType` / `LogoSize` on the branding row. `Content-Length` ≤ 1 MB; `Content-Type` must be one of the three allowed MIME types; server re-validates via magic-byte check (rejects mismatched declared vs actual type). 429 on rate-limit (same `ADMIN_RUN_DAILY_CEILING`). Emits `TenantSettingsChange` with `action: "branding-logo-upload"`.
- `GET /api/branding/<tenantId>/logo?v=<sha>` (reader) — streams the blob from `branding-assets/<tenantId>/logo` via api-reader MI. **IDOR check (WS10 SEC-I-ADR29-02 resolution):** handler MUST assert that the `<tenantId>` URL path parameter matches the caller's authenticated principal's tenant (`resolveApiConfig(context).tenantId`) before issuing the blob read. Mismatch → 403 before I/O, regardless of whether the other tenant's blob exists. Single-tenant today, but the assertion closes the cross-tenant fetch primitive ahead of any multi-tenant deployment. Response headers: `Content-Type` from the row, `Cache-Control: private, max-age=3600, stale-while-revalidate=86400` (logos change rarely; the `?v=<sha>` query param busts cache on overwrite). 404 if `LogoSha256` is empty or the blob is missing.
- `DELETE /api/ingest/branding/logo` (admin) — deletes the blob + clears the three logo columns. Idempotent.

### 4. SPA contract

**`BrandingProvider`** wraps `FluentProvider` at the app root. Consumes `useTenantSettings()`; derives the theme using Fluent's `createLightTheme` / `createDarkTheme` with the operator's `PrimaryHex` as the brand-ramp seed. Falls back to hardcoded defaults when `branding` is absent (fresh tenant) or read fails (ingest RBAC drift).

**Theme resolution precedence** (first-match wins):

1. `localStorage.getItem("aegis.theme")` — per-user override set by the header toggle.
2. `branding.defaultTheme === "light" | "dark"` — tenant-scoped default.
3. `branding.defaultTheme === "system"` OR absent → match `prefers-color-scheme` media query.

The toggle in the header cycles through `system` → `light` → `dark` → `system`, persists to localStorage, and emits a React context update so every consumer re-renders the correct theme.

**localStorage key `aegis.theme` — first-party non-tracking preference** (WS10 SEC-I-ADR29-05 resolution). Scope is the SWA origin only; no third-party surface consumes it. Value is one of `"system" | "light" | "dark"`; anything else is treated as absent (defaulting to the tenant preference chain). Not synced across devices or browsers — by design, to preserve the per-user-per-device browser preference UX convention and avoid a server-side cookie footprint.

**`BrandingSection`** on `/admin` — fifth section card after tile-visibility, agent-budget, user-identifier-strategy. Contains:

- Text input for `productName` (with live char count).
- Colour picker + hex text input for `primaryHex` (regex-validated in real time).
- Text area for `footerText` (with live char count).
- Radio group for `defaultTheme`.
- **Phase B:** drag-drop / file-upload zone for logo with live preview, "remove logo" button, size + type indicator.
- Save / Discard pair with dirty tracking (same pattern as the other three sections).

### 5. Upload hygiene — Phase B

Logo uploads go through three checks at the API handler:

1. **`Content-Length` ≤ 1 MB.** Enforced before reading the body. Rejected with 413.
2. **`Content-Type` one of the three allowed MIME types.** Rejected with 415.
3. **Magic-byte check.** Re-validate the first N bytes of the body match the declared MIME type. Per W3C PNG specification §5.2, the full PNG signature is eight bytes: `89 50 4E 47 0D 0A 1A 0A` — the ADR uses the full signature, not the four-byte prefix, to reject files that happen to start with `89 50 4E 47` but aren't valid PNGs. JPEG starts `FF D8 FF`; WebP has `RIFF` at offset 0 and `WEBP` at offset 8. A client claiming `image/png` but shipping JPEG bytes (or an SVG with `<script>`, or an arbitrary binary) fails at this check. Rejected with 415.

**SVG deliberately excluded.** SVGs can carry `<script>` and event-handler attributes; safe inclusion would require server-side DOMPurify-style sanitisation + CSP-`script-src: none` on the served content. That's a non-trivial attack-surface expansion and is deferred to a Phase 2+ ADR when / if an operator specifically asks. Operators wanting vector quality ship WebP at high resolution.

Filename is fixed (`logo`) — no operator-supplied name reaches storage. Blob metadata stores only the content-type; no EXIF preservation, no operator-controlled metadata fields.

### 6. CSP + origin discipline

The SPA's CSP (`staticwebapp.config.json` `globalHeaders`) stays **`img-src 'self' data:`**. Logos are NOT loaded from a third-party origin — they're served by the Function App backend through the existing SWA → Function proxy, so they appear to the browser under the SWA's own origin.

This was a direct answer to one of the ADR-scoping questions: **strictly no CSP relaxation.** A competing design would embed operator-provided HTTPS URLs (CDN-hosted logos), which requires either a specific `img-src` entry per tenant (impossible with a single CSP) or `img-src https:` (permissive and unnecessary). Hosting via our own origin sidesteps both.

### 7. RBAC

Summarised from §Decision.2 — no new MI.

| MI | `TenantSettings` | `branding-assets` container | Foundry |
|---|---|---|---|
| Ingest | existing Contributor (covers the new row) | **NEW** Contributor (Phase B) | — |
| Api-reader | existing Reader | **NEW** Reader (Phase B) | — |
| Agent | existing Reader | none | — |

The agent MI has no read path to `branding-assets`. Branding does not reach the AI plane.

### 8. Audit / telemetry

`patchSettings` emits `TenantSettingsChange` customEvent with:

- `action: "branding-update"` (Phase A text changes), `changed: ["productName", ...]`.
- `action: "branding-logo-upload"` (Phase B), `size`, `contentType`, `sha256`.
- `action: "branding-logo-delete"` (Phase B).

Not audit-chain-written — branding is UX/policy, not integrity-chain-worthy (matches the ADR-0025 Phase 1 §6 framing for tile-visibility).

### 9. Phasing

**Phase A** (this commit pair — ADR + code):

- `TenantSettings[branding]` row + store helpers + validator + response extension.
- SPA `BrandingProvider` + `BrandingSection` + header theme toggle.
- Dark-mode baseline + light/dark/system trio working.
- No logo handling.

**Phase B** (queued, HANDOVER §6.3):

- `branding-assets` blob container + Bicep RBAC.
- `POST /api/ingest/branding/logo` binary upload handler with MIME + magic-byte validation.
- `GET /api/branding/<tenantId>/logo?v=<sha>` serve handler.
- `DELETE /api/ingest/branding/logo` clear handler.
- `BrandingSection` logo preview + upload + delete UI.
- Extended `TenantSettings[branding]` columns: `LogoSha256`, `LogoContentType`, `LogoSize`.
- Tests: binary upload validation, magic-byte rejection fixtures, serve correctness, size-cap enforcement.

Phase A is independently useful — operators get dark theme + text white-labelling without waiting for Phase B. Phase B is purely additive.

### 10. Non-surfaces (v1)

- **Per-user branding** (each user has their own logo). Explicitly tenant-scoped only.
- **Theme editor beyond brand-ramp seed.** Operators who want full Fluent theme override write a fork. Brand-ramp derivation is the bounded control.
- **Typography / font swap.** Fluent's font stack is the baseline.
- **Runtime layout reconfiguration** (reorder tiles, hide sections beyond the existing tile-visibility toggle). Out of scope.
- **SVG logos.** Deferred for XSS surface reasons; see §Decision.5.
- **Multi-logo variants** (dark-mode logo vs light-mode logo). One logo per tenant; if contrast matters, operator picks a logo that works in both themes. Future enhancement if demanded.
- **Backup / export of branding config.** The `TenantSettings` row is readable via the existing admin API; operators wanting backup use that.

## Consequences

**Positive.**

- Operators get dark mode + text white-labelling immediately (Phase A) with no Phase B dependency.
- Runtime surface is admin-gated, audit-trailed, and follows the three established patterns (TenantSettings rows, admin-page sections, capability-style SPA consumption).
- CSP posture preserved — no relaxation, no cross-origin asset fetch.
- Agent MI remains ignorant of branding; no AI-plane leakage.
- Brand-ramp seed via `createLightTheme` / `createDarkTheme` means one colour choice produces consistent ramps across both themes — operator doesn't juggle two palettes.

**Negative / trade-offs.**

- `TenantSettings` row now has four concerns (tile-visibility, agent-budget, user-identifier-strategy, branding). §9.10's trip-wire for nested-schema migration ("≥8 agent-budget columns OR >2 additional specialists") is different — the count that matters here is RowKeys under a single table. Four is inside the envelope. **Formal RowKey trip-wire (WS10 SEC-I-ADR29-03 resolution):** a schema-versioning ADR is required before a fifth RowKey lands on `TenantSettings` (e.g. `notifications`, `integrations`, `retention-policy`). At five concerns, the admin-page surface already cannot sensibly render as a single flat list of sections; the next concern is the trigger to rethink the table's shape (nested JSON column per concern, or split into per-concern sibling tables, or similar). Phase B — logo handling inside the existing `branding` RowKey — does NOT trip this wire (same RowKey, more columns).
- Operators must understand that the per-tenant `DefaultTheme` interacts with per-user localStorage. Surfaced in the admin-page copy + the AI-SECURITY-POSTURE.md equivalent operator-documentation-doc (branding analogue to that document is a future Phase 2+ item — not in this ADR's scope, but worth an entry on the docs roadmap).
- Phase B adds a new blob container + two role assignments + a binary upload code path. Binary upload with magic-byte validation is modest new attack surface; the MIME allowlist + size cap + tenant-path scoping bound it tightly.

**Negative we accept (explicit).**

- SVG uploads rejected until a sanitisation path lands. Operators wanting vector-quality logos ship WebP at high resolution in the interim.
- A tenant admin with compromised credentials can set the product name to a prompt-injection-shaped string ("Ignore previous instructions"). The AI plane does NOT read branding fields (§Decision.7 agent MI has no access), so this does not reach Foundry. It would render in the SPA header — inspected at render time via React's default text-escape (no `dangerouslySetInnerHTML` on branding values). **Test-enforced invariant (WS10 SEC-I-ADR29-04 resolution):** the Phase A commit lands a repo-wide grep test in the web suite asserting that `dangerouslySetInnerHTML` never appears in the same file as a reference to the branding context / hook / fields. Convention alone is insufficient; the test makes the invariant load-bearing. XSS surface is zero; UX embarrassment is real but self-correcting (the compromised admin is already a different incident).

---

## Appendix A — How this composes with existing ADRs

- **ADR-0007** (Easy Auth): admin gate on write inherited.
- **ADR-0025 §9.10**: additive `TenantSettings` RowKey pattern inherited; branding is the fourth concern.
- **ADR-0025 Phase 2**: capability-derived defaults inherited — the BrandingProvider uses the same "absent row → defaults" fallback shape.
- **ADR-0026** (Table Storage ABAC): row-scope code-enforcement inherited; `patchSettings.ts` remains the only writer path for any `TenantSettings` row.
- **ADR-0007 / ADR-0008** (CSP, app-reg): the `img-src 'self'` posture is preserved by routing logos through the Function App, not from an operator-supplied URL.

## Appendix B — What this ADR is NOT deciding

- **Whether branding metadata lands in the AI prompt.** Explicitly no (§Decision.7 agent MI has no access). If a future specialist wants the tenant's product name in its output, that's a separate decision with its own threat model pass.
- **Multi-theme variants.** One logo per tenant; one colour per tenant. If operator wants light-mode-specific vs dark-mode-specific logos, that's a Phase 3 ADR amendment.
- **Mobile / small-viewport branding behaviour.** Defers to Fluent's responsive primitives.
- **Operator-facing "brand preview" before save.** The admin section shows the current-form values live; a full mock-dashboard-preview surface is larger UX work, not ADR-relevant.
