# ADR-0015 — Audit log hash-chain

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

ADR-0011 §7 specified the per-run NDJSON audit line emitted by every ingest handler to the `audit` blob container. A monotonic `seq` field per `(source, tenantId)` was added at ADR-0011 authoring time for gap detection; a **per-line hash-chain** (`prevLineSha256` / `lineSha256`) was explicitly **deferred** with this deferral clause:

> Hash-chain deferred. A per-line hash-chain […] that cryptographically binds each line to its predecessor is the stronger control and is the intended endpoint. It is deferred to a follow-up "audit-log integrity" ADR that lands when the second ingest source is introduced (i.e. before the audit blob becomes a multi-writer concern across sources).

Step 4 introduces the **second ingest source** (`graph.security.incidents`, ADR-0013/0014). Its first audit-line write would be the moment the audit blob transitions from single-source to multi-source — exactly the trigger clause above. This ADR is the follow-up; it lands before step-4 code writes to the audit blob.

The concerns the chain addresses (independent of container-level WORM, which ADR-0006 handles at the storage layer):

1. **Insertion within the WORM window.** Append-blob WORM with `allowProtectedAppendWrites: true` permits legitimate `AppendBlock` operations during the locked retention. A writer with valid credentials — today, the audit MI — can insert an NDJSON line that was never produced by a real ingest run. Without a chain, a verifier has no way to detect this.
2. **Reordering at the `AppendBlock` boundary.** Two near-concurrent writers (starting with step-4's 15-minute timer overlapping with step-3's 03:00 UTC timer under manual-run conditions) may have their appends serialised by Azure in an order that differs from real-time wallclock. A verifier can prove ordering only if the chain carries the intent.
3. **Gap detection beyond `seq`.** A missing line between `seq=N` and `seq=N+2` is visible via `seq` alone; but if the missing line was for a DIFFERENT `seq=N+1` than the one that should be there, `seq`-only detection would miss it. Hash-chain binds line content to its predecessor, so a substituted line fails verification.

ADR-0011 §7 argued these concerns only bite once two sources share the audit blob. Step 4 is that moment.

## Decision

### 1. Fields added to the NDJSON schema

Every audit line written from this ADR's effective date onwards carries two new fields, both lowercase hex SHA-256 (64 characters):

| Field | Type | Description |
|---|---|---|
| `prevLineSha256` | string (64 hex chars) | `lineSha256` of the immediately previous line in the same `(source, tenantId)` chain. For the first line in a chain, see §3 (genesis value). |
| `lineSha256` | string (64 hex chars) | SHA-256 of this line's **canonical form** (see §2). Written once at line-emit time; never modified. |

The NDJSON line therefore grows from ADR-0011 §7's initial shape to:

```json
{
  "schemaVersion": 2,
  "eventType": "ingest.run",
  "source": "graph.security.incidents",
  "seq": 1,
  "runId": "…",
  "tenantId": "…",
  "startedAt": "2026-04-19T00:15:00.000Z",
  "endedAt":   "2026-04-19T00:15:04.123Z",
  "status": "success",
  "rowsWritten": 3,
  "alertsIngested": 5,
  "retentionRowsDeleted": 0,
  "graphAttempts": 1,
  "callerPrincipalMiClientId": "…",
  "prevLineSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "lineSha256":     "a3f6…"
}
```

**`schemaVersion` bumped 1 → 2.** Downstream verifiers MUST accept both; a chain for an existing `(source, tenantId)` pair may contain `schemaVersion: 1` lines preceding the first `schemaVersion: 2` line in the file.

### 2. Canonical form for hashing

The `lineSha256` is computed over a **JCS-ordered** (RFC 8785 JSON Canonicalization Scheme) serialisation of the NDJSON payload **with `lineSha256` omitted**. Specifically:

1. Start with the object that would be written to the blob.
2. Delete the `lineSha256` key (it's what we're computing).
3. **Keep** `prevLineSha256` — it is part of the chain binding.
4. Canonicalise the result per RFC 8785 (sort keys by UTF-16 code-unit order at every object depth, serialise numbers per ECMAScript `Number.prototype.toString` with JCS's additional constraints, UTF-8 encode).
5. SHA-256 of the resulting bytes; emit lowercase hex.

**The v1 implementation uses [`json-canonicalize`](https://www.npmjs.com/package/json-canonicalize) (or an equivalent vetted library) for step 4.** Hand-rolled canonicalisation is **rejected** as the default. RFC 8785 has three classes of correctness trap — ECMAScript number formatting (§3.2.2.3), UTF-8 string escapes (§3.2.2.2), UTF-16 code-unit key ordering (§3.2.3) — that are easy to get wrong on schema evolution (e.g. when a future audit field grows from "always-integer" to "occasionally-fractional"). A silent canonicalisation bug breaks chain verification without distinguishing tampering from a writer bug; that failure mode is precisely what this ADR exists to prevent. The vetted library is maintained by the JCS spec author with published test vectors; delegating to it removes a class of single-bit integrity bugs from the audit log's threat model.

**Exception process — if the library ever needs to be replaced.** A hand-rolled replacement (e.g. because of a supply-chain event, transitive-dep concern, or breaking upstream change) is permitted **only** when all three of the following hold:

1. The replacement is unit-tested against the RFC 8785 official test vectors (Anders Rundgren publishes them on GitHub at `cyberphone/json-canonicalization`) — all fixtures pass.
2. The replacement is fuzz-tested against the previous implementation for at least 10⁶ random JSON inputs covering non-BMP codepoints, lone surrogates, U+2028/U+2029 line separators, `-0`, integer/float boundary values, and nested objects at least 4 levels deep — no divergence.
3. A WS10 pass explicitly reviews the replacement.

Between removal of the vetted library and the landing of the WS10-approved replacement, no new audit-chain-carrying lines are written (the ingest handlers emit `status = "error"` with `error.kind = "chain_unavailable"` until the library is restored).

**Layered defence — `seq` complements the chain.** The `seq` field (ADR-0011 §7) catches gap-class tampering (insertion, deletion, reordering across `(source, tenantId)`) even if the chain has a canonicalisation bug that produces inconsistent `lineSha256` values. `seq` + chain is strictly stronger than either alone; a verifier runs both checks independently. If the chain ever fails to verify on an otherwise-consistent `seq` sequence, the diagnostic path is "canonicalisation drift" (writer or library bug) rather than "tamper" — the `seq` evidence narrows the search space. This is the defence-in-depth the ADR relies on to keep the cryptographic primitive recoverable if an implementation flaw is ever found.

After the chain fields are added, the final NDJSON line written to the blob is the canonical form **plus** `lineSha256` appended before serialisation to a single-line JSON (no sorting of the final write — only the hash-input is canonicalised).

### 3. Genesis line

The first line in a `(source, tenantId)` chain has no predecessor. The sentinel value **must be distinguishable from "buffer initialised to zero"** — sixty-four `0` characters is the exact lowercase-hex of a Node `Buffer.alloc(32)`, indistinguishable from a writer bug that forgot to populate the field. A distinctive sentinel closes that ambiguity.

**Decision: project-salted SHA-256.** `prevLineSha256` on a genesis line is the lowercase-hex SHA-256 of the ASCII-encoded string:

```text
aegis:audit-chain:v2:<source>:<tenantId>:genesis
```

Example for step 4's first Incidents line in the dev tenant:

```text
prevLineSha256 = SHA256("aegis:audit-chain:v2:graph.security.incidents:764279e8-66e9-49b4-901f-a7592435ae1d:genesis")
```

The `lineSha256` on the genesis line is computed normally — it includes the salted `prevLineSha256` in its input, so the chain binds the first line to a value only the writer could have computed from the known project salt.

**Verifier rules:**

1. **Genesis identification.** A line whose `prevLineSha256` matches the salted value for its `(source, tenantId)` is the chain head. A verifier recomputes the expected genesis sentinel from the project salt + source + tenantId and compares.
2. **Buffer-zero rejection.** A line whose `prevLineSha256` is sixty-four `0` characters is **rejected as malformed**, *never* treated as a genesis line. This catches the "buffer initialised to zero" failure mode unambiguously — a writer that emits sixty-four zeros is broken, not correct.
3. **No other chain head values.** The only valid chain-head value is the salted genesis sentinel. A line that appears to be a chain head (no predecessor present in the file within the search window) but whose `prevLineSha256` is neither the genesis sentinel nor sixty-four zeros is flagged as "unexpected chain boundary" — either a malformed migration or tampering.

**Why salted, not option-(A) sentinel-zero (original draft's decision, now superseded):** the zero sentinel's collision with buffer-init bugs makes it undetectable as a signal — the verifier cannot tell whether a "genesis" line is intentional or the symptom of a writer that fell back to an uninitialised buffer. The project salt is not a secret (it's in this ADR) but it's a **signal** — a value no buggy initialisation path produces by accident. Rejected option-(A) fixed-zero for that reason.

### 3a. Chain-boundary marker for forward-only migration

When a `(source, tenantId)` chain is introduced on an audit blob that already carries pre-chain `schemaVersion: 1` lines (the step-3 `SecureScore` source is the first such case — see §6), the first `schemaVersion: 2` line is a dedicated **boundary marker** rather than an `ingest.run` line:

```json
{
  "schemaVersion": 2,
  "eventType": "audit.chain.start",
  "source": "graph.security.secureScores",
  "tenantId": "764279e8-…",
  "seq": <LastAuditSeq + 1>,
  "startedAt": "2026-04-19T00:00:00.000Z",
  "reason": "chain-introduced",
  "priorLineCount": <N pre-chain schemaVersion=1 lines for this source>,
  "callerPrincipalMiClientId": "<ingest-MI-client-id>",
  "prevLineSha256": "<genesis sentinel per §3>",
  "lineSha256":     "<computed>"
}
```

The next `ingest.run` line for that `(source, tenantId)` takes `prevLineSha256` = the boundary marker's `lineSha256`, so the chain is bound to the explicit boundary rather than starting inside an `ingest.run` payload. A verifier walking the file sees an unambiguous "the chain starts here" landmark; a future auditor inspecting a blob that spans the migration transition doesn't have to infer the boundary from `schemaVersion` alone.

The boundary marker is written by a one-off migration helper (`scripts/write-audit-chain-boundary.mjs`) invoked once per `(source, tenantId)` pair immediately after this ADR's code lands, before any new ingest run writes to the audit blob.

### 4. Per-source chain keying

Each `(source, tenantId)` pair carries its own independent chain. Rationale:

- **Operational:** two ingest handlers in the same Function App may race appends to the same daily blob. If they shared a chain, the loser of the race would compute `prevLineSha256` against a line the winner has not yet read, producing false-positive mismatches on every concurrent write.
- **Verifier ergonomics:** a tenant-scoped or source-scoped verifier can walk a single chain without holding state for unrelated sources.
- **Storage shape:** `seq` is already keyed per `(source, tenantId)` via `IngestHealth.LastAuditSeq` — the chain piggybacks on the same concurrency primitive (the ETag lease).

Within a chain, lines may be interleaved across multiple daily blobs (`audit/<source>/yyyy/mm/dd/ingest.ndjson`) — the chain is logical, not physical-per-blob. A verifier walking the chain sorts by `seq` ascending within `(source, tenantId)` and then verifies `prevLineSha256` = previous line's `lineSha256`.

### 5. Implementation — `api/src/lib/auditChain.ts`

New module added alongside the existing `audit.ts`. Surface:

```typescript
export interface ChainState {
  readonly seq: number; // LastAuditSeq from IngestHealth
  readonly lastLineSha256: string; // sentinel-zero on first line
}

export function canonicalise(
  obj: Record<string, unknown>,
  excludeKey?: string,
): Uint8Array;

export function hashCanonical(bytes: Uint8Array): string;

export function computeLineSha256(
  lineWithoutHash: Record<string, unknown>,
): string;

export function nextChainState(currentState: ChainState): ChainState;
```

**Invariant:** `computeLineSha256` is a **pure function** — no I/O. The audit writer (`audit.ts`) composes the line, calls `computeLineSha256`, appends `lineSha256`, and writes the NDJSON. The chain state is persisted on the `IngestHealth` row (new column `LastLineSha256`) under the same ETag lease that already persists `LastAuditSeq`.

`IngestHealth` row gains one new column:

| Column | Type | Notes |
|---|---|---|
| `LastLineSha256` | string (64 hex chars) | `lineSha256` of the last line successfully appended to this chain. Sentinel-zero on the first run after this ADR lands. |

The ingest handler's existing commit-then-audit ordering (ADR-0011 §5) is preserved: the `IngestHealth` row is committed first with the new `LastAuditSeq` and `LastLineSha256`, and only then is the audit line appended. If the audit append fails, `LastLineSha256` on the row is ahead of what's in the blob — a gap that surfaces in verification exactly as `seq` gap detection does today (ADR-0011 §7). The observability event `AuditWriteFailed` is emitted and a monitoring alert is configured for it (tracked improvement, not pre-merge blocker).

### 6. Migration for step-3 audit lines

Existing `SecureScore` audit lines written before this ADR lands do **not** carry `prevLineSha256` / `lineSha256`. Rather than backfilling (which would require reading-then-rewriting the audit blob — impossible under prod WORM and anti-pattern in dev), we treat the chain as **forward-only per `(source, tenantId)`**:

- The `SecureScore` chain for this tenant begins at `LastAuditSeq + 1` on the first run after this ADR deploys. `prevLineSha256` = sentinel-zero.
- Verifiers aware of the ADR's effective date ignore `prevLineSha256`/`lineSha256` absence before that date.
- A verifier walking the SecureScore chain will see:

  ```text
  seq=1..N   schemaVersion=1, no chain fields          ← pre-chain lines
  seq=N+1    schemaVersion=2, prevLineSha256 = zero    ← genesis
  seq=N+2..  schemaVersion=2, prevLineSha256 = prior   ← chained forward
  ```

This is the pragmatic balance: no retrofit of historical lines, full chain integrity from the effective date forward. The pre-chain period is explicitly flagged in `docs/HANDOVER.md` for any future auditor.

### 7. Verification tool

A small verifier is added as `scripts/verify-audit-chain.mjs` (Node 22, no azure-sdk dependency beyond `@azure/identity` + `@azure/storage-blob`). Surface:

```bash
node scripts/verify-audit-chain.mjs \
  --source "graph.security.incidents" \
  --tenant <tenantId> \
  --from 2026-04-18 \
  --to 2026-05-18
```

For each line in the specified window it:

1. Parses the NDJSON.
2. Recomputes `lineSha256` from the canonical form (ignoring `lineSha256` itself).
3. Compares to the line's own `lineSha256` — mismatch → flag.
4. Compares `prevLineSha256` to the previous line's `lineSha256` — mismatch → flag.
5. Checks `seq` is strictly `prev.seq + 1` — missing `seq` → flag.

Exit code 0 on clean chain; non-zero with a human-readable report on any issue. Documented in `docs/HANDOVER.md` §Operations.

## Consequences

### Positive

- **Tamper-evident audit log** beyond container-level WORM. A malicious writer who inserts a forged line must also forge every subsequent line's `prevLineSha256` — and since each line's content is hashed, any mutation of a prior line breaks the chain for every successor.
- **Gap detection cross-verified.** `seq` + `prevLineSha256` is strictly stronger than either alone.
- **Verifier is standalone and auditable.** No service-side dependency; any operator with audit-blob read access can run it.
- **Forward-only migration avoids WORM gymnastics.** Pre-chain lines remain unmodified; the chain begins at the next line after the ADR deploys.

### Negative / trade-offs

- **Every audit write now requires a SHA-256 computation + JCS canonicalisation.** Negligible at ingest scale (microseconds per line), but it is work that wasn't previously done. Bench-measured ~<1 ms per line on Node 22 + Flex Consumption with the audit payload shape.
- **`IngestHealth` row now carries a 64-character hex column.** Tiny impact on storage; larger impact on the ETag-lease contention window — not measurable at step-4 scale.
- **Third-party library dependency.** The vetted JCS library (`json-canonicalize` or equivalent; §2) adds one direct dependency to `api/package.json`. The library is small, MIT/BSD-licensed, and maintained by the RFC 8785 spec author — an acceptable supply-chain surface for an audit-integrity primitive that would otherwise require us to own the correctness of every schema evolution. Dependabot + pre-commit gitleaks already monitor dependencies; the library is pinned to an exact version in `package-lock.json` and SBOM'd alongside the rest of `/api`.
- **Audit-write failure asymmetry.** If the health commit succeeds but the audit append fails, the on-disk blob is missing the line that `IngestHealth.LastLineSha256` thinks was written. This was already the asymmetry in ADR-0011 §5 — the chain doesn't make it worse, but it makes the gap more visible. Recovery path: on the next successful ingest run, the handler detects the drift (its read of the audit blob's last line doesn't match `IngestHealth.LastLineSha256`) and emits a one-off **chain-repair line** before the `ingest.run` line:

  ```json
  {
    "schemaVersion": 2,
    "eventType": "ingest.audit.repair",
    "source": "…",
    "tenantId": "…",
    "seq": <LastAuditSeq + 1>,
    "reason": "audit-write-gap",
    "priorOnDiskLineSha256": "<actual last line on disk>",
    "expectedLineSha256":    "<IngestHealth.LastLineSha256>",
    "callerPrincipalMiClientId": "…",
    "prevLineSha256": "<actual last line's lineSha256>",
    "lineSha256":     "<computed>"
  }
  ```

  The chain resumes from the repair line — never from an automatic re-genesis. The App Insights event `AuditChainRepairWritten` is emitted so the maintainer can correlate the repair to the failed run. Automatic re-genesis is **forbidden** — it would let an attacker who could induce audit-write failures reset the chain at will. A future ADR can introduce KMS-signed operator-written repair lines if the trust model tightens further; v1 accepts audit-MI-signed repair lines because the audit MI is the trusted writer for the chain in the first place.

- **Alerting on `AuditWriteFailed` is in scope for the step-4 code pass**, not deferred to "polish". With the chain in play, audit-write failure has a higher consequence than under `seq`-only (because subsequent lines depend on `LastLineSha256` matching the on-disk last line). The step-4 code pass lands an App Insights alert rule on the `AuditWriteFailed` event, and the runbook step for acknowledging a repair is documented in `docs/HANDOVER.md` §6.2.

### Neutral

- **RFC 8785 alignment.** Choosing JCS keeps us aligned with the emerging standard for deterministic JSON serialisation. If a future cross-organisation audit comparison is ever needed, we speak the same language.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| **HMAC with a shared secret** instead of SHA-256 | Requires a secret on the writer side; complicates teardown and is not stronger for tamper-detection when the writer (audit MI) is the trusted party anyway. SHA-256 is a commitment, not a signature — exactly what's needed. |
| **Signed lines with a per-tenant signing key** | Same reasoning: the writer is trusted; what we want is evidence of "this line was produced by the writer and followed that line". A hash-chain achieves that. Signatures add key-management overhead. |
| **Merkle tree over entire day's blob** | Higher integrity guarantee (can verify a single line without reading the whole chain), but requires a periodic tree-root write that complicates append-only WORM semantics. Overkill for v1. Re-evaluatable if the audit volume ever exceeds a few thousand lines per day. |
| **Per-blob chain reset at UTC day boundary** | Makes each day's blob independently verifiable — but creates apparent "resets" in a tool that walks a month's worth of audit, which is a verifier UX regression. Per-`(source, tenantId)` chain crosses day boundaries cleanly. |
| **Store `lineSha256` on IngestHealth alone (not inline on the line)** | Defeats the audit log's self-describing property: a verifier needs IngestHealth access to verify the chain, and `IngestHealth` is mutable. Storing the hash inline on the immutable blob is the correct shape. |

## Related

- `PROJECT_BRIEF.md` §4 — Audit log (append-only, retention-governed)
- `PROJECT_BRIEF.md` §9 — Security posture of the tool itself (audit log WORM)
- ADR-0006 — Data stores (audit blob container + WORM in prod)
- ADR-0011 §7 — Audit log pattern (this ADR resolves the deferred hash-chain follow-up)
- RFC 8785 — JSON Canonicalization Scheme
- NIST SP 800-92 §5.2 — Log integrity controls beyond storage immutability

---

*End of ADR-0015.*
