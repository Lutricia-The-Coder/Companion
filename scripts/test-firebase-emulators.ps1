$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$bundledJdkRoot = Join-Path $repoRoot '.tools\temurin21'
$bundledJdk = Get-ChildItem -LiteralPath $bundledJdkRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\java.exe') } |
  Select-Object -First 1 -ExpandProperty FullName

$originalJavaHome = $env:JAVA_HOME
$originalPath = $env:Path
if ($bundledJdk) {
  $env:JAVA_HOME = $bundledJdk
  $env:Path = "$bundledJdk\bin;$originalPath"
} else {
  $java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { (Get-Command java -ErrorAction Stop).Source }
  $versionOutput = (& $java -version 2>&1 | Out-String)
  if ($versionOutput -notmatch 'version "(?<major>\d+)' -or [int]$Matches.major -lt 21) {
    throw 'Firebase CLI 15 emulator tests require Java 21+. Add a JDK 21+ install or keep the project-local ignored Temurin runtime under .tools\temurin21.'
  }
}

Push-Location $repoRoot
try {
  npm run test:firebase
  $testExitCode = $LASTEXITCODE
  if ($testExitCode -eq 0) {
    npm run test:firebase:callables
    $testExitCode = $LASTEXITCODE
  }
} finally {
  Pop-Location
  $env:JAVA_HOME = $originalJavaHome
  $env:Path = $originalPath
}

exit $testExitCode
