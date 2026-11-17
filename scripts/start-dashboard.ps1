$ErrorActionPreference = 'Stop'

$dashboardPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'dashboard'
$configPath = Join-Path $dashboardPath 'config.js'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw 'Dashboard config is missing. Run scripts/configure-dashboard.ps1 first.'
}

$url = 'http://localhost:8000/'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js was not found. Install Node.js and rerun this script.' }
$healthCheck = "fetch('http://127.0.0.1:8000/').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"
try {
  & $node.Source -e $healthCheck
  if ($LASTEXITCODE -eq 0) {
    Write-Output "Dashboard is already running at $url"
    exit 0
  }
} catch { }

$serverPath = Join-Path $PSScriptRoot 'dashboard-server.mjs'
Start-Process -FilePath $node.Source -ArgumentList @($serverPath) -WorkingDirectory $dashboardPath -WindowStyle Hidden

for ($attempt = 0; $attempt -lt 10; $attempt++) {
  Start-Sleep -Milliseconds 300
  & $node.Source -e $healthCheck
  if ($LASTEXITCODE -eq 0) {
    Write-Output "Dashboard is running at $url (bound to this computer only)."
    exit 0
  }
}
throw 'The local dashboard server did not respond on port 8000.'
