' Launches start-resume-tool.bat as a fully detached, hidden process.
' Used as the resumeworkflow:// protocol handler target instead of chaining
' through cmd.exe /c directly, because cmd.exe launched via a browser's
' ShellExecute sometimes inherits an invalid stdin handle and aborts with
' "Input redirection is not supported". WScript.Shell.Run does not have
' that problem.

Dim objShell, scriptDir, batPath
Set objShell = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
batPath = scriptDir & "..\start-resume-tool.bat"
objShell.Run """" & batPath & """", 0, False
