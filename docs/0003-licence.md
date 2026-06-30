# ADR-0003 — Licence

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** Ben Thomas (maintainer)
**Supersedes:** —
**Superseded by:** —

---

## Context

XDR Hub is a community, open-source project contributed under the Microsoft Security MVP programme. The licence choice determines:

- What downstream users — individuals, consultancies, and Microsoft partners — can legally do with the code and its derivatives.
- Whether there is an explicit patent grant protecting adopters from patent claims by contributors.
- What attribution and modification-marking obligations fall on forks and derivative distributions.
- How enterprise adopters' legal and procurement teams view the project during their OSS review process.

The brief (§3 and §17) commits to Apache 2.0 and locks a verbatim NOTICE file. This ADR ratifies that commitment, records the reasoning in full, and fixes the attribution conventions that govern forks and downstream distributions.

## Decision

### Licence

**Apache License, Version 2.0** — unmodified text, placed at repo root as `/LICENSE`.

### NOTICE file

The NOTICE file content is locked verbatim in `PROJECT_BRIEF.md §17`. It is placed at repo root as `/NOTICE` and must not be modified without maintainer approval.

The required content is:

```text
XDR Hub (codename: aegis)
Copyright 2026 Ben Thomas
Originally created by Ben Thomas, Microsoft Security MVP.
This product includes software developed as a community contribution
to the Microsoft Security MVP programme.
```

### Attribution rules for downstream users and forks

Downstream users and forks must:

1. Preserve `/NOTICE` unchanged in any distribution (Apache 2.0 §4(d)).
2. Preserve `/LICENSE` unchanged (Apache 2.0 §4(a)).
3. Mark any modified source files as changed (Apache 2.0 §4(b)).
4. Where the downstream product surfaces an "About" or equivalent UI or CLI derived from this project, include the line:
   > Based on XDR Hub by Ben Thomas
   with a link to the upstream repository.

Rule 4 is a convention requested of community adopters, **not** a licence obligation. Enforcement is strictly limited to what Apache 2.0 itself requires; rule 4 is expected to be respected voluntarily by community projects and is documented as such in the README and brief §17.

### Contribution model

- All contributions are accepted under Apache 2.0 by default (Apache 2.0 §5: inbound equals outbound).
- **No CLA is required in v1.** If the project attracts significant corporate contributors, a DCO (Developer Certificate of Origin) sign-off on commits may be introduced via a superseding ADR; a CLA will not be introduced without specific maintainer approval.

### Per-file licence headers

Not required. Apache 2.0 §4 does not mandate per-file headers when LICENSE and NOTICE are present at the repo root. Source files MAY carry an SPDX identifier (`SPDX-License-Identifier: Apache-2.0`) for tooling convenience; generated code SHOULD carry one so it is correctly classified by SBOM and scan tooling.

### Third-party dependencies

- The project generates and publishes an SBOM in CI (brief §9).
- Dependencies incompatible with Apache 2.0 inbound (e.g. AGPL-licensed libraries in a form that contaminates the distribution) are rejected. Dependency audits run on every release build.
- Apache 2.0 is one-way compatible with GPLv3; this project never includes GPLv3 code in a way that would require re-licensing its own output.

## Consequences

### Positive

- **Explicit patent grant** (Apache 2.0 §3) gives enterprise adopters cover against patent claims by contributors, materially reducing legal friction at OSS review.
- **Permits modification and commercial use** — partners and consultancies can fork, embed, and ship derivatives without asking, which supports the brief's community-adoption goal.
- **NOTICE survives forks** by virtue of Apache 2.0 §4(d); upstream credit is preserved even in transitive derivatives.
- **Broadly recognised** — Apache 2.0 is among the top-two most-recognised OSS licences, and the enterprise approval path is well-trodden.

### Negative / trade-offs

- **Not copyleft.** A downstream fork may close-source modifications as long as `/NOTICE` and `/LICENSE` are preserved and modified files are marked. This is a deliberate trade: community adoption over strict copyleft protection.
- **Liability disclaimed.** Apache 2.0 §§7–8 disclaim warranty and limit liability. Downstream deployers carry operational risk in their own tenants. This is explicitly intended; the project is a security tool and deployers are expected to own the consequences of their own deployments. Re-stated in brief §9.
- **Attribution rule 4 is conventional, not enforceable** beyond what Apache 2.0 itself requires. We accept this; the intent is social, not legal.

### Neutral

- Apache 2.0 is compatible with GPLv3 in one direction only (Apache code may be incorporated into GPLv3 works, not the reverse). This asymmetry does not affect the project's own distribution or dependency policy.

## Alternatives considered

| Alternative | Reason rejected |
|---|---|
| MIT | No explicit patent grant; leaves adopters exposed to patent claims from contributors. Otherwise functionally similar to Apache 2.0 but weaker for enterprise adoption. |
| BSD-3-Clause | Same patent-grant gap as MIT; no meaningful advantage over MIT or Apache 2.0 for this project. |
| GPLv3 | Strong copyleft discourages embedding by partners and consultancies who want to ship proprietary-wrapped derivatives; incompatible with the community-adoption goal. |
| AGPLv3 | Network-use copyleft would force SaaS re-distributors to open-source their deployments. Project goal is single-tenant deployments in the user's own Azure subscription — AGPL adds enforcement overhead without real benefit and complicates enterprise OSS review. |
| Business Source License (BSL) or SSPL | Not OSI-approved. Optics are poor for a community MVP contribution; would not be accepted as "open source" by most adopters' OSS review processes. |
| Dual-licence (Apache 2.0 + commercial) | Introduces governance overhead (CLA, copyright assignment) without a clear commercial strategy to justify it in v1. Reopenable later via a superseding ADR if the strategy changes. |

## Related

- `PROJECT_BRIEF.md` §3 — Architecture decisions (Licence row)
- `PROJECT_BRIEF.md` §9 — Security posture / Liability
- `PROJECT_BRIEF.md` §17 — NOTICE file (verbatim)
- ADR-0001 — Codename and repo identity (establishes the "aegis" codename referenced in NOTICE)
