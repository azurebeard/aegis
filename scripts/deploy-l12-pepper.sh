#!/usr/bin/env bash
# deploy-l12-pepper.sh — recipient-hash pepper deployment runbook (ADR-0030 §C.21).
#
# Lands the L12 Key Vault pepper end-to-end on the CURRENT azd environment.
# Idempotent — safe to re-run; only acts when state diverges. Use this script
# for first prod deploy and for cleanly-replicating the dev landing on any
# future tenant.
#
# Prerequisites:
#   * `az login` against the target tenant + subscription.
#   * `azd env select <env>` against the target environment (dev / prod / etc.).
#   * Caller is `Key Vault Secrets Officer`-capable (the role assignment
#     itself is granted by this script's `azd provision` step, so first-run
#     needs an existing Owner / Contributor + RBAC-admin path).
#
# Exit code 0 on success; non-zero on any failure with a friendly hint.

set -euo pipefail

step() { echo -e "\n\033[1;36m▶ $*\033[0m" >&2; }
ok()   { echo -e "  \033[1;32m✓\033[0m $*" >&2; }
fail() { echo -e "  \033[1;31m✗ $*\033[0m" >&2; exit 1; }

# ── Sanity checks ──────────────────────────────────────────────────────────

step "Verifying az + azd auth"
az account show --query "{tenant: tenantId, sub: name, user: user.name}" -o table >&2 \
  || fail "az CLI not authenticated. Run 'az login' first."
ok "az ready"

azd env get-values >/dev/null 2>&1 \
  || fail "azd env not selected. Run 'azd env select <env>' first."
ENV_NAME=$(azd env get-values | grep '^AZURE_ENV_NAME=' | sed 's/.*="\(.*\)"/\1/')
LOCATION=$(azd env get-values | grep '^AZURE_LOCATION=' | sed 's/.*="\(.*\)"/\1/')
ok "azd env: $ENV_NAME ($LOCATION)"

# ── Step 1: deployer object ID ────────────────────────────────────────────

step "Step 1/3 — Persist AZURE_DEPLOYER_OBJECT_ID for the Bicep role grant"
DEPLOYER_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null) \
  || fail "az ad signed-in-user show failed. Service-principal deploys should set AZURE_DEPLOYER_OBJECT_ID manually to the SP object id."
CURRENT=$(azd env get-values 2>/dev/null | grep '^AZURE_DEPLOYER_OBJECT_ID=' | sed 's/.*="\(.*\)"/\1/' || true)
if [[ "$CURRENT" == "$DEPLOYER_OID" ]]; then
  ok "AZURE_DEPLOYER_OBJECT_ID already set to $DEPLOYER_OID — no-op"
else
  azd env set AZURE_DEPLOYER_OBJECT_ID "$DEPLOYER_OID" >&2
  ok "set AZURE_DEPLOYER_OBJECT_ID=$DEPLOYER_OID"
fi

# ── Step 2: azd provision ─────────────────────────────────────────────────

step "Step 2/3 — Run azd provision (lands KV Secrets User/Officer + FA app settings)"
azd provision --no-prompt >&2 \
  || fail "azd provision failed. See output above; common causes: deployer lacks RBAC-admin on the RG, KV soft-deleted name collision, Bicep param error."
ok "provision succeeded"

# Extract resource names from the azd env post-provision.
KV_NAME=$(azd env get-values 2>/dev/null | grep '^KEY_VAULT_NAME=' | sed 's/.*="\(.*\)"/\1/')
FA_NAME=$(azd env get-values 2>/dev/null | grep '^FUNCTION_APP_NAME=' | sed 's/.*="\(.*\)"/\1/')
RG_NAME=$(azd env get-values 2>/dev/null | grep '^AZURE_RESOURCE_GROUP_NAME=' | sed 's/.*="\(.*\)"/\1/')
[[ -n "$KV_NAME" && -n "$FA_NAME" && -n "$RG_NAME" ]] \
  || fail "Could not resolve KV_NAME / FUNCTION_APP_NAME / AZURE_RESOURCE_GROUP_NAME from azd env. Check azd env get-values output."
ok "KV=$KV_NAME  FA=$FA_NAME  RG=$RG_NAME"

# ── Step 3: pepper provisioning (idempotent on existing) ──────────────────

step "Step 3/3 — Provision the recipient-hash pepper + restart FA"
pwsh -NoProfile -File "$(dirname "$0")/provision-recipient-hash-pepper.ps1" \
  -KeyVaultName "$KV_NAME" \
  -FunctionAppName "$FA_NAME" \
  -ResourceGroupName "$RG_NAME" >&2 \
  || fail "pepper provisioning failed. Common causes: deployer lacks KV Secrets Officer (provision should have just granted it — wait 30s and re-run), KV name has soft-deleted version that needs recovery, pwsh < 7.0."
ok "pepper provisioned + FA restarted"

# ── Smoke checks ──────────────────────────────────────────────────────────

step "Smoke check — KV secret + FA app settings"
SECRET_ID=$(az keyvault secret show --vault-name "$KV_NAME" --name recipient-hash-pepper --query id -o tsv 2>/dev/null) \
  || fail "Pepper secret not readable after provisioning. Check KV name + your RBAC."
ok "KV secret enabled: $SECRET_ID"

APP_SETTINGS=$(az functionapp config appsettings list -g "$RG_NAME" -n "$FA_NAME" \
  --query "[?contains(name, 'PEPPER')].{name: name, value: value}" -o tsv 2>/dev/null)
[[ "$APP_SETTINGS" =~ RECIPIENT_HASH_PEPPER_KV_NAME ]] \
  || fail "FA app setting RECIPIENT_HASH_PEPPER_KV_NAME not present. Re-run azd provision."
ok "FA app settings wired"

echo -e "\n\033[1;32mL12 deployment complete for env=$ENV_NAME.\033[0m" >&2
echo -e "Next send will emit recipientHashSaltedV2 on the audit chain." >&2
echo -e "AIEVENT report.email.pepper.fallback should stop appearing in App Insights." >&2
