#!/usr/bin/env bash
# check-prereqs.sh — preflight tool / version / login check for `azd up`.
#
# Run this BEFORE `azd up` on a fresh machine. Fails fast with explicit
# copy-paste install commands when a prereq is missing.
#
# Exit codes:
#   0  all checks passed; deploy is unblocked
#   1  at least one required prereq missing or below minimum version
#   2  optional warning (e.g. pwsh modules not installed) — deploy can
#      proceed but bootstrap-entra.ps1 will fail until they're installed
#
# Reads no env vars; takes no args. Idempotent.
#
# Usage:
#   bash scripts/check-prereqs.sh
#   bash scripts/check-prereqs.sh --strict   # treat warnings as errors

set -uo pipefail

STRICT=0
if [ "${1:-}" = "--strict" ]; then STRICT=1; fi

# ANSI colours — disable when stdout isn't a TTY (CI logs, redirects).
if [ -t 1 ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; X=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; X=''
fi

ERRORS=0
WARNINGS=0

ok()    { printf '%s✓%s %s\n' "$G" "$X" "$1"; }
warn()  { printf '%s⚠%s %s\n' "$Y" "$X" "$1"; WARNINGS=$((WARNINGS+1)); }
fail()  { printf '%s✗%s %s\n' "$R" "$X" "$1"; ERRORS=$((ERRORS+1)); }
hint()  { printf '   %s↪%s %s\n' "$B" "$X" "$1"; }

printf '%saegis preflight%s — checking deploy prereqs\n\n' "$B" "$X"

# ----- Tool: az CLI -------------------------------------------------------
# Required: az >= 2.50 (anything older lacks several flags used in the
# postprovision hooks; staticwebapp + cognitiveservices subcommands have
# the shape this repo expects).
if ! command -v az >/dev/null 2>&1; then
  fail "az CLI not found"
  hint "curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash   # Debian/Ubuntu"
  hint "brew install azure-cli                                   # macOS"
else
  AZ_VER=$(az version --query '"azure-cli"' -o tsv 2>/dev/null || echo "0.0.0")
  AZ_MAJ=$(echo "$AZ_VER" | cut -d. -f1)
  AZ_MIN=$(echo "$AZ_VER" | cut -d. -f2)
  if [ "${AZ_MAJ:-0}" -lt 2 ] || { [ "${AZ_MAJ:-0}" -eq 2 ] && [ "${AZ_MIN:-0}" -lt 50 ]; }; then
    fail "az CLI $AZ_VER (need >= 2.50)"
    hint "az upgrade"
  else
    ok "az CLI $AZ_VER"
  fi

  # az login state. The bootstrap step issues device-code Graph login
  # interactively; the subscription-context login is separate and needs
  # to be active before azd up.
  if ! az account show >/dev/null 2>&1; then
    fail "az: not logged in"
    hint "az login"
  else
    AZ_USER=$(az account show --query user.name -o tsv)
    AZ_SUB=$(az account show --query name -o tsv)
    ok "az: logged in as $AZ_USER (sub: $AZ_SUB)"
  fi
fi

# ----- Tool: azd CLI ------------------------------------------------------
# Required: azd >= 1.25.6. The 1.24 line had the "environment 'default'
# invalid" SWA-deploy bug — pre-go-live deploys MUST be on >= 1.25
if ! command -v azd >/dev/null 2>&1; then
  fail "azd CLI not found"
  hint "curl -fsSL https://aka.ms/install-azd.sh | bash"
else
  # azd version output: "azd version 1.25.6 (commit ...)"
  AZD_VER=$(azd version 2>/dev/null | head -1 | awk '{print $3}' | sed 's/[^0-9.].*//')
  AZD_MAJ=$(echo "$AZD_VER" | cut -d. -f1)
  AZD_MIN=$(echo "$AZD_VER" | cut -d. -f2)
  if [ "${AZD_MAJ:-0}" -lt 1 ] || { [ "${AZD_MAJ:-0}" -eq 1 ] && [ "${AZD_MIN:-0}" -lt 25 ]; }; then
    fail "azd CLI $AZD_VER (need >= 1.25.6 — earlier versions trip the SWA-deploy 'environment default invalid' bug)"
    hint "curl -fsSL https://aka.ms/install-azd.sh | bash"
  else
    ok "azd CLI $AZD_VER"
  fi

  if ! azd auth login --check-status >/dev/null 2>&1; then
    fail "azd: not logged in"
    hint "azd auth login"
  else
    ok "azd: logged in"
  fi
fi

# ----- Tool: pwsh ---------------------------------------------------------
# Required: pwsh 7+. Bootstrap-entra.ps1 + provision-*.ps1 + cleanup-ai-
# plane.ps1 all assume PSv7 syntax (ternary, null-conditional, etc.).
if ! command -v pwsh >/dev/null 2>&1; then
  fail "pwsh (PowerShell 7+) not found"
  hint "Install via https://learn.microsoft.com/powershell/scripting/install/installing-powershell"
  hint "Or: snap install powershell --classic     # Linux"
  hint "Or: brew install --cask powershell        # macOS"
else
  PWSH_VER=$(pwsh -NoProfile -c '$PSVersionTable.PSVersion.ToString()' 2>/dev/null | head -1)
  PWSH_MAJ=$(echo "$PWSH_VER" | cut -d. -f1)
  if [ "${PWSH_MAJ:-0}" -lt 7 ]; then
    fail "pwsh $PWSH_VER (need >= 7.0)"
  else
    ok "pwsh $PWSH_VER"

    # PowerShell Graph modules used by bootstrap-entra.ps1. Missing
    # modules don't fail azd up itself — they fail bootstrap.ps1 which
    # is step 1/5 of the postprovision hook. Warn rather than block so
    # an offline operator can still inspect the rest of the prereq list.
    MODULES_MISSING=""
    for m in Microsoft.Graph.Applications Microsoft.Graph.Identity.DirectoryManagement Microsoft.Graph.Users; do
      if ! pwsh -NoProfile -c "if (-not (Get-Module -ListAvailable -Name $m)) { exit 1 }" >/dev/null 2>&1; then
        MODULES_MISSING="${MODULES_MISSING}${m},"
      fi
    done
    if [ -n "$MODULES_MISSING" ]; then
      warn "pwsh modules missing: ${MODULES_MISSING%,}"
      hint "pwsh -c \"Install-Module Microsoft.Graph.Applications,Microsoft.Graph.Identity.DirectoryManagement,Microsoft.Graph.Users -Scope CurrentUser -Force\""
    else
      ok "pwsh Graph modules present"
    fi
  fi
fi

# ----- Tool: node ---------------------------------------------------------
# Required: node 22 LTS (>=22, <23). Both api/package.json and
# web/package.json pin `engines.node: ">=22 <23"`. npm install warns on
# mismatch but doesn't block; build fails further downstream.
if ! command -v node >/dev/null 2>&1; then
  fail "node not found"
  hint "Install Node 22 LTS via https://nodejs.org/"
  hint "Or: nvm install 22"
else
  NODE_VER=$(node -v 2>/dev/null | sed 's/^v//')
  NODE_MAJ=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "${NODE_MAJ:-0}" -ne 22 ]; then
    fail "node $NODE_VER (need 22.x — engines pin in api/web package.json)"
    hint "nvm install 22 && nvm use 22"
  else
    ok "node $NODE_VER"
  fi
fi

# ----- Tool: jq -----------------------------------------------------------
# Used by the postprovision shell hook to parse the bootstrap-entra
# summary JSON. Missing jq fails postprovision step 1/5.
if ! command -v jq >/dev/null 2>&1; then
  fail "jq not found"
  hint "apt-get install -y jq    # Debian/Ubuntu"
  hint "brew install jq          # macOS"
else
  ok "jq $(jq --version 2>/dev/null | sed 's/^jq-//')"
fi

# ----- Tool: curl (used by postprovision install + ransomware /validate) -
if ! command -v curl >/dev/null 2>&1; then
  warn "curl not found — only used for one-off install scripts; not blocking"
else
  ok "curl present"
fi

# ----- Tool: git (sanity — required by azd up's package step) -----------
if ! command -v git >/dev/null 2>&1; then
  fail "git not found"
  hint "apt-get install -y git    # Debian/Ubuntu"
  hint "brew install git          # macOS"
else
  ok "git $(git --version 2>/dev/null | awk '{print $3}')"
fi

# ----- Summary -----------------------------------------------------------
printf '\n'
if [ "$ERRORS" -gt 0 ]; then
  printf '%s%d error%s%s — resolve the items marked %s✗%s above before `azd up`.\n' \
    "$R" "$ERRORS" "$([ "$ERRORS" -gt 1 ] && echo s || echo)" "$X" "$R" "$X"
  exit 1
fi
if [ "$WARNINGS" -gt 0 ]; then
  printf '%s%d warning%s%s\n' "$Y" "$WARNINGS" "$([ "$WARNINGS" -gt 1 ] && echo s || echo)" "$X"
  if [ "$STRICT" -eq 1 ]; then
    printf '   --strict mode: treating warnings as errors.\n'
    exit 1
  fi
  printf '   These are recoverable mid-deploy; `azd up` can proceed.\n'
  exit 2
fi
printf '%sAll prereqs OK.%s `azd up` is unblocked.\n' "$G" "$X"
exit 0
