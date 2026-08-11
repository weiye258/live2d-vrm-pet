@echo off
setlocal EnableExtensions
cd /d "%~dp0"

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

echo.
echo   ========================
echo     Live2D Desktop Pet
echo   ========================
echo.

REM Locate Node.js
set "NODE_EXE=%~dp0node_modules\.bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%~dp0..\node_modules\.bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node.exe"

REM Start server fully hidden (no popup window), all output -> logs\server.log
if not exist "%~dp0logs" mkdir "%~dp0logs"
echo   [..] Starting server (background, log: logs\server.log)...
powershell -NoProfile -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList '\"%~dp0server.js\"' -WindowStyle Hidden -RedirectStandardOutput '%~dp0logs\server.log' -RedirectStandardError '%~dp0logs\server-error.log'"
timeout /t 2 >nul 2>&1

REM Launch electron EXACTLY ONCE (visible window) and record its PID.
REM Try local node_modules first, then parent node_modules
set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" set "ELECTRON_EXE=%~dp0..\node_modules\electron\dist\electron.exe"
if exist "%ELECTRON_EXE%" (
  echo   [OK] Electron found
  powershell -NoProfile -Command "Start-Process -FilePath '%ELECTRON_EXE%' -ArgumentList '.' -PassThru | ForEach-Object { $_.Id } | Out-File -FilePath 'pet.pid' -Encoding ascii"
  echo   [OK] Pet window launched
) else (
  echo   [WARN] Electron not found in local or parent node_modules.
  echo   [WARN] Please run: npm install (in D:\ai\pet or D:\ai\pet\live2d-pet)
)

echo.
echo   Press any key to close this window...
pause >nul
