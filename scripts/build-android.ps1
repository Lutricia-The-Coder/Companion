param(
  [ValidateSet('physical', 'physical-32bit', 'emulator')]
  [string]$BuildTarget = 'physical',
  [ValidateSet('debug', 'release')]
  [string]$BuildVariant = 'release',
  [switch]$SkipPrebuild
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'use-android-sdk.ps1')
. (Join-Path $PSScriptRoot 'gradle-short-home.ps1')

$reanimatedAndroid = Join-Path $PSScriptRoot '..\node_modules\react-native-reanimated\android'
$reanimatedGradle = Join-Path $reanimatedAndroid 'build.gradle.kts'
$reanimatedCmake = Join-Path $reanimatedAndroid 'CMakeLists.txt'
if (-not (Test-Path -LiteralPath $reanimatedGradle) -or -not (Test-Path -LiteralPath $reanimatedCmake)) {
  throw "react-native-reanimated Android build files not found. Run npm install first."
}
$cmakeSource = Get-Content -LiteralPath $reanimatedCmake -Raw
if ($cmakeSource -match '(?m)^set\(CMAKE_OBJECT_PATH_MAX 180\)\r?\n') {
  $cmakeSource = [regex]::Replace($cmakeSource, '(?m)^set\(CMAKE_OBJECT_PATH_MAX 180\)\r?\n', '', 1)
  Set-Content -LiteralPath $reanimatedCmake -Value $cmakeSource -NoNewline
}
$gradleSource = Get-Content -LiteralPath $reanimatedGradle -Raw
$gradleSource = [regex]::Replace($gradleSource, '(?m)^\.addAll\(reactNativeArchitectures\(\)\)', '                abiFilters.addAll(reactNativeArchitectures())', 1)
if ($gradleSource -match '(?m)^\s*"-DCMAKE_OBJECT_PATH_MAX=\d+",\r?\n') {
  $gradleSource = [regex]::Replace($gradleSource, '(?m)^\s*"-DCMAKE_OBJECT_PATH_MAX=\d+",\r?\n', '', 1)
}
if ($gradleSource -notmatch '"-DCMAKE_OBJECT_PATH_MAX=240"') {
  $gradleSource = [regex]::Replace(
    $gradleSource,
    '(?m)^(\s*"-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON",\s*)$',
    '$1' + "`r`n                    `"-DCMAKE_OBJECT_PATH_MAX=240`",",
    1
  )
  if ($gradleSource -notmatch '"-DCMAKE_OBJECT_PATH_MAX=240"') {
    throw 'Could not add the Windows CMake path limit to Reanimated Gradle configuration.'
  }
}
$stagingSetting = 'buildStagingDirectory = file("C:/c/reanimated")'
if ($gradleSource -notmatch [regex]::Escape($stagingSetting)) {
  $gradleSource = [regex]::Replace(
    $gradleSource,
    '(?m)^(\s*path = file\("CMakeLists.txt"\))$',
    '$1' + "`r`n            $stagingSetting",
    1
  )
  if ($gradleSource -notmatch [regex]::Escape($stagingSetting)) {
    throw 'Could not set a short Reanimated CMake staging directory.'
  }
}
Set-Content -LiteralPath $reanimatedGradle -Value $gradleSource -NoNewline

$architectures = switch ($BuildTarget) {
  'emulator' { 'x86_64' }
  'physical-32bit' { 'armeabi-v7a' }
  default { 'arm64-v8a' }
}

Write-Host "Building Android $BuildVariant APK for $BuildTarget device architectures: $architectures"

if ($SkipPrebuild) {
  Write-Host 'Keeping the existing generated Android project for an incremental JS/native build.'
} else {
  Write-Host 'Regenerating Android native project from app.json and config plugins.'
  $previousExpoGitStatus = $env:EXPO_NO_GIT_STATUS
  $env:EXPO_NO_GIT_STATUS = '1'
  try {
    & npx.cmd expo prebuild --platform android --clean --no-install
    $prebuildExitCode = $LASTEXITCODE
  } finally {
    if ($null -eq $previousExpoGitStatus) { Remove-Item Env:EXPO_NO_GIT_STATUS -ErrorAction SilentlyContinue }
    else { $env:EXPO_NO_GIT_STATUS = $previousExpoGitStatus }
  }
  if ($prebuildExitCode -ne 0) {
    throw 'Expo prebuild failed; Android native project was not rebuilt.'
  }
}

$gradleTask = if ($BuildVariant -eq 'release') { ':app:assembleRelease' } else { ':app:assembleDebug' }
$arguments = @(
  '--no-daemon',
  '-I', (Join-Path $PSScriptRoot 'windows-app-cmake.gradle'),
  '-p', (Join-Path $PSScriptRoot '..\android'),
  $gradleTask,
  '--max-workers=2',
  "-PreactNativeArchitectures=$architectures"
)
if ($BuildVariant -eq 'release') {
  # Release minification is configured by expo-build-properties in app.json.
  # Passing -Pandroid.enableMinifyInReleaseBuilds here shadows the Android
  # project extension used by Expo modules during Gradle configuration.
}
$exitCode = Invoke-GradleWithShortHome `
  -WrapperPath (Join-Path $PSScriptRoot '..\android\gradlew.bat') `
  -GradleHome 'C:\g' `
  -Arguments $arguments
if ($exitCode -eq 0) {
  $apkPath = Join-Path $PSScriptRoot "..\android\app\build\outputs\apk\$BuildVariant\app-$BuildVariant.apk"
  Write-Host "APK ready: $apkPath"
}
exit $exitCode
