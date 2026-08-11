@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM ============================================================
REM  Live2D Pet - Background start with full request logging
REM  Log files (open with Notepad):
REM    logs\model-request.log   Every full payload sent to the model
REM    logs\server.log          Server runtime log
REM ============================================================

REM Kill previous electron instance via saved PID
if exist pet.pid (
  for /f "usebackq" %%i in ("pet.pid") do (
    taskkill /pid %%i /t /f >nul 2>&1
  )
  del /f /q pet.pid >nul 2>&1
)
REM Kill any leftover electron processes
taskkill /im electron.exe /f >nul 2>&1
REM Kill old server holding port 8740
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8740 ^| findstr LISTENING') do (
  taskkill /pid %%a /f >nul 2>&1
)
timeout /t 1 >nul 2>&1

REM Ensure log directory exists
if not exist "%~dp0logs" mkdir "%~dp0logs"

REM Rotate oversized server log (keep recent 1MB)
if exist "%~dp0logs\server.log" (
  for %%A in ("%~dp0logs\server.log") do if %%~zA GTR 1048576 del /f /q "%~dp0logs\server.log" >nul 2>&1
)

REM Locate Node.js
set "NODE_EXE=%~dp0node_modules\.bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%~dp0..\node_modules\.bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"

REM Start server fully hidden (no popup window), all output -> logs\server.log
powershell -NoProfile -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList '\"%~dp0server.js\"' -WindowStyle Hidden -RedirectStandardOutput '%~dp0logs\server.log' -RedirectStandardError '%~dp0logs\server-error.log'"
timeout /t 2 >nul 2>&1

REM Launch electron EXACTLY ONCE (visible window) and record its PID.
set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" set "ELECTRON_EXE=%~dp0..\node_modules\electron\dist\electron.exe"
if exist "%ELECTRON_EXE%" (
  powershell -NoProfile -Command "Start-Process -FilePath '%ELECTRON_EXE%' -ArgumentList '.' -PassThru | ForEach-Object { $_.Id } | Out-File -FilePath 'pet.pid' -Encoding ascii"
  echo   [OK] Pet window launched.
) else (
  echo   [WARN] Electron not found. Run npm install first.
)

echo.
echo   Live2D Pet started in background (logging mode)
echo   - Full model request log: logs\model-request.log
echo   - Server runtime log:     logs\server.log
echo   Press any key to close this window (pet keeps running)...
pause >nul
