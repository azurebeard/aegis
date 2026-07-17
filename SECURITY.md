# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in XDR Hub (codename `aegis`), please **report it privately**. Do not open a public GitHub issue, discussion, or pull request that describes the vulnerability.

### Preferred channel

Use GitHub's **private vulnerability reporting** on this repository:

> https://github.com/azurebeard/aegis/security/advisories/new

This opens a private advisory visible only to the maintainer and the reporter, and lets us coordinate a fix, a disclosure timeline, and a CVE if applicable.

### Backup channel

If you cannot use GitHub's private reporting, email the maintainer:

> **security@azurebeard.co.uk**

Include:

- A clear description of the vulnerability.
- Reproduction steps or a proof-of-concept, where safe to share.
- The affected component (Bicep module, Function, agent prompt, dashboard surface, etc.) and, where known, the commit SHA or release tag.
- Your preferred disclosure timeline.

For anything sensitive, prefer **GitHub private vulnerability reporting** (the link above) — the channel is end-to-end private between reporter and maintainer and doesn't depend on email-transport security. A PGP key for the backup `security@azurebeard.co.uk` channel is not published in v1; if you specifically need an encrypted email channel, open a private advisory first and we'll coordinate.

## What you can expect

- **Acknowledgement** within 3 working days of receipt.
- A **triage response** within 10 working days, including a preliminary severity assessment and a planned remediation path if the report is confirmed.
- **Coordinated disclosure.** We will not publicly disclose a confirmed vulnerability before a fix is available, unless the reporter requests otherwise or the issue is already public. Our default target is a 90-day coordinated-disclosure window from triage.
- **Credit** in release notes and the project's NOTICE-style acknowledgements, unless the reporter asks to remain anonymous.

## Scope

In scope:

- The Bicep templates under `/infra/`.
- The Azure Functions code under `/api/` and any polyglot Function Apps under `/api-py/` or `/api-net/`.
- The React SPA under `/web/`.
- The Foundry agent definitions, prompts, and tool schemas under `/agents/`.
- The scheduled ingestion Functions under `/ingest/`.
- Deployment scripts under `/scripts/` and migrations under `/infra/migrations/`.

Out of scope:

- Microsoft Azure platform issues — report those to the Microsoft Security Response Center (https://msrc.microsoft.com/).
- Vulnerabilities in third-party dependencies that are not reachable from this project's code paths. Where they are reachable, they are in scope and we will typically coordinate with the upstream maintainer.
- Issues in deployer-managed Azure configuration (tenant-side Conditional Access, RBAC, Entra ID policies, etc.) — those are the deployer's responsibility under the Apache 2.0 liability disclaimer.

## Data handling

If you're an operator or evaluator wondering what tenant data Aegis processes, where prompt data goes, and what the retention posture looks like, the short answer is in [README — Security posture](README.md#security-posture) and the full answer is in [`docs/AI-SECURITY-POSTURE.md`](docs/AI-SECURITY-POSTURE.md). Headline: ingest data never leaves your tenant; the AI plane is off by default; Microsoft's standard Azure OpenAI retention (30 days, abuse-detection scanning, human review on flagged content only) applies when the AI plane is enabled.

## Safe harbour

We consider good-faith security research that:

- Does not degrade or disrupt the service for other users.
- Does not exfiltrate or retain production data beyond what is necessary to demonstrate the issue.
- Respects privacy and data-protection obligations.
- Follows the coordinated-disclosure process above.

...to be authorised and will not pursue legal action for it. This safe harbour does not extend to activity that violates applicable law.

## Out of scope for this file

This policy governs the open-source project only. Deployers running XDR Hub in their own Azure tenant are responsible for incidents in their own environments and should follow their organisation's incident-response process. Liability is on the deployer per Apache 2.0 §§7–8.
