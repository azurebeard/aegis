# Modified Abuse Monitoring — Pre-Submission Package

**Status:** Draft pre-submission package for Project Aegis / Foundry (West Europe). Compiled 2026-04-21.
**Purpose:** pre-populate Microsoft's Limited Access form so the operator can submit without re-researching the field list.
**Target programme:** Azure OpenAI Limited Access Review — **Modified Abuse Monitoring** (zero retention of prompts/completions, no Microsoft human review).

## TL;DR

- The toggle flips `ContentLogging: false` on every Cognitive Services / Foundry account inside the approved subscription(s) — no code change, no tenant-side config diff.
- The hard gate is **managed-customer status** with Microsoft (account team / CSAM / FastTrack). Without that the submission is deprioritised indefinitely. **Confirm this before submitting.**
- Realistic SLA: **2–4 weeks** for clean submissions; 6–8+ weeks for non-standard use cases (Aegis / MSSP-adjacent falls here because the form's preset dropdown doesn't list managed-security-services as a category).
- Modified abuse monitoring does NOT turn off the content-filter pipeline. Filters remain ON; only prompt/completion retention + human review stop.

## Authoritative URLs (verified 2026-04-21)

| Resource | URL |
|---|---|
| Policy / gateway page | <https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/limited-access> |
| Application form (Customer Voice) | <https://customervoice.microsoft.com/Pages/ResponsePage.aspx?id=v4j5cvGGr0GRqy180BHbR7en2Ais5pxKtso_Pz4b1_xUOE9MUTFMUlpBNk5IQlZWWkcyUEpWWEhGOCQlQCN0PWcu> |
| Abuse monitoring concept | <https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/abuse-monitoring> |
| Limited Access FAQ / SLA | <https://learn.microsoft.com/en-us/azure/ai-services/cognitive-services-limited-access> |

The form is titled **"Azure OpenAI Limited Access Review: Modified Abuse Monitoring"**.

## Pre-populated field responses

Microsoft does not publish the full field list. The following is reconstructed from the live form + community threads. Treat as a working template; the form may add / reorder fields on re-submission.

| # | Field | Aegis value |
|---|---|---|
| 1 | Corporate email (personal emails auto-reject) | `ben@azurebeard.co.uk` |
| 2 | Company / legal entity name | *(operator to supply)* |
| 3 | Microsoft account team / CSAM name | **CRITICAL** — see §Blocker below |
| 4 | Tenant ID | `764279e8-66e9-49b4-901f-a7592435ae1d` (picnicdev) |
| 5 | Azure subscription ID(s) | `58ffe548-7d9e-4c50-9fb9-bcbd74d39fdd` (Management) — add prod subscription when it exists |
| 6 | Foundry / Azure Direct Model resource name(s) | `aif-aegis-hub-dev-weu` (hub) / `aif-aegis-proj-dev-weu` (project). Add prod resources when they exist. |
| 7 | Region(s) | West Europe |
| 8 | Models in use | `aegis-small` deployment → `gpt-4.1-mini` (Standard SKU) |
| 9 | Expected monthly token volume | ~6M tokens/month (200K/day × 30) across brief + posture + incidents-analysis agents combined |
| 10 | Use-case category (dropdown) | "Security operations / managed security analytics" is closest; fall back to "Internal enterprise analytics / summarisation" if MSSP-adjacent is not listed |
| 11 | Use-case description (free text, ~2000 char) | **See §Suggested narrative below** — drop verbatim |
| 12 | Description of end users | Security operators inside a single tenant. Admin-only dashboard. No end-customer chat; no free-text input path reaches the model. |
| 13 | Customer base / sector | Single-tenant enterprise security tooling for a managed-security practice (azurebeard.co.uk) |
| 14 | Data sensitivity / zero-retention justification | Deterministic security-signal payloads reference Defender XDR incidents, Secure Score, Entra risky-user telemetry — treated as confidential security data under customer NDA. Retention outside operator tenant boundary is unacceptable by engagement terms with end customers. |
| 15 | PII handling | Default `userIdentifierStrategy=objectId` — only Entra object GUIDs enter prompts; no names, UPNs, or email addresses. Operator-controlled opt-in to partial-mask (`A___ E*****`) or display_name. Documented in `docs/AI-SECURITY-POSTURE.md`. |
| 16 | Compliance attestation checkboxes | Tick both: "implement systems and measures…Microsoft Generative AI Services Code of Conduct" + "acknowledge risks of turning off abuse monitoring" |
| 17 | Content-moderation controls in place | Azure OpenAI default content filters ENABLED (no severity override). 4-layer prompt-injection defence: length cap → control-character strip → denylist → structural fencing. Per-field screening on 4 adversary-influenceable incident-detail fields (description, summary, resolvingComment, alert.title). |
| 18 | Logging / auditing controls | JCS-canonical (RFC 8785) per-source SHA-256 hash-chained NDJSON audit trail. Every prompt + completion recorded as an `agent.run` line with chain fields (`prevLineSha256`, `lineSha256`, `outputSha256`). `outputSha256` re-verified on read. Standalone verifier at `scripts/verify-audit-chain.mjs` walks the chain from genesis sentinel. ADR-0015 / ADR-0021. |
| 19 | Access controls | Azure RBAC + managed-identity-only on the Foundry project (agent MI holds `Azure AI Developer` role, scoped to the single project). No shared-key access anywhere in the stack. Easy Auth on the Function App; SWA admin-role gate on all admin endpoints. `deployAiAgents` Bicep toggle for regulated / air-gapped deployments that need the AI plane disabled entirely (ADR-0017 resolution, 2026-04-21). |
| 20 | Incident response process | Security-incident escalation routes via the tenant's standard Azure Monitor + App Insights alert pipeline. Audit-chain-break alert fires on verifier exit-code 2 via scheduled query rule. Retention-breach playbook would engage the operator's data-incident-response process. |
| 21 | Training / responsible-use programme | Operator-signed acceptable use policy (operator is single-person today; expand to formal AUP on team growth). Responsible AI posture documented in `docs/AI-SECURITY-POSTURE.md`, reviewed by WS10 Security Reviewer at release. |
| 22 | Previous approved application ID | Leave blank (first submission) |
| 23 | Specific modifications requested | **Modified abuse monitoring only.** Do NOT request modified content filters in this submission. |
| 24 | Modification sub-panel | Tick: "Disable human review of prompts and completions" + "Disable prompt/completion retention for abuse monitoring" |
| 25 | Signatory name + role | Must be someone who can legally bind the entity. Ben Thomas — proprietor / directing mind. |

## Suggested use-case narrative (field 11 verbatim)

> Aegis is a single-tenant Microsoft Defender XDR analytics dashboard
> deployed inside the operator's own Azure tenant (West Europe, Foundry
> Standard SKU). Azure Direct Model calls are made exclusively by three
> deterministic agents (brief, posture, incidents-analysis) that synthesise
> human-readable narratives from operator-filtered Defender XDR incidents,
> Secure Score telemetry, and Entra risky-user signals. There is no
> end-user chat surface, no free-text operator input path, and no training
> or fine-tune loop — the model receives structured security signals from
> the operator's own ingest and returns summarisation narratives for
> dashboard rendering only. PII is minimised by default: user identifiers
> are Entra object GUIDs (no names, UPNs, or email addresses enter
> prompts) unless the operator explicitly opts into display-name
> rendering. Azure default content filters remain enabled. A 4-layer
> prompt-injection defence (length cap, control-character strip, denylist,
> structural fencing) runs on every input. Every prompt and completion is
> recorded on a JCS-canonical SHA-256 hash-chained NDJSON audit trail
> with output integrity verification on read. The operator's engagement
> terms with their own customers prohibit security-incident payloads
> leaving the operator-controlled boundary; this is why Microsoft-side
> retention and human review of prompts must be disabled under a formal
> Limited Access approval rather than relied upon as a policy
> commitment. Expected volume is small (~200k tokens/day across all
> three agents).

## Eligibility

Two hard gates:

1. **Microsoft-managed-customer status.** Required. Submissions from corporate email without a managed-customer relationship (account team / CSAM / FastTrack) are technically processed but routed to a low-priority "eligibility programme review" that rarely clears. The form's account-team field is the primary signal Microsoft uses for prioritisation.
2. **Corporate email domain.** Personal email addresses are auto-rejected at form submission.

Canonical qualifying sectors: healthcare (HIPAA), financial services (PCI), legal (privileged material), government. Managed-security-services is NOT a preset category — Aegis submissions must argue the case under "highly sensitive / confidential data" using the single-tenant architecture framing (see field 11 narrative) rather than an MSSP multi-tenant framing.

## What happens after approval

- **Scope: subscription-level.** Applies to every `Microsoft.CognitiveServices/accounts` resource inside the approved subscriptions, across all regions, all models, all deployments.
- **Technical artefact:** each account's `properties.ContentLogging` flips to `false`.
- **Verification command:**

```bash
az cognitiveservices account show \
  --name aif-aegis-hub-dev-weu \
  --resource-group rg-aegis-dev-weu \
  --query "properties" -o json | grep -i contentLogging
# Expected post-approval: "ContentLogging": false
```

- **No code change required.** The flip is invisible to the application code path. The audit value is that the Azure platform stops storing the payload — retention clock goes to zero, JIT human-reviewer access stops.
- **What does NOT change:** Azure content-filter classifier runs as before on every request. Aegis's own audit chain is unaffected (it's operator-side, not Microsoft-side). Aegis's 4-layer prompt-injection defence is unaffected.

## SLA

- Published: 5–10 business days to first communication.
- Realistic commercial experience (2025–2026):
  - **Clean managed-customer request: 2–4 weeks end-to-end.**
  - Non-standard use case (Aegis-adjacent MSSP / managed-security framing): **6–8+ weeks.**
- Microsoft may request clarification; each round restarts the clock. **Respond within 48h** to keep momentum.

## Common delay / rejection reasons

1. Submission without a managed-customer relationship (Aegis's #1 risk — see §Blocker).
2. Personal email domain.
3. Use-case preset mismatch — mitigate by leading with the deterministic-input-only / no-end-user-chat / operator-tenant-bounded framing.
4. Generic "we care about privacy" justification — anchor to concrete regulatory / contractual drivers.
5. Thin content-moderation story — Aegis is strong here; lead with content filters + injection defences + hash-chain audit.
6. Missing technical detail (vague sub IDs, volume estimates, model list).
7. Requesting modified content filters in the same submission — compound asks take longer. Submit filter-modification separately (if ever needed).
8. Signatory not authorised — must be someone who can legally bind the entity.

## Blocker to resolve BEFORE submission

**Confirm Microsoft-managed-customer status for azurebeard.co.uk.**

If there is no active account team or CSAM relationship, field 3 cannot be completed credibly and the application will not clear first review. Options:

1. **Engage a Microsoft account team first.** For a single-person consultancy, this typically means going through a partner programme (Solutions Partner / FastTrack for Azure / CSP). If Ben already has Partner Centre access, the CSAM relationship may exist under that umbrella — check Partner Centre → "Your Microsoft contacts".
2. **Submit via a customer relationship.** If the first operational tenant is a larger customer with an existing account team, the application can be co-signed with that customer's CSAM.
3. **Accept the slow path.** Without a managed-customer relationship, submit anyway and prepare for 6+ weeks in the review queue. This is tolerable if the regulated-tenant trigger is still distant.

## Post-approval checklist

On approval email arrival:

1. `az cognitiveservices account show` on each listed Foundry resource — confirm `ContentLogging: false`. If not flipped, open a support ticket referencing the approval email.
2. Update `AI-SECURITY-POSTURE.md` §"Where the data goes outside the app" to reflect zero-retention status. Add the approval date + subscription scope.
3. Update `HANDOVER.md` §6.3 — strike the Modified Abuse Monitoring opt-in item with resolution date.
4. If a prod subscription lands later, file a scope-modification request to add it.

## Sources

- [Limited access to Azure OpenAI in Microsoft Foundry Models](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/limited-access)
- [Azure Direct Models abuse monitoring](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/abuse-monitoring)
- [Limited Access features for Foundry Tools (FAQ + SLA)](https://learn.microsoft.com/en-us/azure/ai-services/cognitive-services-limited-access)
- [Customer Voice form — Modified Abuse Monitoring](https://customervoice.microsoft.com/Pages/ResponsePage.aspx?id=v4j5cvGGr0GRqy180BHbR7en2Ais5pxKtso_Pz4b1_xUOE9MUTFMUlpBNk5IQlZWWkcyUEpWWEhGOCQlQCN0PWcu)
- [microsoft-foundry discussion #170 — subscription-scope confirmation](https://github.com/orgs/microsoft-foundry/discussions/170)
- [Microsoft Q&A — Clarification on Disabling Abuse Monitoring + Data Retention](https://learn.microsoft.com/en-us/answers/questions/5609842/(urgent)-clarification-on-disabling-abuse-monitori)
