@echo off
chcp 65001 >nul
echo =============================================
echo   ixBrowser 自动化工具 - 打包脚本
echo =============================================
echo.

REM 检查 Python 环境
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python，请确保已安装并添加到 PATH
    pause
    exit /b 1
)

REM 检查 PyInstaller
pip show pyinstaller >nul 2>&1
if errorlevel 1 (
    echo [安装] PyInstaller 未安装，正在安装...
    pip install pyinstaller
    if errorlevel 1 (
        echo [错误] PyInstaller 安装失败
        pause
        exit /b 1
    )
)

echo.
echo [步骤 1/3] 清理旧的构建文件...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo.
echo [步骤 2/3] 开始打包...
echo 这可能需要几分钟时间，请耐心等待...
echo.

pyinstaller build_exe.spec --noconfirm

if errorlevel 1 (
    echo.
    echo [错误] 打包失败，请检查上方错误信息
    pause
    exit /b 1
)

echo.
echo [步骤 3/3] 打包完成！
echo.
echo =============================================
echo   输出文件: dist\ixBrowser自动化工具.exe
echo =============================================
echo.

REM 显示文件大小
for %%I in ("dist\ixBrowser自动化工具.exe") do echo 文件大小: %%~zI bytes

echo.
echo 按任意键打开输出目录...
pause >nul
explorer dist

