param(
  [ValidateSet('inventory','preflight','monitor')][string]$Action = 'inventory',
  [string]$EvidenceDirectory = 'docs/remediation/2026-10-31/W01'
)
# Read-only stdin execution. Never copies candidate files or credentials remotely.
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $EvidenceDirectory -PathType Container)) {
  throw 'Evidence directory must already exist.'
}
if ($Action -eq 'inventory') {
  $remoteScript = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'production_inventory.py') -Raw
} else {
  $candidate = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'recovery.py') -Raw
  $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.example.json') -Raw
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($config))
  $method = if ($Action -eq 'preflight') { 'run_checks' } else { 'monitor' }
  $field = if ($Action -eq 'preflight') { 'ready_to_backup' } else { 'stateful_change_ready' }
  $footer = "`nconfig_input = json.loads(__import__('base64').b64decode('$encoded'))`nreport = $method(load_config(config_input))`nprint(json.dumps(report, indent=2))`nraise SystemExit(0 if report['$field'] else 2)`n"
  $remoteScript = $candidate.Replace("if __name__ == '__main__':", 'if False:') + $footer
}
$output = $remoteScript | & ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 root@94.103.170.66 python3 -
$innerExit = $LASTEXITCODE
if ($output) {
  $output | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "production-$Action.json") -Encoding utf8
}
Write-Output "read_only_${Action}_exit=$innerExit"
exit $innerExit
