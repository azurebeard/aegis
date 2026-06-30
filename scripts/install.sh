#!/usr/bin/env bash
# scripts/install.sh — interactive single-command installer for Project Aegis.
#
# Replaces the 5-step (check-prereqs → az login → azd auth login →
# azd env new → azd up → seed ransomware key → smoke) chain with a
# guided narrative. Hides the underlying `azd` commands from the
# first-time installer.
#
# Operators who already know azd should use the explicit path
# (README.md "Quickstart"): they'll find this wrapper unnecessarily
# wordy. This is the welcoming-mat for someone who's never deployed
# Aegis before.
#
# Codespaces-aware: when $CODESPACES=true, skips the heavy reinstall
# advice on a failing prereq (post-create.sh already handled tool
# installs).
#
# Exit codes:
#   0  deploy completed
#   1  prereq missing (with copy-paste fix already printed)
#   2  user cancelled
#   3  azd up failed (azd already streamed its own error output)

set -euo pipefail

# ----- TTY colour --------------------------------------------------------
if [ -t 1 ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; D=$'\033[2m'; X=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; D=''; X=''
fi
section() { printf '\n%s━━ %s ━━%s\n' "$B" "$1" "$X"; }
ok()      { printf '%s✓%s %s\n' "$G" "$X" "$1"; }
warn()    { printf '%s⚠%s %s\n' "$Y" "$X" "$1"; }
err()     { printf '%s✗%s %s\n' "$R" "$X" "$1" >&2; }
prompt()  { printf '%s?%s %s' "$B" "$X" "$1"; }

printf '%saegis installer%s\n' "$B" "$X"
printf '%sone-shot install — for the canonical command-line flow, see README §Quickstart%s\n' "$D" "$X"

# ----- Step 1/6 — Preflight ---------------------------------------------
section "Step 1/6 — Preflight"
if ! bash scripts/check-prereqs.sh --strict; then
  err "Preflight failed. Resolve the items marked ✗ above, then re-run scripts/install.sh."
  if [ "${CODESPACES:-}" = "true" ]; then
    warn "You're in a Codespace — the missing tool should have been installed by .devcontainer/post-create.sh. Try Codespaces ▸ Rebuild Container."
  fi
  exit 1
fi

# ----- Step 2/6 — Subscription ------------------------------------------
section "Step 2/6 — Subscription"
SUBS_JSON=$(az account list --query '[?state==`Enabled`].{id:id, name:name}' -o json 2>/dev/null || echo "[]")
SUB_COUNT=$(echo "$SUBS_JSON" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "${SUB_COUNT:-0}" -eq 0 ]; then
  err "No enabled subscriptions visible. Run 'az login' first."
  exit 1
fi
echo "Available subscriptions:"
echo "$SUBS_JSON" | python3 -c "
import json,sys
for i,s in enumerate(json.load(sys.stdin),1):
  print(f'  {i}) {s[\"name\"]:40s}  {s[\"id\"]}')
"
prompt "Pick subscription number [1]: "
read -r SUB_PICK
SUB_PICK="${SUB_PICK:-1}"
SUB_ID=$(echo "$SUBS_JSON" | python3 -c "
import json,sys
subs = json.load(sys.stdin)
i = int('$SUB_PICK') - 1
if 0 <= i < len(subs): print(subs[i]['id'])
" 2>/dev/null)
if [ -z "$SUB_ID" ]; then
  err "Invalid selection."
  exit 2
fi
SUB_NAME=$(echo "$SUBS_JSON" | python3 -c "
import json,sys; print([s['name'] for s in json.load(sys.stdin) if s['id']=='$SUB_ID'][0])
")
ok "Subscription: $SUB_NAME ($SUB_ID)"

# ----- Step 3/6 — Env name + location -----------------------------------
section "Step 3/6 — Environment"
prompt "Environment name [dev]: "
read -r ENV_NAME
ENV_NAME="${ENV_NAME:-dev}"

prompt "Azure location [westeurope]: "
read -r LOCATION
LOCATION="${LOCATION:-westeurope}"

# Prod gets an extra confirmation — auto-derive of admin email is
# disabled so the operator must accept they'll need
# to set AZURE_ADMIN_EMAIL explicitly.
if [ "$ENV_NAME" = "prod" ]; then
  warn "Prod requires AZURE_ADMIN_EMAIL to be set explicitly (auto-derive disabled)."
  prompt "Operator email to seed as admin: "
  read -r ADMIN_EMAIL
  if [ -z "$ADMIN_EMAIL" ]; then
    err "AZURE_ADMIN_EMAIL is required for prod."
    exit 2
  fi
fi

# ----- Step 4/6 — AI plane ---------------------------------------------
section "Step 4/6 — AI plane"
echo "The AI plane adds Foundry agents (daily brief, weekly posture, incident analysis)."
echo "Default off — flip on later with 'azd env set AZURE_DEPLOY_AI_AGENTS true && azd provision'."
prompt "Deploy AI plane? [y/N]: "
read -r AI_PICK
case "$AI_PICK" in
  [yY]|[yY][eE][sS]) DEPLOY_AI="true" ;;
  *)                 DEPLOY_AI="false" ;;
esac
ok "AI plane: $DEPLOY_AI"

# ----- Step 5/6 — Create env + run azd up -------------------------------
section "Step 5/6 — Running azd up (5-8 min)"
# Idempotency: if the env already exists, ask before clobbering.
if azd env list --output json 2>/dev/null | python3 -c "
import json,sys
envs = json.load(sys.stdin)
sys.exit(0 if any(e.get('Name')=='$ENV_NAME' for e in envs) else 1)
"; then
  warn "azd env '$ENV_NAME' already exists."
  prompt "Re-provision into the existing env? [y/N]: "
  read -r REPROV
  case "$REPROV" in
    [yY]|[yY][eE][sS])
      azd env select "$ENV_NAME"
      ;;
    *)
      err "Aborted by user."; exit 2 ;;
  esac
else
  azd env new "$ENV_NAME" --subscription "$SUB_ID" --location "$LOCATION"
fi

azd env set AZURE_DEPLOY_AI_AGENTS "$DEPLOY_AI" --no-prompt
if [ "$ENV_NAME" = "prod" ] && [ -n "${ADMIN_EMAIL:-}" ]; then
  azd env set AZURE_ADMIN_EMAIL "$ADMIN_EMAIL" --no-prompt
fi

echo
echo "Running azd up — streaming the underlying output below."
echo "${D}(preprovision auto-detects AZURE_TENANT_ID + AZURE_REGION_SHORT + AZURE_ADMIN_EMAIL for dev)${X}"
echo
if ! azd up; then
  err "azd up failed. See the streamed output above for the actual cause."
  exit 3
fi
ok "azd up complete."

# ----- Step 6/6 — Operator-supplied secrets -----------------------------
section "Step 6/6 — Operator-supplied secrets"
echo "Aegis pulls ransomware.live PRO threat-intel hourly. The API key comes"
echo "from https://www.ransomware.live/my — it is NOT auto-generated."
prompt "Seed the ransomware.live API key now? [y/N]: "
read -r SEED
case "$SEED" in
  [yY]|[yY][eE][sS])
    KV_NAME=$(azd env get-values | grep "^KEY_VAULT_NAME=" | cut -d= -f2 | tr -d '"')
    FA_NAME=$(azd env get-values | grep "^FUNCTION_APP_NAME=" | cut -d= -f2 | tr -d '"')
    RG_NAME=$(azd env get-values | grep "^AZURE_RESOURCE_GROUP_NAME=" | cut -d= -f2 | tr -d '"')
    if [ -z "$KV_NAME" ] || [ -z "$FA_NAME" ] || [ -z "$RG_NAME" ]; then
      warn "Couldn't read deployed resource names from azd env — run the provision script manually:"
      echo "  pwsh -File scripts/provision-ransomware-live-api-key.ps1 -Mode Provision"
    else
      pwsh -NoProfile -File scripts/provision-ransomware-live-api-key.ps1 \
        -Mode Provision \
        -KeyVaultName "$KV_NAME" \
        -FunctionAppName "$FA_NAME" \
        -ResourceGroupName "$RG_NAME" || warn "Seed step failed — re-run manually."
    fi
    ;;
  *)
    echo "Skipping. Seed later via:"
    echo "  pwsh -File scripts/provision-ransomware-live-api-key.ps1 -Mode Provision"
    echo "  or via the SPA admin section → Ransomware intel → 'Rotate API key'"
    echo "  (once any first version of the secret exists in KV)"
    ;;
esac

# ----- Final summary ----------------------------------------------------
SWA_HOST=$(azd env get-values | grep "^SWA_DEFAULT_HOSTNAME=" | cut -d= -f2 | tr -d '"')
DETECTED_ADMIN=$(azd env get-values | grep "^AZURE_ADMIN_EMAIL=" | cut -d= -f2 | tr -d '"')
section "Done"
ok "Dashboard: https://${SWA_HOST}/"
ok "Admin role: ${DETECTED_ADMIN} (auto-assigned by bootstrap; sign in to verify)"
echo
echo "Smoke check (should return 401 — confirms the in-handler auth gate is live):"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://${SWA_HOST}/api/ping"
echo
echo "Next code change:"
echo "  azd deploy api      # api/ only"
echo "  azd deploy web      # web/ only"
echo "  azd provision       # Bicep delta"
