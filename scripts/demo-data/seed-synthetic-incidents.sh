#!/usr/bin/env bash
# Seeds 6 curated synthetic incidents into the picnicdev Sentinel workspace
# so the Aegis demo has a populated XDR incident queue without standing up
# infrastructure. Re-running upserts (stable GUIDs). Use --delete to remove.
#
# Auth: uses the current az CLI bearer token (Microsoft Sentinel Contributor
# or higher on the workspace RG required). No app reg, no secret handling.
#
# Every incident is tagged with label "synthetic-aegis-demo" so the SOC can
# distinguish them from real detections.

set -euo pipefail

SUB="58ffe548-7d9e-4c50-9fb9-bcbd74d39fdd"
RG="picnic-mgmt-sentinel-rg"
WS="picnic-sentinel-la"
API="2024-03-01"
LABEL="synthetic-aegis-demo"

BASE="https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.OperationalInsights/workspaces/${WS}/providers/Microsoft.SecurityInsights/incidents"

# Stable GUIDs — re-running PUTs the same incident in place.
declare -A INCIDENTS=(
  ["a1d4e0f0-aeg1-4001-b001-000000000001"]="impossible-travel"
  ["a1d4e0f0-aeg1-4002-b002-000000000002"]="mailbox-forwarding"
  ["a1d4e0f0-aeg1-4003-b003-000000000003"]="suspicious-powershell"
  ["a1d4e0f0-aeg1-4004-b004-000000000004"]="credential-dump"
  ["a1d4e0f0-aeg1-4005-b005-000000000005"]="mfa-fatigue"
  ["a1d4e0f0-aeg1-4006-b006-000000000006"]="onedrive-mass-download"
)

payload_for() {
  case "$1" in
    impossible-travel)
      cat <<'JSON'
{
  "properties": {
    "title": "Atypical travel - sign-in from two countries within 12 minutes",
    "description": "User signed in from London, UK at 09:14 UTC then from Houston, TX at 09:26 UTC. Travel time infeasible. Both sessions used the same user agent but different IP autonomous systems.",
    "severity": "High",
    "status": "New",
    "labels": [{"labelName": "synthetic-aegis-demo", "labelType": "User"}]
  }
}
JSON
      ;;
    mailbox-forwarding)
      cat <<'JSON'
{
  "properties": {
    "title": "Suspicious inbox forwarding rule created on executive mailbox",
    "description": "Inbox rule 'rss-archive' created via OWA forwarding all messages containing 'invoice', 'wire', or 'payment' to an external Gmail address, then deleting from Inbox. Rule created from an unmanaged device.",
    "severity": "High",
    "status": "New",
    "labels": [{"labelName": "synthetic-aegis-demo", "labelType": "User"}]
  }
}
JSON
      ;;
    suspicious-powershell)
      cat <<'JSON'
{
  "properties": {
    "title": "Encoded PowerShell command launched from Office process",
    "description": "winword.exe spawned powershell.exe with -EncodedCommand. Decoded payload performs a DownloadString from a recently-registered domain. Parent process chain indicates macro-based execution.",
    "severity": "High",
    "status": "New",
    "labels": [{"labelName": "synthetic-aegis-demo", "labelType": "User"}]
  }
}
JSON
      ;;
    credential-dump)
      cat <<'JSON'
{
  "properties": {
    "title": "LSASS memory access by non-system process",
    "description": "Unsigned binary opened a handle to lsass.exe with PROCESS_VM_READ. Process originated from a user temp directory and has no prevalence in the tenant. Behaviour consistent with credential extraction tooling.",
    "severity": "Medium",
    "status": "New",
    "labels": [{"labelName": "synthetic-aegis-demo", "labelType": "User"}]
  }
}
JSON
      ;;
    mfa-fatigue)
      cat <<'JSON'
{
  "properties": {
    "title": "Repeated MFA push challenges against single principal",
    "description": "37 MFA challenges issued to the same user within 9 minutes from an IP geolocated outside the tenant's normal pattern. One challenge was approved at the 36th attempt.",
    "severity": "Medium",
    "status": "New",
    "labels": [{"labelName": "synthetic-aegis-demo", "labelType": "User"}]
  }
}
JSON
      ;;
    onedrive-mass-download)
      cat <<'JSON'
{
  "properties": {
    "title": "Mass file download from OneDrive following risky sign-in",
    "description": "812 files (4.1 GB) downloaded from user's OneDrive within 6 minutes, immediately following an Entra ID sign-in flagged as risky. Files include shared folders from Finance and HR.",
    "severity": "High",
    "status": "New",
    "labels": [{"labelName": "synthetic-aegis-demo", "labelType": "User"}]
  }
}
JSON
      ;;
  esac
}

action="${1:-create}"

case "$action" in
  create)
    for guid in "${!INCIDENTS[@]}"; do
      scenario="${INCIDENTS[$guid]}"
      body=$(payload_for "$scenario")
      echo "PUT ${scenario} (${guid})"
      az rest --method put \
        --uri "${BASE}/${guid}?api-version=${API}" \
        --body "$body" \
        --headers "Content-Type=application/json" \
        --query "{name:name, severity:properties.severity, status:properties.status, url:properties.incidentUrl}" \
        -o table
    done
    ;;

  delete)
    for guid in "${!INCIDENTS[@]}"; do
      scenario="${INCIDENTS[$guid]}"
      echo "DELETE ${scenario} (${guid})"
      az rest --method delete \
        --uri "${BASE}/${guid}?api-version=${API}" \
        -o none || echo "  (not found - skipping)"
    done
    ;;

  dry-run)
    for guid in "${!INCIDENTS[@]}"; do
      scenario="${INCIDENTS[$guid]}"
      echo "=== ${scenario} (${guid}) ==="
      payload_for "$scenario"
      echo
    done
    ;;

  *)
    echo "Usage: $0 [create|delete|dry-run]" >&2
    exit 1
    ;;
esac
