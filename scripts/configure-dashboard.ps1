$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
$configPath = Join-Path $projectRoot 'dashboard\config.js'
if (-not (Test-Path -LiteralPath $envPath)) {
  throw 'Local .env was not found. Create it from .env.example and add the Supabase project URL and publishable key.'
}

$envValues = @{}
foreach ($line in Get-Content -LiteralPath $envPath) {
  if ($line -match '^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY)\s*=\s*(.*)\s*$') {
    $envValues[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
  }
}

$url = $envValues['EXPO_PUBLIC_SUPABASE_URL']
$key = $envValues['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY']
if ([string]::IsNullOrWhiteSpace($url) -or [string]::IsNullOrWhiteSpace($key)) {
  throw 'Both EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set in .env.'
}
if ($key -match 'service_role|sb_secret_') {
  throw 'A secret/service-role key cannot be used in browser dashboard config. Use the project publishable key.'
}

$clientConfig = [ordered]@{ url = $url; publishableKey = $key } | ConvertTo-Json -Compress
$content = "window.COMPANION_SUPABASE_CONFIG = $clientConfig;`r`n"
Set-Content -LiteralPath $configPath -Value $content -Encoding utf8 -NoNewline
Write-Output 'Created dashboard/config.js from the local Supabase URL and publishable key.'
