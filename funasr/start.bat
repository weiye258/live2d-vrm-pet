@echo off
chcp 65001 >nul
title FunASR 语音识别服务 (8766)
cd /d "%~dp0"

echo ============================================
echo   FunASR 流式语音识别（供桌宠语音输入用）
echo   端口 8766，首次启动会自动下载模型（约 1GB）
echo ============================================
echo.

REM 已在运行则退出
netstat -ano | findstr ":8766" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo [OK] 8766 端口已有服务在运行，无需重复启动。
    timeout /t 3 /nobreak >nul
    exit /b 0
)

REM 找 Python
where python >nul 2>&1
if %errorlevel%==0 (
    set "PY=python"
) else (
    py -3 --version >nul 2>&1
    if %errorlevel%==0 (
        set "PY=py -3"
    ) else (
        echo [错误] 找不到 Python。请先运行 install.bat 或安装 Python 3.10+。
        pause
        exit /b 1
    )
)

echo 首次运行会自动下载识别模型到 funasr/models_cache，耐心等待...
echo 出现 "server ready" / "Listening on" 字样即启动成功。
echo 关闭本窗口即停止语音服务。
echo.

%PY% -u gf_live2d_asr_server.py
echo.
echo 服务已退出。
pause
