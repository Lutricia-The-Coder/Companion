param(
  [ValidateSet('physical', 'physical-32bit')]
  [string]$BuildTarget = 'physical'
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'use-android-sdk.ps1')
. (Join-Path $PSScriptRoot 'gradle-short-home.ps1')

$devices = & (Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe') devices
$connectedDevices = @($devices | Select-String "`tdevice(\s|$)")
if ($connectedDevices.Count -eq 0) {
  throw 'No authorized Android phone is connected. Connect it over USB, enable USB debugging, and accept its authorization prompt.'
}

$architectures = if ($BuildTarget -eq 'physical-32bit') { 'armeabi-v7a' } else { 'arm64-v8a' }
$initScript = Join-Path $PSScriptRoot 'windows-app-cmake.gradle'
$androidRoot = Join-Path $PSScriptRoot '..\android'
$gradlew = Join-Path $androidRoot 'gradlew.bat'

Write-Host "Running Companion monitor lifecycle instrumentation tests for $BuildTarget device architecture: $architectures"
$arguments = @(
  '--no-daemon',
  '-I', $initScript,
  '-p', $androidRoot,
  ':expo-companion-monitor:connectedDebugAndroidTest',
  '--max-workers=2',
  "-PreactNativeArchitectures=$architectures"
)
$exitCode = Invoke-GradleWithShortHome `
  -WrapperPath $gradlew `
  -GradleHome 'C:\g' `
  -Arguments $arguments
exit $exitCode
