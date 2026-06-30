# XDR Hub (Aegis) — Customer Onboarding Runbook

> Audience: operator deploying Aegis to a customer-owned Azure subscription +
> Entra tenant for the first time. "Live-observed" footnotes capture the
> exact symptoms a fresh-tenant deploy produces — paste them into a search
> bar to match against what you're seeing.

## TL;DR

```bash
# 1. Pre-flight — you do these once, by hand
az login --tenant <CUSTOMER_TENANT_ID>
az account set --subscription <CUSTOMER_SUBSCRIPTION_ID>
azd auth login

# 2. Create the azd env
azd env new <env-name>         # `dev` | `test` | `prod`
azd env set AZURE_LOCATION uksouth      # azd's deploy-resource location only — see note below
azd env set AZURE_ADMIN_EMAIL    <admin@customer.example>
azd env set AZURE_ADMIN_UPN      <admin-upn@tenant.onmicrosoft.com>
azd env set AZURE_DEPLOYER_OBJECT_ID    <your-az-ad-objectId>
azd env set AZURE_DEPLOYER_PRINCIPAL_TYPE User           # or ServicePrincipal for headless
azd env set AZURE_BUDGET_START_DATE     <YYYY-MM-DD>

# 3. Provision + bootstrap + deploy
azd up
```

`azd up` runs provision → postprovision hooks (Entra bootstrap + KV
secret seeding) → api + web deploy in one shot. Typical wall-clock on
a fresh-tenant deploy:

- `azd provision` (incl. postprovision Phase 1–4): **~3m 10s** cold
  (~1m 35s on re-runs once resources cached)
- `azd deploy api`: **~1m 49s**
- `azd deploy web`: **~50s**

→ **end-to-end ~6 minutes** on a clean tenant when the operator already
has a cached Microsoft Graph token. Add 1–3 minutes if Connect-MgGraph
needs an interactive sign-in. No phase blocks for more than ~30s; the
operator can leave it running.

---

## §1. Prerequisites the customer must provide

Land these by email or kick-off call **before** you start `azd up`. Each
maps to one of the env vars below.

| Item | Used for | Maps to |
|---|---|---|
| **Tenant ID** (GUID) | All Azure CLI commands; postprovision Entra bootstrap | `az account` context (no env var) |
| **Subscription ID** (GUID) | Resource provisioning target | `AZURE_SUBSCRIPTION_ID` (auto-set by `azd env new`) |
| **Region** | Resource group region | Bicep params `region` / `regionShort` (default `uksouth` / `uks`) — set via `azd env set AZURE_LOCATION=westeurope` + `azd env set AZURE_REGION_SHORT=weu` if you want WEU. `AZURE_LOCATION` only controls where azd places the deployment metadata resource, NOT the resources themselves. |
| **SWA region** (separate from main region) | Static Web App control-plane location — SWA only available in **5 regions** (`centralus`, `eastus2`, `westus2`, `westeurope`, `eastasia`). This is a control-plane choice, not a user-latency choice (SWA edge CDN reaches users globally regardless). | `staticWebAppLocation` Bicep param / `AZURE_STATIC_WEB_APP_LOCATION` env var. Default `westeurope`. Reference: [Microsoft Learn — SWA region FAQ](https://learn.microsoft.com/azure/static-web-apps/faq#how-do-i-ensure-my-app-is-deployed-to-a-specific-azure-region) |
| **Admin UPN** (full UPN, e.g. `admin@contoso.onmicrosoft.com`) | The first user who gets the `admin` App Role grant on the SPA — they sign in and become the operator | `AZURE_ADMIN_UPN` |
| **Admin contact email** (vanity OK, e.g. `admin@contoso.com`) | Stored as downstream contact metadata; falls back to UPN if external-email lookup fails | `AZURE_ADMIN_EMAIL` |
| **Deployer object ID** (your operator account's AAD `objectId`) | Key Vault Secrets Officer ABAC grant — narrows the deployer's KV read scope to per-secret-name | `AZURE_DEPLOYER_OBJECT_ID` |
| **Mail-sender mailbox UPN** (prod) — licensed or shared mailbox | Outbound report-email Phase C wiring. **Prod default is hard-fail**: if you don't set EITHER this OR `AZURE_MAIL_SENDER_REQUIRED=false`, postprovision aborts at Phase C with a stack-trace error. Dev/test soft-skip when empty. | `AZURE_MAIL_SENDER_UPN` (mailbox) OR `AZURE_MAIL_SENDER_REQUIRED=false` (ingest-only deploy) |
| **Deployer public CIDR** (prod with PE) | KV + ops-storage `networkAcls.ipRules` exception. Required when `AZURE_PRIVATE_ENDPOINTS_ENABLED=true` AND the operator runs `azd provision` / `azd deploy` from outside the VNet — otherwise the secret seed and FA zip upload hit `Forbidden`. | `AZURE_DEPLOYER_IP_ALLOWLIST` (e.g. `"203.0.113.42/32"`; comma-separated for multiple, no whitespace) |
| **Budget start date** | Anchors the monthly agent-budget reset window (immutable once set) | `AZURE_BUDGET_START_DATE` (YYYY-MM-DD) |

### Customer-side Azure permissions you'll need

The deploying operator account needs, in the customer's subscription:

- **Contributor** on the subscription (or RG once it exists)
- **User Access Administrator** on the RG (Bicep creates role assignments)
- **Application Administrator** OR **Cloud Application Administrator** in
  Entra (the postprovision hook creates app registrations)

If the operator can't be a permanent admin, document a "deploy-then-step-
down" plan with the customer: the deployer Secrets Officer ABAC grant
already narrows the post-deploy footprint to a single named secret.

### Customer-side feature licensing

Aegis ingests Microsoft Defender XDR + Secure Score + Entra Risk + Conditional
Access. Confirm the customer has:

- **Microsoft Defender for Endpoint Plan 2** (or Defender XDR / E5
  Security) — drives `incidents` + `alerts` ingest
- **Microsoft Entra ID P1** minimum (P2 for risk detections) — drives
  `riskyUsers` + `riskDetections`
- **Microsoft Secure Score** access — included with any tenant; needs at
  least one workload (Exchange, SharePoint, Defender) populating signal

### Pre-flight quota check (optional but recommended)

Check Foundry capacity in the target region BEFORE starting:

```bash
az cognitiveservices usage list --location <region> \
  --query "[?contains(name.value, '4.1-mini')].{n:name.value, c:currentValue, l:limit}" -o table
```

Aegis deploys **50K TPM gpt-4.1-mini Standard** by default. If the
customer's subscription doesn't yet have OpenAI quota in the region,
request it via the Azure Portal *Quota* blade before `azd up`. Lead
time: usually instant for ≤ 50K TPM, 1–3 days for larger asks.

---

## §2. Step-by-step

### 2.1 Log in to all three SDKs

```bash
az login --tenant <CUSTOMER_TENANT_ID>             # core Azure CLI
az account set --subscription <CUSTOMER_SUBSCRIPTION_ID>
azd auth login                                     # azd uses its own token
```

> **Pitfall**: if you're already signed in to a different tenant, `azd` may
> silently re-use the old context. `azd auth logout` first to be safe.

### 2.2 Create the azd environment

```bash
azd env new <env-name> \
  --location <region> \
  --subscription <CUSTOMER_SUBSCRIPTION_ID>
```

`<env-name>` MUST be one of: `dev`, `test`, `prod`. The Bicep `@allowed`
constraint rejects anything else, and the value drives the hardening tier
— `prod` enables resource locks, KV purge protection, audit immutability
lock; `dev`/`test` skip those for iteration speed.

### 2.3 Pre-populate required env vars

```bash
# Mandatory (deploy fails without these)
azd env set AZURE_ADMIN_EMAIL          <admin@customer.com>
azd env set AZURE_ADMIN_UPN            <admin@tenant.onmicrosoft.com>
azd env set AZURE_DEPLOYER_OBJECT_ID   <your-az-ad-objectId>
azd env set AZURE_DEPLOYER_PRINCIPAL_TYPE User       # or 'ServicePrincipal'
azd env set AZURE_BUDGET_START_DATE    <YYYY-MM-DD>

# Mandatory IN PROD — pick ONE of:
azd env set AZURE_MAIL_SENDER_UPN      <reports@customer.com>   # licenced or shared mailbox
# ── OR ──
azd env set AZURE_MAIL_SENDER_REQUIRED false                    # ingest-only deploy, Phase C inert
```

To find your AAD object ID:

```bash
az ad signed-in-user show --query id -o tsv
```

> **Tip**: if `AZURE_ADMIN_EMAIL` is an external/vanity email (doesn't
> resolve as a UPN in the customer tenant), the `AZURE_ADMIN_UPN` value
> takes priority for the directory lookup — keep both set.

#### Recommended for fresh-tenant deploys: `AZURE_UNIQUE_SUFFIX`

KV and Storage account names are **globally unique across all Azure
customers**. A deploy attempting `kv-aegis-prod-uks` on a fresh tenant
can fail with `VaultAlreadyExists` if some unrelated tenant has the
same name. Same risk on `staegisaudit<env><region>` and
`staegisops<env><region>`.

Setting a sub-derived suffix sidesteps the collision entirely:

```bash
# Use the last 4 characters of the subscription ID as a suffix
azd env set AZURE_UNIQUE_SUFFIX $(az account show --query id -o tsv | tail -c 5 | tr -d '-')
```

This makes the deployed names look like `kv-aegis-prod-uks-b055`,
`staegisauditprodweub055`, etc. — guaranteed unique within the sub
and statistically unique across customers.

> Safe to omit on tenants already deployed without a suffix. Changing
> the suffix on an already-deployed tenant creates NEW resources
> alongside the originals (it is not a rename).
>
> KV and Storage account names are globally unique across Azure. If the
> unsuffixed name (e.g. `kv-aegis-prod-uks`) is already in use by
> another Azure customer, set the suffix to recover.

#### Required for prod with private endpoints: `AZURE_DEPLOYER_IP_ALLOWLIST`

When `AZURE_PRIVATE_ENDPOINTS_ENABLED=true` (prod-tier default), KV and
ops-storage are configured with `publicNetworkAccess: Disabled`. The
private endpoints serve runtime traffic, but the operator running
`azd provision` / `azd deploy` is still **outside the VNet** — without
an exception, three deploy steps will fail with `Forbidden`:

- Postprovision Phase 4 — `az keyvault secret set` for `recipient-hash-pepper`
- Postprovision Phase 4 — `az keyvault secret set` for `report-share-signing-key`
- `azd deploy api` — zip upload to the `func-deployments` blob container

Wire a single durable CIDR exception through `networkAcls.ipRules` on
both resources:

```bash
# Look up your current egress IP (whatever the customer's KV/Storage
# firewalls will see when az / azd connects out). Pick the path you trust:
MY_IP=$(dig +short myip.opendns.com @resolver1.opendns.com)   # DNS-only, no third-party HTTP
# ── OR ──
MY_IP=$(curl -s https://api.ipify.org)                        # public HTTP reflector (third-party SaaS)

azd env set AZURE_DEPLOYER_IP_ALLOWLIST "${MY_IP}/32"
```

Comma-separated for multiple operators (no whitespace, IPv4 only —
Storage + KV both reject IPv6 ipRules):

```bash
azd env set AZURE_DEPLOYER_IP_ALLOWLIST "203.0.113.42/32,198.51.100.7/32"
```

The exception is **durable** — it applies to all future rotations from
the same network boundary, not just the initial deploy. `publicNetworkAccess`
stays `Disabled` (the PE remains the primary access path); only the
named CIDRs are firewall-excepted.

> Without this param, the workaround is manually flipping
> `publicNetworkAccess` to `Enabled` for the deploy window — error-prone,
> and leaves the resources transiently more-exposed than the prod-tier
> posture says they should be.

### 2.4 Run `azd up`

```bash
azd up
```

Expect this sequence (timing from a clean tenant, no cache):

| Phase | Duration | What happens |
|---|---|---|
| `Validating deployment` | ~30s | Bicep template validates against the resource provider; main.bicep + bicepparam compile |
| `Creating/Updating resources` | ~2–3 min cold | RG, App Insights, LAW, KV, audit storage, ops storage, SWA, Foundry hub + project + aegis-small deployment, App Service plan, Function App, role assignments + ABAC conditions, scheduledQueryRules, action group. Live-observed on a fresh tenant: ~2m 30s wall-clock; subsequent re-provisions ~1m 35s (existing resources fast-path). |
| `postprovision` Phase 1 — Entra bootstrap | ~30–60s | **Interactive Graph login** (Connect-MgGraph; picks up `az login` token if a session is cached — usually NO device-code prompt). Creates 3 app registrations: `app-aegis-<env>-<tenantShort>` (legacy combined app, not used on new deploys), `app-aegis-api-<env>-<tenantShort>` (resource side), `app-aegis-spa-<env>-<tenantShort>` (client side). Tenant-wide admin consent for the SPA → API `api.access` delegated permission. Admin role granted on both SPA + API SPs to the resolved UPN. **8 Graph app-role grants** to the ingest MI: `SecurityEvents.Read.All`, `SecurityIncident.Read.All`, `IdentityRiskyUser.Read.All`, `Organization.Read.All`, `User.Read.All`, `AuditLog.Read.All`, `Application.Read.All`, `Policy.Read.All`. Function App restart to invalidate the IMDS MI token cache. |
| `postprovision` Phase 2 | <1s | SWA → Function App backend linking (same-origin proxy for Bearer JWT pass-through) |
| `postprovision` Phase 3 | <1s | Audit immutability lock check (skipped for `dev`/`test`; prod-only) |
| `postprovision` Phase 4 | ~20s | KV secret seeding — `recipient-hash-pepper` + `report-share-signing-key`. First-time deploy writes new versions + restarts Function App so the module-scope caches pick them up. Idempotent on re-runs. |
| `azd deploy api` | ~1m 45s | `npm ci`, `tsc build`, zip + upload to Function App. Fetches Function App endpoints (~1m 30s of that is the endpoint-fetch step on Flex Consumption). |
| `azd deploy web` | ~40s | `vite build` (consumes `AZURE_AEGIS_SPA_APP_ID` from postprovision-1), zip + upload to SWA. |

### 2.5 Verify the deploy

After `azd up` reports `SUCCESS`:

```bash
# 1. Pull the SWA hostname from the deployment outputs.
#    The shape is https://<random-name>.<N>.azurestaticapps.net/ — printed in
#    the `azd deploy web` output ("Endpoint: ...") and queryable via Azure:
az staticwebapp show -n stapp-aegis-<env>-<regionShort> \
  -g rg-aegis-<env>-<regionShort> \
  --query "defaultHostname" -o tsv

# 2. Surface-level smoke (no sign-in required):
curl -s -o /dev/null -w "SWA shell: HTTP %{http_code}\n" \
  https://<hostname>/
# Expect: HTTP 200 (the SPA index.html)

curl -s -o /dev/null -w "Function App unauth: HTTP %{http_code}\n" \
  https://func-aegis-api-<env>-<regionShort>.azurewebsites.net/api/auth/roles
# Expect: HTTP 403 (Bearer JWT enforcement)

# 3. Sign in as the admin UPN. The 'admin' App Role grant landed during
#    postprovision Phase 1 on both the SPA SP (drives the `roles` claim in
#    the ID token) and the API SP (audience-side enforcement).

# 4. Trigger the first ingest by hand (Timer cadence is hourly to daily —
#    you don't want to wait for the natural fire on a fresh deploy):
#    — Settings > Trigger now > Secure Score
#    — Settings > Trigger now > Incidents
#    — Settings > Trigger now > EntraRisk

# 5. Wait for the brief-agent / posture-agent next-fire OR trigger by hand
#    — Daily Brief tile > Refresh now
#    — Weekly Posture tile > Refresh now
```

Live-observed checks on a fresh deploy:

- SWA shell: HTTP 200 ✅
- Function App `/api/auth/roles` unauth: HTTP 403 ✅
- All postprovision env var persistence: AZURE_AEGIS_API_APP_ID,
  AZURE_AEGIS_SPA_APP_ID, AZURE_BUDGET_START_DATE all auto-populated

> If sign-in returns 404 from `/.auth/login/aad`, the SWA's
> `AAD_CLIENT_ID` app setting didn't pick up. See §3.4 below.

---

## §3. Known pitfalls + recovery

These have all been seen during build-out — this is the
onboarding-relevant subset of the full catalogue.

<!-- POPULATE_FROM_RUN — captured as I walk the deploy -->

### 3.1 Bootstrap-entra Graph auth — token discovery, not always device-code

Live-observed: on a workstation with a fresh `az login` session
to the customer tenant, `Connect-MgGraph -TenantId X -Scopes Y` picks up the
cached Microsoft Graph token from the `az` session and does NOT prompt for
device code. Postprovision Phase 1 ran end-to-end without a single browser
interaction.

If the operator does NOT have a cached Graph token (clean machine, first
ever Graph call), Connect-MgGraph falls back to:

- **GUI machine** (Windows / macOS with browser): pop-up browser sign-in.
- **Headless Linux**: device-code printed to terminal stdout — visit
  `https://microsoft.com/devicelogin`, paste the code.

If your `azd up` is running in a CI job or non-TTY context, the
device-code prompt may not surface visibly. Run `azd provision` foreground
in a terminal you can see.

### 3.5 Fresh-workspace AzureDiagnostics schema discovery — RESOLVED

**Live-observed on a fresh deploy.**

`azd provision` aborts mid-way with:

> `BadRequest: 'project' operator: Failed to resolve scalar expression named '<col>'. A semantic error occurred.`

…and named one of: `Identity`, `identity_claim_xms_mirid_s`, `id_s`.

**Cause**: the `kvAbacDenialAlert` scheduledQueryRule's KQL projects
columns from `AzureDiagnostics`. Azure validates the KQL against the
workspace's *discovered* schema at deploy time. On a fresh workspace
that has never ingested an AzureDiagnostics row, none of those columns
are in the discovered schema and the query fails semantic validation.

**Resolution**: all dynamic columns now wrapped in `column_ifexists("col", "")`
in `infra/modules/alerts.bicep`. Fresh deploys should not hit this. If you
do, re-run `azd provision` after a `git pull`.

### 3.2 Foundry quota exhaustion

If `azd provision` fails on the `Microsoft.CognitiveServices/accounts/deployments`
resource with `InvalidParameter: Requested capacity exceeds available quota`,
the subscription lacks 50K TPM gpt-4.1-mini Standard quota in the region.

**Fix**: Portal > Subscription > Quotas > *Cognitive Services* > raise
the gpt-4.1-mini-Standard quota in the target region. Most asks ≤ 50K TPM
are auto-approved.

### 3.3 `azd up` aborts on a 5-minute postprovision timeout

If the operator doesn't complete the device-code login within ~5 minutes,
the postprovision hook times out and the deployment is left half-applied
— RG resources are deployed, but Entra app regs may not have been created.

**Fix**: `azd provision` again (idempotent; reuses existing resources +
re-runs postprovision). Have the browser tab ready before starting.

### 3.4 SWA sign-in returns 404 — app setting not picked up

Live-observed during the build-out. If `azd provision`
runs WITHOUT the `AZURE_AAD_CLIENT_ID` and `AZURE_SWA_MI_APP_ID` env vars
set, the SWA's appsettings + the Function App's Easy Auth bindings get
reset to the placeholder client ID. Bicep is now authoritative for both,
but ONLY when the env vars are set.

**Fix**: after the first `azd up`, the postprovision hook persists both
into the azd env. Subsequent `azd provision` runs preserve them
automatically. If you lose the env vars (e.g. by deleting `.azure/test/`):

```bash
# Recover from Bicep deployment outputs
az staticwebapp appsettings set ... AAD_CLIENT_ID=<appId>
az rest --method PUT ... authsettingsV2 ...
```

---

## §4. Teardown (test/dev only)

```bash
azd down --force --purge
```

`--purge` is critical: without it, the KV stays soft-deleted for 7+ days
and a re-deploy with the same env name will fail with
`Conflict: VaultAlreadyExistsInSoftDeletedState`.

**Manual Entra cleanup** is still required after `azd down` — `azd` does
not touch app registrations.

The split-deploy creates **TWO** app registrations on first deploy:

| App reg | Role |
|---|---|
| `app-aegis-api-<env>-<tenantShort>` | Resource side — audience-validated by the Function App's native JWT validator |
| `app-aegis-spa-<env>-<tenantShort>` | Client side — MSAL SPA + ID-token `roles` claim |

The legacy combined `app-aegis-<env>-<tenantShort>` is NOT created on
fresh deploys; you only see it on environments upgraded from the legacy
flow.

```bash
# List the app regs created for this env (substitute env + tenantShort)
az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/applications?\$filter=endsWith(displayName,'-<env>-<tenantShort>')&\$count=true" \
  --headers "ConsistencyLevel=eventual" \
  --query "value[].{name:displayName, id:appId}" -o table

# Delete them (one at a time; permanent — they go into the 30-day deleted-app
# recycle bin and can be restored from there until that window closes)
az ad app delete --id <appId>
```

`<tenantShort>` is the last 8 hex chars of the tenant ID. For example,
in tenant `764279e8-...-2435ae1d`, the test env's app regs end with
`-test-2435ae1d`.

---

## §5. Post-onboarding checklist

After verifying §2.5, hand the customer:

- [ ] SWA hostname (where the operator signs in)
- [ ] Schedule summary (daily brief 05:00 UTC, weekly posture 06:00 UTC Mon)
- [ ] Trigger-now workflow (Settings > Trigger now > <vertical>)
- [ ] Cost expectation note: Foundry inference is the dominant cost; idle
      run rate ~£0.20/day, active with daily brief ~£1–2/day at default
      50K TPM (varies with model deployment)
- [ ] Operator handover note: which person holds the `admin` App Role
      grant + how to grant additional admins (Entra > Enterprise apps >
      `app-aegis-spa-<env>-<tenantShort>` > Users and groups > Add)

---

## §6. Optional integrations

Operator-driven add-ons. None of these are required for the core dashboard
to work — they extend the data surfaces Aegis can show. Each section is
self-contained and can be enabled / disabled independently after the
base onboarding (§1–§5) is complete.

### §6.1 Ransomware.live PRO threat-intel

**What it does (when fully live):** surfaces the recent ransomware victim
list + cyberattack press for the customer's country alongside the
internal posture tiles. Operator-side context — answers "which groups
are active in our sector this month" with public-feed data rather than
internal telemetry. Hourly ingest, separate dashboard tile + `/ransomware`
drilldown, optional sector filter.

The operator seeds the KV secret first; the dashboard tile auto-appears
once the first ingest run completes.

#### Step 1 — get an API key

The integration uses [ransomware.live](https://www.ransomware.live/)'s
PRO API. The key is free and tied to an email address. Generate at:

> <https://www.ransomware.live/my>

The 500K req/month rate cap on the free PRO key is generous for Aegis's
hourly cadence (~1,440 req/month/tenant — supports ~347 tenants on one
shared key).

#### Step 2 — seed the KV secret

Once the API key is in hand, run the operator-side provisioning script:

```bash
./scripts/provision-ransomware-live-api-key.ps1 \
  -KeyVaultName "$(azd env get-value KEY_VAULT_NAME)" \
  -FunctionAppName "$(azd env get-value FUNCTION_APP_NAME)" \
  -ResourceGroupName "$(azd env get-value AZURE_RESOURCE_GROUP_NAME)"
```

The script:

1. Prompts for the API key value via a hidden secure-string input
   (key never appears in shell history / process command line).
2. Validates the key against `GET https://api-pro.ransomware.live/validate`
   before writing — fails the script if the key isn't recognised, so
   you don't deploy a bad key.
3. Writes the secret to Key Vault under the name
   `ransomware-live-api-key` (matches the Bicep `ransomwareLiveSecretName`
   single-source-of-truth literal — change both if you rename).
4. Restarts the Function App (optional — only when `-FunctionAppName`
   is supplied) so the next ingest run starts immediately rather than
   waiting for the next hourly Timer fire.

#### Step 3 — verify

```bash
# Confirm the secret landed:
az keyvault secret show \
  --vault-name "$(azd env get-value KEY_VAULT_NAME)" \
  --name ransomware-live-api-key \
  --query "id" -o tsv

# Expected: prints the secret URI like
# https://kv-aegis-<env>-<region>.vault.azure.net/secrets/ransomware-live-api-key/<version>
```

Once the ingest runs, you'll see the freshness row in `IngestHealth`
(PartitionKey = tenantId, RowKey = `external.ransomware.live`) and the
tile will auto-appear on the dashboard.

#### Rotation

Use the same script with `-Mode Rotate` to force a new secret version
(default `-Mode Provision` is no-op when the secret already exists):

```bash
./scripts/provision-ransomware-live-api-key.ps1 -Mode Rotate \
  -KeyVaultName "$(azd env get-value KEY_VAULT_NAME)" \
  -FunctionAppName "$(azd env get-value FUNCTION_APP_NAME)" \
  -ResourceGroupName "$(azd env get-value AZURE_RESOURCE_GROUP_NAME)"
```

The ingest path reads KV on every Timer fire (no module-scope cache),
so the next hourly fire picks up the new key automatically. Restart is
offered for operators who want immediate effect via the SPA's
"Ingest now" button.

#### Offline rotation

If ransomware.live is unreachable at rotation time, the pre-write
`/validate` call will fail. Bypass with `-SkipValidate` if you've
verified the key out-of-band (and accept the risk that the key may
turn out to be invalid until the next Timer fire surfaces a 401):

```bash
./scripts/provision-ransomware-live-api-key.ps1 -Mode Rotate -SkipValidate \
  -KeyVaultName "$(azd env get-value KEY_VAULT_NAME)"
```

#### Tearing down

The integration auto-disables when the KV secret is absent. To remove:

```bash
# Soft-delete the secret (KV purge protection keeps it for the soft-delete
# retention window). The threatIntel MI's ABAC grant is unchanged but its
# read returns 404 → IngestHealth status sticks at `not_configured` →
# tile auto-hides.
az keyvault secret delete \
  --vault-name "$(azd env get-value KEY_VAULT_NAME)" \
  --name ransomware-live-api-key
```

The threatIntel MI + RansomwareIntel table stay in the resource group
(cheap; inert). Re-enable by running the provisioning script again.

---

## Appendix — env var reference

| Env var | Set by | Required? | Notes |
|---|---|---|---|
| `AZURE_ENV_NAME` | `azd env new` | yes | `dev` / `test` / `prod` |
| `AZURE_LOCATION` | `azd env new` flag | yes | e.g. `westeurope` |
| `AZURE_REGION_SHORT` | you | recommended | Short region code for resource names (e.g. `weu`, `uks`). Default `uks` may not match your `AZURE_LOCATION` — set explicitly to keep names readable. |
| `AZURE_STATIC_WEB_APP_LOCATION` | you | recommended | SWA control-plane region; only 5 valid values (`centralus`/`eastus2`/`westus2`/`westeurope`/`eastasia`). Default `westeurope`. Independent of `AZURE_LOCATION` — SWA serves the user globally via Front Door regardless. |
| `AZURE_UNIQUE_SUFFIX` | you | recommended for fresh deploys | Globally-unique-name discriminator on KV + Storage accounts. Recommended pattern: `$(az account show --query id -o tsv \| tail -c 5 \| tr -d '-')`. See §2.3 "Recommended for fresh-tenant deploys" for details. |
| `AZURE_SUBSCRIPTION_ID` | `azd env new` flag | yes | GUID |
| `AZURE_TENANT_ID` | `azd auth login` | yes | resolved from sign-in |
| `AZURE_ADMIN_EMAIL` | you | yes | downstream contact metadata |
| `AZURE_ADMIN_UPN` | you | recommended | takes priority for directory lookup |
| `AZURE_DEPLOYER_OBJECT_ID` | you | yes | KV ABAC scope |
| `AZURE_DEPLOYER_PRINCIPAL_TYPE` | you | yes | `User` or `ServicePrincipal` |
| `AZURE_DEPLOYER_IP_ALLOWLIST` | you | required for prod with PEs | Comma-separated IPv4 CIDR list applied to KV + ops-storage `networkAcls.ipRules` when `publicNetworkAccess=Disabled`. No whitespace; IPv4 only. Empty preserves the pre-fix posture (operator inside the VNet). See §2.3 "Required for prod with private endpoints". |
| `AZURE_MAIL_SENDER_UPN` | you | required in prod (or `AZURE_MAIL_SENDER_REQUIRED=false`) | Outbound report-email sender mailbox UPN — licensed or shared. Empty + prod = hard-fail at postprovision Phase C. Set to `false` on `AZURE_MAIL_SENDER_REQUIRED` for ingest-only deploys. |
| `AZURE_MAIL_SENDER_REQUIRED` | you | tri-state | Empty (default) = env-aware (prod → required, dev/test → optional). `true` = explicit hard-fail when sender UPN missing. `false` = explicit soft-skip (Phase C inert; admin send endpoint returns 503 not_configured until configured). |
| `AZURE_BUDGET_START_DATE` | you | yes | YYYY-MM-DD, immutable once set |
| `AZURE_AAD_CLIENT_ID` | postprovision | auto (legacy) | Legacy SWA Easy Auth client ID. With the SPA cut over to MSAL native auth, this is no longer load-bearing on new deploys; postprovision may leave it unset on fresh tenants. |
| `AZURE_AEGIS_API_APP_ID` | postprovision | auto | Split-app — resource side. Audience-validated by the Function App's native JWT validator. |
| `AZURE_AEGIS_SPA_APP_ID` | postprovision | auto | Split-app — client side. Consumed by the `web` Vite build via `VITE_AAD_CLIENT_ID`. |
| `AZURE_SWA_MI_APP_ID` | postprovision | auto (legacy) | Legacy SWA managed identity binding for Easy Auth. The native-MSAL cutover removed the dependency. |

---

*When the deployment surface changes, update this runbook.*
