function Invoke-GradleWithShortHome {
  param(
    [Parameter(Mandatory = $true)] [string] $WrapperPath,
    [Parameter(Mandatory = $true)] [string] $GradleHome,
    [Parameter(Mandatory = $true)] [string[]] $Arguments
  )

  $previousHome = $env:GRADLE_USER_HOME
  $effectiveHome = if ($previousHome) { $previousHome } else { $GradleHome }
  try {
    [System.IO.Directory]::CreateDirectory($effectiveHome) | Out-Null
    $probe = Join-Path $effectiveHome ('.write-check-' + $PID)
    [System.IO.File]::WriteAllText($probe, '')
    Remove-Item -LiteralPath $probe -Force
  } catch {
    throw "Gradle cache '$effectiveHome' is not writable. Set GRADLE_USER_HOME to a writable short path, for example C:\g."
  }

  try {
    $env:GRADLE_USER_HOME = $effectiveHome
    & $WrapperPath @Arguments
    return $LASTEXITCODE
  } finally {
    if ($null -eq $previousHome) { Remove-Item Env:GRADLE_USER_HOME -ErrorAction SilentlyContinue }
    else { $env:GRADLE_USER_HOME = $previousHome }
  }
}
