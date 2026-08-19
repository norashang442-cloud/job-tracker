@echo off
cd /d "%~dp0resume-workflow"
netstat -ano | findstr "LISTENING" | findstr :5055 >nul
if errorlevel 1 (
  echo Starting resume-workflow local server...
  start "resume-workflow-server" /min cmd /c "python server\app.py"
  timeout /t 2 /nobreak >nul
) else (
  echo Server already running, skipping startup.
)
start "" "%~dp0resume.html"
