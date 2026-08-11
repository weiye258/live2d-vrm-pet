# ============================================================
# Live2D Desktop Pet - PowerShell Launcher
# No encoding issues - pure PowerShell
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $appDir

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "    Live2D Desktop Pet" -ForegroundColor Cyan
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

# ---- Check Node.js ----
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    Write-Host "  [ERROR] Node.js not found!" -ForegroundColor Red
    Write-Host "  Install: https://nodejs.org" -ForegroundColor Yellow
    Read-Host "  Press Enter to exit"
    exit 1
}
Write-Host "  [OK] Node.js found" -ForegroundColor Green

# ---- Check port 8740 ----
$portInUse = Get-NetTCPConnection -LocalPort 8740 -State Listen -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Host "  [OK] Server already running on port 8740" -ForegroundColor Green
} else {
    Write-Host "  Starting local server..." -ForegroundColor Yellow
    Start-Process -FilePath $nodeExe -ArgumentList "server.js" -WindowStyle Minimized
    Start-Sleep -Seconds 2
    Write-Host "  [OK] Server started" -ForegroundColor Green
}

# ---- Check Electron ----
$electronExe = Join-Path $appDir "node_modules\electron\dist\electron.exe"
if (Test-Path $electronExe) {
    Write-Host "  [OK] Electron found" -ForegroundColor Green
    Start-Process -FilePath $electronExe -ArgumentList $appDir
    Write-Host "  [OK] Pet window launched" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Electron not found, installing..." -ForegroundColor Yellow
    & npm install
    if (Test-Path $electronExe) {
        Start-Process -FilePath $electronExe -ArgumentList $appDir
        Write-Host "  [OK] Installed and launched" -ForegroundColor Green
    } else {
        Write-Host "  [FALLBACK] Opening in browser..." -ForegroundColor Yellow
        Start-Process "http://127.0.0.1:8740/"
    }
}

Write-Host ""
Write-Host "  Dock:  Chat / Voice / Character / Settings / Zoom" -ForegroundColor Gray
Write-Host "  Right-click pet for more options" -ForegroundColor Gray
Write-Host "  Close this window anytime - pet keeps running" -ForegroundColor Gray
Write-Host ""
