@echo off
chcp 65001 >nul
title FunASR 依赖安装
cd /d "%~dp0"

echo ============================================
echo   安装 FunASR 语音识别依赖（一次即可）
echo   有 NVIDIA 显卡：自动装 CUDA 版 torch（识别快）
echo   没有显卡：用 CPU 版（也能用，稍慢）
echo ============================================
echo.

where python >nul 2>&1
if %errorlevel%==0 (
    set "PY=python"
) else (
    py -3 --version >nul 2>&1
    if %errorlevel%==0 (
        set "PY=py -3"
    ) else (
        echo [错误] 找不到 Python。请先安装 Python 3.10 或 3.11：
        echo        https://www.python.org/downloads/
        echo        安装时务必勾选 "Add Python to PATH"
        pause
        exit /b 1
    )
)

echo 使用的 Python：%PY%
echo 正在安装依赖（可能需要几分钟）...
%PY% -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple

set /p GPU="有 NVIDIA 显卡吗？(y/n，默认 n): "
if /i "%GPU%"=="y" (
    %PY% -m pip install funasr modelscope torch torchaudio -i https://pypi.tuna.tsinghua.edu.cn/simple
) else (
    %PY% -m pip install funasr modelscope -i https://pypi.tuna.tsinghua.edu.cn/simple
    %PY% -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
)

echo.
echo [完成] 依赖安装完毕。接下来双击 start.bat 启动语音服务。
pause
