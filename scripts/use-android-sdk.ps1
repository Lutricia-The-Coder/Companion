$ErrorActionPreference = 'Stop'

$androidSdk = 'C:\Users\LCX\AppData\Local\Android\Sdk'
$javaHomes = @()
if ($env:JAVA_HOME) {
  $javaHomes += $env:JAVA_HOME
}
$javaHomes += Get-ChildItem -Path 'C:\Program Files\Eclipse Adoptium' -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -ExpandProperty FullName
$javaHome = $javaHomes | Where-Object {
  (Test-Path (Join-Path $_ 'bin\java.exe')) -and (Test-Path (Join-Path $_ 'lib\jvm.cfg'))
} | Select-Object -First 1

if (-not (Test-Path (Join-Path $androidSdk 'platform-tools\adb.exe'))) {
  throw "Android SDK platform-tools not found at $androidSdk. Install it with Android Studio SDK Manager."
}

if (-not $javaHome) {
  throw 'A usable JDK 17 was not found. Install JDK 17; Android Studio is not required.'
}

$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk
$env:JAVA_HOME = $javaHome
$env:Path = "$javaHome\bin;$androidSdk\platform-tools;$androidSdk\emulator;$androidSdk\cmdline-tools\latest\bin;$env:Path"

Write-Host "Android SDK configured for this PowerShell session: $androidSdk"
Write-Host "Using command-line JDK: $javaHome"

java -version
adb version
