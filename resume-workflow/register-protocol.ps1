# Registers the resumeworkflow:// custom protocol, bound to launch.vbs
# (which in turn runs start-resume-tool.bat as a detached, hidden process).
# Writes only to the current user's registry hive (HKEY_CURRENT_USER) -
# no admin rights needed, does not affect other Windows users.
#
# Usage (from PowerShell):
#   .\register-protocol.ps1
#
# After registering, clicking a resumeworkflow://start link in a browser
# will show a system confirmation dialog; confirming runs start-resume-tool.bat
# (starts the local server and opens resume.html).
#
# Why launch.vbs instead of calling start-resume-tool.bat directly: cmd.exe,
# when launched via a browser's ShellExecute for a custom protocol, can
# inherit an invalid stdin handle and abort with "Input redirection is not
# supported" before doing anything. WScript.Shell.Run (used in launch.vbs)
# does not have that problem.

$scheme = "resumeworkflow"
$scriptDir = $PSScriptRoot
$vbsPath = Join-Path $scriptDir "launch.vbs"

if (-not (Test-Path $vbsPath)) {
    Write-Error "Cannot find $vbsPath - make sure this script lives in resume-workflow/ alongside launch.vbs."
    exit 1
}

$base = "HKCU:\Software\Classes\$scheme"
New-Item -Path $base -Force | Out-Null
Set-ItemProperty -Path $base -Name "(Default)" -Value "URL:Resume Workflow Protocol"
Set-ItemProperty -Path $base -Name "URL Protocol" -Value ""

New-Item -Path "$base\shell\open\command" -Force | Out-Null
$cmdValue = "wscript.exe `"$vbsPath`" `"%1`""
Set-ItemProperty -Path "$base\shell\open\command" -Name "(Default)" -Value $cmdValue

Write-Output "Registered resumeworkflow:// protocol -> $vbsPath"
Write-Output "Test it by typing resumeworkflow://start in your browser's address bar."
