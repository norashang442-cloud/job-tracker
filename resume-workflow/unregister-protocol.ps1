# Removes the resumeworkflow:// protocol registered by register-protocol.ps1
#
# Usage (from PowerShell):
#   .\unregister-protocol.ps1

$base = "HKCU:\Software\Classes\resumeworkflow"
if (Test-Path $base) {
    Remove-Item -Path $base -Recurse -Force
    Write-Output "Removed resumeworkflow:// protocol registration."
} else {
    Write-Output "No resumeworkflow:// protocol registration found, nothing to do."
}
