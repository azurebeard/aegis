#!/usr/bin/env bash
# .devcontainer/post-create.sh — one-time setup after the container is built.
#
# Runs inside the container as the non-root `node` user. Anything that
# needs root uses `sudo` (the base image has passwordless sudo for the
# node user; standard devcontainer pattern).
#
# Net effect: by the end of this script, `bash scripts/check-prereqs.sh`
# shows all greens and the user is one `az login` + `azd auth login` +
# `azd up` away from a live deploy.

set -euo pipefail

if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; X=$'\033[0m'
else
  G=''; Y=''; B=''; X=''
fi
log()  { printf '%s[post-create]%s %s\n' "$B" "$X" "$1"; }
note() { printf '   %s↪%s %s\n' "$Y" "$X" "$1"; }
ok()   { printf '%s✓%s %s\n' "$G" "$X" "$1"; }

cd /workspaces/aegis 2>/dev/null || cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

log "Installing the three Microsoft.Graph.* modules bootstrap-entra.ps1 needs."
# `Install-Module` to CurrentUser scope; idempotent (`-Force` overwrites
# stale versions). The three modules together pull ~80 MB of nupkgs. Run
# in a fresh pwsh session so PSModulePath is clean.
pwsh -NoProfile -Command "
  \$ProgressPreference = 'SilentlyContinue'
  Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
  foreach (\$m in 'Microsoft.Graph.Applications','Microsoft.Graph.Identity.DirectoryManagement','Microsoft.Graph.Users') {
    if (-not (Get-Module -ListAvailable -Name \$m)) {
      Write-Host \"[post-create] Installing \$m...\"
      Install-Module \$m -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
    } else {
      Write-Host \"[post-create] \$m already installed.\"
    }
  }
"
ok "pwsh Graph modules installed."

log "Installing Azure Functions Core Tools 4.x (for local 'npm run start' in api/)."
# Functions Core Tools provides the `func` binary that `cd api && npm
# run start` (which runs `func start`) needs. Optional for deploy
# (azd ships its own packaging) but required for the local dev loop.
# Install globally so it's on PATH; `--unsafe-perm` is the documented
# requirement for the v4 native-binding install.
if ! command -v func >/dev/null 2>&1; then
  sudo npm install -g azure-functions-core-tools@4 --unsafe-perm true
  ok "func $(func --version 2>/dev/null | head -1) installed."
else
  ok "Functions Core Tools already present ($(func --version 2>/dev/null | head -1))."
fi

log "Running npm ci in api/ + web/ so the first iteration loop is fast."
# Pre-warm node_modules so the user doesn't pay the install cost on the
# first `npm run test` / `npm run start`. Done sequentially to keep the
# resource pressure during build modest.
(cd api && npm ci --omit=dev=false --no-audit --no-fund) || note "api npm ci failed — re-run manually before first dev session."
(cd web && npm ci --no-audit --no-fund)                  || note "web npm ci failed — re-run manually before first dev session."
ok "node_modules pre-warmed."

log "Running the prereqs preflight as a smoke check."
# Expected to show all green except for the az + azd login checks (the
# user hasn't logged in yet — that's their next step). Non-zero exit is
# OK here; the failures are the user's TODO list.
bash scripts/check-prereqs.sh || true

printf '\n%saegis dev container ready.%s\n' "$G" "$X"
printf 'Next steps:\n'
printf '  1. az login                     %s← device-code; opens in a browser tab%s\n' "$Y" "$X"
printf '  2. azd auth login               %s← same identity is fine%s\n' "$Y" "$X"
printf '  3. bash scripts/install.sh      %s← interactive single-command install%s\n' "$Y" "$X"
printf '     or, the explicit path:\n'
printf '     azd env new dev --subscription <subId> --location westeurope\n'
printf '     azd up                       %s← preprovision auto-detects env vars%s\n' "$Y" "$X"
