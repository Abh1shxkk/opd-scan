# Start the Android emulator and open the app in it.
#
# Usage (from the mobile folder):   powershell -ExecutionPolicy Bypass -File scripts\android-emulator.ps1
#
# The SDK lives on D: because C: has almost no free space. Override with -Sdk if it moves.

param(
  [string]$Sdk = "D:\Android\sdk",
  [string]$Avd = "OPD_Phone"
)

$env:ANDROID_HOME = $Sdk
$env:ANDROID_SDK_ROOT = $Sdk
$env:ANDROID_AVD_HOME = "D:\Android\avd"
$env:JAVA_HOME = "C:\Program Files\Android\openjdk\jdk-21.0.8"
$env:PATH = "$Sdk\platform-tools;$Sdk\emulator;$env:PATH"

$running = (& adb devices) -match "emulator-"
if (-not $running) {
  Write-Host "Starting emulator $Avd ..."
  Start-Process -FilePath "$Sdk\emulator\emulator.exe" -ArgumentList "-avd", $Avd, "-no-snapshot-save", "-gpu", "auto"
  & adb wait-for-device
  do {
    Start-Sleep -Seconds 3
    $booted = (& adb shell getprop sys.boot_completed 2>$null) -match "1"
  } until ($booted)
  Write-Host "Emulator ready."
}

Set-Location (Join-Path $PSScriptRoot "..")
# --android installs Expo Go on the emulator the first time and opens the app.
npx expo start --android
